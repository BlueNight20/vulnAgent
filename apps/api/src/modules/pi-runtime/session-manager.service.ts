import { serialSave } from '../../database/serial-transaction';
import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
  AgentRole,
  SessionDto,
  SessionState,
  StateCard,
  WorkerProfileId,
} from '@vulnagent/shared';
import { AgentSessionEntity, HintEntity, TaskEntity, WorkerTaskEntity } from '../../database/entities';
import { runtimeEnabled } from '../../database/runtime-control';
import { HintsService } from '../blackboard/hints.service';
import { adoptTaskAccounting, sessionAccounting } from '../../database/model-accounting';
import { serialTransaction } from '../../database/serial-transaction';
import { newId, toIso } from '../../common/utils/id';
import { AuditService } from '../audit/audit.service';
import { EventsGateway } from '../events/events.gateway';
import { ModelGatewayService } from '../model-gateway/model-gateway.service';
import {
  extractText,
  type PiAgentEvent,
  type PiAgentLike,
  type PiAgentMessage,
  type PiToolDefinition,
  type PiToolResultMessage,
} from './pi-types';
import { SessionStoreService } from './session-store.service';
import { loadPiAgentCore } from './esm-loader';

interface AgentRuntimeHandle {
  agent: PiAgentLike;
  unsubscribe: () => void;
  entity: AgentSessionEntity;
  serverSideToolResultIds: Set<string>;
  queuedHintIds: Set<string>;
}

export interface CreateSessionOptions {
  tokenAllowance?: number;
  taskId: string;
  role: AgentRole;
  profileId?: WorkerProfileId | null;
  parentSessionId?: string | null;
  modelName: string;
  systemPrompt: string;
  tools: PiToolDefinition[];
  /** 生成一条 assistant 消息时的回调（用于提取 Result Card 等） */
  onAssistantMessage?: (message: PiAgentMessage, session: AgentSessionEntity) => void | Promise<void>;
  /** 工具执行结束回调 */
  onToolResult?: (message: PiToolResultMessage, session: AgentSessionEntity) => void | Promise<void>;
}

export type SessionEventSink = (event: PiAgentEvent, session: AgentSessionEntity) => void;

/**
 * SessionManager：管理 Pi Agent 实例的真实生命周期。
 * 内存持有 AgentHandle，数据库为唯一真相源。
 */
@Injectable()
export class SessionManagerService {
  private readonly logger = new Logger(SessionManagerService.name);
  private readonly handles = new Map<string, AgentRuntimeHandle>();
  private readonly sinks = new Map<string, SessionEventSink>();

  constructor(
    @InjectRepository(AgentSessionEntity)
    private readonly sessions: Repository<AgentSessionEntity>,
    readonly store: SessionStoreService,
    private readonly modelGateway: ModelGatewayService,
    private readonly gateway: EventsGateway,
    private readonly audit: AuditService,
    @Optional() private readonly hints?: HintsService,
  ) { this.hints?.setDeliveryHandler((hint) => this.queueHint(hint)); }

  /** 启动时清理进程重启遗留的 running 会话 */
  async reconcile(): Promise<number> {
    const orphans = await this.sessions.find({ where: { state: In(['created', 'running', 'paused']) } });
    for (const session of orphans) {
      session.state = 'failed';
      session.errorMessage = '进程重启，会话中断';
      session.endedAt = new Date();
      await serialSave(this.sessions, session);
    }
    if (orphans.length > 0) {
      this.logger.warn(`已标记 ${orphans.length} 个遗留活动会话为 failed；请通过任务控制人工恢复`);
    }
    return orphans.length;
  }

  setEventSink(sessionId: string, sink: SessionEventSink): void {
    this.sinks.set(sessionId, sink);
  }

  hasHandle(sessionId: string): boolean {
    return this.handles.has(sessionId);
  }

  async createAndStart(options: CreateSessionOptions, initialPrompt: string): Promise<SessionDto> {
    await this.modelGateway.assertRuntimeEnabled();
    const entity = await this.createRecord(options);
    const dto = await this.start(entity, options, initialPrompt);
    return dto;
  }

  /** 仅创建数据库记录（不启动 Agent），用于排队中的 Worker */
  async createRecord(options: CreateSessionOptions): Promise<AgentSessionEntity> {
    const saved = await serialTransaction(this.sessions.manager, async (manager) => {
    const task = await manager.findOne(TaskEntity, { where: { id: options.taskId } });
    if (!task) throw new NotFoundException('任务不存在');
    await adoptTaskAccounting(manager, task);
    const entity = manager.create(AgentSessionEntity, {
      id: newId(),
      taskId: options.taskId,
      role: options.role,
      profileId: options.profileId ?? null,
      parentSessionId: options.parentSessionId ?? null,
      sessionKey: `${options.taskId.slice(0, 8)}-${options.role}-${newId().slice(0, 8)}`,
      modelName: options.modelName.trim() || task.modelName.trim(),
      state: 'created',
      tokenInput: 0,
      tokenAllowance: options.tokenAllowance ?? null, budgetManaged: true, budgetEpoch: task.budgetEpoch,
      baselineInput: 0, baselineOutput: 0, baselineCost: 0,
      tokenOutput: 0,
      costUsd: 0,
      stateCard: null,
      errorMessage: null,
    });
    return manager.save(entity);
    });
    this.gateway.broadcast('session.created', await this.toDto(saved));
    return saved;
  }

  /** 启动（或恢复）一个 Session，并发送首条用户消息 */
  async start(
    entity: AgentSessionEntity,
    options: CreateSessionOptions,
    initialPrompt: string | null,
  ): Promise<SessionDto> {
    await this.modelGateway.assertRuntimeEnabled();
    if (!entity.budgetManaged) {
      await serialTransaction(this.sessions.manager, async (manager) => {
        const task = await manager.findOneOrFail(TaskEntity, { where: { id: entity.taskId } });
        await adoptTaskAccounting(manager, task);
        entity.budgetManaged = true; entity.budgetEpoch = task.budgetEpoch;
        entity.baselineInput = entity.tokenInput; entity.baselineOutput = entity.tokenOutput; entity.baselineCost = entity.costUsd;
        entity.tokenAllowance = options.tokenAllowance ?? null;
        await manager.save(entity);
      });
    }
    const agentCore = (await loadPiAgentCore()) as unknown as {
      Agent: new (opts: Record<string, unknown>) => PiAgentLike;
    };
    const { Agent } = agentCore;
    const model = await this.modelGateway.getModel(entity.modelName);
    entity.modelName = model.id;
    const streamFn = await this.modelGateway.createStreamFn(entity.id);

    const history = await this.store.loadMessages(entity.id);
    const agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model,
        thinkingLevel: 'low',
        tools: options.tools,
        messages: history,
      },
      streamFn,
      sessionId: entity.sessionKey,
      getApiKey: () => this.modelGateway.getApiKey(),
      toolExecution: 'sequential',
    });

    const handle: AgentRuntimeHandle = {
      agent,
      unsubscribe: () => undefined,
      entity,
      serverSideToolResultIds: new Set<string>(),
      queuedHintIds: new Set<string>(),
    };

    const unsubscribe = agent.subscribe(async (event) => {
      await this.handleEvent(handle, event, options);
    });
    handle.unsubscribe = unsubscribe;

    this.handles.set(entity.id, handle);
    entity.state = 'running';
    entity.startedAt = entity.startedAt ?? new Date();
    entity.endedAt = null;
    entity.errorMessage = null;
    await serialSave(this.sessions, entity);
    await this.store.appendEvent(entity.id, entity.taskId, 'lifecycle', { action: 'started' });
    this.gateway.broadcast('session.updated', await this.toDto(entity));

    if (initialPrompt) {
      void this.runPrompt(handle, initialPrompt);
    }
    return this.toDto(entity);
  }

  /** 向空闲的编排会话追加用户消息并驱动模型。活动流的提示必须使用 steer。 */
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) throw new NotFoundException('会话未在运行，无法发送消息');
    void this.runPrompt(handle, text);
  }

  /** Admission to the SDK queue is not consumption. message_end commits the durable receipt. */
  async queueHint(candidate: HintEntity, allowIdle = false): Promise<void> {
    if (!candidate.agentSessionId) return;
    const handle = this.handles.get(candidate.agentSessionId);
    if (!handle || handle.queuedHintIds.has(candidate.id)) return;
    await serialTransaction(this.sessions.manager, async (manager) => {
      const hint = await manager.findOneBy(HintEntity, { id: candidate.id, taskId: handle.entity.taskId, agentSessionId: handle.entity.id, status: 'pending' });
      if (!hint || !await runtimeEnabled(manager)) return;
      const task = await manager.findOneBy(TaskEntity, { id: hint.taskId, status: 'running', engineStatus: 'running' });
      const session = await manager.findOneBy(AgentSessionEntity, { id: handle.entity.id, taskId: hint.taskId, state: 'running' });
      if (!task || !session) return;
      if (session.role !== 'planner') {
        const worker = await manager.findOneBy(WorkerTaskEntity, { taskId: hint.taskId, sessionId: session.id, status: 'running' });
        if (!worker?.leaseExpiresAt || worker.leaseExpiresAt.getTime() <= Date.now()) return;
      }
      // No await between final handle checks and synchronous queue insertion.
      if (this.handles.get(session.id) !== handle || handle.entity.state !== 'running' || (!allowIdle && !handle.agent.state.isStreaming) || handle.queuedHintIds.has(hint.id)) return;
      handle.agent.steer({ role: 'user', content: `人工提示（仅供当前会话参考，仍须遵守授权范围、权限和预算）：\n${hint.content}`, timestamp: Date.now(), hintId: hint.id });
      handle.queuedHintIds.add(hint.id);
    });
  }

  private async runPrompt(handle: AgentRuntimeHandle, text: string): Promise<void> {
    try {
      await handle.agent.prompt(text);
    } catch (error) {
      if (this.handles.get(handle.entity.id) === handle && handle.entity.state === 'running') await this.markFailed(handle.entity, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 事件处理：持久化消息与事件、记账、广播。
   * 注意：agent 自身的 tool 执行消息由 Pi 生成，这里只做持久化与通知。
   */
  private async handleEvent(
    handle: AgentRuntimeHandle,
    event: PiAgentEvent,
    options: CreateSessionOptions,
  ): Promise<void> {
    const session = handle.entity;
    if (this.handles.get(session.id) !== handle || ['paused', 'failed', 'terminated'].includes(session.state)) return;
    try {
      switch (event.type) {
        case 'message_end': {
          const message = event.message;
          if (message.role === 'user' && message.hintId) {
            try { await this.store.appendHintMessage(session, message); }
            catch (error) {
              await this.interruptAsFailed(session.id, `人工提示接收未能保存：${error instanceof Error ? error.message : String(error)}`);
              throw error;
            }
            break;
          }
          if (message.role === 'system') {
            await this.store.appendMessage(session, message);
            break;
          }
          const meta =
            message.role === 'toolResult'
              ? { toolCallId: message.toolCallId, toolName: message.toolName }
              : undefined;
          await this.store.appendMessage(session, message, meta);
          if (message.role === 'assistant') {
            await this.store.recordUsage(session, message, message.durationMs ?? 0);
            if (options.onAssistantMessage) await options.onAssistantMessage(message, session);
            if (message.stopReason === 'toolUse') {
              try { await this.modelGateway.assertToolBudget(session.id); }
              catch (error) { await this.interruptAsFailed(session.id, error instanceof Error ? error.message : String(error)); }
            }
          }
          if (message.role === 'toolResult' && options.onToolResult) {
            await options.onToolResult(message, session);
          }
          break;
        }
        case 'tool_execution_start':
          await this.store.appendEvent(session.id, session.taskId, 'tool_execution_start', {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
          break;
        case 'tool_execution_end':
          await this.store.appendEvent(session.id, session.taskId, 'tool_execution_end', {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            durationMs: event.durationMs ?? null,
          });
          break;
        case 'turn_end':
          await this.store.appendEvent(session.id, session.taskId, 'turn_end', {
            role: event.message.role,
            toolResults: event.toolResults.length,
          });
          break;
        case 'agent_end': {
          await this.store.appendEvent(session.id, session.taskId, 'agent_end', {
            messages: event.messages.length,
          });
          // Agent 自然结束（模型输出了最终回答）：必须把会话状态从 running 推进到终态，
          // 否则 Worker 的 watchCompletion 会一直等不到结束，任务永久卡在 executing。
          const lastAssistant = [...event.messages].reverse().find((m) => m.role === 'assistant') as
            | { stopReason?: string; errorMessage?: string }
            | undefined;
          const stoppedWithError = lastAssistant?.stopReason === 'error';
          this.logger.log(
            `[session:${session.id.slice(0, 8)}:${session.role}] agent_end，消息 ${event.messages.length} 条，` +
              `最后 assistant stopReason=${lastAssistant?.stopReason ?? 'none'}，准备推进到 ${
                stoppedWithError ? 'failed' : 'completed'
              }`,
          );
          try {
            if (stoppedWithError) {
              await this.markFailed(session, lastAssistant?.errorMessage ?? '模型返回错误，会话终止');
            } else {
              // 关键：此处正处于 agent 事件回调内，跳 waitForIdle 以避免自等待死锁
              await this.markCompleted(session.id, { skipWaitForIdle: true });
            }
            this.logger.log(`[session:${session.id.slice(0, 8)}:${session.role}] 状态已更新为 ${
              stoppedWithError ? 'failed' : 'completed'
            }`);
          } catch (innerError) {
            this.logger.error(
              `[session:${session.id.slice(0, 8)}:${session.role}] 推进终态失败：${
                innerError instanceof Error ? innerError.message : String(innerError)
              }`,
            );
            throw innerError;
          }
          break;
        }
        case 'agent_start':
          await this.store.appendEvent(session.id, session.taskId, 'agent_start', null);
          break;
        default:
          break;
      }

      const sink = this.sinks.get(session.id);
      if (sink) sink(event, session);
    } catch (error) {
      this.logger.error(
        `[session:${session.id}:${session.role}] 处理事件 ${event.type} 失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async pause(sessionId: string): Promise<SessionDto> {
    const handle = this.handles.get(sessionId);
    const entity = handle?.entity ?? (await this.findEntity(sessionId));
    entity.state = 'paused';
    await serialSave(this.sessions, entity);
    if (handle) {
      handle.agent.abort();
      await handle.agent.waitForIdle();
      handle.agent.clearSteeringQueue();
      handle.queuedHintIds.clear();
    }
    entity.state = 'paused';
    await serialSave(this.sessions, entity);
    await this.store.appendEvent(sessionId, entity.taskId, 'lifecycle', { action: 'paused' });
    this.gateway.broadcast('session.updated', await this.toDto(entity));
    return this.toDto(entity);
  }

  /**
   * 恢复：实测结论 —— continue() 在末尾为 assistant 时会抛错，
   * 必须先追加一条 user 消息再 continue()。
   */
  async resume(sessionId: string): Promise<SessionDto> {
    await this.modelGateway.assertRuntimeEnabled();
    let handle = this.handles.get(sessionId);
    const entity = handle?.entity ?? (await this.findEntity(sessionId));

    if (!handle) {
      throw new NotFoundException('会话实例已不存在，无法恢复；请重新启动任务');
    }

    entity.state = 'running';
    await serialSave(this.sessions, entity);

    // Explicit resume may re-admit hints discarded by abort before the SDK accepted them.
    const waitingHints = await this.sessions.manager.find(HintEntity, { where: { taskId: entity.taskId, agentSessionId: entity.id, status: 'pending' }, order: { createdAt: 'ASC', id: 'ASC' } });
    for (const hint of waitingHints) await this.queueHint(hint, true);

    const messages = handle.agent.state.messages;
    const last = messages[messages.length - 1];
    const resumeMessage: PiAgentMessage = {
      role: 'user',
      content: '继续执行你的任务，基于已有事实推进下一步。',
      timestamp: Date.now(),
    };
    if (!last || last.role === 'assistant') {
      handle.agent.state.messages = [...messages, resumeMessage];
    }
    try {
      await handle.agent.continue();
    } catch (error) {
      await this.markFailed(entity, error instanceof Error ? error.message : String(error));
      throw error;
    }
    await this.store.appendEvent(sessionId, entity.taskId, 'lifecycle', { action: 'resumed' });
    this.gateway.broadcast('session.updated', await this.toDto(entity));
    return this.toDto(entity);
  }

  async terminate(sessionId: string, reason = '已完成'): Promise<SessionDto> {
    const handle = this.handles.get(sessionId);
    const entity = handle?.entity ?? (await this.findEntity(sessionId));
    if (handle) {
      // 先解除订阅再 abort：否则 abort 过程中触发的事件仍会写库，
      // 与 terminate 自身的 SQLite 写入并发，会与原生句柄析构竞争并触发
      // `RemoveEnvironmentCleanupHook: Assertion failed` 进程级崩溃。
      handle.unsubscribe();
      handle.agent.abort();
      try {
        await handle.agent.waitForIdle();
      } catch {
        /* 中止过程中的异常不影响清理 */
      }
      this.handles.delete(sessionId);
    }
    this.sinks.delete(sessionId);
    this.store.releaseSeq(sessionId);
    entity.state = 'terminated';
    entity.endedAt = new Date();
    await serialSave(this.sessions, entity);
    await this.store.appendEvent(sessionId, entity.taskId, 'lifecycle', { action: 'terminated', reason });
    this.gateway.broadcast('session.ended', await this.toDto(entity));
    return this.toDto(entity);
  }

  /** May be called from an awaited tool-result callback: abort without waiting on that same callback. */
  async interruptAsFailed(sessionId: string, reason: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    const entity = handle?.entity ?? await this.findEntity(sessionId);
    if (['completed', 'failed', 'terminated'].includes(entity.state)) return;
    if (handle) { handle.unsubscribe(); this.handles.delete(sessionId); handle.agent.abort(); }
    this.sinks.delete(sessionId);
    this.store.releaseSeq(sessionId);
    await this.markFailed(entity, reason);
  }

  /**
   * 标记会话完成。
   *
   * `skipWaitForIdle` 必须为 true 当调用方就在 agent 事件回调内：
   * 事件订阅者会被 await，此时再 waitForIdle() 会等待自己，形成死锁
   * （曾经导致 agent 已结束但会话永久停在 running）。
   */
  async markCompleted(sessionId: string, options: { skipWaitForIdle?: boolean } = {}): Promise<void> {
    const handle = this.handles.get(sessionId);
    const entity = handle?.entity ?? (await this.findEntity(sessionId));
    if (['failed', 'terminated', 'paused', 'completed'].includes(entity.state)) return;
    if (handle) {
      if (!options.skipWaitForIdle) {
        try {
          await handle.agent.waitForIdle();
        } catch {
          /* 已完成 */
        }
      }
      handle.unsubscribe();
      this.handles.delete(sessionId);
    }
    entity.state = 'completed';
    entity.endedAt = new Date();
    await serialSave(this.sessions, entity);
    await this.store.appendEvent(sessionId, entity.taskId, 'lifecycle', { action: 'completed' });
    this.gateway.broadcast('session.ended', await this.toDto(entity));
  }

  async markFailed(entity: AgentSessionEntity, error: string): Promise<void> {
    const handle = this.handles.get(entity.id);
    if (handle) {
      handle.unsubscribe();
      this.handles.delete(entity.id);
    }
    entity.state = 'failed';
    entity.errorMessage = error;
    entity.endedAt = new Date();
    await serialSave(this.sessions, entity);
    await this.store.appendEvent(entity.id, entity.taskId, 'lifecycle', { action: 'failed', error });
    this.gateway.broadcast('session.updated', await this.toDto(entity));
    await this.audit.record({
      action: 'session.failed',
      entityType: 'agent_session',
      entityId: entity.id,
      taskId: entity.taskId,
      result: 'failure',
      detail: { role: entity.role, error },
    });
  }

  async updateStateCard(sessionId: string, patch: Partial<StateCard>): Promise<void> {
    const handle = this.handles.get(sessionId);
    const entity = handle?.entity ?? (await this.findEntity(sessionId));
    entity.stateCard = { ...(entity.stateCard ?? {}), ...patch, updatedAt: new Date().toISOString() };
    await serialSave(this.sessions, entity);
    this.gateway.broadcast('session.updated', await this.toDto(entity));
  }

  async listByTask(taskId: string): Promise<SessionDto[]> {
    const rows = await this.sessions.find({ where: { taskId }, order: { createdAt: 'ASC' } });
    const counts = await this.countMessages(rows.map((r) => r.id));
    return Promise.all(rows.map(async (row) => { await this.refreshAccounting(row); return this.mapDto(row, counts.get(row.id) ?? 0); }));
  }

  async findOne(sessionId: string): Promise<SessionDto> {
    const entity = await this.findEntity(sessionId);
    return this.toDto(entity);
  }

  async findByTaskAndRole(taskId: string, role: AgentRole): Promise<AgentSessionEntity[]> {
    return this.sessions.find({ where: { taskId, role }, order: { createdAt: 'ASC' } });
  }

  getEntity(sessionId: string): AgentSessionEntity | undefined {
    return this.handles.get(sessionId)?.entity;
  }

  getAgent(sessionId: string): PiAgentLike | undefined {
    return this.handles.get(sessionId)?.agent;
  }

  /** 当前活跃句柄数量 */
  get activeCount(): number {
    return this.handles.size;
  }

  private async findEntity(sessionId: string): Promise<AgentSessionEntity> {
    const entity = await this.sessions.findOne({ where: { id: sessionId } });
    if (!entity) throw new NotFoundException('会话不存在');
    return entity;
  }

  private async countMessages(ids: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (ids.length === 0) return map;
    const rows = await this.store.listMessagesBySessions(ids);
    for (const [id, count] of rows) map.set(id, count);
    return map;
  }

  async toDto(entity: AgentSessionEntity): Promise<SessionDto> {
    await this.refreshAccounting(entity);
    const count = await this.store.countMessages(entity.id);
    return this.mapDto(entity, count);
  }

  private async refreshAccounting(entity: AgentSessionEntity): Promise<void> {
    if (entity.budgetManaged) {
      const usage = await sessionAccounting(this.sessions.manager, entity);
      entity.tokenInput = usage.input; entity.tokenOutput = usage.output; entity.costUsd = usage.cost;
      (entity as AgentSessionEntity & { tokensCommitted?: number }).tokensCommitted = usage.committed;
    }
  }

  private mapDto(entity: AgentSessionEntity, messageCount: number): SessionDto {
    return {
      id: entity.id,
      taskId: entity.taskId,
      role: entity.role,
      profileId: entity.profileId,
      parentSessionId: entity.parentSessionId,
      sessionKey: entity.sessionKey,
      modelName: entity.modelName,
      state: entity.state as SessionState,
      tokenInput: entity.tokenInput,
      tokenOutput: entity.tokenOutput,
      costUsd: entity.costUsd,
      stateCard: entity.stateCard,
      errorMessage: entity.errorMessage,
      startedAt: toIso(entity.startedAt),
      endedAt: toIso(entity.endedAt),
      createdAt: toIso(entity.createdAt) ?? '',
      messageCount,
      tokenAllowance: entity.tokenAllowance ?? null,
      tokensCommitted: (entity as AgentSessionEntity & { tokensCommitted?: number }).tokensCommitted ?? 0,
      budgetManaged: entity.budgetManaged ?? false,
    };
  }
}

export { extractText };
export type { PiToolDefinition };
