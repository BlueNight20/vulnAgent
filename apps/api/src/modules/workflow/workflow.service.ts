import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  AgentRole,
  WorkflowEdgeDto,
  WorkflowGraphDto,
  WorkflowNodeDto,
} from '@vulnagent/shared';
import {
  AgentSessionEntity,
  AgentSessionMessageEntity,
  EvidenceEntity,
  IntentEntity,
  TaskEntity,
  WorkerTaskEntity,
} from '../../database/entities';
import { nowIso, toIso } from '../../common/utils/id';
import { OrchestratorService } from '../orchestrator/orchestrator.service';

/**
 * 工作流图：完全由数据库真实记录生成，没有任何硬编码节点。
 * Orchestrator 节点来自运行快照，Planner 与 Worker 节点来自 agent_sessions，
 * 连线来自 intent 归属与 worker_tasks 依赖。
 */
@Injectable()
export class WorkflowService {
  constructor(
    @InjectRepository(TaskEntity) private readonly tasks: Repository<TaskEntity>,
    @InjectRepository(AgentSessionEntity) private readonly sessions: Repository<AgentSessionEntity>,
    @InjectRepository(WorkerTaskEntity) private readonly workers: Repository<WorkerTaskEntity>,
    @InjectRepository(IntentEntity) private readonly intents: Repository<IntentEntity>,
    @InjectRepository(EvidenceEntity) private readonly evidence: Repository<EvidenceEntity>,
    private readonly orchestrator: OrchestratorService,
  ) {}

  async graph(taskId: string): Promise<WorkflowGraphDto> {
    const task = await this.tasks.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException('任务不存在');

    const engine = await this.orchestrator.snapshot(taskId).catch(() => null);
    const [sessions, workers, intents] = await Promise.all([
      this.sessions.find({ where: { taskId }, order: { createdAt: 'ASC' } }),
      this.workers.find({ where: { taskId }, order: { createdAt: 'ASC' } }),
      this.intents.find({ where: { taskId } }),
    ]);

    const evidenceRows = await this.evidence.find({
      where: { taskId },
      select: ['id', 'agentSessionId'],
    });
    const evidenceBySession = new Map<string, number>();
    for (const row of evidenceRows) {
      if (!row.agentSessionId) continue;
      evidenceBySession.set(row.agentSessionId, (evidenceBySession.get(row.agentSessionId) ?? 0) + 1);
    }

    const nodes: WorkflowNodeDto[] = [];
    const edges: WorkflowEdgeDto[] = [];

    // 根节点：Orchestrator（始终真实存在，状态来自引擎快照）
    nodes.push({
      id: 'orchestrator',
      kind: 'orchestrator',
      label: 'Orchestrator Core',
      role: 'orchestrator' as AgentRole,
      profileId: null,
      status: engine?.orchestratorStatus ?? 'idle',
      title: `第 ${engine?.cycle ?? 0} 轮编排`,
      tokens: engine?.tokensUsed ?? 0,
      durationMs: engine ? engine.elapsedSeconds * 1000 : null,
      evidenceCount: evidenceRows.length,
      detail: {
        stopReason: engine?.stopReason ?? null,
        activeWorkers: engine?.activeWorkers ?? 0,
        maxConcurrency: engine?.maxConcurrency ?? task.workerCount,
        factCounts: engine?.factCounts ?? null,
        intentCounts: engine?.intentCounts ?? null,
      },
    });

    const plannerSessions = sessions.filter((s) => s.role === 'planner');
    for (const planner of plannerSessions) {
      const [input, output] = await Promise.all(['user', 'assistant'].map((role) =>
        this.sessions.manager.findOne(AgentSessionMessageEntity, {
          where: { taskId, sessionId: planner.id, role: role as 'user' | 'assistant' },
          select: ['id', 'seq', 'content'], order: { seq: 'DESC' },
        })));
      const preview = (message: AgentSessionMessageEntity | null) => message
        ? { messageId: message.id, seq: message.seq, textPreview: message.content, note: '最多 8000 字符预览；完整结构化消息见智能体工作台的此会话' } : null;
      nodes.push({
        id: planner.id,
        kind: 'planner',
        label: 'Planner',
        role: 'planner',
        profileId: null,
        status: planner.state,
        title: planner.stateCard?.phase ?? '规划',
        tokens: planner.tokenInput + planner.tokenOutput,
        durationMs: planner.startedAt
          ? (planner.endedAt ? planner.endedAt.getTime() : Date.now()) - planner.startedAt.getTime()
          : null,
        evidenceCount: evidenceBySession.get(planner.id) ?? 0,
        detail: {
          sessionKey: planner.sessionKey,
          sessionId: planner.id,
          model: planner.modelName,
          input: preview(input),
          output: preview(output),
          stateCard: planner.stateCard,
          error: planner.errorMessage,
        },
      });
      edges.push({
        id: `edge-orch-${planner.id}`,
        source: 'orchestrator',
        target: planner.id,
        kind: 'intent',
        label: '请求规划',
      });
    }

    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    const intentById = new Map(intents.map((i) => [i.id, i]));
    const visibleWorkers = workers.filter((worker) => worker.sessionId && sessionById.has(worker.sessionId));
    const workerBySession = new Map(visibleWorkers.map((worker) => [worker.sessionId!, worker]));
    const visibleWorkerIds = new Set(visibleWorkers.map((worker) => worker.id));

    for (const worker of workers) {
      const session = worker.sessionId ? sessionById.get(worker.sessionId) : undefined;
      const intent = worker.intentId ? intentById.get(worker.intentId) : undefined;
      if (!session) continue;
      nodes.push({
        id: worker.id,
        kind: 'worker',
        label: session.profileId ?? session.role,
        role: session.role,
        profileId: session.profileId,
        status: worker.status,
        title: worker.title,
        tokens: worker.tokensSpent,
        durationMs: worker.startedAt
          ? (worker.endedAt ? worker.endedAt.getTime() : Date.now()) - worker.startedAt.getTime()
          : null,
        evidenceCount: evidenceBySession.get(session.id) ?? 0,
        detail: {
          sessionId: session.id,
          intentId: worker.intentId,
          objective: intent?.objective ?? '',
          hypothesis: intent?.hypothesis ?? '',
          score: intent?.score ?? null,
          scoreBreakdown: intent?.scoreBreakdown ?? null,
          attempt: worker.attempt,
          maxAttempts: worker.maxAttempts,
          error: worker.errorMessage,
          input: worker.input,
          output: worker.output,
          resultCardId: worker.resultCardId,
        },
      });

      // Use persisted provenance, never the first/nearest Planner as a guessed producer.
      const producer = intent?.agentSessionId ? sessionById.get(intent.agentSessionId) : undefined;
      const producerWorker = producer ? workerBySession.get(producer.id) : undefined;
      const parentId = worker.parentWorkerTaskId && visibleWorkerIds.has(worker.parentWorkerTaskId)
        ? worker.parentWorkerTaskId : producerWorker?.id;
      if (parentId && parentId !== worker.id) {
        edges.push({
          id: `edge-worker-${parentId}-${worker.id}`,
          source: parentId,
          target: worker.id,
          kind: 'dependency',
          label: worker.parentWorkerTaskId === parentId ? '依赖' : '后续意图',
        });
      } else if (producer?.role === 'planner') {
        edges.push({
          id: `edge-planner-${worker.id}`,
          source: producer.id,
          target: worker.id,
          kind: 'intent',
          label: intent?.title?.slice(0, 16) ?? '派发',
        });
      } else {
        edges.push({
          id: `edge-orch-${worker.id}`,
          source: 'orchestrator',
          target: worker.id,
          kind: 'dependency',
          label: '派发',
        });
      }

      // Explicit prerequisite intents can add separate branches. Use only a completed
      // predecessor already ended when this Worker started; later retries are not its dependency.
      const boundary = worker.startedAt ?? worker.createdAt;
      for (const dependencyId of new Set(intent?.dependencies ?? [])) {
        const predecessor = visibleWorkers.filter((candidate) => candidate.id !== worker.id
          && candidate.intentId === dependencyId && candidate.status === 'succeeded'
          && candidate.endedAt && candidate.endedAt.getTime() <= boundary.getTime())
          .sort((a, b) => b.endedAt!.getTime() - a.endedAt!.getTime())[0];
        if (!predecessor || edges.some((edge) => edge.source === predecessor.id && edge.target === worker.id)) continue;
        edges.push({ id: `edge-prerequisite-${predecessor.id}-${worker.id}`, source: predecessor.id, target: worker.id, kind: 'dependency', label: '前置意图' });
      }

      if ((evidenceBySession.get(session.id) ?? 0) > 0) {
        edges.push({
          id: `edge-evidence-${worker.id}`,
          source: worker.id,
          target: 'orchestrator',
          kind: 'evidence',
          label: `${evidenceBySession.get(session.id)} 条证据`,
        });
      }
    }

    return {
      source: 'live',
      taskId,
      taskName: task.name,
      taskStatus: task.status,
      engine,
      nodes,
      edges,
      generatedAt: nowIso(),
    };
  }
}
