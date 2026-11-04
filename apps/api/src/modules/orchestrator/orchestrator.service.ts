import { recordKnowledgeProgress } from '../blackboard/knowledge-progress';
import { reconcileTerminalVerifications } from '../blackboard/verification-terminal';
import { serialSave, serialTransaction } from '../../database/serial-transaction';
import { ConflictException, Injectable, Logger, NotFoundException, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import type {
  AgentRole,
  EngineSnapshot,
  EngineStatus,
  FactStatus,
  OrchestratorStatus,
  StopReason,
} from '@vulnagent/shared';
import {
  DEFAULT_MAX_CYCLES,
  DEFAULT_NO_PROGRESS_ROUNDS,
  DEFAULT_WORKER_MAX_ATTEMPTS,
  DEFAULT_WORKER_TIMEOUT_SECONDS,
  WORKER_LEASE_SCAN_INTERVAL_MS,
} from '@vulnagent/shared';
import {
  IntentEntity,
  OrchestratorRunEntity,
  TargetEntity,
  TaskEntity,
  TaskStateEventEntity,
  ToolCallEntity,
  HintEntity,
  AuditLogEntity,
  WorkerTaskEntity,
} from '../../database/entities';
import { newId } from '../../common/utils/id';
import { AuditService } from '../audit/audit.service';
import { EventsGateway } from '../events/events.gateway';
import { PiRuntimeService } from '../pi-runtime/pi-runtime.service';
import { FactsService } from '../blackboard/facts.service';
import { HintsService } from '../blackboard/hints.service';
import { IntentsService } from '../blackboard/intents.service';
import { WorkerStateService } from '../blackboard/worker-state.service';
import { WorkerSkillsService } from '../worker-skills/worker-skills.service';
import { getProfile } from '../worker-skills/profiles';
import { checkBudget, workerTokenAllowance, type BudgetCheck } from './budget-guard';
import { admitIntents } from './intent-admission';
import { goalStatusToOrchestrator, isTerminal, shouldMarkStalled } from './orchestrator-state-machine';
import { scoreIntent, isHighValueTarget, estimateCost } from './exploration-score';
import { planDispatch, decideRetry, type SchedulableIntent } from './worker-scheduler';
import { PlannerRunnerService } from './planner-runner.service';
import { WorkerRunnerService } from './worker-runner.service';
import type { OrchestratorContext } from './orchestrator-context';
import { parsePlannerResult } from './result-parser';
import { EvidenceIngestionService } from '../blackboard/evidence-ingestion.service';
import { trackTaskActivity } from '../../database/task-activity';
import { hydrateTaskAccounting } from '../../database/model-accounting';
import { requireRuntime, runtimeEnabled, workerConcurrency } from '../../database/runtime-control';
import { AsyncLocalStorage } from 'node:async_hooks';

interface ExecutionFence { context: OrchestratorContext | undefined; revision: number }

const EMPTY_FACT_COUNTS: Record<FactStatus, number> = {
  inferred: 0,
  observed: 0,
  verified: 0,
  refuted: 0,
};

/**
 * Orchestrator Core：确定性编排。
 * Planner 只提出意图，这里决定是否允许执行、派发给谁、什么时候回收。
 */
@Injectable()
export class OrchestratorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly contexts = new Map<string, OrchestratorContext>();
  private leaseTimer: NodeJS.Timeout | null = null;
  private consumerTimer: NodeJS.Timeout | null = null;
  private booted = false;
  private consumingEvents = false;
  private controlQueues = new Map<string, Promise<unknown>>();
  private executionScope = new AsyncLocalStorage<ExecutionFence>();
  private callbackTimers = new Set<NodeJS.Timeout>();

  private captureExecution(taskId: string): ExecutionFence {
    const scope = this.executionScope.getStore();
    if (scope?.context?.taskId === taskId) return scope;
    const context = this.contexts.get(taskId);
    return { context, revision: context?.controlRevision ?? 0 };
  }

  private executionCurrent(task: TaskEntity, fence: ExecutionFence): boolean {
    const ctx = this.contexts.get(task.id);
    return task.status === 'running' && task.engineStatus === 'running' && ctx === fence.context
      && (ctx?.controlRevision ?? 0) === fence.revision
      && (!ctx || !['paused', 'stopping', 'stopped', 'completed', 'failed'].includes(ctx.status));
  }

  private scheduleCycle(taskId: string, expected = this.contexts.get(taskId)): void {
    if (!expected) return;
    // 同一上下文只允许一个在途循环：重入会把 Planner 并发打乱并让周期计数失真。
    // 若已有循环在跑，标记为"结束后再跑一轮"由 finally 调度。
    if (expected.cycleScheduled) { expected.cyclePending = true; return; }
    expected.cycleScheduled = true;
    void this.runCycle(taskId, expected)
      .catch((error) => this.logger.error(`编排状态未能提交：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        expected.cycleScheduled = false;
        if (expected.cyclePending && this.contexts.get(taskId) === expected && ['planning', 'executing'].includes(expected.status)) {
          expected.cyclePending = false;
          this.scheduleCycle(taskId, expected);
        }
      });
  }

  private async control<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.controlQueues.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.controlQueues.set(taskId, next);
    try { return await next; }
    finally { if (this.controlQueues.get(taskId) === next) this.controlQueues.delete(taskId); }
  }

  private publishControlAudit(row: AuditLogEntity): void {
    this.audit.publish(this.audit.toDto(row));
  }

  /**
   * 启动对账：清理遗留 running 状态，保证重启后不会永久卡住。
   * 对账完成后才允许消费持久化事件，避免新启动的会话又被当作遗留会话回收。
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.booted) return;
    const result = await this.reconcileOnBoot();
    for (const task of await this.tasks.find({ where: { status: In(['stopped', 'failed', 'completed']) }, select: ['id'] })) {
      await reconcileTerminalVerifications(this.tasks.manager, task.id);
    }
    this.logger.log(`编排对账完成：清理遗留 Worker ${result.workers} 个，遗留会话 ${result.sessions} 个`);
    this.booted = true;
  }

  constructor(
    @InjectRepository(TaskEntity) private readonly tasks: Repository<TaskEntity>,
    @InjectRepository(TargetEntity) private readonly targets: Repository<TargetEntity>,
    @InjectRepository(IntentEntity) private readonly intentRepo: Repository<IntentEntity>,
    @InjectRepository(OrchestratorRunEntity) private readonly runs: Repository<OrchestratorRunEntity>,
    @InjectRepository(TaskStateEventEntity)
    private readonly stateEvents: Repository<TaskStateEventEntity>,
    private readonly runtime: PiRuntimeService,
    private readonly facts: FactsService,
    private readonly intents: IntentsService,
    private readonly hints: HintsService,
    private readonly workers: WorkerStateService,
    private readonly skills: WorkerSkillsService,
    private readonly planner: PlannerRunnerService,
    private readonly workerRunner: WorkerRunnerService,
    private readonly gateway: EventsGateway,
    private readonly audit: AuditService,
    private readonly ingestion: EvidenceIngestionService,
  ) {
    this.leaseTimer = setInterval(() => void this.reapExpiredWorkers().catch((error) => this.logger.error(`Worker 对账失败：${String(error)}`)), WORKER_LEASE_SCAN_INTERVAL_MS);
    this.consumerTimer = setInterval(() => void this.consumeTaskStateEvents().catch((error) =>
      this.logger.error(`任务事件消费失败：${error instanceof Error ? error.message : String(error)}`)), 1500);
    this.leaseTimer.unref?.();
    this.consumerTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.consumerTimer) clearInterval(this.consumerTimer);
    for (const timer of this.callbackTimers) clearTimeout(timer);
    this.callbackTimers.clear();
  }

  /* ==================== 生命周期 ==================== */

  async start(taskId: string): Promise<EngineSnapshot> {
    return this.control(taskId, () => this.startUnlocked(taskId));
  }

  private async startUnlocked(taskId: string, recovering = false): Promise<EngineSnapshot> {
    await requireRuntime(this.tasks.manager);
    if (await this.stateEvents.count({ where: { taskId, eventType: 'runtime.disabled', consumedAt: IsNull() } })) throw new ConflictException('关闭引擎的暂停操作仍在收尾，请稍后手动启动');
    const task = await this.findTask(taskId);
    if (['stopped', 'completed', 'failed'].includes(task.status)) throw new ConflictException('终态任务请先重新运行，不能直接启动或恢复');
    const existing = this.contexts.get(taskId);
    if (existing && task.status === 'running' && task.engineStatus === 'running' && ['planning', 'executing'].includes(existing.status)) return this.snapshot(taskId);
    const eligible = (task.status === 'pending' || task.status === 'running') && task.engineStatus === 'idle';
    if (!eligible && !(recovering && (task.status === 'paused' || ['paused', 'needs_input', 'stalled'].includes(task.engineStatus)))) throw new ConflictException('当前任务不能启动；暂停或等待输入的任务请恢复');
    if (existing && task.status !== 'pending' && !isTerminal(existing.status)) {
      throw new ConflictException('任务已有执行上下文，请使用恢复或等待当前控制操作完成');
    }

    const knowledgeSeen = new Set(await this.facts.progressKeys(taskId));
    const evidenceBaseline = knowledgeSeen.size;
    const startedAt = recovering ? task.startedAt ?? new Date() : new Date();

    const committed = await serialTransaction(this.tasks.manager, async (manager) => {
      await requireRuntime(manager);
      const fresh = await manager.findOneByOrFail(TaskEntity, { id: taskId });
      if (fresh.status !== task.status || fresh.engineStatus !== task.engineStatus) throw new ConflictException('任务状态已变化，请重新确认启动操作');
      const run = await manager.save(manager.create(OrchestratorRunEntity, {
        id: newId(),
        taskId,
        status: 'planning',
        cycleCount: 0,
        activeWorkers: 0,
        noProgressRounds: 0,
        runKey: `run-${taskId}-${Date.now()}`,
        stopReason: null,
        plannerSessionId: null,
        lastError: null,
        startedAt: new Date(),
        finishedAt: null,
      }));
      await manager.update(TaskEntity, taskId, { engineStatus: 'running', stopReason: null, status: 'running', startedAt, finishedAt: null, lastError: null });
      const audit = await manager.save(manager.create(AuditLogEntity, { id: newId(), actor: 'local-operator', action: 'engine.start', entityType: 'task', entityId: taskId, taskId, detail: { maxConcurrency: task.workerCount, runId: run.id } }));
      return { run, audit };
    });
    const run = committed.run;
    this.publishControlAudit(committed.audit);

    const ctx: OrchestratorContext = {
      taskId,
      runId: run.id,
      status: 'planning',
      cycle: 0,
      noProgressRounds: 0,
      stopReason: null,
      plannerSessionId: null,
      startedAt,
      finishedAt: null,
      lastError: null,
      activeWorkers: new Map(),
      plannerBusy: false,
      cycleScheduled: false,
      cyclePending: false,
      plannerRetries: 0,
      cycleGainedEvidence: false,
      evidenceBaseline,
      knowledgeSeen,
      lastPlannerText: '',
    };
    this.contexts.set(taskId, ctx);

    this.scheduleCycle(taskId, ctx);
    return this.snapshot(taskId);
  }

  async pause(taskId: string): Promise<EngineSnapshot> {
    return this.control(taskId, () => this.pauseUnlocked(taskId));
  }

  private async pauseUnlocked(taskId: string): Promise<EngineSnapshot> {
    const ctx = this.contexts.get(taskId);
    const changed = await serialTransaction(this.tasks.manager, async (manager) => {
      const task = await manager.findOneBy(TaskEntity, { id: taskId });
      if (!task) throw new NotFoundException('任务不存在');
      if (['stopped', 'completed', 'failed'].includes(task.status)) return false; // An obsolete queued pause cannot resurrect a terminal task.
      if (!['running', 'paused'].includes(task.status)) throw new ConflictException('当前任务不能暂停');
      if (task.status === 'paused' && task.engineStatus === 'paused' && ctx?.status === 'paused') return false;
      await manager.update(TaskEntity, taskId, { engineStatus: 'paused', status: 'paused' });
      if (ctx) await manager.update(OrchestratorRunEntity, ctx.runId, { status: 'paused', finishedAt: null });
      return manager.save(manager.create(AuditLogEntity, { id: newId(), actor: 'local-operator', action: 'engine.pause', entityType: 'task', entityId: taskId, taskId }));
    });
    if (!changed) return this.snapshot(taskId);
    this.publishControlAudit(changed);

    if (ctx) {
      ctx.controlRevision = (ctx.controlRevision ?? 0) + 1;
      ctx.status = 'paused';
      for (const [, worker] of ctx.activeWorkers) {
        await this.runtime.sessions.pause(worker.sessionId).catch(() => undefined);
      }
      if (ctx.plannerSessionId) {
        await this.runtime.sessions.pause(ctx.plannerSessionId).catch(() => undefined);
      }
    }
    this.broadcastSnapshot(taskId);
    return this.snapshot(taskId);
  }

  async resume(taskId: string): Promise<EngineSnapshot> {
    return this.control(taskId, () => this.resumeUnlocked(taskId));
  }

  private async resumeUnlocked(taskId: string): Promise<EngineSnapshot> {
    await requireRuntime(this.tasks.manager);
    if (await this.stateEvents.count({ where: { taskId, eventType: 'runtime.disabled', consumedAt: IsNull() } })) throw new ConflictException('关闭引擎的暂停操作仍在收尾，请稍后手动恢复');
    const ctx = this.contexts.get(taskId);
    const task = await this.findTask(taskId);
    if (['stopped', 'completed', 'failed'].includes(task.status) || (ctx && isTerminal(ctx.status))) throw new ConflictException('终态任务请先重新运行，不能直接恢复');
    if (ctx && task.status === 'running' && task.engineStatus === 'running' && ['planning', 'executing'].includes(ctx.status)) return this.snapshot(taskId);
    if (task.status !== 'paused' && !['paused', 'needs_input', 'stalled'].includes(task.engineStatus)) throw new ConflictException('当前任务不能恢复');
    if (!ctx) return this.startUnlocked(taskId, true);
    // 任务已被其它路径置为 running（例如生命周期接口直接改写状态），但上下文仍是 paused：
    // 这里要把内存上下文拉回执行态，否则恢复后循环会立即以为"已暂停"而退出，任务永远不推进。
    if (task.status === 'running' && task.engineStatus === 'running' && ctx.status === 'paused') {
      ctx.controlRevision = (ctx.controlRevision ?? 0) + 1;
      ctx.status = 'planning';
      ctx.stopReason = null;
      ctx.finishedAt = null;
      ctx.lastError = null;
      ctx.noProgressRounds = 0;
      this.scheduleCycle(taskId, ctx);
      this.broadcastSnapshot(taskId);
      return this.snapshot(taskId);
    }

    const origin = { status: task.status, engineStatus: task.engineStatus, lastError: task.lastError };
    const committed = await serialTransaction(this.tasks.manager, async (manager) => {
      await requireRuntime(manager);
      const fresh = await manager.findOneByOrFail(TaskEntity, { id: taskId });
      if (fresh.status !== origin.status || fresh.engineStatus !== origin.engineStatus || fresh.lastError !== origin.lastError) throw new ConflictException('任务状态已变化，请重新确认恢复操作');
      await manager.update(TaskEntity, taskId, { engineStatus: 'running', status: 'running', stopReason: null, finishedAt: null, lastError: null });
      await manager.update(OrchestratorRunEntity, ctx.runId, { status: 'planning', stopReason: null, finishedAt: null, lastError: null });
      return manager.save(manager.create(AuditLogEntity, { id: newId(), actor: 'local-operator', action: 'engine.resume', entityType: 'task', entityId: taskId, taskId }));
    });
    this.publishControlAudit(committed);
    ctx.controlRevision = (ctx.controlRevision ?? 0) + 1;
    ctx.status = 'planning';
    ctx.stopReason = null;
    ctx.finishedAt = null;
    ctx.lastError = null;
    ctx.noProgressRounds = 0;

    for (const [, worker] of ctx.activeWorkers) {
      await this.runtime.sessions.resume(worker.sessionId).catch(() => undefined);
    }
    if (ctx.plannerSessionId) {
      await this.runtime.sessions.resume(ctx.plannerSessionId).catch(() => undefined);
    }
    this.scheduleCycle(taskId, ctx);
    return this.snapshot(taskId);
  }

  async stop(taskId: string, reason: StopReason = 'user_stopped'): Promise<EngineSnapshot> {
    return this.control(taskId, () => this.stopUnlocked(taskId, reason));
  }

  private async stopUnlocked(taskId: string, reason: StopReason, completion?: { fence: ExecutionFence; detail: string }): Promise<EngineSnapshot> {
    const ctx = this.contexts.get(taskId);
    const finishedAt = new Date();
    const state = reason === 'goal_reached' ? 'completed' : 'stopped';
    const changed = await serialTransaction(this.tasks.manager, async (manager) => {
      const task = await manager.findOneBy(TaskEntity, { id: taskId });
      if (!task) throw new NotFoundException('任务不存在');
      if (completion && !this.executionCurrent(task, completion.fence)) return false;
      if (['completed', 'failed'].includes(task.status) || (task.status === 'stopped' && task.engineStatus === 'stopped')) return false;
      await manager.update(TaskEntity, taskId, { engineStatus: state, status: state, stopReason: reason, finishedAt });
      if (ctx) await manager.update(OrchestratorRunEntity, ctx.runId, { status: state, stopReason: reason, finishedAt, activeWorkers: 0, cycleCount: ctx.cycle, noProgressRounds: ctx.noProgressRounds, lastError: ctx.lastError });
      if (completion) await manager.insert(AuditLogEntity, { id: newId(), actor: 'system', action: 'engine.finished', entityType: 'task', entityId: taskId, taskId, detail: { reason, detail: completion.detail } });
      return manager.save(manager.create(AuditLogEntity, { id: newId(), actor: 'local-operator', action: 'engine.stop', entityType: 'task', entityId: taskId, taskId, detail: { reason } }));
    });
    if (!changed) return this.snapshot(taskId);
    this.publishControlAudit(changed);

    if (ctx) {
      ctx.controlRevision = (ctx.controlRevision ?? 0) + 1;
      ctx.status = 'stopping';
      // 先把状态落库并返回，再在后台终止 Session。
      // Agent.abort() + waitForIdle() 可能需要数秒，同步等待会让 stop 接口超时。
      const workers = Array.from(ctx.activeWorkers.entries());
      const plannerId = ctx.plannerSessionId;
      ctx.activeWorkers.clear();
      ctx.status = reason === 'goal_reached' ? 'completed' : 'stopped';
      ctx.stopReason = reason;
      ctx.finishedAt = finishedAt;

      void Promise.all([
        ...workers.map(async ([workerTaskId, worker]) => {
          await this.runtime.sessions.terminate(worker.sessionId, '引擎停止').catch(() => undefined);
          await this.workers
            .complete(workerTaskId, { status: 'cancelled', error: '引擎已停止' })
            .catch(() => undefined);
        }),
        plannerId
          ? this.runtime.sessions.terminate(plannerId, '引擎停止').catch(() => undefined)
          : Promise.resolve(),
      ]).then(() => reconcileTerminalVerifications(this.tasks.manager, taskId))
        .catch((error) => this.logger.error(`验证收尾失败：${String(error)}`));
    } else {
      await reconcileTerminalVerifications(this.tasks.manager, taskId);
    }

    this.broadcastSnapshot(taskId);
    return this.snapshot(taskId);
  }

  async snapshot(taskId: string): Promise<EngineSnapshot> {
    const task = await this.findTask(taskId);
    const ctx = task.status === 'pending' ? undefined : this.contexts.get(taskId);
    const [factCounts, intentCounts, workers] = await Promise.all([
      this.facts.counts(taskId),
      this.intents.counts(taskId),
      this.workers.listByTask(taskId),
    ]);

    const startedAt = ctx?.startedAt ?? task.startedAt;
    const elapsedSeconds = startedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
      : 0;
    const status: OrchestratorStatus = task.status === 'pending' ? 'idle'
      : ['paused', 'stopped', 'completed', 'failed'].includes(task.status) ? task.status as OrchestratorStatus
      : ['needs_input', 'stalled'].includes(task.engineStatus) ? task.engineStatus as OrchestratorStatus
      : ctx?.status ?? 'idle';
    const engineStatus: EngineStatus = task.engineStatus;

    return {
      taskId,
      globalWorkerLimit: await workerConcurrency(this.tasks.manager),
      globalWorkersActive: await this.tasks.manager.count(WorkerTaskEntity, { where: { status: In(['queued', 'running']) } }),
      waitingForWorkerCapacity: Boolean(task.status === 'running' && task.engineStatus === 'running' && ctx?.capacityDeferred),
      engineStatus,
      orchestratorStatus: status,
      stopReason: task.stopReason ?? ctx?.stopReason ?? null,
      cycle: ctx?.cycle ?? 0,
      activeWorkers: workers.filter((w) => w.status === 'running').length,
      totalWorkers: workers.length,
      maxConcurrency: task.workerCount,
      tokensUsed: task.tokensUsed,
      tokenBudget: task.tokenBudget,
      elapsedSeconds,
      timeBudgetSeconds: task.timeBudgetMinutes * 60,
      factCounts: { ...EMPTY_FACT_COUNTS, ...factCounts },
      intentCounts,
      plannerSessionId: ctx?.plannerSessionId ?? null,
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      finishedAt: task.finishedAt ? new Date(task.finishedAt).toISOString() : ctx?.finishedAt?.toISOString() ?? null,
      lastError: task.lastError ?? ctx?.lastError ?? null,
    };
  }

  getContext(taskId: string): OrchestratorContext | undefined {
    return this.contexts.get(taskId);
  }

  /** 供循环体在可恢复失败（如上游 5xx）后请求下一轮，复用同一上下文与并发保护。 */
  requestCycle(taskId: string, ctx: OrchestratorContext): void {
    if (this.contexts.get(taskId) !== ctx) return;
    if (!['planning', 'executing'].includes(ctx.status)) return;
    this.scheduleCycle(taskId, ctx);
  }

  /* ==================== 核心循环（见 orchestrator.cycle.ts） ==================== */

  async runCycle(taskId: string, expected?: OrchestratorContext): Promise<void> {
    const ctx = this.contexts.get(taskId);
    if (!ctx || (expected && ctx !== expected)) return;
    const revision = ctx.controlRevision ?? 0;
    if (ctx.status === 'paused' || isTerminal(ctx.status)) return;
    if (ctx.status === 'stopping') return;
    const persisted = await this.tasks.findOneBy({ id: taskId });
    if (this.contexts.get(taskId) !== ctx || (ctx.controlRevision ?? 0) !== revision) return;
    if (!persisted || ['stopped', 'completed', 'failed'].includes(persisted.status)) return;
    if (persisted.status === 'paused' || !await runtimeEnabled(this.tasks.manager)) { await this.pause(taskId); return; }
    if (ctx.plannerBusy) {
      this.logger.debug(`任务 ${taskId} Planner 正在运行，跳过本轮`);
      return;
    }
    ctx.plannerBusy = true;
    try {
      await this.executionScope.run({ context: ctx, revision }, async () => {
        try { await trackTaskActivity(this.tasks.manager, taskId, () => this.cycleBody(taskId, ctx)); }
        catch (error) { await this.failTask(taskId, error); }
      });
    } finally {
      ctx.plannerBusy = false;
      if (this.contexts.get(taskId) === ctx && (ctx.controlRevision ?? 0) !== revision && ['planning', 'executing'].includes(ctx.status)) this.scheduleCycle(taskId, ctx);
    }
  }

  /** 循环主体由 cycle-mixin 提供，保持单文件聚焦生命周期与状态 */
  private cycleBody: (taskId: string, ctx: OrchestratorContext) => Promise<void> = async () => undefined;

  registerCycleBody(fn: (taskId: string, ctx: OrchestratorContext) => Promise<void>): void {
    this.cycleBody = fn;
  }

  /* ==================== 内部工具 ==================== */

  notifyWorkerFinished(taskId: string, workerTaskId: string, sessionId: string): void {
    const context = this.contexts.get(taskId);
    if (!context) return;
    const deliver = (attempt: number) => {
      if (this.contexts.get(taskId) !== context || context.activeWorkers.get(workerTaskId)?.sessionId !== sessionId) return;
      void this.onWorkerFinished(taskId, workerTaskId, sessionId).catch((error) => {
        if (attempt < 3) {
          const timer = setTimeout(() => { this.callbackTimers.delete(timer); deliver(attempt + 1); }, 1000);
          this.callbackTimers.add(timer); timer.unref?.();
        } else {
          this.logger.error(`Worker 收尾通知失败：${error instanceof Error ? error.message : String(error)}`);
          void this.executionScope.run({ context, revision: context.controlRevision ?? 0 }, () => this.failTask(taskId, new Error('Worker 收尾通知连续失败，请核实数据库状态后恢复')))
            .catch((failure) => this.logger.error(`Worker 失败状态未能提交：${String(failure)}`));
        }
      });
    };
    deliver(0);
  }

  async onWorkerFinished(taskId: string, workerTaskId: string, sessionId: string): Promise<void> {
    await this.control(taskId, async () => {
      const ctx = this.contexts.get(taskId);
      if (!ctx || ctx.activeWorkers.get(workerTaskId)?.sessionId !== sessionId) return;
      const remainingWorkers = ctx.activeWorkers.size - 1;
      const knowledge = await this.facts.progressKeys(taskId);
      const changed = await serialTransaction(this.tasks.manager, async (manager) => {
        const task = await manager.findOneBy(TaskEntity, { id: taskId });
        if (!task || task.status !== 'running' || task.engineStatus !== 'running' || this.contexts.get(taskId) !== ctx) return false;
        await hydrateTaskAccounting(manager, task);
        await manager.update(TaskEntity, taskId, {
          currentPhase: `第 ${ctx.cycle} 轮 · 活跃 Worker ${remainingWorkers}`,
          progress: Math.min(95, Math.round((task.tokensUsed / Math.max(1, task.tokenBudget)) * 60 + ctx.cycle * 3)),
        });
        return true;
      });
      ctx.activeWorkers.delete(workerTaskId);
      if (!changed) return;
      ctx.planRevision = (ctx.planRevision ?? 0) + 1;
      const seen = ctx.knowledgeSeen ?? new Set<string>();
      const delta = recordKnowledgeProgress(seen, knowledge);
      ctx.knowledgeSeen = seen;
      ctx.evidenceBaseline = seen.size;
      if (delta > 0) { ctx.noProgressRounds = 0; ctx.cycleGainedEvidence = true; }
      else { ctx.noProgressRounds += 1; ctx.cycleGainedEvidence = false; }
      this.broadcastSnapshot(taskId);
      if (ctx.status === 'paused' || isTerminal(ctx.status)) return;
      const timer = setTimeout(() => {
        this.callbackTimers.delete(timer);
        if (this.contexts.get(taskId) !== ctx || ctx.plannerBusy) return;
        this.scheduleCycle(taskId, ctx);
      }, 600);
      this.callbackTimers.add(timer); timer.unref?.();
    });
  }

  /**
   * 超时回收。**必须扫描数据库而不是内存 contexts**：
   * 进程重启后 contexts 为空，旧实现会让 worker_tasks 永久停留在 running。
   */
  async reapExpiredWorkers(): Promise<void> {
    const expired = await this.workers.findAllExpired();
    for (const worker of expired) {
      this.logger.warn(
        `Worker 超时回收：${worker.title}（attempt ${worker.attempt}/${worker.maxAttempts}）`,
      );
      const ctx = this.contexts.get(worker.taskId);
      if (worker.sessionId) {
        await this.runtime.sessions.terminate(worker.sessionId, '超时').catch(() => undefined);
        ctx?.activeWorkers.delete(worker.id);
      }
      await this.workers.markTimeout(worker.id);

      const nextAttempt = worker.attempt + 1;
      const retry = decideRetry(nextAttempt, worker.maxAttempts);
      if (retry === 'retry' && worker.intentId) {
        await this.intents.requeue(worker.intentId);
        // Dispatch creates the next Worker. Creating a queued row here leaves an orphan
        // and used to reset the actual dispatched Worker's attempt back to zero.
      } else if (worker.intentId) {
        // 达到最大尝试次数：明确失败，不留下僵尸意图
        await this.intents.reject(worker.intentId, 'manual');
      }
      this.broadcastSnapshot(worker.taskId);
      if (ctx && !['paused', 'stopped', 'stopping', 'completed', 'failed'].includes(ctx.status)) this.scheduleCycle(worker.taskId, ctx);
    }
    for (const [taskId, ctx] of this.contexts) {
      if (ctx.capacityDeferred && ['planning', 'executing'].includes(ctx.status)) this.scheduleCycle(taskId, ctx);
    }
  }

  /**
   * 启动对账：
   * 1. 把进程重启前遗留的 running Worker 标记为 timeout 并释放意图
   * 2. 把与数据库状态不一致的内存上下文清理掉
   * 3. 对仍有活跃 Worker 的任务重新挂载调度（继续推进）
   */
  async reconcileOnBoot(): Promise<{ workers: number; sessions: number }> {
    const sessions = await this.runtime.sessions.reconcile();
    const orphans = await this.workers.findRunningAll();

    for (const worker of orphans) {
      this.logger.warn(`对账：Worker "${worker.title}" 遗留 ${worker.status}，标记为 timeout`);
      await this.workers.complete(worker.id, {
        status: 'timeout',
        error: '进程重启，Worker 执行中断',
      });
      if (worker.intentId) {
        const intent = await this.intents.findById(worker.intentId);
        if (intent && intent.status === 'dispatched') {
          await this.intents.requeue(worker.intentId);
        }
      }
    }

    // In-memory contexts do not survive a process restart. Preserve evidence/accounting, but never
    // display an orphaned task as executing or automatically replay its old resume/rerun requests.
    await serialTransaction(this.tasks.manager, async (manager) => {
      const interrupted = await manager.find(TaskEntity, { where: { status: 'running', engineStatus: 'running' } });
      for (const task of interrupted) {
        const now = new Date();
        await manager.update(TaskEntity, { id: task.id }, { status: 'paused', engineStatus: 'needs_input', stopReason: 'needs_input',
          currentPhase: '进程中断，等待人工恢复', lastError: '进程重启，执行上下文已丢失；请核实远端工具状态和未确认用量后再恢复' });
        const cancelled = await manager.update(TaskStateEventEntity, { taskId: task.id, consumedAt: IsNull(), eventType: In(['task.start_requested', 'task.resume', 'task.resumed', 'task.rerun']) }, { consumedAt: now });
        await manager.update(OrchestratorRunEntity, { taskId: task.id, finishedAt: IsNull() }, { status: 'paused', stopReason: 'needs_input', finishedAt: now, lastError: '进程中断，需要人工恢复' });
        await manager.insert(AuditLogEntity, { id: newId(), taskId: task.id, actor: 'system', action: 'engine.recovered', entityType: 'task', entityId: task.id,
          detail: { reason: 'process_restart', invalidatedControlRequests: cancelled.affected ?? 0 }, result: 'success' });
      }
    });

    // 清理内存中已失效的任务上下文（进程重启后 Map 本就是空的，这里防御未来热更新场景）
    for (const [taskId, ctx] of this.contexts) {
      if (isTerminal(ctx.status)) this.contexts.delete(taskId);
    }

    return { workers: orphans.length, sessions };
  }

  private async consumeTaskStateEvents(): Promise<void> {
    if (!this.booted || this.consumingEvents) return;
    this.consumingEvents = true;
    try {
      for (const id of this.contexts.keys()) {
        if (!await this.tasks.existsBy({ id })) this.contexts.delete(id);
      }
      // 每个任务只取最早的一条未消费事件：某任务的失败事件会留在队首重试，
      // 不能因此饿死其他任务在同一批次里的启动/停止请求。
      const pending = await this.stateEvents
        .createQueryBuilder('e')
        .select('e.taskId', 'taskId')
        .where('e.consumedAt IS NULL')
        .groupBy('e.taskId')
        .getRawMany<{ taskId: string }>();
      if (pending.length === 0) return;
      const events: TaskStateEventEntity[] = [];
      for (const { taskId } of pending) {
        const head = await this.stateEvents.findOne({ where: { taskId, consumedAt: IsNull() }, order: { createdAt: 'ASC' } });
        if (head) events.push(head);
      }

      // 不同任务并行消费；同一任务内仍按 createdAt 顺序、逐条提交。
      await Promise.all(events.map((event) => this.consumeEvent(event)));
    } finally { this.consumingEvents = false; }
  }

  private async consumeEvent(event: TaskStateEventEntity): Promise<void> {
    const current = await this.stateEvents.findOneBy({ id: event.id });
    if (!current || current.consumedAt) return;
    try {
      if (event.eventType === 'runtime.disabled') await this.pause(event.taskId);
      else if (['task.start_requested', 'task.resume', 'task.resumed'].includes(event.eventType) && !await runtimeEnabled(this.tasks.manager)) await this.pause(event.taskId);
      else if (event.eventType === 'task.start_requested') {
        const task = await this.findTask(event.taskId);
        // 待启动、以及进程中断后留下的 needs_input/stalled 排队请求都应真正启动。
        if (task.status === 'running' && ['idle', 'needs_input', 'stalled'].includes(task.engineStatus)) await this.start(event.taskId);
      }
      else if (['task.pause', 'task.paused'].includes(event.eventType)) await this.pause(event.taskId);
      else if (['task.resume', 'task.resumed'].includes(event.eventType)) {
        const task = await this.findTask(event.taskId);
        if (!['pending', 'stopped', 'completed', 'failed'].includes(task.status)) await this.resume(event.taskId);
      }
      else if (['task.stop', 'task.stopped'].includes(event.eventType)) await this.stop(event.taskId, 'user_stopped');
      else if (event.eventType === 'task.rerun') {
        // 启动接口可能已经创建新一轮上下文；晚消费的旧重跑事件不能删掉它。
        const ctx = this.contexts.get(event.taskId);
        const retired = event.payload && 'retiredRunId' in event.payload;
        if (ctx && (retired ? ctx.runId === event.payload?.retiredRunId : !ctx.startedAt || ctx.startedAt.getTime() < event.createdAt.getTime())) this.contexts.delete(event.taskId);
      }
      else if (event.eventType === 'tool.approval_resolved') await this.applyApprovalOutcome(event);
      else if (event.eventType === 'model.budget_blocked') {
        const task = await this.findTask(event.taskId);
        if (task.status === 'running') await this.stopWithReason(event.taskId, event.payload?.stopReason === 'budget_time' ? 'budget_time' : 'budget_tokens', String(event.payload?.reason ?? '模型请求无法在剩余额度内执行'));
      }
      else if (event.eventType === 'finding.verification_requested') {
        const task = await this.findTask(event.taskId);
        if (task.status === 'running' && ['needs_input', 'stalled'].includes(task.engineStatus)) await this.resume(event.taskId);
        else if (task.engineStatus === 'running' && this.contexts.has(event.taskId)) this.scheduleCycle(event.taskId);
      }
    } catch (error) {
      // 失败保留未消费事件，下一轮重试；不再次执行远程工具。
      this.logger.warn(
        `处理任务事件 ${event.eventType} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    event.consumedAt = new Date();
    await serialSave(this.stateEvents, event);
  }

  private async applyApprovalOutcome(event: TaskStateEventEntity): Promise<void> {
    const manager = this.stateEvents.manager;
    const call = await manager.findOne(ToolCallEntity, { where: { id: event.id, taskId: event.taskId } });
    if (!call || call.status === 'pending_approval') throw new Error('审批结果尚未落库');
    if (call.status === 'success' && call.rawOutputRef) await this.ingestion.ingest(event.taskId, [call.rawOutputRef]);
    // 确定性 ID 使重试不会重复创建提示；失败和拒绝也进入后续规划上下文。
    if (!await manager.findOne(HintEntity, { where: { id: event.id } })) {
      await manager.insert(HintEntity, {
        id: event.id, taskId: event.taskId, agentSessionId: null, appliedToSessionId: null,
        status: 'pending', consumedAt: null,
        content: `审批结果 ${call.toolName} [${call.status}]，调用 ${call.id}。${call.rawOutputRef ? `证据 ${call.rawOutputRef}。` : ''}${call.errorMessage ?? call.decisionReason ?? ''} 请依据真实结果更新规划；拒绝、过期或执行错误不能作为目标不存在的证据。`,
      });
    }
    const task = await this.findTask(event.taskId);
    // 未知结果的人工收尾只通知规划，不自动恢复用户暂停/等待的任务。
    if (event.payload?.requiresReview === true) {
      this.broadcastSnapshot(event.taskId);
      return;
    }
    const pending = await manager.count(ToolCallEntity, { where: { taskId: event.taskId, status: 'pending_approval' } });
    if (pending > 0) return;
    if (task.engineStatus === 'needs_input' && task.status === 'running') {
      await this.resume(event.taskId);
    } else if (task.engineStatus === 'running' && this.contexts.has(event.taskId)) {
      this.scheduleCycle(event.taskId);
    }
    this.broadcastSnapshot(event.taskId);
  }

  async stopWithReason(taskId: string, reason: StopReason, detail: string): Promise<void> {
    const fence = this.captureExecution(taskId);
    if (reason === 'needs_input') return this.automaticTransition(taskId, 'needs_input', reason, detail, 'engine.finished', fence);
    await this.control(taskId, () => this.stopUnlocked(taskId, reason, { fence, detail }));
  }

  async markStalled(taskId: string, detail: string): Promise<void> {
    return this.automaticTransition(taskId, 'stalled', 'no_progress', detail, 'engine.stalled', this.captureExecution(taskId));
  }

  async failTask(taskId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.automaticTransition(taskId, 'failed', 'error', message, 'engine.failed', this.captureExecution(taskId));
  }

  private async automaticTransition(taskId: string, status: 'needs_input' | 'stalled' | 'failed', reason: StopReason, detail: string, action: string, fence: ExecutionFence): Promise<void> {
    await this.control(taskId, async () => {
      const ctx = fence.context;
      const finishedAt = status === 'needs_input' ? null : new Date();
      const audit = await serialTransaction(this.tasks.manager, async (manager) => {
        const task = await manager.findOneBy(TaskEntity, { id: taskId });
        if (!task || !this.executionCurrent(task, fence)) return null;
        await manager.update(TaskEntity, taskId, {
          engineStatus: status, status: status === 'failed' ? 'failed' : 'running', stopReason: reason,
          lastError: detail.slice(0, 1000), finishedAt: status === 'failed' ? finishedAt : null,
          currentPhase: status === 'needs_input' ? '需要人工介入' : status === 'stalled' ? '已停滞：需要新的信息来源' : '执行失败',
        });
        if (ctx) await manager.update(OrchestratorRunEntity, ctx.runId, { status, stopReason: reason, lastError: detail.slice(0, 1000), finishedAt, activeWorkers: status === 'failed' ? 0 : ctx.activeWorkers.size });
        return manager.save(manager.create(AuditLogEntity, { id: newId(), actor: 'system', action, entityType: 'task', entityId: taskId, taskId, detail: { reason, detail: detail.slice(0, 1000) } }));
      });
      if (!audit) return;
      if (ctx) {
        ctx.controlRevision = (ctx.controlRevision ?? 0) + 1;
        ctx.status = status; ctx.stopReason = reason; ctx.lastError = detail.slice(0, 1000); ctx.finishedAt = finishedAt;
        if (status === 'failed') this.terminateContext(ctx, '编排失败');
      } else if (status === 'failed') {
        await reconcileTerminalVerifications(this.tasks.manager, taskId);
      }
      this.publishControlAudit(audit);
      this.broadcastSnapshot(taskId);
    });
  }

  /** Asynchronous planning and dispatch checkpoints share the cycle's captured revision. */
  async executionAllowed(taskId: string): Promise<boolean> {
    const task = await this.tasks.findOneBy({ id: taskId });
    return Boolean(task && this.executionCurrent(task, this.captureExecution(taskId)));
  }

  async setStatus(taskId: string, status: OrchestratorStatus, phase?: string): Promise<void> {
    const fence = this.captureExecution(taskId);
    await this.control(taskId, async () => {
      const changed = await serialTransaction(this.tasks.manager, async (manager) => {
        const task = await manager.findOneBy(TaskEntity, { id: taskId });
        if (!task || !this.executionCurrent(task, fence)) return false;
        if (phase) await manager.update(TaskEntity, taskId, { currentPhase: phase });
        return true;
      });
      if (!changed) return;
      if (fence.context) fence.context.status = status;
      this.broadcastSnapshot(taskId);
    });
  }

  async persistRun(ctx: OrchestratorContext, reason: StopReason | null): Promise<void> {
    const fence = this.captureExecution(ctx.taskId);
    await serialTransaction(this.tasks.manager, async (manager) => {
      const task = await manager.findOneBy(TaskEntity, { id: ctx.taskId });
      if (!task || fence.context !== ctx || !this.executionCurrent(task, fence)) return;
      await manager.update(OrchestratorRunEntity, ctx.runId, {
        status: ctx.status, cycleCount: ctx.cycle, activeWorkers: ctx.activeWorkers.size,
        noProgressRounds: ctx.noProgressRounds, stopReason: reason, plannerSessionId: ctx.plannerSessionId,
        lastError: ctx.lastError, finishedAt: null,
      });
      // 任务行也要带上原因：快照与任务列表都从 tasks.lastError 读，重启后仍然可见。
      await manager.update(TaskEntity, ctx.taskId, { lastError: ctx.lastError ?? null });
    });
  }

  private terminateContext(ctx: OrchestratorContext, reason: string): void {
    const workers = [...ctx.activeWorkers]; const plannerId = ctx.plannerSessionId;
    ctx.activeWorkers.clear();
    void Promise.all([
      ...workers.map(async ([id, worker]) => {
        await this.runtime.sessions.terminate(worker.sessionId, reason).catch(() => undefined);
        await this.workers.complete(id, { status: 'cancelled', error: reason }).catch(() => undefined);
      }),
      plannerId ? this.runtime.sessions.terminate(plannerId, reason).catch(() => undefined) : Promise.resolve(),
    ]).then(() => reconcileTerminalVerifications(this.tasks.manager, ctx.taskId))
      .catch((error) => this.logger.error(`验证收尾失败：${String(error)}`));
  }

  broadcastSnapshot(taskId: string): void {
    void this.snapshot(taskId)
      .then((snapshot) => this.gateway.broadcast('engine.status', snapshot))
      .catch(() => undefined);
  }

  async findTask(taskId: string): Promise<TaskEntity> {
    const task = await this.tasks.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException('任务不存在');
    return hydrateTaskAccounting(this.tasks.manager, task);
  }

  /** 由 cycle 实现复用 */
  get deps() {
    return {
      targets: this.targets,
      intents: this.intents,
      intentRepo: this.intentRepo,
      facts: this.facts,
      hints: this.hints,
      skills: this.skills,
      planner: this.planner,
      workerRunner: this.workerRunner,
      workers: this.workers,
      runtime: this.runtime,
      tasks: this.tasks,
    };
  }
}
