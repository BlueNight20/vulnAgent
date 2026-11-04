import { Injectable, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentSessionEntity, ModelRequestEntity, ModelUsageEntity, TaskEntity, TaskStateEventEntity } from '../../database/entities';
import { newId } from '../../common/utils/id';
import { adoptTaskAccounting, hydrateTaskAccounting, sessionAccounting, sessionBudgetProblem } from '../../database/model-accounting';
import { serialTransaction } from '../../database/serial-transaction';
import { estimateInputTokens, providerUsage, TokenBudgetBusyError, TokenBudgetError } from './token-budget';

@Injectable()
export class ModelBudgetService implements OnApplicationBootstrap {
  constructor(@InjectRepository(ModelRequestEntity) private readonly requests: Repository<ModelRequestEntity>) {}

  async onApplicationBootstrap(): Promise<void> {
    await serialTransaction(this.requests.manager, (manager) => manager.update(ModelRequestEntity, { state: 'reserved' }, { state: 'uncertain', finishedAt: new Date(), errorMessage: '进程中断，供应商实际用量未知，保留已预留额度' }));
  }

  async reserve(sessionId: string, context: unknown, model: { id: string; provider: string; maxTokens: number; contextWindow: number }, requested?: number): Promise<ModelRequestEntity> {
    const estimate = estimateInputTokens(context);
    if (!Number.isFinite(model.contextWindow) || estimate >= model.contextWindow || !Number.isFinite(model.maxTokens) || model.maxTokens < 1) throw new TokenBudgetError('context', '上下文已达到模型窗口或模型限制无效');
    const result = await serialTransaction(this.requests.manager, async (manager) => {
      const session = await manager.findOne(AgentSessionEntity, { where: { id: sessionId } });
      if (!session) throw new NotFoundException('模型会话不存在');
      const task = await manager.findOne(TaskEntity, { where: { id: session.taskId } });
      if (!task || task.status !== 'running' || session.state !== 'running') throw new TokenBudgetError('task', '任务或会话未在运行，拒绝新的模型请求');
      const remainingTime = (task.startedAt ?? task.createdAt).getTime() + task.timeBudgetMinutes * 60000 - Date.now();
      if (remainingTime <= 0) {
        const error = new TokenBudgetError('task', '任务墙钟时间预算已耗尽');
        await manager.insert(TaskStateEventEntity, { id: newId(), taskId: task.id, eventType: 'model.budget_blocked', payload: { reason: error.message, stopReason: 'budget_time' }, consumedAt: null });
        return { error };
      }
      if (await manager.count(ModelRequestEntity, { where: { sessionId, state: 'uncertain' } })) throw new TokenBudgetError('worker', '此会话存在用量未确认的请求，不能自动重试；保留占用并使用新的明确预算或会话');
      if (!task.budgetEpoch) {
        await adoptTaskAccounting(manager, task);
      }
      if (session.budgetEpoch && session.budgetEpoch !== task.budgetEpoch) throw new TokenBudgetError('worker', '此会话属于旧运行，不能使用新一轮额度');
      if (!session.budgetManaged) {
        session.baselineInput = session.tokenInput; session.baselineOutput = session.tokenOutput; session.baselineCost = session.costUsd; session.budgetManaged = true;
      }
      session.budgetEpoch = task.budgetEpoch;
      await manager.update(AgentSessionEntity, { id: session.id }, { budgetManaged: true, budgetEpoch: session.budgetEpoch, baselineInput: session.baselineInput, baselineOutput: session.baselineOutput, baselineCost: session.baselineCost });
      await hydrateTaskAccounting(manager, task);
      const used = await sessionAccounting(manager, session);
      const taskLeft = Math.max(0, Math.floor(task.tokenBudget * 0.9) - task.tokensUsed - (task.tokensCommitted ?? 0));
      const workerLeft = session.tokenAllowance === null ? taskLeft : Math.max(0, session.tokenAllowance - used.input - used.output - used.committed);
      const available = Math.min(taskLeft, workerLeft, Math.max(0, model.contextWindow - estimate));
      if (estimate >= Math.min(taskLeft, workerLeft) || available <= 0) {
        const [reserved] = await manager.query("SELECT COALESCE(SUM(reservedTokens),0) AS taskTokens, COALESCE(SUM(CASE WHEN sessionId = ? THEN reservedTokens ELSE 0 END),0) AS sessionTokens FROM model_requests WHERE taskId = ? AND budgetEpoch = ? AND state = 'reserved'", [sessionId, task.id, task.budgetEpoch]);
        if (Math.min(taskLeft + reserved.taskTokens, workerLeft + (session.tokenAllowance === null ? reserved.taskTokens : reserved.sessionTokens)) > estimate) throw new TokenBudgetBusyError('额度被在途模型请求暂时占用');
        const scope = taskLeft <= workerLeft ? 'task' : 'worker';
        const error = new TokenBudgetError(scope, `输入预估 ${estimate}，任务可用 ${taskLeft}，会话可用 ${workerLeft}；需缩小上下文或使用新的明确预算`);
        if (scope === 'task') await manager.insert(TaskStateEventEntity, { id: newId(), taskId: task.id, eventType: 'model.budget_blocked', payload: { reason: error.message }, consumedAt: null });
        return { error };
      }
      const output = Math.max(1, Math.floor(Math.min(model.maxTokens, typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? requested : model.maxTokens, taskLeft - estimate, workerLeft - estimate, model.contextWindow - estimate)));
      const lease = await manager.save(manager.create(ModelRequestEntity, {
        id: newId(), taskId: task.id, sessionId, budgetEpoch: task.budgetEpoch!, state: 'reserved', modelName: model.id, provider: model.provider,
        inputEstimate: estimate, maxOutputTokens: output, reservedTokens: estimate + output, inputTokens: null, outputTokens: null, costUsd: null, errorMessage: null, createdAt: new Date(), finishedAt: null,
      }));
      lease.timeoutMs = Math.max(1, remainingTime);
      return { lease };
    });
    if (result.error) throw result.error;
    return result.lease!;
  }

  async finish(id: string, message: { usage?: unknown; errorMessage?: string; stopReason?: string } | null, reason?: string, neverDispatched = false): Promise<void> {
    const actual = providerUsage(message?.usage);
    await serialTransaction(this.requests.manager, async (manager) => {
      const lease = await manager.findOne(ModelRequestEntity, { where: { id } });
      if (!lease || ['settled', 'cancelled'].includes(lease.state)) return;
      if (neverDispatched && lease.state !== 'reserved') return;
      const partial = message && ['error', 'aborted', 'pending'].includes(message.stopReason ?? '');
      const state = neverDispatched ? 'cancelled' : actual && !partial ? 'settled' : 'uncertain';
      const inputTokens = actual ? Math.max(lease.inputTokens ?? 0, actual.input) : lease.inputTokens;
      const outputTokens = actual ? Math.max(lease.outputTokens ?? 0, actual.output) : lease.outputTokens;
      const costUsd = actual ? Math.max(lease.costUsd ?? 0, actual.cost) : lease.costUsd;
      const safeReason = reason && /^(?:模型流超过|模型请求已取消|模型流消费者|发送前)/.test(reason) ? reason.slice(0, 1000) : '供应商未返回有效用量或本地请求异常，保留预留额度；预算账本不保存原始服务端错误';
      await manager.update(ModelRequestEntity, { id }, { state, inputTokens, outputTokens, costUsd, errorMessage: state === 'uncertain' ? safeReason : null, finishedAt: new Date() });
      if (actual && !neverDispatched) {
        await manager.save(manager.create(ModelUsageEntity, { id: lease.id, taskId: lease.taskId, agentSessionId: lease.sessionId, provider: lease.provider, modelName: lease.modelName, inputTokens: inputTokens!, outputTokens: outputTokens!, costUsd: costUsd!, latencyMs: Math.max(0, Date.now() - lease.createdAt.getTime()) }));
      }
      const session = await manager.findOne(AgentSessionEntity, { where: { id: lease.sessionId, taskId: lease.taskId } });
      if (session) {
        const s = await sessionAccounting(manager, session);
        await manager.update(AgentSessionEntity, { id: session.id }, { tokenInput: s.input, tokenOutput: s.output, costUsd: s.cost });
      }
      const task = await manager.findOne(TaskEntity, { where: { id: lease.taskId, budgetEpoch: lease.budgetEpoch } });
      if (task) {
        await hydrateTaskAccounting(manager, task);
        await manager.update(TaskEntity, { id: task.id, budgetEpoch: lease.budgetEpoch }, { tokensUsed: task.tokensUsed, costUsd: task.costUsd });
      }
    });
  }

  async assertToolBudget(sessionId: string): Promise<void> {
    const problem = await sessionBudgetProblem(this.requests.manager, sessionId);
    if (problem) throw new TokenBudgetError(problem.scope, problem.reason);
  }
}
