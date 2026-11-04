import type { EntityManager } from 'typeorm';
import { AgentSessionEntity, ModelRequestEntity, ModelUsageEntity, TaskEntity } from './entities';
import { newId } from '../common/utils/id';

/** 调用方持有串行事务；旧运行只接管一次已知用量，不重算到新运行。 */
export async function adoptTaskAccounting(manager: EntityManager, task: TaskEntity): Promise<void> {
  if (task.budgetEpoch) return;
  const previous = await manager.createQueryBuilder(ModelUsageEntity, 'u').select('COALESCE(SUM(u.inputTokens + u.outputTokens),0)', 'tokens').addSelect('COALESCE(SUM(u.costUsd),0)', 'cost')
    .where('u.taskId = :taskId', { taskId: task.id }).andWhere('u.createdAt >= :start', { start: (task.startedAt ?? task.createdAt).toISOString().replace('T', ' ').replace('Z', '') }).getRawOne<{ tokens: number; cost: number }>();
  task.budgetEpoch = newId(); task.tokenBaseline = Math.max(task.tokensUsed, Number(previous?.tokens ?? 0)); task.costBaseline = Math.max(task.costUsd, Number(previous?.cost ?? 0));
  await manager.update(TaskEntity, { id: task.id }, { budgetEpoch: task.budgetEpoch, tokenBaseline: task.tokenBaseline, costBaseline: task.costBaseline });
}

async function totals(manager: EntityManager, where: { taskId?: string; budgetEpoch?: string; sessionId?: string }) {
  const qb = manager.createQueryBuilder(ModelRequestEntity, 'r');
  for (const [key, value] of Object.entries(where)) qb.andWhere(`r.${key} = :${key}`, { [key]: value });
  return qb.select("COALESCE(SUM(CASE WHEN r.state IN ('settled','uncertain') THEN r.inputTokens ELSE 0 END),0)", 'input')
    .addSelect("COALESCE(SUM(CASE WHEN r.state IN ('settled','uncertain') THEN r.outputTokens ELSE 0 END),0)", 'output')
    .addSelect("COALESCE(SUM(CASE WHEN r.state IN ('settled','uncertain') THEN r.costUsd ELSE 0 END),0)", 'cost')
    .addSelect("COALESCE(SUM(CASE WHEN r.state = 'reserved' THEN r.reservedTokens WHEN r.state = 'uncertain' THEN MAX(0,r.reservedTokens-COALESCE(r.inputTokens,0)-COALESCE(r.outputTokens,0)) ELSE 0 END),0)", 'committed')
    .getRawOne<{ input: number; output: number; cost: number; committed: number }>();
}

export async function hydrateTaskAccounting(manager: EntityManager, task: TaskEntity): Promise<TaskEntity> {
  if (!task.budgetEpoch) { task.tokensCommitted = 0; return task; }
  const sum = await totals(manager, { taskId: task.id, budgetEpoch: task.budgetEpoch });
  task.tokensUsed = task.tokenBaseline + Number(sum?.input ?? 0) + Number(sum?.output ?? 0);
  task.costUsd = Number((task.costBaseline + Number(sum?.cost ?? 0)).toFixed(6));
  task.tokensCommitted = Number(sum?.committed ?? 0);
  return task;
}
export async function sessionAccounting(manager: EntityManager, session: AgentSessionEntity) {
  if (!session.budgetManaged) return { input: session.tokenInput, output: session.tokenOutput, cost: session.costUsd, committed: 0 };
  const sum = await totals(manager, { sessionId: session.id });
  return { input: session.baselineInput + Number(sum?.input ?? 0), output: session.baselineOutput + Number(sum?.output ?? 0), cost: Number((session.baselineCost + Number(sum?.cost ?? 0)).toFixed(6)), committed: Number(sum?.committed ?? 0) };
}

export async function sessionBudgetProblem(manager: EntityManager, sessionId: string, expectedTaskId?: string | null): Promise<{ scope: 'task' | 'worker'; reason: string } | null> {
  const session = await manager.findOne(AgentSessionEntity, { where: { id: sessionId } });
  if (session && expectedTaskId && session.taskId !== expectedTaskId) return { scope: 'task', reason: '会话不属于当前任务' };
  if (!session?.budgetManaged) return null;
  const task = await manager.findOne(TaskEntity, { where: { id: session.taskId } });
  if (!task || task.budgetEpoch !== session.budgetEpoch) return { scope: 'task', reason: '旧运行或任务已删除' };
  if (task.status !== 'running') return { scope: 'task', reason: '任务已暂停或结束，不能继续自动工具调用' };
  await hydrateTaskAccounting(manager, task);
  const usage = await sessionAccounting(manager, session);
  if (session.tokenAllowance !== null && usage.input + usage.output + usage.committed >= session.tokenAllowance) return { scope: 'worker', reason: '会话实际用量及未确认占用已达到额度' };
  if (task.tokensUsed + (task.tokensCommitted ?? 0) >= Math.floor(task.tokenBudget * 0.9)) return { scope: 'task', reason: '任务实际用量及未确认占用已达到可用额度' };
  return null;
}
