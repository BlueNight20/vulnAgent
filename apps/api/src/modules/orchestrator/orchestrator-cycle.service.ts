import { compactPendingQueue, limitPlannerOutput } from './planner-capacity';
import { newId } from '../../common/utils/id';
import { AuditLogEntity } from '../../database/entities';
import { serialTransaction } from '../../database/serial-transaction';
import { serialUpdate } from '../../database/serial-transaction';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AgentRole, FactStatus } from '@vulnagent/shared';
import {
  DEFAULT_MAX_CYCLES,
  DEFAULT_NO_PROGRESS_ROUNDS,
  DEFAULT_WORKER_MAX_ATTEMPTS,
  DEFAULT_WORKER_TIMEOUT_SECONDS,
} from '@vulnagent/shared';
import {
  AgentSessionEntity,
  EvidenceEntity,
  IntentEntity,
  TargetEntity,
  TaskEntity,
  ToolCallEntity,
} from '../../database/entities';
import { FactsService } from '../blackboard/facts.service';
import { HintsService } from '../blackboard/hints.service';
import { HypothesisService } from '../blackboard/hypothesis.service';
import { IntentsService } from '../blackboard/intents.service';
import { WorkerStateService } from '../blackboard/worker-state.service';
import { PiRuntimeService } from '../pi-runtime/pi-runtime.service';
import { WorkerSkillsService } from '../worker-skills/worker-skills.service';
import { getProfile } from '../worker-skills/profiles';
import { checkBudget, workerTokenAllowance, type BudgetCheck } from './budget-guard';
import { estimateCost, isHighValueTarget, scoreIntent } from './exploration-score';
import { admitIntents } from './intent-admission';
import { shouldMarkStalled } from './orchestrator-state-machine';
import { evaluateCompletion } from './completion-evaluator';
import { TaskGoalsService } from '../blackboard/task-goals.service';
import {
  MAX_PLANNER_RETRIES,
  describeModelError,
  isTransientModelError,
  retryDelay,
  sleep,
} from './model-error-policy';
import type { OrchestratorContext } from './orchestrator-context';
import { PlannerRunnerService } from './planner-runner.service';
import { parsePlannerResult } from './result-parser';
import { planDispatch, type SchedulableIntent } from './worker-scheduler';
import { WorkerRunnerService } from './worker-runner.service';
import { OrchestratorService } from './orchestrator.service';

/**
 * 编排循环实现：规划 → 准入 → 评分 → 派发。
 * 与 OrchestratorService 拆开以避免单文件过大，职责仍然清晰。
 */
@Injectable()
export class OrchestratorCycleService implements OnModuleInit {
  private readonly logger = new Logger(OrchestratorCycleService.name);

  constructor(
    @InjectRepository(TaskEntity) private readonly tasks: Repository<TaskEntity>,
    @InjectRepository(TargetEntity) private readonly targets: Repository<TargetEntity>,
    @InjectRepository(IntentEntity) private readonly intentRepo: Repository<IntentEntity>,
    @InjectRepository(AgentSessionEntity) private readonly sessions: Repository<AgentSessionEntity>,
    @InjectRepository(ToolCallEntity) private readonly toolCalls: Repository<ToolCallEntity>,
    @InjectRepository(EvidenceEntity) private readonly evidence: Repository<EvidenceEntity>,
    private readonly orchestrator: OrchestratorService,
    private readonly runtime: PiRuntimeService,
    private readonly facts: FactsService,
    private readonly hints: HintsService,
    private readonly hypotheses: HypothesisService,
    private readonly intents: IntentsService,
    private readonly workers: WorkerStateService,
    private readonly skills: WorkerSkillsService,
    private readonly planner: PlannerRunnerService,
    private readonly workerRunner: WorkerRunnerService,
    private readonly goals: TaskGoalsService,
  ) {}

  onModuleInit(): void {
    this.orchestrator.registerCycleBody((taskId, ctx) => this.run(taskId, ctx));
  }

  async run(taskId: string, ctx: OrchestratorContext): Promise<void> {
    if (!await this.orchestrator.executionAllowed(taskId)) return;
    const task = await this.orchestrator.findTask(taskId);
    const budget = checkBudget({
      tokensUsed: task.tokensUsed,
      tokensCommitted: task.tokensCommitted,
      tokenBudget: task.tokenBudget,
      startedAt: task.startedAt,
      timeBudgetMinutes: task.timeBudgetMinutes,
    });
    const acceptance = await this.goals.evaluate(taskId);
    if (!await this.orchestrator.executionAllowed(taskId)) return;
    if (acceptance.complete && ctx.activeWorkers.size === 0) {
      await this.orchestrator.stopWithReason(taskId, 'goal_reached', '任务验收目标已由实际证据满足');
      return;
    }
    if (budget.exhausted) {
      await this.orchestrator.stopWithReason(taskId, budget.reason ?? 'budget_tokens', budget.detail);
      return;
    }
    if (!acceptance.configured) {
      await this.orchestrator.stopWithReason(taskId, 'needs_input', '任务尚未配置验收目标');
      return;
    }
    if (ctx.capacityDeferred) {
      const capacity = await this.workers.capacity(taskId);
      if (capacity.active >= capacity.limit || capacity.taskActive >= task.workerCount) return;
      ctx.capacityDeferred = false;
    }
    await this.goals.prepare(taskId);
    const ready = await this.goals.evaluate(taskId);
    if (!await this.orchestrator.executionAllowed(taskId)) return;
    if (ready.complete && ctx.activeWorkers.size === 0) {
      await this.orchestrator.stopWithReason(taskId, 'goal_reached', '任务验收目标已由实际证据满足');
      return;
    }
    // 等待已派发工作完成不消耗探索轮次，也不提前取消最后一批 Worker。
    if (ctx.activeWorkers.size >= task.workerCount) {
      await this.orchestrator.setStatus(taskId, 'executing');
      return;
    }
    if (ctx.cycle >= DEFAULT_MAX_CYCLES) {
      if (ctx.activeWorkers.size > 0) return;
      await this.orchestrator.stopWithReason(taskId, 'max_cycles', `达到最大派发轮次 ${DEFAULT_MAX_CYCLES}`);
      return;
    }
    ctx.cycle += 1;
    await this.orchestrator.setStatus(taskId, 'planning', `第 ${ctx.cycle} 轮调度中`);

    let proposed = await this.intentRepo.find({ where: { taskId, status: 'proposed' } });
    let replanned = false;
    const needsReview = (ctx.planRevision ?? 0) > (ctx.reviewedRevision ?? 0)
      || proposed.length > task.workerCount * 2
      || ctx.cycle - (ctx.lastPlanningCycle ?? 0) >= 3;
    if (proposed.length === 0 || needsReview) {
      await this.runPlanner(taskId, task, budget);
      if (['paused', 'completed', 'needs_input', 'stalled', 'stopped', 'stopping', 'failed'].includes(ctx.status)) return;
      proposed = await this.intentRepo.find({ where: { taskId, status: 'proposed' } });
      replanned = true;
    }

    const dispatched = await this.admitAndDispatch(taskId, task, proposed, budget);
    if (!await this.orchestrator.executionAllowed(taskId)) return;
    if (!dispatched && ctx.activeWorkers.size === 0 && !ctx.capacityDeferred) {
      ctx.noProgressRounds += 1;
      if (shouldMarkStalled(ctx.noProgressRounds, DEFAULT_NO_PROGRESS_ROUNDS)) {
        await this.orchestrator.markStalled(taskId, '连续多轮没有可执行的探索意图');
        return;
      }
    }

    await this.orchestrator.persistRun(ctx, ctx.stopReason);
    if (ctx.activeWorkers.size > 0) {
      await this.orchestrator.setStatus(taskId, 'executing');
      return;
    }
    // 本轮规划后没有任何 Worker 在跑：必须主动推进下一轮，
    // 否则任务会停在"规划中"直到外部事件唤醒。
    if (replanned) this.orchestrator.requestCycle(taskId, ctx);
  }

  /* ==================== Planner ==================== */

  private async runPlanner(taskId: string, task: TaskEntity, budget: BudgetCheck): Promise<void> {
    if (!await this.orchestrator.executionAllowed(taskId)) return;
    const ctx = this.orchestrator.getContext(taskId);
    if (!ctx) return;

    const reviewRevision = ctx.planRevision ?? 0;
    const targetIps = (await this.targets.find({ where: { taskId, inScope: true } })).map((t) => t.ip);
    const pendingHints = await this.hints.takePending(taskId);
    const catalog = await this.skills.catalogToolNames();
    const elapsedMinutes = task.startedAt
      ? (Date.now() - new Date(task.startedAt).getTime()) / 60_000
      : 0;

    const prompt = await this.planner.buildPrompt({
      taskId,
      taskName: task.name,
      targetIps,
      scopeCidrs: task.scope?.cidrs ?? [],
      tokenBudget: task.tokenBudget,
      tokensUsed: task.tokensUsed + (task.tokensCommitted ?? 0),
      timeBudgetMinutes: task.timeBudgetMinutes,
      elapsedMinutes,
      availableProfiles: this.skills.list().map((p) => p.id),
      availableTools: catalog,
      hints: pendingHints.map((h) => h.content),
    });

    const existing = ctx.plannerSessionId
      ? await this.sessions.findOne({ where: { id: ctx.plannerSessionId } })
      : null;
    if (!await this.orchestrator.executionAllowed(taskId)) return;

    try {
      if (!existing || existing.endedAt) {
        const created = await this.runtime.sessions.createRecord({
          taskId,
          role: 'planner' as AgentRole,
          profileId: null,
          parentSessionId: null,
          modelName: task.modelName,
          systemPrompt: this.planner.getSystemPrompt(),
          tools: [],
        });
        ctx.plannerSessionId = created.id;
        await serialUpdate(this.sessions, created.id, {
          stateCard: { phase: '规划中', plan: ['收集事实', '分析缺口', '提出意图'] },
        });
        await this.runtime.sessions.start(
          created,
          {
            taskId,
            role: 'planner',
            profileId: null,
            parentSessionId: null,
            modelName: task.modelName,
            systemPrompt: this.planner.getSystemPrompt(),
            tools: [],
            onAssistantMessage: (message) => {
              this.planner.recordOutput(created.id, message);
            },
          },
          prompt,
        );
      } else {
        await this.runtime.sessions.sendMessage(existing.id, prompt);
      }

      await this.waitPlannerIdle(ctx.plannerSessionId!);
      if (!await this.orchestrator.executionAllowed(taskId)) return;

      // 模型侧连接错误（限流 / 上游 5xx / 网络瞬断）属于可恢复故障：
      // 重建 Planner 会话后重试，不计入无进展轮次，避免一次抖动就让任务停滞。
      const failure = await this.detectSessionFailure(ctx.plannerSessionId!);
      if (failure) {
        const attempt = (ctx.plannerRetries ?? 0) + 1;
        const transient = isTransientModelError(failure);
        if (transient && attempt <= MAX_PLANNER_RETRIES) {
          ctx.plannerRetries = attempt;
          this.logger.warn(
            `Planner 模型调用失败（${failure}），第 ${attempt}/${MAX_PLANNER_RETRIES} 次重试`,
          );
          ctx.lastError = `Planner 第 ${attempt} 次重试中：${describeModelError(failure)}`;
          ctx.plannerSessionId = null;
          this.orchestrator.broadcastSnapshot(taskId);
          await sleep(retryDelay(attempt));
          return this.runPlanner(taskId, task, budget);
        }
        // 失败原因必须落到任务上，否则界面只显示 Planner「失败」而没有可操作信息。
        const reason = describeModelError(failure);
        ctx.plannerRetries = 0;
        ctx.noProgressRounds += 1;
        ctx.lastError = `Planner 模型调用失败：${reason}`;
        this.logger.error(`Planner 会话 ${ctx.plannerSessionId} 失败：${failure}`);
        this.orchestrator.broadcastSnapshot(taskId);
        if (shouldMarkStalled(ctx.noProgressRounds, DEFAULT_NO_PROGRESS_ROUNDS)) {
          await this.orchestrator.markStalled(taskId, `Planner 连续失败：${reason}`);
        }
        return;
      }

      ctx.plannerRetries = 0;
      ctx.lastError = null;
      const output = this.planner.getOutput(ctx.plannerSessionId!);
      if (output?.parsed) {
        await this.applyPlannerOutput(taskId, ctx, output.parsed);
        ctx.reviewedRevision = reviewRevision;
        ctx.lastPlanningCycle = ctx.cycle;
        ctx.planningCount = (ctx.planningCount ?? 0) + 1;
        this.planner.clearOutput(ctx.plannerSessionId!);
        // 消费本轮的 Hint
        for (const hint of pendingHints) {
          await this.hints.consume(hint.id, ctx.plannerSessionId!);
        }
        return;
      }

      ctx.noProgressRounds += 1;
      if (shouldMarkStalled(ctx.noProgressRounds, DEFAULT_NO_PROGRESS_ROUNDS)) {
        await this.orchestrator.markStalled(taskId, 'Planner 连续多轮未产出结构化意图');
      }
    } catch (error) {
      if (!await this.orchestrator.executionAllowed(taskId)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Planner 执行失败：${message}`);
      ctx.lastError = message;
      ctx.noProgressRounds += 1;
      if (ctx.noProgressRounds >= DEFAULT_NO_PROGRESS_ROUNDS) {
        await this.orchestrator.markStalled(taskId, `Planner 连续失败：${message}`);
      }
    }
  }

  /** 检查会话是否已因模型错误终止，返回错误信息 */
  private async detectSessionFailure(sessionId: string): Promise<string | null> {
    const entity = await this.sessions.findOne({ where: { id: sessionId } }).catch(() => null);
    if (!entity) return null;
    if (entity.state === 'failed') return entity.errorMessage ?? '模型调用失败';
    return null;
  }

  private async waitPlannerIdle(sessionId: string, timeoutMs = 240_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const agent = this.runtime.sessions.getAgent(sessionId);
      if (!agent || !agent.state.isStreaming) {
        // 再等一小段时间确保 message_end 已落库
        await new Promise((r) => setTimeout(r, 300));
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    this.logger.warn(`Planner ${sessionId} 等待空闲超时`);
  }

  private async applyPlannerOutput(
    taskId: string,
    ctx: OrchestratorContext,
    parsed: NonNullable<ReturnType<typeof parsePlannerResult>>,
  ): Promise<void> {
    await serialTransaction(this.tasks.manager, async (manager) => {
      for (const review of parsed.intentReviews ?? []) {
        const existing = await manager.findOne(IntentEntity, { where: { id: review.id, taskId, status: 'proposed' } });
        if (!existing || existing.workerProfileId === 'verification') continue;
        await manager.update(IntentEntity, existing.id, review.action === 'retire'
          ? { status: 'rejected', rejectedReason: 'superseded' }
          : { priority: review.priority ?? existing.priority });
        await manager.insert(AuditLogEntity, { id: newId(), taskId, action: 'planner.intent_reviewed', entityType: 'intent', entityId: existing.id,
          detail: { action: review.action, reason: review.reason, priority: review.priority ?? existing.priority, planningCycle: ctx.cycle } });
      }
      await manager.insert(AuditLogEntity, { id: newId(), taskId, action: 'planner.round_completed', entityType: 'planner', entityId: ctx.plannerSessionId,
        detail: { planningCount: (ctx.planningCount ?? 0) + 1, dispatchCycle: ctx.cycle } });
      const task = await manager.findOneByOrFail(TaskEntity, { id: taskId });
      const pending = await manager.find(IntentEntity, { where: { taskId, status: 'proposed' } });
      const active = await manager.find(IntentEntity, { where: { taskId, status: 'dispatched' } });
      const capacity = task.workerCount * 2;
      const compacted = compactPendingQueue(pending, capacity, active.flatMap((row) => row.dependencies));
      for (const row of compacted.deferred) {
        await manager.update(IntentEntity, row.id, { status: 'rejected', rejectedReason: 'queue_capacity' });
      }
      if (compacted.deferred.length || compacted.protectedCount > capacity) {
        await manager.insert(AuditLogEntity, { id: newId(), taskId, action: 'planner.queue_compacted', entityType: 'planner', entityId: ctx.plannerSessionId,
          detail: { capacity, before: pending.length, retained: compacted.retained.length, protectedCount: compacted.protectedCount,
            deferredIds: compacted.deferred.map((row) => row.id), disposition: 'retained_in_history_reopen_only_if_planner_selects_again' } });
      }
    });
    const task = await this.orchestrator.findTask(taskId);
    const pending = await this.intentRepo.count({ where: { taskId, status: 'proposed' } });
    const batch = limitPlannerOutput(parsed, Math.max(0, task.workerCount * 2 - pending));
    if (batch.dropped.length) {
      await serialTransaction(this.tasks.manager, async (manager) => {
        await manager.insert(AuditLogEntity, {
          id: newId(), taskId, action: 'planner.output_limited', entityType: 'planner', entityId: ctx.plannerSessionId,
          detail: { received: parsed.intents.length, accepted: batch.intents.length, limit: batch.limit,
            disposition: 'not_queued_reconsider_next_plan', deferredTitles: batch.dropped.map((intent) => intent.title) },
        });
      });
    }
    const hypothesisRefs = new Map<string, string>();
    const ambiguousRefs = new Set<string>();
    for (const hypothesis of batch.hypotheses) {
      try {
        const created = await this.hypotheses.create({
          taskId,
          title: hypothesis.title,
          description: hypothesis.description,
          severity: hypothesis.severity,
          targetIp: hypothesis.targetIp,
          createdBy: 'planner',
        });
        if (hypothesis.key) {
          if (hypothesisRefs.has(hypothesis.key)) ambiguousRefs.add(hypothesis.key);
          else hypothesisRefs.set(hypothesis.key, created.id);
        }
      } catch (error) { this.logger.warn(`Planner 假设未接纳：${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const intent of batch.intents) {
      const created = await this.intents.create({
        taskId,
        agentSessionId: ctx.plannerSessionId,
        title: intent.title,
        hypothesis: intent.hypothesis,
        objective: intent.objective,
        rationale: intent.rationale,
        workerProfileId: intent.workerProfileId,
        suggestedTools: intent.suggestedTools,
        expectedEvidence: intent.expectedEvidence,
        targetIp: intent.targetIp,
        priority: intent.priority,
        dedupeKey: intent.dedupeKey,
        cycle: ctx.cycle,
      });
      for (const reference of intent.hypothesisRefs) {
        try {
          if (ambiguousRefs.has(reference)) throw new Error(`假设 key ${reference} 重复，不能确定关联对象`);
          await this.hypotheses.link(hypothesisRefs.get(reference) ?? reference, 'depends_on', 'intent', created.intent.id, taskId, 'Planner 明确安排此意图研究该假设，不作为支持证据', { source: 'agent', sessionId: ctx.plannerSessionId });
        } catch (error) { this.logger.warn(`Planner 假设关联未接纳：${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    ctx.lastPlannerText = parsed.analysis;

    // 不直接采信 Planner 的自述，交由证据校验判定真正的完成/停止
    const verdict = await this.evaluateWithEvidence(taskId, ctx, parsed.goalStatus);
    if (verdict.status === 'needs_input' && verdict.reason) {
      await this.orchestrator.stopWithReason(taskId, verdict.reason, verdict.detail);
    } else if (verdict.status === 'stalled') {
      await this.orchestrator.markStalled(taskId, verdict.detail);
    } else if (verdict.finish && verdict.status && verdict.reason) {
      this.logger.log(`任务 ${taskId} 结束判定：${verdict.detail}`);
      await this.orchestrator.stopWithReason(taskId, verdict.reason, verdict.detail);
    }
  }

  /** 结合黑板真实事实、待审批与并发状态评估是否应当结束任务 */
  private async evaluateWithEvidence(
    taskId: string,
    ctx: OrchestratorContext,
    plannerGoal: 'in_progress' | 'goal_reached' | 'needs_input' | 'blocked',
  ) {
    const [acceptance, pendingIntents, task] = await Promise.all([
      this.goals.evaluate(taskId),
      this.intentRepo.count({ where: { taskId, status: 'proposed' } }),
      this.orchestrator.findTask(taskId),
    ]);
    const budget = checkBudget({ tokensUsed: task.tokensUsed, tokensCommitted: task.tokensCommitted, tokenBudget: task.tokenBudget, startedAt: task.startedAt, timeBudgetMinutes: task.timeBudgetMinutes });

    return evaluateCompletion({
      plannerGoal,
      acceptance,
      hasPendingIntents: pendingIntents > 0,
      hasActiveWorkers: ctx.activeWorkers.size > 0,
      noProgressRounds: ctx.noProgressRounds,
      noProgressThreshold: DEFAULT_NO_PROGRESS_ROUNDS,
      budgetExhausted: budget.exhausted,
      budgetReason: budget.reason === 'budget_time' ? 'budget_time' : 'budget_tokens',
    });
  }

  /* ==================== 准入与派发 ==================== */

  private async admitAndDispatch(
    taskId: string,
    task: TaskEntity,
    proposed: IntentEntity[],
    budget: BudgetCheck,
  ): Promise<number> {
    if (!await this.orchestrator.executionAllowed(taskId)) return 0;
    if (proposed.length === 0) return 0;
    const ctx = this.orchestrator.getContext(taskId);
    if (!ctx) return 0;

    const authorized = await this.targets.find({ where: { taskId, inScope: true } });
    const authorizedIps = authorized.filter((t) => !t.hostname).map((t) => t.ip);
    const authorizedHostnames = authorized.filter((t) => t.hostname).map((t) => t.hostname!.toLowerCase());
    const catalog = await this.skills.catalogToolNames();
    const allowed = await this.exploreAllowedTools();

    if (catalog.length === 0) {
      this.logger.warn(
        `任务 ${taskId} 的 MCP 工具目录为空：无法校验意图所需工具。请先在「MCP 管理」连接 blhackbox Gateway 并同步工具目录。`,
      );
    }
    const allIntents = await this.intentRepo.find({ where: { taskId } });
    const satisfied = new Set(
      allIntents.filter((i) => i.status === 'done' || i.status === 'dispatched').map((i) => i.id),
    );
    // 只把「已派发/已完成」的意图计入去重集合；
    // 待执行（proposed）的意图本身就在本次候选里，由 admitIntents 内部同批次去重处理，
    // 否则会把刚生成的意图全部误判为 duplicate。
    const existingKeys = new Set(
      allIntents
        .filter((i) => i.status === 'dispatched' || i.status === 'done')
        .map((i) => i.dedupeKey),
    );

    const admission = admitIntents(
      proposed.map((i) => ({
        id: i.id,
        title: i.title,
        objective: i.objective,
        dedupeKey: i.dedupeKey,
        targetIp: i.targetIp,
        suggestedTools: i.suggestedTools ?? [],
        dependencies: i.dependencies ?? [],
        status: i.status,
        prerequisites: i.prerequisites ?? [],
      })),
      {
        authorizedIps,
        authorizedCidrs: [...(task.scope?.cidrs ?? []), ...authorized.filter((t) => t.kind === 'cidr').map((t) => t.ip)],
        authorizedHostnames,
        existingDedupeKeys: existingKeys,
        satisfiedIntentIds: satisfied,
        allowedTools: allowed,
        catalogTools: new Set(catalog),
      },
    );

    for (const rejected of admission.rejected) {
      await this.intents.reject(rejected.intent.id, rejected.reason);
      this.logger.log(`意图被拒绝 [${rejected.reason}] ${rejected.intent.title}：${rejected.detail}`);
    }

    const schedulable: SchedulableIntent[] = [];
    for (const candidate of admission.accepted) {
      const entity = proposed.find((p) => p.id === candidate.id);
      if (!entity) continue;
      const executedSameTarget = allIntents.filter(
        (i) => i.targetIp === entity.targetIp && i.status !== 'proposed' && i.id !== entity.id,
      ).length;
      const relatedFacts = await this.factCountForTarget(taskId, entity.targetIp);
      const dependents = allIntents.filter((i) => (i.dependencies ?? []).includes(entity.id)).length;
      const linkedHypotheses = await this.hypotheses.findByTargets(taskId, 'intent', [entity.id]);
      const scored = scoreIntent(
        {
          title: entity.title,
          hypothesis: entity.hypothesis,
          targetIp: entity.targetIp,
          suggestedTools: entity.suggestedTools ?? [],
          priority: entity.priority,
        },
        {
          relatedFactCount: relatedFacts,
          hasEvidenceBackedFact: relatedFacts > 0,
          sameTargetExecutedCount: executedSameTarget,
          hypothesisConfidence: linkedHypotheses.length ? Math.max(...linkedHypotheses.map((h) => h.conflicted ? 0.3 : h.confidence)) : 0.3,
          estimatedCost: estimateCost((entity.suggestedTools ?? []).length, false),
          dependentsCount: dependents,
          highValueTarget: isHighValueTarget(
            `${entity.title} ${entity.objective} ${entity.targetIp ?? ''}`,
          ),
        },
      );
      schedulable.push({
        id: entity.id,
        title: entity.title,
        targetIp: entity.targetIp,
        suggestedTools: entity.suggestedTools ?? [],
        score: scored.score,
        breakdown: scored.breakdown,
        priority: entity.priority,
        createdAt: entity.createdAt.toISOString(),
        workerProfileId: entity.workerProfileId,
        dedupeKey: entity.dedupeKey,
      });
    }

    const perWorkerEstimate = Math.max(3000, Math.floor(task.tokenBudget * 0.08));
    const decision = planDispatch(schedulable, {
      maxConcurrency: task.workerCount,
      runningWorkers: ctx.activeWorkers.size,
      estimatedTokensPerWorker: perWorkerEstimate,
      tokensLeft: budget.tokensLeft,
    });

    let dispatched = 0;
    for (const item of decision.dispatch) if (await this.dispatchWorker(taskId, task, item, budget)) dispatched++;
    return dispatched;
  }

  private async dispatchWorker(
    taskId: string,
    task: TaskEntity,
    item: SchedulableIntent,
    budget: BudgetCheck,
  ): Promise<boolean> {
    if (!await this.orchestrator.executionAllowed(taskId)) return false;
    const ctx = this.orchestrator.getContext(taskId);
    if (!ctx) return false;
    const intent = await this.intentRepo.findOne({ where: { id: item.id } });
    if (!intent) return false;

    const profileId = intent.workerProfileId;
    const profile = getProfile(profileId);
    const previousAttempts = (await this.workers.listByTask(taskId)).filter((w) => w.intentId === intent.id);
    const attempt = previousAttempts.length ? Math.max(...previousAttempts.map((w) => w.attempt)) + 1 : 0;
    const maxAttempts = intent.maxAttempts || DEFAULT_WORKER_MAX_ATTEMPTS;
    if (attempt >= maxAttempts) { await this.intents.reject(intent.id, 'manual'); return false; }
    const allowance = workerTokenAllowance(budget, profile.tokenBudgetShare, task.tokenBudget);
    const reservation = await this.workers.reserve({
      taskId,
      intentId: intent.id,
      parentWorkerTaskId: null,
      title: intent.title,
      profileId,
      dedupeKey: intent.dedupeKey,
      timeoutSeconds: profile.timeoutSeconds || DEFAULT_WORKER_TIMEOUT_SECONDS,
      maxAttempts: intent.maxAttempts || DEFAULT_WORKER_MAX_ATTEMPTS,
      input: {
        intentId: intent.id,
        objective: intent.objective,
        targetIp: intent.targetIp,
        score: item.score,
        breakdown: item.breakdown,
      },
    }, item.score, item.breakdown as unknown as Record<string, number>);
    if (!reservation.worker) {
      if (reservation.reason === 'capacity') {
        ctx.capacityDeferred = true;
        await this.orchestrator.setStatus(taskId, 'planning', '等待 Worker 并发槽位');
      } else if (reservation.reason === 'attempt_limit') await this.intents.reject(intent.id, 'manual');
      return false;
    }
    const workerTask = reservation.worker;
    let handle;
    try {
    const targetIps = (await this.targets.find({ where: { taskId, inScope: true } })).map((t) => t.ip);
    if (!await this.orchestrator.executionAllowed(taskId)) {
      await this.workers.complete(workerTask.id, { status: 'cancelled', error: '任务控制已变化，未派发 Worker' });
      await this.intents.requeue(intent.id);
      return false;
    }
    handle = await this.workerRunner.launch({
      taskId,
      intent: this.intents.toDto(intent),
      targetIps,
      workerTaskId: workerTask.id,
      tokenAllowance: allowance,
      onFinished: (workerTaskId, sessionId) => {
        this.orchestrator.notifyWorkerFinished(taskId, workerTaskId, sessionId);
      },
    });
    if (!await this.orchestrator.executionAllowed(taskId)) {
      await this.runtime.sessions.terminate(handle.sessionId, '任务控制已变化，取消迟到的 Worker 启动');
      await this.workers.complete(workerTask.id, { status: 'cancelled', error: '任务控制已变化，Worker 启动已收尾' });
      await this.intents.requeue(intent.id);
      return false;
    }
    ctx.activeWorkers.set(workerTask.id, { sessionId: handle.sessionId, startedAt: Date.now() });
    this.logger.log(`派发 Worker：${intent.title}（profile=${item.workerProfileId}）`);
    return true;
    } catch (error) {
      if (handle) await this.runtime.sessions.terminate(handle.sessionId, 'Worker 启动失败').catch(() => undefined);
      await this.workers.complete(workerTask.id, { status: 'failed', error: 'Worker 启动失败，执行名额已释放' });
      await this.intents.requeue(intent.id);
      throw error;
    }

  }

  /* ==================== 辅助 ==================== */

  private async factCountForTarget(taskId: string, targetIp: string | null): Promise<number> {
    if (!targetIp) {
      const counts = await this.facts.counts(taskId);
      return counts.observed + counts.verified;
    }
    const list = await this.facts.listByTask(taskId, 200);
    return list.filter((f) => f.subject.includes(targetIp)).length;
  }

  private async exploreAllowedTools(): Promise<Set<string>> {
    return new Set(await this.skills.catalogToolNames());
  }

  get factStatusKeys(): FactStatus[] {
    return ['inferred', 'observed', 'verified', 'refuted'];
  }

  async toolCallSummary(taskId: string) {
    const rows = await this.toolCalls.find({ where: { taskId }, take: 200 });
    return {
      total: rows.length,
      success: rows.filter((r) => r.status === 'success').length,
      error: rows.filter((r) => r.status === 'error').length,
      denied: rows.filter((r) => r.status === 'denied').length,
    };
  }
}
