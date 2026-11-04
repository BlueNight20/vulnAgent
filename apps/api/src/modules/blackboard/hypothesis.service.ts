import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository, type EntityManager } from 'typeorm';
import { isValidCidr, isValidIPv4, type EvidenceRelationsDto, type HypothesisDto, type HypothesisLinkDto, type HypothesisLinkType, type Severity } from '@vulnagent/shared';
import { AuditLogEntity, EvidenceEntity, FactEntity, FindingEntity, FindingVerificationEntity, HypothesisEntity, HypothesisLinkEntity, TaskEntity } from '../../database/entities';
import { newId, toIso } from '../../common/utils/id';
import { serialTransaction } from '../../database/serial-transaction';
import { EventsGateway } from '../events/events.gateway';
import { checkScope, extractTargets } from '../mcp/scope-guard';
import { loadGraphContext, targetWithin, validateRelation, type Quote } from './hypothesis-provenance';

export interface CreateHypothesisInput {
  taskId: string;
  title: string;
  description: string;
  severity?: Severity | null;
  targetIp?: string | null;
  createdBy?: 'agent' | 'user' | 'planner';
}
interface LinkOptions {
  evidenceQuotes?: Quote[];
  source?: 'agent' | 'user';
  sessionId?: string | null;
}
export interface HypothesisView { hypothesis: HypothesisDto; links: HypothesisLinkDto[] }

/** 关联是带原文的解释，不将链接数当成独立漏洞确认。 */
@Injectable()
export class HypothesisService {
  constructor(
    @InjectRepository(HypothesisEntity) private readonly hypotheses: Repository<HypothesisEntity>,
    @InjectRepository(HypothesisLinkEntity) private readonly links: Repository<HypothesisLinkEntity>,
    private readonly events: EventsGateway,
  ) {}

  async create(input: CreateHypothesisInput): Promise<HypothesisDto> {
    if (!input.title.trim() || !input.description.trim()) throw new BadRequestException('假设需要标题和说明');
    const saved = await serialTransaction(this.hypotheses.manager, async (manager) => {
      const task = await manager.findOne(TaskEntity, { where: { id: input.taskId } });
      if (!task) throw new NotFoundException('任务不存在');
      const targetIp = input.targetIp?.trim() || null;
      if (targetIp) {
        if (!isValidIPv4(targetIp) && !isValidCidr(targetIp)) throw new BadRequestException('假设目标必须是明确 IPv4 或 CIDR');
        const context = await loadGraphContext(manager, task, []);
        if (!checkScope(extractTargets({ target: targetIp }), context.policy).allow) throw new BadRequestException('假设目标不在当前授权范围内');
      }
      const title = input.title.trim().slice(0, 200);
      const existing = await manager.findOne(HypothesisEntity, { where: { taskId: input.taskId, title, targetIp: targetIp ?? IsNull() } });
      if (existing) return existing;
      return manager.save(manager.create(HypothesisEntity, {
        id: newId(), taskId: input.taskId, title, description: input.description.trim().slice(0, 4000),
        targetIp, status: 'proposed', severity: input.severity ?? null, supportCount: 0,
        contradictCount: 0, confidence: 0.3, createdBy: input.createdBy ?? 'planner',
      }));
    });
    const dto = (await this.detail(input.taskId, saved.id)).hypothesis;
    this.events.broadcast('blackboard.hypothesis', dto);
    return dto;
  }

  async createForPlanner(taskId: string, title: string, description: string, severity: Severity | null): Promise<HypothesisDto> {
    return this.create({ taskId, title, description, severity, createdBy: 'planner' });
  }

  async link(hypothesisId: string, linkType: HypothesisLinkType, targetType: 'fact' | 'evidence' | 'intent', targetId: string, taskId: string, note?: string, options: LinkOptions = {}): Promise<void> {
    if (!['supports', 'contradicts', 'depends_on', 'refines'].includes(linkType) || !['fact', 'evidence', 'intent'].includes(targetType)) throw new BadRequestException('未知关系类型');
    if (note && note.length > 4000) throw new BadRequestException('关联说明过长');
    await serialTransaction(this.links.manager, async (manager) => {
      const h = await manager.findOne(HypothesisEntity, { where: { id: hypothesisId, taskId } });
      if (!h) throw new NotFoundException('假设不存在');
      const task = await manager.findOneOrFail(TaskEntity, { where: { id: taskId } });
      const candidate = manager.create(HypothesisLinkEntity, {
        id: newId(), taskId, hypothesisId, linkType, targetType, targetId,
        note: note?.trim() || null, evidenceQuotes: options.evidenceQuotes ?? [],
        assessmentSource: options.source ?? 'user', agentSessionId: options.sessionId ?? null,
      });
      const validation = validateRelation(h, candidate, await loadGraphContext(manager, task, [candidate]));
      if (validation.validation !== 'valid') throw new BadRequestException(validation.invalidReason);
      const versions = await manager.find(HypothesisLinkEntity, { where: { taskId, hypothesisId, linkType, targetType, targetId } });
      const existing = versions.find((l) => l.note === candidate.note && l.assessmentSource === candidate.assessmentSource && l.agentSessionId === candidate.agentSessionId && JSON.stringify(l.evidenceQuotes ?? []) === JSON.stringify(candidate.evidenceQuotes));
      if (existing) {
        // 同样的解释与原文幂等；修改引用时保留新的关系版本，不覆盖旧研究历史。
        candidate.id = existing.id;
        candidate.createdAt = existing.createdAt;
      }
      await manager.save(candidate);
      if (targetType === 'fact') {
        const fact = await manager.findOneOrFail(FactEntity, { where: { taskId, id: targetId } });
        await manager.update(FactEntity, { taskId, id: targetId }, { hypothesisIds: [...new Set([...(fact.hypothesisIds ?? []), hypothesisId])] });
      }
      if (candidate.assessmentSource === 'user') await manager.save(manager.create(AuditLogEntity, { id: newId(), actor: 'local-operator', action: 'hypothesis.link', entityType: 'hypothesis', entityId: hypothesisId, taskId, result: 'success', detail: { linkType, targetType, targetId } }));
    });
    await this.recount(hypothesisId, taskId);
  }

  /** Worker 只能使用明确列出的证据；单个坏关联不会丢弃其余有效结果。 */
  async recordAssessment(taskId: string, input: { hypothesisId?: string | null; targetIp?: string | null; title: string; description: string; severity: Severity | null; status: string; evidenceQuotes?: Quote[]; factIds?: string[]; rationale?: string }, context: { targetIp: string | null; sessionId: string; intentId: string; evidenceIds: string[] }): Promise<{ hypothesis: HypothesisDto; errors: string[] }> {
    if (context.targetIp && input.targetIp && !targetWithin(input.targetIp, context.targetIp)) throw new BadRequestException('假设目标超出本次意图的明确目标');
    const hypothesis = input.hypothesisId ? (await this.detail(taskId, input.hypothesisId)).hypothesis
      : await this.create({ taskId, title: input.title, description: input.description, severity: input.severity, targetIp: input.targetIp || context.targetIp, createdBy: 'agent' });
    if (context.targetIp && !targetWithin(hypothesis.targetIp, context.targetIp)) throw new BadRequestException('引用的假设与本次意图目标不一致');
    const errors: string[] = [];
    const attempt = async (action: () => Promise<void>) => { try { await action(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); } };
    await attempt(() => this.link(hypothesis.id, 'depends_on', 'intent', context.intentId, taskId, '本次 Worker 明确研究此假设，关系仅表示验证计划', { source: 'agent', sessionId: context.sessionId }));
    if (['supported', 'refuted'].includes(input.status)) {
      const quotes = input.evidenceQuotes ?? [];
      if (!quotes.length) errors.push('假设状态声明缺少明确证据原文，保留待验证');
      const type = input.status === 'refuted' ? 'contradicts' : 'supports';
      for (const evidenceId of [...new Set(quotes.map((q) => q.evidenceId))].slice(0, 10)) {
        if (!context.evidenceIds.includes(evidenceId)) { errors.push(`证据 ${evidenceId} 未在本次结果中明确使用`); continue; }
        await attempt(() => this.link(hypothesis.id, type, 'evidence', evidenceId, taskId, input.rationale || input.description, { source: 'agent', sessionId: context.sessionId, evidenceQuotes: quotes.filter((q) => q.evidenceId === evidenceId) }));
      }
      for (const id of [...new Set(input.factIds ?? [])].slice(0, 20)) {
        const fact = await this.links.manager.findOne(FactEntity, { where: { id, taskId } });
        await attempt(() => this.link(hypothesis.id, type, 'fact', id, taskId, input.rationale || input.description, { source: 'agent', sessionId: context.sessionId, evidenceQuotes: quotes.filter((q) => context.evidenceIds.includes(q.evidenceId) && fact?.sourceEvidenceIds.includes(q.evidenceId)) }));
      }
    }
    return { hypothesis: (await this.detail(taskId, hypothesis.id)).hypothesis, errors };
  }

  async recount(hypothesisId: string, taskId?: string): Promise<HypothesisDto | null> {
    const dto = await serialTransaction(this.hypotheses.manager, async (manager) => {
      const row = await manager.findOne(HypothesisEntity, { where: { id: hypothesisId, ...(taskId ? { taskId } : {}) } });
      if (!row) return null;
      const view = (await this.views(manager, row.taskId, [row.id]))[0].hypothesis;
      // 只更新已存在行，避免异步回调重新创建删除的假设。
      await manager.update(HypothesisEntity, { id: row.id, taskId: row.taskId }, { status: view.status, supportCount: view.supportCount, contradictCount: view.contradictCount, confidence: view.confidence });
      return view;
    });
    if (dto) this.events.broadcast('blackboard.hypothesis', dto);
    return dto;
  }

  async list(taskId: string): Promise<HypothesisDto[]> {
    return (await this.views(this.hypotheses.manager, taskId)).map((v) => v.hypothesis);
  }

  /** 报告传入正在捕获快照的同一事务管理器，冻结生成时的校验结果。 */
  async readSnapshot(manager: EntityManager, taskId: string): Promise<HypothesisView[]> {
    return this.views(manager, taskId);
  }

  async detail(taskId: string, id: string): Promise<HypothesisView> {
    const view = (await this.views(this.hypotheses.manager, taskId, [id]))[0];
    if (!view) throw new NotFoundException('假设不存在');
    return view;
  }

  async findByTargets(taskId: string, targetType: 'fact' | 'evidence' | 'intent', ids: string[]): Promise<HypothesisDto[]> {
    if (!ids.length) return [];
    const links = await this.links.find({ where: { taskId, targetType, targetId: In(ids) } });
    return (await this.views(this.hypotheses.manager, taskId, [...new Set(links.map((l) => l.hypothesisId))])).map((v) => v.hypothesis);
  }

  async relationsForEvidence(taskId: string, evidenceId: string): Promise<EvidenceRelationsDto> {
    const manager = this.hypotheses.manager;
    if (!await manager.exists(EvidenceEntity, { where: { taskId, id: evidenceId } })) throw new NotFoundException('证据不存在');
    const facts = await manager.createQueryBuilder(FactEntity, 'f').where('f.taskId = :taskId', { taskId })
      .andWhere('EXISTS (SELECT 1 FROM json_each(f.sourceEvidenceIds) WHERE value = :evidenceId)', { evidenceId }).getMany();
    const factIds = new Set(facts.map((f) => f.id));
    const linked = await manager.createQueryBuilder(HypothesisLinkEntity, 'l').where('l.taskId = :taskId', { taskId })
      .andWhere("((l.targetType = 'evidence' AND l.targetId = :evidenceId) OR EXISTS (SELECT 1 FROM json_each(l.evidenceQuotes) q WHERE json_extract(q.value, '$.evidenceId') = :evidenceId))", { evidenceId }).getMany();
    // taskId 的条件包在外层，防止 OR 把其他任务的关联带入结果。
    const related = linked.filter((l) => l.taskId === taskId);
    for (const id of factIds) related.push(...await this.links.find({ where: { taskId, targetType: 'fact', targetId: id } }));
    const hypotheses = (await this.views(manager, taskId, [...new Set(related.map((l) => l.hypothesisId))])).map((view) => ({
      ...view, links: view.links.filter((l) => (l.targetType === 'evidence' && l.targetId === evidenceId) || (l.targetType === 'fact' && factIds.has(l.targetId)) || l.evidenceQuotes?.some((q) => q.evidenceId === evidenceId)),
    }));
    const verifications = await manager.createQueryBuilder(FindingVerificationEntity, 'v').where('v.taskId = :taskId', { taskId })
      .andWhere('(EXISTS (SELECT 1 FROM json_each(v.evidenceIds) WHERE value = :evidenceId) OR EXISTS (SELECT 1 FROM json_each(v.baselineEvidenceIds) WHERE value = :evidenceId))', { evidenceId }).getMany();
    const findings = await manager.createQueryBuilder(FindingEntity, 'f').where('f.taskId = :taskId', { taskId })
      .andWhere('(EXISTS (SELECT 1 FROM json_each(f.evidenceIds) WHERE value = :evidenceId) OR f.id IN (:...ids))', { evidenceId, ids: verifications.length ? verifications.map((v) => v.findingId) : [''] }).getMany();
    return {
      facts: facts.map((f) => ({ id: f.id, subject: f.subject, predicate: f.predicate, object: f.object, status: f.status, targetIp: f.targetIp })),
      hypotheses,
      findings: findings.map((f) => ({ id: f.id, title: f.title, status: f.status, targetIp: f.targetIp, verificationIds: verifications.filter((v) => v.findingId === f.id).map((v) => v.id) })),
    };
  }

  private async views(manager: EntityManager, taskId: string, ids?: string[]): Promise<HypothesisView[]> {
    const task = await manager.findOne(TaskEntity, { where: { id: taskId } });
    if (!task) throw new NotFoundException('任务不存在');
    if (ids?.length === 0) return [];
    const rows = await manager.find(HypothesisEntity, { where: { taskId, ...(ids ? { id: In(ids) } : {}) }, order: { createdAt: 'DESC', id: 'ASC' } });
    const links = await manager.find(HypothesisLinkEntity, { where: { taskId, ...(ids ? { hypothesisId: In(ids) } : {}) }, order: { createdAt: 'ASC', id: 'ASC' } });
    const ctx = await loadGraphContext(manager, task, links);
    return rows.map((row) => {
      const supports = new Set<string>(); const contradicts = new Set<string>();
      const relationDtos = links.filter((l) => l.hypothesisId === row.id).map((l): HypothesisLinkDto => {
        const checked = validateRelation(row, l, ctx);
        const bucket = l.linkType === 'supports' ? supports : l.linkType === 'contradicts' ? contradicts : null;
        const counted = checked.validation === 'valid' && bucket !== null;
        if (counted) for (const hash of checked.hashes) bucket!.add(hash);
        return { id: l.id, hypothesisId: row.id, linkType: l.linkType, targetType: l.targetType, targetId: l.targetId, note: l.note, evidenceQuotes: l.evidenceQuotes ?? [], assessmentSource: l.assessmentSource, agentSessionId: l.agentSessionId, validation: checked.validation, invalidReason: checked.invalidReason, counted, createdAt: toIso(l.createdAt) ?? '' };
      });
      const valid = relationDtos.filter((l) => l.validation === 'valid');
      const conflicted = supports.size > 0 && contradicts.size > 0;
      const hypothesis: HypothesisDto = {
        id: row.id, taskId, title: row.title, description: row.description, targetIp: row.targetIp,
        severity: row.severity, createdBy: row.createdBy, createdAt: toIso(row.createdAt) ?? '', updatedAt: toIso(row.updatedAt) ?? '',
        status: conflicted || (!supports.size && !contradicts.size) ? 'proposed' : supports.size ? 'supported' : 'refuted',
        supportCount: supports.size, contradictCount: contradicts.size, conflicted,
        invalidLinkCount: relationDtos.length - valid.length,
        confidence: conflicted ? 0.3 : supports.size ? 0.6 : contradicts.size ? 0.1 : 0.3,
        factIds: [...new Set(valid.filter((l) => l.targetType === 'fact').map((l) => l.targetId))],
        evidenceIds: [...new Set(valid.flatMap((l) => [...(l.targetType === 'evidence' ? [l.targetId] : []), ...(l.evidenceQuotes ?? []).map((q) => q.evidenceId)]))],
        intentIds: [...new Set(valid.filter((l) => l.targetType === 'intent').map((l) => l.targetId))],
      };
      return { hypothesis, links: relationDtos };
    });
  }
}
