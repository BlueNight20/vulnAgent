import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerPrompt,
  type PlannerContext,
} from '../worker-skills/prompt-builder';
import type { ParsedPlannerResult } from './result-parser';
import { parsePlannerResult } from './result-parser';

import { AgentSessionEntity, FactEntity, HypothesisEntity, IntentEntity, WorkerTaskEntity, ToolCallEntity } from '../../database/entities';
import { recentToolSummary } from './tool-history';
import {
  KILL_CHAIN_STAGES,
  STAGE_LABEL,
  STAGE_NEXT_NEED,
  detectDeadEnds,
  findLooseEnds,
  inferStage,
} from './kill-chain';
import type { PiAgentMessage } from '../pi-runtime/pi-types';
import { extractText } from '../pi-runtime/pi-types';
import { AttackSurfaceService } from '../blackboard/attack-surface.service';
import { TaskGoalsService } from '../blackboard/task-goals.service';
import { HypothesisService } from '../blackboard/hypothesis.service';

export interface PlannerRunInput {
  taskId: string;
  taskName: string;
  targetIps: string[];
  scopeCidrs: string[];
  tokenBudget: number;
  tokensUsed: number;
  timeBudgetMinutes: number;
  elapsedMinutes: number;
  availableProfiles: string[];
  availableTools: string[];
  hints: string[];
}

/**
 * Planner 执行器：负责组装上下文、驱动 Planner Session、解析结构化输出。
 * Planner 只产出建议，不做任何调度决策。
 */
@Injectable()
export class PlannerRunnerService {
  private readonly logger = new Logger(PlannerRunnerService.name);
  private readonly outputs = new Map<string, { text: string; parsed: ParsedPlannerResult | null }>();

  constructor(
    @InjectRepository(FactEntity) private readonly facts: Repository<FactEntity>,
    @InjectRepository(HypothesisEntity) private readonly hypotheses: Repository<HypothesisEntity>,
    @InjectRepository(IntentEntity) private readonly intents: Repository<IntentEntity>,
    @InjectRepository(WorkerTaskEntity) private readonly workers: Repository<WorkerTaskEntity>,
    @InjectRepository(AgentSessionEntity) private readonly sessions: Repository<AgentSessionEntity>,
    private readonly surface: AttackSurfaceService,
    private readonly goals: TaskGoalsService,
    private readonly hypothesisGraph: HypothesisService,
  ) {}

  getSystemPrompt(): string {
    return PLANNER_SYSTEM_PROMPT;
  }

  async buildPrompt(input: PlannerRunInput): Promise<string> {
    const facts = await this.facts.find({
      where: { taskId: input.taskId },
      order: { createdAt: 'DESC' },
      take: 60,
    });
    const factSummary = facts
      .map((f) => `- ID=${f.id} [${f.status}] ${f.subject} ${f.predicate} ${f.object}；目标=${f.targetIp ?? '未知'}；证据=${(f.sourceEvidenceIds ?? []).join(',') || '无'}`)
      .join('\n');

    const hypotheses = (await this.hypothesisGraph.list(input.taskId)).slice(0, 30);
    const hypothesisSummary = hypotheses
      .map((h) => `- ID=${h.id} 目标=${h.targetIp ?? '未绑定'} [${h.conflicted ? '依据冲突' : h.status}] ${h.title}：${h.description}；有效支持/反驳来源=${h.supportCount}/${h.contradictCount}；证据=${h.evidenceIds.join(',') || '无'}；无效/旧关联=${h.invalidLinkCount ?? 0}（假设解释，不代表漏洞确认）`)
      .join('\n');

    const intents = await this.intents.find({
      where: { taskId: input.taskId },
      order: { createdAt: 'DESC' },
      take: 40,
    });
    const pendingIntents = await this.intents.find({ where: { taskId: input.taskId, status: 'proposed' }, order: { priority: 'DESC', createdAt: 'ASC' } });
    const intentSummary = [...pendingIntents, ...intents.filter((i) => i.status !== 'proposed')]
      .map((i) => `- ID=${i.id} priority=${i.priority} [${i.status}${i.rejectedReason ? `/${i.rejectedReason}` : ''}] ${i.title}（${i.workerProfileId}）`)
      .join('\n');

    const workers = await this.workers.find({
      where: { taskId: input.taskId },
      order: { createdAt: 'DESC' },
      take: 20,
    });
    const workerSummary = workers
      .map((w) => `- [${w.status}] ${w.title}${w.errorMessage ? `（${w.errorMessage.slice(0, 80)}）` : ''}`)
      .join('\n');

    const ctx: PlannerContext = {
      taskName: input.taskName,
      targetIps: input.targetIps,
      scopeCidrs: input.scopeCidrs,
      factSummary,
      killChainSummary: await this.killChainSummary(input.taskId),
      looseEndSummary: await this.looseEndSummary(input.taskId, intents, facts),
      deadEndSummary: await this.deadEndSummary(input.taskId, intents, workers),
      assetSummary: await this.surface.summary(input.taskId),
      goalSummary: await this.goals.summary(input.taskId),
      hypothesisSummary,
      intentSummary,
      workerSummary,
      toolSummary: recentToolSummary(await this.facts.manager.find(ToolCallEntity, { where: { taskId: input.taskId }, order: { createdAt: 'DESC' }, take: 20 })),
      budget: {
        tokensUsed: input.tokensUsed,
        tokenBudget: input.tokenBudget,
        elapsedMinutes: input.elapsedMinutes,
        timeBudgetMinutes: input.timeBudgetMinutes,
      },
      availableProfiles: input.availableProfiles,
      availableTools: input.availableTools,
      hints: input.hints,
    };
    return buildPlannerPrompt(ctx);
  }

  /** 攻击链位置：当前阶段 + 进入下一阶段的必要条件。 */
  private async killChainSummary(taskId: string): Promise<string> {
    const rows = await this.facts.find({ where: { taskId }, select: ['category', 'predicate', 'status', 'observationKind'] });
    const stage = inferStage(rows.map((row) => ({
      category: row.category,
      predicate: row.predicate,
      status: row.status,
      observationKind: row.observationKind,
    })));
    const index = KILL_CHAIN_STAGES.indexOf(stage);
    const next = KILL_CHAIN_STAGES[index + 1];
    const lines = [`当前阶段：${index + 1}/${KILL_CHAIN_STAGES.length} ${STAGE_LABEL[stage]}`];
    lines.push(`进入 ${STAGE_LABEL[stage]} 还缺：${STAGE_NEXT_NEED[stage]}`);
    if (next) lines.push(`若本阶段已完成，下一阶段 ${STAGE_LABEL[next]} 需要：${STAGE_NEXT_NEED[next]}`);
    lines.push('判断依据来自已确认事实的类别；如果与此处推断不符，请在 analysis 中明确说明理由。');
    return lines.join('\n');
  }

  /** 尚未被利用的线索：已发现但还没有被任何意图研究的凭据、路径、版本等。 */
  private async looseEndSummary(
    taskId: string,
    intents: IntentEntity[],
    facts: FactEntity[],
  ): Promise<string> {
    // 事实一旦被某个意图或假设引用过，就视为"已被研究"
    const consumed = new Set<string>();
    for (const intent of intents) for (const id of intent.factIds ?? []) consumed.add(id);
    for (const fact of facts) for (const id of fact.hypothesisIds ?? []) consumed.add(id);

    const rows = await this.facts.find({ where: { taskId }, take: 200 });
    const ends = findLooseEnds(
      rows.map((row) => ({
        id: row.id, category: row.category, subject: row.subject,
        predicate: row.predicate, object: row.object, status: row.status,
      })),
      consumed,
    ).slice(0, 12);
    if (!ends.length) return '';
    return ends.map((end) => `- [${end.factId}] ${end.clue} —— ${end.why}`).join('\n');
  }

  /** 已判定为死路的方向，避免反复生成等价意图。 */
  private async deadEndSummary(
    taskId: string,
    intents: IntentEntity[],
    workers: WorkerTaskEntity[],
  ): Promise<string> {
    const failureByIntent = new Map<string, string>();
    for (const worker of workers) {
      if (worker.intentId && worker.errorMessage) failureByIntent.set(worker.intentId, worker.errorMessage);
    }
    const dead = detectDeadEnds(intents.map((intent) => ({
      title: intent.title,
      status: intent.status,
      rejectedReason: intent.rejectedReason,
      failure: failureByIntent.get(intent.id) ?? null,
    })));
    if (!dead.length) return '';
    return dead.map((item) => `- ${item.direction}（${item.reason}）`).join('\n');
  }

  /** 记录 Planner 的最终回复并解析 */
  recordOutput(sessionId: string, message: PiAgentMessage): ParsedPlannerResult | null {
    if (message.role !== 'assistant') return null;
    const text = extractText(message);
    const parsed = parsePlannerResult(text);
    this.outputs.set(sessionId, { text, parsed });
    if (!parsed) {
      this.logger.warn(`Planner [${sessionId}] 未输出可解析的结构化结果，将仅保留分析文本`);
    }
    return parsed;
  }

  getOutput(sessionId: string): { text: string; parsed: ParsedPlannerResult | null } | null {
    return this.outputs.get(sessionId) ?? null;
  }

  clearOutput(sessionId: string): void {
    this.outputs.delete(sessionId);
  }
}
