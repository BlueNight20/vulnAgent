import { ToolCatalogService } from '../tool/tool-catalog.service';
import { recoverToolSelection } from './tool-recovery';
import { Injectable, Logger } from '@nestjs/common';
import { requireRuntime } from '../../database/runtime-control';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import type { HintDto, IntentDto, WorkerProfileId } from '@vulnagent/shared';
import { EvidenceIngestionService } from '../blackboard/evidence-ingestion.service';
import { FindingsService } from '../blackboard/findings.service';
import { AttackSurfaceService } from '../blackboard/attack-surface.service';
import { TaskGoalsService } from '../blackboard/task-goals.service';
import type { PiToolResult } from '../pi-runtime/pi-types';
import { EvidenceEntity, TargetEntity, ToolCallEntity } from '../../database/entities';
import { recentToolSummary } from './tool-history';
import { buildWorkerTools } from './worker-tools';
import { ToolInvoker } from '../tool/tool-invoker';
import { ToolRecorder } from '../tool/tool-recorder';
import { FactsService } from '../blackboard/facts.service';
import { HintsService } from '../blackboard/hints.service';
import { HypothesisService } from '../blackboard/hypothesis.service';
import { IntentsService } from '../blackboard/intents.service';
import { WorkerStateService } from '../blackboard/worker-state.service';
import { SessionManagerService } from '../pi-runtime/session-manager.service';
import { buildWorkerSystemPrompt, buildWorkerTaskPrompt } from '../worker-skills/prompt-builder';
import { WorkerSkillsService } from '../worker-skills/worker-skills.service';
import { getProfile } from '../worker-skills/profiles';
import { fallbackWorkerResult, parseWorkerResult, type ParsedWorkerResult } from './result-parser';
import { WorkerExecutionBudget } from './worker-execution-budget';

export interface WorkerRunInput {
  taskId: string;
  intent: IntentDto;
  targetIps: string[];
  workerTaskId: string;
  tokenAllowance: number;
  onFinished: (workerTaskId: string, sessionId: string) => void;
}

export interface WorkerRunHandle {
  workerTaskId: string;
  sessionId: string;
}

/** 最终回答后等待多久判定会话已结束（防止落库延迟被误判） */
const FINAL_ANSWER_GRACE_MS = 60_000;

/**
 * 等待工具结果的最长容忍时间。
 * 需大于单次工具执行超时（默认 300s）+ 模型下一轮推理时间；
 * 超过则判定工具结果回填丢失，强制收尾而非无限等待。
 */
const TOOL_WAIT_TIMEOUT_MS = 420_000;

/**
 * Worker 执行器：
 * - 根据 Intent 的 profileId 动态加载专业能力与工具集合
 * - 把 MCP 工具包装成 Pi AgentTool，真实执行并回收证据
 * - 会话结束后解析结构化结果，写入事实、假设、结果卡与后续意图
 */
@Injectable()
export class WorkerRunnerService {
  private readonly logger = new Logger(WorkerRunnerService.name);

  constructor(
    @InjectRepository(TargetEntity) private readonly targets: Repository<TargetEntity>,
    @InjectRepository(EvidenceEntity) private readonly evidence: Repository<EvidenceEntity>,
    private readonly sessions: SessionManagerService,
    private readonly skills: WorkerSkillsService,
    private readonly toolInvoker: ToolInvoker,
    private readonly toolRecorder: ToolRecorder,
    private readonly facts: FactsService,
    private readonly hypotheses: HypothesisService,
    private readonly intents: IntentsService,
    private readonly hints: HintsService,
    private readonly workers: WorkerStateService,
    private readonly ingestion: EvidenceIngestionService,
    private readonly findings: FindingsService,
    private readonly surface: AttackSurfaceService,
    private readonly goals: TaskGoalsService,
    private readonly catalog: ToolCatalogService,
  ) {}

  async launch(input: WorkerRunInput): Promise<WorkerRunHandle> {
    await requireRuntime(this.evidence.manager);
    await this.catalog.sync();
    const { intent } = input;
    const profileId: WorkerProfileId = intent.workerProfileId;
    const profile = getProfile(profileId);
    const resolved = await this.skills.resolve(profileId, intent.suggestedTools, input.taskId);
    const history = await this.evidence.manager.find(ToolCallEntity, { where: { taskId: input.taskId }, order: { createdAt: 'DESC' }, take: 200 });
    const recovery = recoverToolSelection(resolved.tools, await this.skills.catalogToolNames(), history, intent.targetIp);
    const permitted = await this.skills.resolve(profileId, recovery.tools, input.taskId);
    resolved.tools = recovery.tools.filter((name) => permitted.tools.includes(name));

    const authorizedTargets = (
      await this.targets.find({ where: { taskId: input.taskId, inScope: true } })
    ).map((t) => t.ip);

    const evidenceIds: string[] = [];
    const executionBudget = new WorkerExecutionBudget();
    // 会话 ID 在 createRecord 之前不可知，用闭包变量延迟绑定：
    // 工具执行时读取的是当前值，保证调用记录归属正确。
    let boundSessionId: string | null = null;
    const bindSession = (id: string) => {
      boundSessionId = id;
    };
    const toolDefs = this.buildToolDefinitions(
      resolved.tools,
      profileId,
      input,
      authorizedTargets,
      evidenceIds,
      () => boundSessionId,
      executionBudget,
    );

    const systemPrompt = buildWorkerSystemPrompt(profile, [...new Set([...input.targetIps, ...(intent.targetIp ? [intent.targetIp] : [])])], resolved.tools);
    const allFacts = await this.facts.listByTask(input.taskId, 40);
    const relatedHypotheses = await this.hypotheses.list(input.taskId);
    const evidenceBrief = await this.buildEvidenceBrief(input.taskId);
    const taskPrompt = recovery.notes.join('\n') + '\n' + buildWorkerTaskPrompt(
      intent,
      allFacts,
      relatedHypotheses,
      [],
      evidenceBrief,
      await this.surface.summary(input.taskId),
      await this.goals.summary(input.taskId),
      recentToolSummary(await this.evidence.manager.find(ToolCallEntity, { where: { taskId: input.taskId }, order: { createdAt: 'DESC' }, take: 20 })),
    );

    const session = await this.sessions.createRecord({
      tokenAllowance: input.tokenAllowance,
      taskId: input.taskId,
      role: profile.role,
      profileId,
      parentSessionId: null,
      modelName: '',
      systemPrompt,
      tools: toolDefs,
    });
    try {
    // SessionManager 在排队时继承任务模型，不能用字面量 default 覆盖任务选择。
    const modelName = session.modelName;
    // 工具定义在会话创建前构建，此处回填会话 ID，
    // 保证工具调用记录能正确归属到本 Worker 会话（用于去重复用与追溯）。
    bindSession(session.id);
    await this.workers.attachSession(input.workerTaskId, session.id);
    await this.skills.recordLoad({
      taskId: input.taskId,
      sessionId: session.id,
      profileId,
      skillIds: profile.skills.map((s) => s.id),
      allowedTools: resolved.tools,
      expectedEvidence: profile.expectedEvidence,
      tokenBudget: input.tokenAllowance,
      promptVersion: profile.promptVersion,
    });

    await this.sessions.updateStateCard(session.id, {
      currentIntentId: intent.id,
      currentIntentTitle: intent.title,
      phase: '执行任务',
      plan: profile.skills.map((s) => s.name),
      toolCallCount: 0,
    });

    await this.sessions.start(
      session,
      {
        tokenAllowance: input.tokenAllowance,
        taskId: input.taskId,
        role: profile.role,
        profileId,
        parentSessionId: null,
        modelName: session.modelName,
        systemPrompt,
        tools: toolDefs,
        onAssistantMessage: async (message, entity) => {
          const text = extractTextOf(message);
          const parsed = parseWorkerResult(text);
          if (parsed) {
            this.lastResults.set(entity.id, parsed);
          }
        },
        onToolResult: async () => {
          await this.sessions.updateStateCard(session.id, {
            toolCallCount: (await this.countToolCalls(session.id)),
          });
          if (executionBudget.stopReason) await this.sessions.interruptAsFailed(session.id, executionBudget.stopReason);
        },
      },
      taskPrompt,
    );

    this.watchCompletion(session.id, input, evidenceIds);
    this.logger.log(
      `Worker 启动 [${profileId}] session=${session.id} 工具=${resolved.tools.length} 意图=${intent.title}`,
    );
    return { workerTaskId: input.workerTaskId, sessionId: session.id };
    } catch (error) {
      await this.sessions.terminate(session.id, 'Worker 启动失败').catch(() => undefined);
      throw error;
    }
  }

  private readonly lastResults = new Map<string, ParsedWorkerResult>();

  private watchCompletion(sessionId: string, input: WorkerRunInput, evidenceIds: string[]): void {
    // 心跳续租：长任务（nmap / nikto）执行期间不断延长租约，
    // 避免被 reapExpiredWorkers 误判为超时回收。
    const heartbeat = setInterval(() => {
      void this.workers.renewLease(input.workerTaskId).catch(() => undefined);
    }, 20_000);
    heartbeat.unref?.();

    let polling = false;
    const poll = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
      if (this.finalized.has(input.workerTaskId)) {
        clearInterval(poll);
        clearInterval(heartbeat);
        return;
      }
      const dto = await this.sessions.findOne(sessionId).catch(() => null);
      if (!dto) {
        clearInterval(poll);
        clearInterval(heartbeat);
        return;
      }
      if (dto.state === 'paused') return;
      let recoveryError: string | null = null;
      if (dto.state === 'running') {
        const timeoutSeconds = getProfile(input.intent.workerProfileId).timeoutSeconds;
        if (dto.startedAt && Date.now() >= new Date(dto.startedAt).getTime() + timeoutSeconds * 1000) {
          const reason = `Worker 达到 ${timeoutSeconds} 秒绝对执行时限，心跳不能延长该时限`;
          await this.sessions.interruptAsFailed(sessionId, reason);
          clearInterval(poll); clearInterval(heartbeat);
          await this.finalize(sessionId, input, evidenceIds, reason);
          input.onFinished(input.workerTaskId, sessionId);
          return;
        }
        // 兜底：Agent 已输出最终回答（stop）但状态未推进时，主动收尾，
        // 防止会话因事件丢失而永久停留在 running。
        const stalled = await this.isStalledButFinished(sessionId);
        if (!stalled) return;
        this.logger.warn(
          `会话 ${sessionId} 已输出最终回答但状态仍为 running，主动收尾`,
        );
        if (stalled === 'failed') {
          recoveryError = '等待工具结果超过兜底时限，结果未知，不能标记执行成功';
          await this.sessions.interruptAsFailed(sessionId, recoveryError);
        } else await this.sessions.markCompleted(sessionId, { skipWaitForIdle: true });
      }
      clearInterval(poll);
      clearInterval(heartbeat);
      await this.finalize(sessionId, input, evidenceIds, recoveryError ?? (dto.state === 'failed' ? dto.errorMessage || '会话失败' : dto.state === 'terminated' ? '会话已终止，任务未完成' : null));
      input.onFinished(input.workerTaskId, sessionId);
      } catch (error) { this.logger.error(`Worker 状态回收失败 [${sessionId}]: ${String(error)}`); }
      finally { polling = false; }
    }, 3000);
  }

  /**
   * 判定会话是否已经无法推进，需要强制收尾。
   *
   * 两种情形：
   * 1. 最后一条 assistant 是 `stop`（最终回答），超过宽限期仍未推进 → 收尾
   * 2. 最后一条 assistant 是 `toolUse`（等待工具结果），但超过兜底时限仍无新消息
   *    → 视为工具结果丢失，强制收尾，避免 Worker 永久 running
   */
  private async isStalledButFinished(sessionId: string): Promise<'completed' | 'failed' | null> {
    const last = await this.sessions.store.latestAssistant(sessionId);
    if (!last) return null;
    const json = last.messageJson as { stopReason?: string } | null;
    const age = Date.now() - new Date(last.createdAt).getTime();

    if (json?.stopReason === 'stop') return age > FINAL_ANSWER_GRACE_MS ? 'completed' : null;
    if (json?.stopReason === 'toolUse') {
      // 等待上限取工具层单次调用上限（ToolInvoker 统一施加）与固定兜底中的较大者。
      const waitMs = Math.max(TOOL_WAIT_TIMEOUT_MS, toolCallTimeoutMs() + FINAL_ANSWER_GRACE_MS);
      if (age > waitMs) {
        this.logger.warn(
          `会话 ${sessionId} 在等待工具结果超过 ${Math.round(waitMs / 1000)}s，判定为结果丢失`,
        );
        return 'failed';
      }
      return null;
    }
    return null;
  }

  /** 已收尾的 Worker，防止 watchCompletion 与超时回收并发触发重复写事实 */
  private readonly finalized = new Set<string>();

  /** 会话结束后的收尾：事实、假设、结果卡、后续意图（幂等） */
  private async finalize(
    sessionId: string,
    input: WorkerRunInput,
    evidenceIds: string[],
    error: string | null,
  ): Promise<void> {
    if (this.finalized.has(input.workerTaskId)) {
      this.logger.debug(`Worker ${input.workerTaskId} 已收尾，跳过重复处理`);
      return;
    }
    this.finalized.add(input.workerTaskId);
    try {
    const currentWorker = await this.workers.findById(input.workerTaskId);
    if (currentWorker && ['timeout', 'cancelled'].includes(currentWorker.status)) {
      await this.ingestion.ingest(input.taskId, await this.collectSessionEvidence(sessionId));
      if (currentWorker.status === 'cancelled') await this.intents.reject(input.intent.id, 'manual');
      if (input.intent.workerProfileId === 'verification') await this.findings.recordWorkerResult(input.taskId, input.intent.id, sessionId, input.workerTaskId, null, currentWorker.errorMessage ?? 'Worker 已中断');
      return;
    }
      const dto = await this.sessions.findOne(sessionId);
      const lastAssistant = await this.sessions.store.latestAssistant(sessionId, true);
      const text = lastAssistant?.content ?? '';
      const parsed = this.lastResults.get(sessionId) ?? parseWorkerResult(text) ?? fallbackWorkerResult(text, input.intent.objective);

      const sessionEvidence = await this.collectSessionEvidence(sessionId);
      const referencedEvidence = await this.referencedEvidence(input.taskId, parsed.usedEvidenceIds ?? []);
      const effectiveEvidenceIds = [...new Set([...(sessionEvidence.length > 0 ? sessionEvidence : evidenceIds), ...referencedEvidence])];

      const factIds: string[] = [];
      for (const fact of parsed.facts) {
        const idx = fact.evidenceIndex;
        const evidenceId =
          idx !== null && idx >= 0 && idx < effectiveEvidenceIds.length ? effectiveEvidenceIds[idx] : null;

        if (evidenceId) {
          const dtoFact = await this.facts.create({
            taskId: input.taskId,
            agentSessionId: sessionId,
            category: fact.category,
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
            status: 'inferred',
            confidence: Math.min(fact.confidence, 0.5),
            observationKind: 'inference',
            sourceEvidenceIds: [evidenceId],
            // 溯源：工具名、目标、观测时间由分类器与证据共同决定可信度
            sourceTool: await this.resolveEvidenceTool(evidenceId),
            targetIp: input.intent.targetIp,
            observedAt: new Date(),
            createdBy: 'agent',
          });
          factIds.push(dtoFact.id);
        } else {
          const dtoFact = await this.facts.create({
            taskId: input.taskId,
            agentSessionId: sessionId,
            category: fact.category,
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
            status: 'inferred',
            confidence: Math.min(0.5, fact.confidence),
            sourceEvidenceIds: [],
            createdBy: 'agent',
            targetIp: input.intent.targetIp,
          });
          factIds.push(dtoFact.id);
        }
      }

      // ---- 确定性事实提取 ----
      // 模型经常只写摘要而漏掉具体端口/路径，导致黑板长期为空。
      // 这里直接从真实工具输出解析，产出有确凿证据的 observed 事实。
      const extracted = await this.ingestion.ingest(input.taskId, effectiveEvidenceIds);
      factIds.push(...extracted);

      // 验证会话只回答"这个候选是否成立"，不是新的探索。
      // 若允许它再产出候选并排队验证，验证结果本身会成为新候选的来源，
      // 形成"验证 → 新候选 → 再验证"的自我繁殖，消耗预算却不收敛。
      // 因此验证会话不进入候选捕获与验证排队，其结论只回写原候选。
      const isVerification = input.intent.workerProfileId === 'verification';
      if (!isVerification) {
        await this.findings.captureCandidates(input.taskId, factIds);
        await this.findings.queueEligibleCandidates(input.taskId, factIds);
      } else {
        await this.findings.recordWorkerResult(input.taskId, input.intent.id, sessionId, input.workerTaskId, parsed.verification ?? null, error);
      }

      const supported: string[] = [];
      const refuted: string[] = [];
      for (const hypothesis of parsed.hypotheses) {
        try {
          const assessment = await this.hypotheses.recordAssessment(input.taskId, { ...hypothesis, status: error ? 'proposed' : hypothesis.status }, {
            targetIp: input.intent.targetIp, sessionId, intentId: input.intent.id, evidenceIds: effectiveEvidenceIds,
          });
          if (assessment.hypothesis.status === 'supported') supported.push(assessment.hypothesis.id);
          if (assessment.hypothesis.status === 'refuted') refuted.push(assessment.hypothesis.id);
          parsed.openQuestions.push(...assessment.errors.map((e) => `假设“${hypothesis.title}”：${e}`));
        } catch (cause) {
          parsed.openQuestions.push(`假设“${hypothesis.title}”未接纳：${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }

      const startedAt = dto.startedAt ? new Date(dto.startedAt).getTime() : Date.now();
      const card = await this.workers.saveResultCard(input.taskId, input.workerTaskId, sessionId, {
        objective: input.intent.objective || input.intent.title,
        summary: error ? `[未完成] ${error}；${parsed.summary || '无结构化摘要'}` : parsed.summary || '(无摘要)',
        newFactIds: factIds,
        supportedHypothesisIds: supported,
        refutedHypothesisIds: refuted,
        evidenceIds: effectiveEvidenceIds,
        openQuestions: parsed.openQuestions,
        nextSteps: parsed.nextSteps,
        tokensUsed: dto.tokenInput + dto.tokenOutput,
        durationMs: Date.now() - startedAt,
        synthetic: !this.lastResults.has(sessionId) && !parseWorkerResult(text),
      });

      for (const next of error ? [] : parsed.nextIntents) {
        const createdIntent = await this.intents.create({
          taskId: input.taskId,
          agentSessionId: sessionId,
          title: next.title,
          hypothesis: next.hypothesis,
          objective: next.objective,
          rationale: next.rationale || `由 Worker 结果卡提出：${card.summary.slice(0, 100)}`,
          workerProfileId: next.workerProfileId,
          suggestedTools: next.suggestedTools,
          expectedEvidence: next.expectedEvidence,
          targetIp: next.targetIp,
          priority: next.priority,
          dedupeKey: next.dedupeKey,
        });
        for (const id of next.hypothesisRefs) {
          try { await this.hypotheses.link(id, 'depends_on', 'intent', createdIntent.intent.id, input.taskId, 'Worker 明确提出后续验证计划，不作为支持证据', { source: 'agent', sessionId }); }
          catch (cause) { this.logger.warn(`后续意图的假设关联未接纳：${cause instanceof Error ? cause.message : String(cause)}`); }
        }
      }

      await this.workers.complete(input.workerTaskId, {
        status: error ? 'failed' : 'succeeded',
        output: {
          summary: parsed.summary,
          factCount: factIds.length,
          evidenceCount: effectiveEvidenceIds.length,
        },
        evidenceIds: effectiveEvidenceIds,
        tokensSpent: dto.tokenInput + dto.tokenOutput,
        resultCardId: card.id,
        error,
      });

      if (error) await this.intents.reject(input.intent.id, 'manual');
      else await this.intents.markDone(input.intent.id);
      this.lastResults.delete(sessionId);
    } catch (err) {
      this.logger.error(
        `Worker 收尾失败 [${sessionId}]: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (input.intent.workerProfileId === 'verification') {
        await this.findings.recordWorkerResult(input.taskId, input.intent.id, sessionId, input.workerTaskId, null, String(err))
          .catch((error) => this.logger.error(`验证结果收尾失败：${String(error)}`));
      }
      const latest = await this.workers.findById(input.workerTaskId);
      if (!latest || !['timeout', 'cancelled'].includes(latest.status)) await this.workers.complete(input.workerTaskId, {
        status: 'failed', error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 工具定义统一由 Registry 生成、经 ToolInvoker 执行。
   * 这里不再直接查 mcp_tools 或调用 McpExecutorService，避免出现第二条执行路径。
   */
  private buildToolDefinitions(
    toolNames: string[],
    profileId: WorkerProfileId,
    input: WorkerRunInput,
    authorizedTargets: string[],
    evidenceIds: string[],
    getSessionId: () => string | null,
    budget = new WorkerExecutionBudget(),
  ): import('../pi-runtime/pi-types').PiToolDefinition[] {
    return buildWorkerTools(
      { invoker: this.toolInvoker, recorder: this.toolRecorder },
      {
        toolNames,
        taskId: input.taskId,
        role: getProfile(profileId).role,
        authorizedTargets,
        evidenceIds,
        sessionKey: getSessionId() ?? input.workerTaskId,
        getSessionId,
        budget,
      },
    );
  }

  /** 从证据元数据反查产出它的工具名 */
  private async resolveEvidenceTool(evidenceId: string): Promise<string | null> {
    const row = await this.evidence.findOne({ where: { id: evidenceId } });
    const meta = row?.meta as { tool?: string } | null | undefined;
    return meta?.tool ?? null;
  }

  private async collectSessionEvidence(sessionId: string): Promise<string[]> {
    const rows = await this.evidence.find({
      where: { agentSessionId: sessionId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((r) => r.id);
  }

  private async referencedEvidence(taskId: string, ids: string[]): Promise<string[]> {
    const valid: string[] = [];
    const unique = [...new Set(ids)];
    for (let start = 0; start < unique.length; start += 100) {
      const rows = await this.evidence.find({ where: unique.slice(start, start + 100).map((id) => ({ id, taskId })) });
      for (const row of rows) if (row.content?.trim() && row.sha256 === createHash('sha256').update(row.content).digest('hex') && (row.sizeBytes === null || row.sizeBytes === Buffer.byteLength(row.content, 'utf8'))) valid.push(row.id);
    }
    return valid;
  }

  private async buildEvidenceBrief(taskId: string): Promise<string[]> {
    const rows = await this.evidence.find({
      where: { taskId },
      order: { createdAt: 'DESC' },
      take: 10,
    });
    return rows.map((r) => `[证据ID ${r.id}] ${r.title}：${(r.content ?? '').slice(0, 120).replace(/\s+/g, ' ')}`);
  }

  private async countToolCalls(sessionId: string): Promise<number> {
    const events = await this.sessions.store.listEvents(sessionId, 500);
    return events.filter((e) => e.type === 'tool_execution_end').length;
  }

  private hintDto(entity: import('../../database/entities').HintEntity): HintDto {
    return this.hints.toDto(entity);
  }
}



/** 与 ToolInvoker 的单次调用上限保持一致，避免"工具还在跑、Worker 已判超时"。 */
export function toolCallTimeoutMs(): number {
  const raw = Number(process.env.TOOL_CALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

function extractTextOf(message: import('../pi-runtime/pi-types').PiAgentMessage): string {
  if (message.role !== 'assistant') return '';
  return message.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}
