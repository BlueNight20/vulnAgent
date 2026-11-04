import { serialSave, serialUpdate, serialTransaction } from '../../database/serial-transaction';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import type {
  WorkerProfileId,
  WorkerResultCardDto,
  WorkerTaskDto,
  WorkerTaskStatus,
} from '@vulnagent/shared';
import { IntentEntity, TaskEntity, WorkerResultCardEntity, WorkerTaskEntity } from '../../database/entities';
import { requireRuntime, workerConcurrency } from '../../database/runtime-control';
import { newId, toIso } from '../../common/utils/id';
import { EventsGateway } from '../events/events.gateway';

export interface CreateWorkerTaskInput {
  taskId: string;
  intentId: string | null;
  parentWorkerTaskId?: string | null;
  title: string;
  profileId: WorkerProfileId;
  dedupeKey: string;
  timeoutSeconds: number;
  maxAttempts: number;
  input?: Record<string, unknown>;
}

@Injectable()
export class WorkerStateService {
  constructor(
    @InjectRepository(WorkerTaskEntity) private readonly workers: Repository<WorkerTaskEntity>,
    @InjectRepository(WorkerResultCardEntity)
    private readonly cards: Repository<WorkerResultCardEntity>,
    private readonly events: EventsGateway,
  ) {}

  async create(input: CreateWorkerTaskInput): Promise<WorkerTaskDto> {
    const saved = await serialSave(this.workers, this.newWorker(input));
    const dto = this.toDto(saved);
    this.notify(dto);
    return dto;
  }

  private newWorker(input: CreateWorkerTaskInput): WorkerTaskEntity {
    const lease = new Date(Date.now() + input.timeoutSeconds * 1000);
    return this.workers.create({
      id: newId(),
      createdAt: new Date(),
      taskId: input.taskId,
      sessionId: null,
      intentId: input.intentId,
      parentWorkerTaskId: input.parentWorkerTaskId ?? null,
      title: input.title.slice(0, 200),
      profileId: input.profileId,
      status: 'queued',
      attempt: 0,
      maxAttempts: input.maxAttempts,
      dedupeKey: input.dedupeKey.slice(0, 200),
      timeoutSeconds: input.timeoutSeconds,
      leaseExpiresAt: lease,
      tokensSpent: 0,
      evidenceIds: [],
      input: input.input ?? null,
      output: null,
      resultCardId: null,
      errorMessage: null,
    });
  }

  private notify(dto: WorkerTaskDto): void { try { this.events.broadcast('worker.task', dto); } catch { /* Persisted state remains authoritative. */ } }

  async capacity(taskId: string, manager = this.workers.manager): Promise<{ limit: number; active: number; taskActive: number }> {
    const limit = await workerConcurrency(manager);
    const [active, taskActive] = await Promise.all([
      manager.count(WorkerTaskEntity, { where: { status: In(['queued', 'running']) } }),
      manager.count(WorkerTaskEntity, { where: { taskId, status: In(['queued', 'running']) } }),
    ]);
    return { limit, active, taskActive };
  }

  /** Reserve a global/task slot and dispatch the intent in one SQLite transaction. */
  async reserve(input: CreateWorkerTaskInput, score: number, breakdown: Record<string, number>): Promise<{ worker: WorkerTaskDto | null; reason: 'capacity' | 'stale' | 'attempt_limit' | null }> {
    const result = await serialTransaction(this.workers.manager, async (manager) => {
      await requireRuntime(manager);
      const task = await manager.findOneBy(TaskEntity, { id: input.taskId });
      const intent = input.intentId ? await manager.findOneBy(IntentEntity, { id: input.intentId, taskId: input.taskId }) : null;
      if (!task || task.status !== 'running' || task.engineStatus !== 'running' || !intent || intent.status !== 'proposed') return { worker: null, reason: 'stale' as const };
      const slots = await this.capacity(input.taskId, manager);
      if (slots.active >= slots.limit || slots.taskActive >= task.workerCount) return { worker: null, reason: 'capacity' as const };
      const previous = await manager.find(WorkerTaskEntity, { where: { taskId: input.taskId, intentId: intent.id } });
      const attempt = previous.length ? Math.max(...previous.map((row) => row.attempt)) + 1 : 0;
      if (attempt >= (intent.maxAttempts || input.maxAttempts)) return { worker: null, reason: 'attempt_limit' as const };
      const entity = this.newWorker(input); entity.attempt = attempt;
      const worker = await manager.save(entity);
      await manager.update(IntentEntity, intent.id, { status: 'dispatched', score, scoreBreakdown: breakdown, dispatchCount: intent.dispatchCount + 1 });
      return { worker: this.toDto(worker), reason: null };
    });
    if (result.worker) this.notify(result.worker);
    return result;
  }

  async attachSession(id: string, sessionId: string): Promise<WorkerTaskDto> {
    const saved = await serialTransaction(this.workers.manager, async (manager) => {
    const entity = await manager.findOneBy(WorkerTaskEntity, { id });
    if (!entity) throw new NotFoundException('Worker 不存在');
    if (entity.status === 'running' && entity.sessionId === sessionId) return entity;
    if (entity.status !== 'queued' || (entity.leaseExpiresAt && entity.leaseExpiresAt.getTime() <= Date.now())) throw new ConflictException('Worker 派发占位已失效，不能启动会话');
    entity.sessionId = sessionId;
    entity.status = 'running';
    entity.startedAt = new Date();
    const hardDeadline = (entity.startedAt ?? entity.createdAt).getTime() + entity.timeoutSeconds * 1000 + 30_000;
    entity.leaseExpiresAt = new Date(Math.min(Date.now() + entity.timeoutSeconds * 1000, hardDeadline));
    return manager.save(entity);
    });
    const dto = this.toDto(saved);
    this.notify(dto);
    return dto;
  }

  async complete(
    id: string,
    payload: {
      status: WorkerTaskStatus;
      output?: Record<string, unknown> | null;
      evidenceIds?: string[];
      tokensSpent?: number;
      resultCardId?: string | null;
      error?: string | null;
    },
  ): Promise<WorkerTaskDto> {
    const saved = await serialTransaction(this.workers.manager, async (manager) => {
    const entity = await manager.findOneBy(WorkerTaskEntity, { id });
    if (!entity) throw new NotFoundException('Worker 不存在');
    if (['succeeded', 'failed', 'timeout', 'cancelled'].includes(entity.status)) return entity;
    entity.status = payload.status;
    entity.output = payload.output ?? entity.output;
    entity.evidenceIds = payload.evidenceIds ?? entity.evidenceIds;
    entity.tokensSpent = payload.tokensSpent ?? entity.tokensSpent;
    entity.resultCardId = payload.resultCardId ?? entity.resultCardId;
    entity.errorMessage = payload.error ?? null;
    entity.endedAt = new Date();
    entity.leaseExpiresAt = null;
    return manager.save(entity);
    });
    const dto = this.toDto(saved);
    this.notify(dto);
    return dto;
  }

  /** 超时回收：返回已过期的 running 任务 */
  async findExpired(): Promise<WorkerTaskEntity[]> {
    return this.workers.find({
      where: { status: 'running', leaseExpiresAt: LessThan(new Date()) },
    });
  }

  /** 指定任务的过期 Worker（同样用 datetime() 归一化比较） */
  async expiredForTask(taskId: string): Promise<WorkerTaskDto[]> {
    const rows = await this.workers
      .createQueryBuilder('w')
      .where('w.taskId = :taskId', { taskId })
      .andWhere("w.status = 'running'")
      .andWhere('w.leaseExpiresAt IS NOT NULL')
      .andWhere((qb) => `NOT EXISTS ${qb.subQuery().select('1').from(TaskEntity, 't').where("t.id = w.taskId AND t.status = 'paused'").getQuery()}`)
      .andWhere("datetime(w.leaseExpiresAt) < datetime('now')")
      .getMany();
    return rows.map((r) => this.toDto(r));
  }

  /**
   * 全库扫描过期 Worker（不依赖内存上下文，进程重启后依然有效）。
   *
   * 注意：SQLite 把 datetime 存成 `YYYY-MM-DD HH:MM:SS.SSS`（空格分隔），
   * 若用 `LessThan(new Date().toISOString())` 比较会得到 `YYYY-MM-DDTHH:MM:SS.sssZ`（T 分隔），
   * 字符串顺序与预期不符导致永远匹配不到。必须用 datetime() 归一化后比较。
   */
  async findAllExpired(): Promise<WorkerTaskDto[]> {
    const rows = await this.workers
      .createQueryBuilder('w')
      .where("w.status IN ('queued', 'running')")
      .andWhere('w.leaseExpiresAt IS NOT NULL')
      .andWhere((qb) => `NOT EXISTS ${qb.subQuery().select('1').from(TaskEntity, 't').where("t.id = w.taskId AND t.status = 'paused'").getQuery()}`)
      .andWhere("datetime(w.leaseExpiresAt) < datetime('now')")
      .getMany();
    return rows.map((r) => this.toDto(r));
  }

  /** 启动对账包含派发占位；旧 queued 也不能永久占用名额。 */
  async findRunningAll(): Promise<WorkerTaskDto[]> {
    const rows = await this.workers.find({ where: { status: In(['queued', 'running']) } });
    return rows.map((r) => this.toDto(r));
  }

  /** 设置重试次数（重试时不修改 dedupeKey） */
  async setAttempt(id: string, attempt: number): Promise<void> {
    await serialUpdate(this.workers, { id }, { attempt });
  }

  /** Heartbeats allow a short recovery grace, never an unlimited execution lease. */
  async renewLease(id: string): Promise<void> {
    await serialTransaction(this.workers.manager, async (manager) => {
    const entity = await manager.findOneBy(WorkerTaskEntity, { id });
    if (!entity || entity.status !== 'running') return;
    const hardDeadline = (entity.startedAt ?? entity.createdAt).getTime() + entity.timeoutSeconds * 1000 + 30_000;
    entity.leaseExpiresAt = new Date(Math.min(Date.now() + entity.timeoutSeconds * 1000, hardDeadline));
    await manager.update(WorkerTaskEntity, id, { leaseExpiresAt: entity.leaseExpiresAt });
    });
  }

  /** 是否已经为同一个意图+参数指纹创建过 Worker（重复动作识别） */
  async hasAttemptForFingerprint(taskId: string, fingerprint: string): Promise<boolean> {
    const count = await this.workers
      .createQueryBuilder('w')
      .where('w.taskId = :taskId', { taskId })
      .andWhere('w.dedupeKey = :fingerprint', { fingerprint })
      .getCount();
    return count > 0;
  }

  async markTimeout(id: string): Promise<WorkerTaskDto> {
    return this.complete(id, { status: 'timeout', error: 'Worker 执行超时，租约已过期' });
  }

  async listByTask(taskId: string): Promise<WorkerTaskDto[]> {
    const rows = await this.workers.find({ where: { taskId }, order: { createdAt: 'ASC' } });
    return rows.map((r) => this.toDto(r));
  }

  async countActive(taskId: string): Promise<number> {
    return this.workers.count({ where: { taskId, status: 'running' } });
  }

  async findById(id: string): Promise<WorkerTaskDto | null> {
    const row = await this.workers.findOne({ where: { id } });
    return row ? this.toDto(row) : null;
  }

  async saveResultCard(
    taskId: string,
    workerTaskId: string,
    sessionId: string,
    card: {
      objective: string;
      summary: string;
      newFactIds: string[];
      supportedHypothesisIds: string[];
      refutedHypothesisIds: string[];
      evidenceIds: string[];
      openQuestions: string[];
      nextSteps: string[];
      tokensUsed: number;
      durationMs: number;
      synthetic: boolean;
    },
  ): Promise<WorkerResultCardDto> {
    const entity = this.cards.create({
      id: newId(),
      taskId,
      workerTaskId,
      sessionId,
      ...card,
    });
    const saved = await serialSave(this.cards, entity);
    const worker = await this.workers.findOne({ where: { id: workerTaskId } });
    if (worker) {
      worker.resultCardId = saved.id;
      await serialSave(this.workers, worker);
    }
    return this.cardToDto(saved);
  }

  async listResultCards(taskId: string): Promise<WorkerResultCardDto[]> {
    const rows = await this.cards.find({ where: { taskId }, order: { createdAt: 'DESC' } });
    return rows.map((r) => this.cardToDto(r));
  }

  private async findEntity(id: string): Promise<WorkerTaskEntity> {
    const entity = await this.workers.findOne({ where: { id } });
    if (!entity) throw new NotFoundException('Worker 任务不存在');
    return entity;
  }

  toDto(entity: WorkerTaskEntity): WorkerTaskDto {
    return {
      id: entity.id,
      taskId: entity.taskId,
      sessionId: entity.sessionId,
      intentId: entity.intentId,
      parentWorkerTaskId: entity.parentWorkerTaskId,
      title: entity.title,
      profileId: (entity.profileId ?? 'recon') as WorkerProfileId,
      status: entity.status,
      attempt: entity.attempt,
      maxAttempts: entity.maxAttempts,
      dedupeKey: entity.dedupeKey ?? '',
      timeoutSeconds: entity.timeoutSeconds,
      leaseExpiresAt: toIso(entity.leaseExpiresAt),
      tokensSpent: entity.tokensSpent,
      evidenceIds: entity.evidenceIds ?? [],
      input: entity.input,
      output: entity.output,
      resultCardId: entity.resultCardId,
      errorMessage: entity.errorMessage,
      startedAt: toIso(entity.startedAt),
      endedAt: toIso(entity.endedAt),
      createdAt: toIso(entity.createdAt) ?? '',
    };
  }

  private cardToDto(entity: WorkerResultCardEntity): WorkerResultCardDto {
    return {
      id: entity.id,
      taskId: entity.taskId,
      workerTaskId: entity.workerTaskId,
      sessionId: entity.sessionId,
      objective: entity.objective,
      summary: entity.summary,
      newFactIds: entity.newFactIds ?? [],
      supportedHypothesisIds: entity.supportedHypothesisIds ?? [],
      refutedHypothesisIds: entity.refutedHypothesisIds ?? [],
      evidenceIds: entity.evidenceIds ?? [],
      openQuestions: entity.openQuestions ?? [],
      nextSteps: entity.nextSteps ?? [],
      tokensUsed: entity.tokensUsed,
      durationMs: entity.durationMs,
      synthetic: entity.synthetic,
      createdAt: toIso(entity.createdAt) ?? '',
    };
  }
}
