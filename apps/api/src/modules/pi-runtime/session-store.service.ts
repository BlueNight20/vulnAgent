import { serialSave } from '../../database/serial-transaction';
import { serialTransaction } from '../../database/serial-transaction';
import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Not, Repository } from 'typeorm';
import type { SessionEventDto, SessionMessageDto } from '@vulnagent/shared';
import {
  AgentSessionEntity,
  AgentSessionEventEntity,
  AgentSessionMessageEntity,
  ModelUsageEntity,
  HintEntity,
  TaskEntity,
  WorkerTaskEntity,
} from '../../database/entities';
import { newId, toIso } from '../../common/utils/id';
import { EventsGateway } from '../events/events.gateway';
import type { PiAgentMessage } from './pi-types';
import { normalizeStoredMessage, toPlainMessage } from './message-codec';
import { extractText, usageToNumbers } from './pi-types';
import { sessionAccounting } from '../../database/model-accounting';
import { runtimeEnabled } from '../../database/runtime-control';

/**
 * Session 消息与事件的持久化层。
 * 消息保存完整 messageJson（含 toolCall / toolResult），是进程重启后恢复会话的唯一依据。
 */
@Injectable()
export class SessionStoreService {
  private readonly logger = new Logger(SessionStoreService.name);
  private readonly seqCache = new Map<string, number>();

  constructor(
    @InjectRepository(AgentSessionMessageEntity)
    private readonly messages: Repository<AgentSessionMessageEntity>,
    @InjectRepository(AgentSessionEventEntity)
    private readonly events: Repository<AgentSessionEventEntity>,
    @InjectRepository(AgentSessionEntity)
    private readonly sessions: Repository<AgentSessionEntity>,
    @InjectRepository(ModelUsageEntity)
    private readonly usage: Repository<ModelUsageEntity>,
    private readonly gateway: EventsGateway,
  ) {}

  async nextSeq(sessionId: string): Promise<number> {
    const cached = this.seqCache.get(sessionId);
    if (cached !== undefined) {
      const next = cached + 1;
      this.seqCache.set(sessionId, next);
      return next;
    }
    const row = await this.messages
      .createQueryBuilder('m')
      .select('MAX(m.seq)', 'max')
      .where('m.sessionId = :sessionId', { sessionId })
      .getRawOne<{ max: number | null }>();
    const next = (row?.max ?? 0) + 1;
    this.seqCache.set(sessionId, next);
    return next;
  }

  releaseSeq(sessionId: string): void {
    this.seqCache.delete(sessionId);
  }

  async appendMessage(
    session: AgentSessionEntity,
    message: PiAgentMessage,
    meta?: { toolCallId?: string; toolName?: string },
    receiptHintId?: string,
  ): Promise<SessionMessageDto> {
    const dto = await serialTransaction(this.messages.manager, async (manager) => {
    if (receiptHintId) {
      const hint = await manager.findOneBy(HintEntity, { id: receiptHintId, taskId: session.taskId, agentSessionId: session.id });
      if (!hint || message.role !== 'user') throw new ConflictException('定向提示与会话不匹配');
      const previous = await manager.findOneBy(AgentSessionMessageEntity, { id: receiptHintId, taskId: session.taskId, sessionId: session.id });
      if (hint.status === 'consumed' && hint.appliedToSessionId === session.id && previous) return this.messageDto(previous);
      const task = await manager.findOneBy(TaskEntity, { id: session.taskId, status: 'running', engineStatus: 'running' });
      const current = await manager.findOneBy(AgentSessionEntity, { id: session.id, taskId: session.taskId, state: 'running' });
      if (hint.status !== 'pending' || !task || !current || !await runtimeEnabled(manager)) throw new ConflictException('会话或任务已停止，提示尚未消费');
      if (current.role !== 'planner') {
        const worker = await manager.findOneBy(WorkerTaskEntity, { taskId: session.taskId, sessionId: session.id, status: 'running' });
        if (!worker?.leaseExpiresAt || worker.leaseExpiresAt.getTime() <= Date.now()) throw new ConflictException('Worker 已收尾或租约过期，提示尚未消费');
      }
      await manager.update(HintEntity, { id: hint.id, status: 'pending' }, { status: 'consumed', appliedToSessionId: session.id, consumedAt: new Date() });
    }
    const seq = await this.nextSeq(session.id);
    const usage =
      message.role === 'assistant'
        ? usageToNumbers(message.usage)
        : message.role === 'toolResult' && message.details
          ? null
          : null;

    const entity = this.messages.create({
      id: receiptHintId ?? newId(),
      taskId: session.taskId,
      sessionId: session.id,
      seq,
      role: message.role,
      content: extractText(message).slice(0, 8000),
      // Pi 的 message 对象可能带有原型上的非枚举引用，必须拍平成纯 JSON，
      // 否则 simple-json 会把整个对象再序列化一次（出现双重编码，恢复上下文时失效）。
      messageJson: toPlainMessage(message),
      toolCallId: meta?.toolCallId ?? null,
      toolName: meta?.toolName ?? null,
      usage,
    });
    const saved = await serialSave(this.messages, entity);

    const dto: SessionMessageDto = {
      id: saved.id,
      sessionId: saved.sessionId,
      seq: saved.seq,
      role: saved.role,
      content: saved.content,
      messageJson: saved.messageJson,
      toolCallId: saved.toolCallId,
      toolName: saved.toolName,
      usage: saved.usage,
      createdAt: toIso(saved.createdAt) ?? '',
    };
    return dto;
    });
    try { this.gateway.broadcast('session.message', dto); }
    catch { this.logger.warn('会话消息已保存，实时推送失败；可重新读取历史'); }
    return dto;
  }

  async appendHintMessage(session: AgentSessionEntity, message: PiAgentMessage): Promise<SessionMessageDto> {
    if (message.role !== 'user' || !message.hintId) throw new BadRequestException('提示消息缺少本地关联 ID');
    return this.appendMessage(session, message, undefined, message.hintId);
  }

  /** 记录一条 assistant 消息的 Token 与成本 */
  async recordUsage(
    session: AgentSessionEntity,
    message: PiAgentMessage,
    latencyMs: number,
  ): Promise<void> {
    if (session.budgetManaged) {
      const value = await sessionAccounting(this.sessions.manager, session);
      session.tokenInput = value.input; session.tokenOutput = value.output; session.costUsd = value.cost;
      return; // 网关已按请求 ID 原子写账，不再由事件回调重复计费。
    }
    if (message.role !== 'assistant' || !message.usage) return;
    const usage = message.usage;
    const numbers = usageToNumbers(usage);
    if (numbers.input === 0 && numbers.output === 0) return;

    session.tokenInput += numbers.input;
    session.tokenOutput += numbers.output;
    session.costUsd = Number((session.costUsd + numbers.cost).toFixed(6));
    await serialSave(this.sessions, session);

    await serialSave(this.usage, 
      this.usage.create({
        id: newId(),
        taskId: session.taskId,
        agentSessionId: session.id,
        provider: message.provider ?? 'unknown',
        modelName: message.model ?? session.modelName,
        inputTokens: numbers.input,
        outputTokens: numbers.output,
        costUsd: numbers.cost,
        latencyMs,
      }),
    );
  }

  async appendEvent(
    sessionId: string,
    taskId: string,
    type: string,
    payload: Record<string, unknown> | null,
  ): Promise<SessionEventDto> {
    const entity = this.events.create({
      id: newId(),
      taskId,
      sessionId,
      type,
      payload,
    });
    const saved = await serialSave(this.events, entity);
    const dto: SessionEventDto = {
      id: saved.id,
      sessionId: saved.sessionId,
      taskId: saved.taskId,
      type: saved.type,
      payload: saved.payload,
      createdAt: toIso(saved.createdAt) ?? '',
    };
    this.gateway.broadcast('session.event', dto);
    return dto;
  }

  /** 读取历史消息（进程重启后恢复上下文） */
  async loadMessages(sessionId: string): Promise<PiAgentMessage[]> {
    const rows = await this.messages.find({
      where: { sessionId },
      order: { seq: 'ASC' },
    });
    return rows
      .map((row) => normalizeStoredMessage(row.messageJson))
      .filter((m): m is PiAgentMessage => Boolean(m && m.role));
  }

  async listMessages(sessionId: string, afterSeq = 0, limit = 200): Promise<{ items: SessionMessageDto[]; total: number; nextAfterSeq: number | null }> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new BadRequestException('消息游标须为非负安全整数，每页数量须为 1～500');
    const rows = await this.messages.find({
      where: { sessionId, seq: MoreThan(afterSeq) },
      order: { seq: 'ASC' },
      take: limit + 1,
    });
    const filtered = rows.slice(0, limit);
    return {
      items: filtered.map((row) => this.messageDto(row)),
      total: await this.messages.count({ where: { sessionId } }),
      nextAfterSeq: rows.length > limit ? filtered[filtered.length - 1].seq : null,
    };
  }

  /** Worker recovery must inspect the latest response, regardless of history length. */
  async latestAssistant(sessionId: string, requireContent = false): Promise<SessionMessageDto | null> {
    const row = await this.messages.findOne({ where: { sessionId, role: 'assistant', ...(requireContent ? { content: Not('') } : {}) }, order: { seq: 'DESC' } });
    if (!row) return null;
    const dto = this.messageDto(row);
    // List content is an 8k preview; recovery must parse the complete stored response.
    if (row.messageJson?.role === 'assistant' && Array.isArray(row.messageJson.content)) {
      dto.content = extractText(row.messageJson as unknown as PiAgentMessage) || dto.content;
    }
    return dto;
  }

  private messageDto(row: AgentSessionMessageEntity): SessionMessageDto {
    return {
        id: row.id,
        sessionId: row.sessionId,
        seq: row.seq,
        role: row.role,
        content: row.content,
        messageJson: row.messageJson,
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        usage: row.usage,
        createdAt: toIso(row.createdAt) ?? '',
      };
  }

  async listEvents(sessionId: string, limit = 100): Promise<SessionEventDto[]> {
    const rows = await this.events.find({
      where: { sessionId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return rows
      .map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        taskId: row.taskId,
        type: row.type,
        payload: row.payload,
        createdAt: toIso(row.createdAt) ?? '',
      }))
      .reverse();
  }

  async countMessages(sessionId: string): Promise<number> {
    return this.messages.count({ where: { sessionId } });
  }

  /** 批量统计多个会话的消息数，避免 N+1 */
  async listMessagesBySessions(sessionIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (sessionIds.length === 0) return map;
    const rows = await this.messages
      .createQueryBuilder('m')
      .select('m.sessionId', 'sessionId')
      .addSelect('COUNT(1)', 'count')
      .where('m.sessionId IN (:...sessionIds)', { sessionIds })
      .groupBy('m.sessionId')
      .getRawMany<{ sessionId: string; count: string | number }>();
    for (const row of rows) map.set(row.sessionId, Number(row.count));
    return map;
  }
}
