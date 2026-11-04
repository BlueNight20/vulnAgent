import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { HintDto } from '@vulnagent/shared';
import { AgentSessionEntity, HintEntity, TaskEntity } from '../../database/entities';
import { serialTransaction } from '../../database/serial-transaction';
import { newId, toIso } from '../../common/utils/id';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class HintsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HintsService.name);
  private deliver?: (hint: HintEntity) => Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private pumping = false;

  constructor(
    @InjectRepository(HintEntity) private readonly hints: Repository<HintEntity>,
    private readonly audit: AuditService,
  ) {}

  setDeliveryHandler(deliver: (hint: HintEntity) => Promise<void>): void { this.deliver = deliver; }
  onModuleInit(): void {
    this.timer = setInterval(() => { void this.deliverPending().catch((error: unknown) => this.logger.warn(`提示投递暂不可用：${error instanceof Error ? error.message : String(error)}`)); }, 1000);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  /** Retry local queue admission only. Never start/resume an Agent or move a hint to another session. */
  async deliverPending(): Promise<void> {
    if (this.pumping || !this.deliver) return;
    this.pumping = true;
    try {
      const rows = await this.hints.createQueryBuilder('h')
        .innerJoin(AgentSessionEntity, 's', 's.id = h.agentSessionId AND s.taskId = h.taskId')
        .innerJoin(TaskEntity, 't', 't.id = h.taskId')
        .where('h.status = :pending AND s.state = :running AND t.status = :running AND t.engineStatus = :running', { pending: 'pending', running: 'running' })
        .orderBy('h.createdAt', 'ASC').addOrderBy('h.id', 'ASC').getMany();
      for (const hint of rows) await this.deliver(hint);
    } finally { this.pumping = false; }
  }

  async create(taskId: string, content: string, sessionId?: string | null): Promise<HintDto> {
    if (typeof content !== 'string' || !content.trim() || content.length > 2000) throw new BadRequestException('提示内容须为 1～2000 字符的非空文本');
    const { saved, audit } = await serialTransaction(this.hints.manager, async (manager) => {
      const task = await manager.findOneBy(TaskEntity, { id: taskId });
      if (!task) throw new NotFoundException('任务不存在');
      if (['completed', 'failed', 'stopped'].includes(task.status)) throw new ConflictException('任务已结束，请重新运行后提交提示');
      if (sessionId != null) {
        const session = await manager.findOneBy(AgentSessionEntity, { id: sessionId, taskId });
        if (!session) throw new NotFoundException('该任务下的会话不存在');
        if (!['created', 'running', 'paused'].includes(session.state)) throw new ConflictException('会话已结束；请向当前会话提交提示，或提交任务提示供 Planner 后续规划');
      }
      const saved = await manager.save(manager.create(HintEntity, {
        id: newId(), taskId, agentSessionId: sessionId ?? null, appliedToSessionId: null,
        content: content.trim(), status: 'pending', consumedAt: null,
      }));
      const audit = await this.audit.recordInTransaction(manager, {
        action: 'hint.create', entityType: 'hint', entityId: saved.id, taskId,
        detail: { sessionId: sessionId ?? null, length: saved.content.length },
      });
      return { saved, audit };
    });
    this.audit.publish(audit);
    // Durable acceptance is independent of an unavailable queue; the periodic pump retries it.
    if (saved.agentSessionId && this.deliver) await this.deliver(saved).catch((error: unknown) => this.logger.warn(`提示已保存，等待会话接收：${error instanceof Error ? error.message : String(error)}`));
    return this.toDto(saved);
  }

  async list(taskId: string): Promise<HintDto[]> {
    if (!await this.hints.manager.existsBy(TaskEntity, { id: taskId })) throw new NotFoundException('任务不存在');
    const rows = await this.hints.find({ where: { taskId }, order: { createdAt: 'DESC', id: 'DESC' }, take: 100 });
    return rows.map((r) => this.toDto(r));
  }

  /** Task hints are read by the Planner; directed hints are delivered only to their exact session. */
  async takePending(taskId: string): Promise<HintEntity[]> {
    return this.hints.find({ where: { taskId, status: 'pending', agentSessionId: IsNull() }, order: { createdAt: 'ASC', id: 'ASC' } });
  }

  /** A successful planning round consumes only the task hints included in that round. */
  async consume(id: string, sessionId: string): Promise<void> {
    await serialTransaction(this.hints.manager, async (manager) => {
      const hint = await manager.findOneBy(HintEntity, { id });
      if (!hint) throw new NotFoundException('提示不存在');
      const session = await manager.findOneBy(AgentSessionEntity, { id: sessionId, taskId: hint.taskId, role: 'planner' });
      if (!session || hint.agentSessionId !== null) throw new ConflictException('仅 Planner 可消费本轮任务提示，定向提示须由指定会话接收');
      if (hint.status === 'consumed' && hint.appliedToSessionId === sessionId) return;
      if (hint.status !== 'pending') throw new ConflictException('提示已被处理');
      const task = await manager.findOneBy(TaskEntity, { id: hint.taskId, status: 'running', engineStatus: 'running' });
      if (!task) throw new ConflictException('任务已暂停或结束，保留提示等待后续规划');
      await manager.update(HintEntity, { id, status: 'pending', agentSessionId: IsNull() }, { status: 'consumed', appliedToSessionId: sessionId, consumedAt: new Date() });
    });
  }

  toDto(entity: HintEntity): HintDto {
    return { id: entity.id, taskId: entity.taskId, agentSessionId: entity.agentSessionId,
      appliedToSessionId: entity.appliedToSessionId, content: entity.content, status: entity.status,
      consumedAt: toIso(entity.consumedAt), createdAt: toIso(entity.createdAt) ?? '' };
  }
}
