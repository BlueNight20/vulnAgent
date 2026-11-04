import { serialTransaction } from '../../database/serial-transaction';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type EntityManager } from 'typeorm';
import type { AuditLogDto } from '@vulnagent/shared';
import { AuditLogEntity } from '../../database/entities';
import { newId, nowIso } from '../../common/utils/id';
import { normalizePagination } from '../../common/utils/pagination';
import { EventsGateway } from '../events/events.gateway';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  taskId?: string | null;
  result?: 'success' | 'failure';
  detail?: Record<string, unknown> | null;
  actor?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLogEntity)
    private readonly repo: Repository<AuditLogEntity>,
    private readonly events: EventsGateway,
  ) {}

  async record(input: AuditInput): Promise<AuditLogDto> {
    const dto = await serialTransaction(this.repo.manager, (manager) => this.recordInTransaction(manager, input));
    this.publish(dto);
    return dto;
  }

  /** Persist beside the business mutation; the transaction owner publishes after commit. */
  async recordInTransaction(manager: EntityManager, input: AuditInput): Promise<AuditLogDto> {
    if (manager.connection !== this.repo.manager.connection || !manager.queryRunner?.isTransactionActive) throw new Error('审计必须使用同一数据源的活动事务');
    const entity = manager.create(AuditLogEntity, {
      id: newId(),
      actor: input.actor ?? 'user',
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      taskId: input.taskId ?? null,
      result: input.result ?? 'success',
      detail: input.detail ?? null,
    });
    return this.toDto(await manager.save(entity));
  }

  /** Delivery is best effort: a disconnected socket must not turn a committed write into HTTP failure. */
  publish(dto: AuditLogDto): void {
    this.logger.debug(`审计: ${dto.action} ${dto.entityType} ${dto.entityId ?? ''} ${dto.result}`);
    try { this.events.broadcast('audit.appended', dto); }
    catch { this.logger.warn('审计推送失败；已提交的审计记录保留，可重新读取'); }
  }

  async list(page?: string, pageSize?: string, taskId?: string): Promise<{ items: AuditLogDto[]; total: number }> {
    const { skip, take } = normalizePagination(page, pageSize);
    const qb = this.repo.createQueryBuilder('a').orderBy('a.createdAt', 'DESC').skip(skip).take(take);
    if (taskId) qb.andWhere('a.taskId = :taskId', { taskId });
    const [rows, total] = await qb.getManyAndCount();
    return { items: rows.map((r) => this.toDto(r)), total };
  }

  toDto(entity: AuditLogEntity): AuditLogDto {
    return {
      id: entity.id,
      actor: entity.actor,
      action: entity.action,
      entityType: entity.entityType,
      entityId: entity.entityId,
      taskId: entity.taskId,
      result: entity.result,
      detail: entity.detail,
      createdAt: entity.createdAt ? new Date(entity.createdAt).toISOString() : nowIso(),
    };
  }
}
