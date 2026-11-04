import { serialSave, serialTransaction } from '../../database/serial-transaction';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  IntentDto,
  IntentRejectReason,
  ScoreBreakdown,
  WorkerProfileId,
} from '@vulnagent/shared';
import { AuditLogEntity, IntentEntity } from '../../database/entities';
import { newId, toIso } from '../../common/utils/id';
import { normalizePagination } from '../../common/utils/pagination';
import { EventsGateway } from '../events/events.gateway';

export interface CreateIntentInput {
  taskId: string;
  agentSessionId?: string | null;
  title: string;
  hypothesis?: string;
  objective?: string;
  rationale?: string;
  prerequisites?: string[];
  workerProfileId?: WorkerProfileId;
  suggestedTools?: string[];
  expectedEvidence?: string[];
  targetIp?: string | null;
  priority?: number;
  dedupeKey: string;
  dependencies?: string[];
  factIds?: string[];
  maxAttempts?: number;
  cycle?: number;
}

@Injectable()
export class IntentsService {
  constructor(
    @InjectRepository(IntentEntity) private readonly intents: Repository<IntentEntity>,
    private readonly events: EventsGateway,
  ) {}

  /** 创建意图；dedupeKey 冲突时返回已有记录（同一任务内唯一） */
  async create(input: CreateIntentInput): Promise<{ created: boolean; intent: IntentDto }> {
    const existing = await this.intents.findOne({
      where: { taskId: input.taskId, dedupeKey: input.dedupeKey },
    });
    if (existing) {
      if (existing.status === 'rejected' && existing.rejectedReason === 'queue_capacity' && existing.attemptCount < existing.maxAttempts) {
        const reopened = await serialTransaction(this.intents.manager, async (manager) => {
          const row = await manager.findOneByOrFail(IntentEntity, { id: existing.id });
          if (row.status !== 'rejected' || row.rejectedReason !== 'queue_capacity' || row.attemptCount >= row.maxAttempts) return row;
          row.status = 'proposed'; row.rejectedReason = null;
          row.priority = input.priority ?? row.priority; row.cycle = input.cycle ?? row.cycle;
          row.agentSessionId = input.agentSessionId ?? row.agentSessionId;
          await manager.save(IntentEntity, row);
          await manager.insert(AuditLogEntity, { id: newId(), taskId: row.taskId, action: 'intent.capacity_reconsidered', entityType: 'intent', entityId: row.id,
            detail: { cycle: row.cycle, priority: row.priority } });
          return row;
        });
        const dto = this.toDto(reopened);
        this.events.broadcast('blackboard.intent', dto);
        return { created: false, intent: dto };
      }
      return { created: false, intent: this.toDto(existing) };
    }

    const entity = this.intents.create({
      id: newId(),
      taskId: input.taskId,
      agentSessionId: input.agentSessionId ?? null,
      title: input.title.slice(0, 200),
      hypothesis: input.hypothesis ?? '',
      objective: input.objective ?? '',
      rationale: input.rationale ?? '',
      prerequisites: input.prerequisites ?? [],
      workerProfileId: input.workerProfileId ?? 'recon',
      suggestedTools: input.suggestedTools ?? [],
      expectedEvidence: input.expectedEvidence ?? [],
      targetIp: input.targetIp ?? null,
      priority: input.priority ?? 50,
      status: 'proposed',
      rejectedReason: null,
      dedupeKey: input.dedupeKey.slice(0, 200),
      dependencies: input.dependencies ?? [],
      factIds: input.factIds ?? [],
      maxAttempts: input.maxAttempts ?? 2,
      attemptCount: 0,
      dispatchCount: 0,
      cycle: input.cycle ?? 0,
    });
    const saved = await serialSave(this.intents, entity);
    const dto = this.toDto(saved);
    this.events.broadcast('blackboard.intent', dto);
    return { created: true, intent: dto };
  }

  async list(
    taskId: string,
    filters: { status?: string; page?: number; pageSize?: number } = {},
  ): Promise<{ items: IntentDto[]; total: number; counts: Record<string, number> }> {
    const { skip, take } = normalizePagination(filters.page, filters.pageSize ?? 50);
    const qb = this.intents.createQueryBuilder('i').where('i.taskId = :taskId', { taskId });
    if (filters.status) qb.andWhere('i.status = :status', { status: filters.status });
    const [rows, total] = await qb.orderBy('i.createdAt', 'DESC').skip(skip).take(take).getManyAndCount();

    const countRows = await this.intents
      .createQueryBuilder('i')
      .select('i.status', 'status')
      .addSelect('COUNT(1)', 'count')
      .where('i.taskId = :taskId', { taskId })
      .groupBy('i.status')
      .getRawMany<{ status: string; count: string | number }>();
    const counts: Record<string, number> = {};
    for (const row of countRows) counts[row.status] = Number(row.count);

    return { items: rows.map((r) => this.toDto(r)), total, counts };
  }

  async proposed(taskId: string): Promise<IntentEntity[]> {
    return this.intents.find({
      where: { taskId, status: 'proposed' },
      order: { priority: 'DESC', createdAt: 'ASC' },
    });
  }

  async markDispatched(id: string, score: number, breakdown: Record<string, number>): Promise<void> {
    const entity = await this.intents.findOne({ where: { id } });
    if (!entity) return;
    entity.status = 'dispatched';
    entity.score = score;
    entity.scoreBreakdown = breakdown;
    entity.dispatchCount += 1;
    entity.attemptCount += 0;
    const saved = await serialSave(this.intents, entity);
    this.events.broadcast('blackboard.intent', this.toDto(saved));
  }

  async markDone(id: string): Promise<void> {
    await this.setStatus(id, 'done', null);
  }

  async reject(id: string, reason: IntentRejectReason): Promise<IntentDto> {
    const entity = await this.intents.findOne({ where: { id } });
    if (!entity) throw new NotFoundException('意图不存在');
    entity.status = 'rejected';
    entity.rejectedReason = reason;
    const saved = await serialSave(this.intents, entity);
    const dto = this.toDto(saved);
    this.events.broadcast('blackboard.intent', dto);
    return dto;
  }

  /** 重试时回到 proposed，但 dedupeKey 保持不变 */
  async requeue(id: string): Promise<void> {
    const entity = await this.intents.findOne({ where: { id } });
    if (!entity) return;
    entity.attemptCount += 1;
    entity.status = 'proposed';
    const saved = await serialSave(this.intents, entity);
    this.events.broadcast('blackboard.intent', this.toDto(saved));
  }

  async incrementAttempt(id: string): Promise<number> {
    const entity = await this.intents.findOne({ where: { id } });
    if (!entity) return 0;
    entity.attemptCount += 1;
    await serialSave(this.intents, entity);
    return entity.attemptCount;
  }

  async findById(id: string): Promise<IntentEntity | null> {
    return this.intents.findOne({ where: { id } });
  }

  async counts(taskId: string): Promise<Record<string, number>> {
    const rows = await this.intents
      .createQueryBuilder('i')
      .select('i.status', 'status')
      .addSelect('COUNT(1)', 'count')
      .where('i.taskId = :taskId', { taskId })
      .groupBy('i.status')
      .getRawMany<{ status: string; count: string | number }>();
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  private async setStatus(
    id: string,
    status: 'proposed' | 'dispatched' | 'done' | 'rejected',
    reason: IntentRejectReason | null,
  ): Promise<void> {
    const entity = await this.intents.findOne({ where: { id } });
    if (!entity) return;
    entity.status = status;
    entity.rejectedReason = reason;
    const saved = await serialSave(this.intents, entity);
    this.events.broadcast('blackboard.intent', this.toDto(saved));
  }

  toDto(entity: IntentEntity): IntentDto {
    return {
      id: entity.id,
      taskId: entity.taskId,
      agentSessionId: entity.agentSessionId,
      title: entity.title,
      hypothesis: entity.hypothesis,
      objective: entity.objective,
      rationale: entity.rationale,
      prerequisites: entity.prerequisites ?? [],
      workerProfileId: entity.workerProfileId,
      suggestedTools: entity.suggestedTools ?? [],
      expectedEvidence: entity.expectedEvidence ?? [],
      targetIp: entity.targetIp,
      priority: entity.priority,
      score: entity.score ?? 0,
      scoreBreakdown: (entity.scoreBreakdown as ScoreBreakdown | null) ?? null,
      status: entity.status,
      rejectedReason: entity.rejectedReason,
      dedupeKey: entity.dedupeKey,
      dependencies: entity.dependencies ?? [],
      factIds: entity.factIds ?? [],
      maxAttempts: entity.maxAttempts,
      attemptCount: entity.attemptCount,
      dispatchCount: entity.dispatchCount,
      cycle: entity.cycle,
      createdAt: toIso(entity.createdAt) ?? '',
      updatedAt: toIso(entity.updatedAt) ?? '',
    };
  }
}
