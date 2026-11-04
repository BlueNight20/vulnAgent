import { serialSave } from '../../database/serial-transaction';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import type {
  FactCategory,
  FactConflictDto,
  FactDto,
  FactObservationKind,
  FactStatus,
} from '@vulnagent/shared';
import { EvidenceEntity, FactEntity, HypothesisEntity, HypothesisLinkEntity } from '../../database/entities';
import { knowledgeProgressKeys } from './knowledge-progress';
import { newId, toIso } from '../../common/utils/id';
import { normalizePagination } from '../../common/utils/pagination';
import { EventsGateway } from '../events/events.gateway';
import { assertTransition, validateFactDraft } from './fact-provenance';
import { arbitrateConflict, classifyFact, isConflict } from './fact-classifier';
import { targetWithin } from './hypothesis-provenance';

export interface CreateFactInput {
  taskId: string;
  agentSessionId?: string | null;
  category: FactCategory;
  subject: string;
  predicate: string;
  object: string;
  status?: FactStatus;
  confidence?: number;
  sourceEvidenceIds?: string[];
  createdBy: 'tool' | 'agent' | 'user';
  hypothesisIds?: string[];
  /** 第三阶段：溯源字段 */
  sourceTool?: string | null;
  targetIp?: string | null;
  observedAt?: Date | null;
  /** 可选：覆盖自动判定的观测类别 */
  observationKind?: FactObservationKind;
}

@Injectable()
export class FactsService {
  constructor(
    @InjectRepository(FactEntity) private readonly facts: Repository<FactEntity>,
    @InjectRepository(HypothesisLinkEntity) private readonly links: Repository<HypothesisLinkEntity>,
    private readonly events: EventsGateway,
  ) {}

  /**
   * 创建或更新事实。
   *
   * 关键规则（第三阶段）：
   * 1. 自动判定 observationKind，probe_error 不得改写目标状态事实
   * 2. 同 subject+predicate 但 object 不同 → **记录冲突**，不覆盖已有事实
   * 3. 完全相同三元组 → 合并证据，置信度取较高值
   */
  async create(input: CreateFactInput): Promise<FactDto> {
    const hypothesisIds = [...new Set(input.hypothesisIds ?? [])];
    if (hypothesisIds.length) {
      const rows = await this.facts.manager.find(HypothesisEntity, { where: { taskId: input.taskId, id: In(hypothesisIds) } });
      if (rows.length !== hypothesisIds.length || rows.some((h) => !targetWithin(input.targetIp ?? null, h.targetIp))) throw new BadRequestException('事实关联的假设不存在、跨任务或目标不一致');
    }
    const evidenceIds = input.sourceEvidenceIds ?? [];
    const classification = input.observationKind
      ? {
          kind: input.observationKind,
          confidence: input.confidence ?? 0.6,
          reason: '调用方显式指定观测类别',
        }
      : classifyFact({
          object: input.object,
          sourceTool: input.sourceTool,
          rawConfidence: input.confidence,
          hasEvidence: evidenceIds.length > 0,
        });

    // 探测失败不允许落成 observed
    const status: FactStatus =
      classification.kind === 'probe_error' || classification.kind === 'inference'
        ? classification.kind === 'inference'
          ? 'inferred'
          : 'observed'
        : (input.status ?? (evidenceIds.length > 0 ? 'observed' : 'inferred'));

    const confidence = input.confidence ?? classification.confidence;

    validateFactDraft({
      status,
      createdBy: input.createdBy,
      sourceEvidenceIds: evidenceIds,
      confidence,
      category: input.category,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
    });

    // ---- 1. 完全相同三元组：合并 ----
    const sameTriple = await this.facts.findOne({
      where: {
        taskId: input.taskId,
        targetIp: input.targetIp ?? IsNull(),
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
      },
    });

    if (sameTriple) {
      const wasInferred = sameTriple.status === 'inferred';
      const mergedEvidence = Array.from(
        new Set([...(sameTriple.sourceEvidenceIds ?? []), ...evidenceIds]),
      );
      const upgraded: FactStatus =
        status === 'observed' && sameTriple.status === 'inferred' ? 'observed' : sameTriple.status;
      assertTransition(sameTriple.status, upgraded, mergedEvidence);
      sameTriple.status = upgraded;
      if (wasInferred && upgraded === 'observed') sameTriple.observationKind = classification.kind;
      sameTriple.confidence = Math.max(sameTriple.confidence, confidence);
      sameTriple.sourceEvidenceIds = mergedEvidence;
      if (wasInferred && upgraded === 'observed') sameTriple.createdBy = input.createdBy;
      sameTriple.sourceTool = sameTriple.sourceTool ?? input.sourceTool ?? null;
      sameTriple.targetIp = sameTriple.targetIp ?? input.targetIp ?? null;
      sameTriple.observedAt = sameTriple.observedAt ?? input.observedAt ?? new Date();
      sameTriple.hypothesisIds = [...new Set([...(sameTriple.hypothesisIds ?? []), ...hypothesisIds])];
      const saved = await serialSave(this.facts, sameTriple);
      await this.linkExplicitHypotheses(saved, hypothesisIds);
      const dto = this.toDto(saved);
      this.events.broadcast('blackboard.fact', dto);
      return dto;
    }

    // ---- 2. 同 subject+predicate 不同 object：冲突检测 ----
    const siblings = await this.facts.find({
      where: {
        taskId: input.taskId,
        targetIp: input.targetIp ?? IsNull(),
        subject: input.subject,
        predicate: input.predicate,
      },
    });

    const conflicting = siblings.filter((sibling) =>
      isConflict(
        { object: input.object, kind: classification.kind },
        { object: sibling.object, kind: sibling.observationKind },
      ),
    );

    let conflictGroupId: string | null = null;
    if (conflicting.length > 0) {
      // 复用已有冲突组，保证同一组内所有取值共享 ID
      conflictGroupId =
        conflicting.find((c) => c.conflictGroupId)?.conflictGroupId ?? newId();
      for (const sibling of conflicting) {
        if (!sibling.conflictGroupId) {
          sibling.conflictGroupId = conflictGroupId;
          await serialSave(this.facts, sibling);
        }
      }
    }

    const entity = this.facts.create({
      id: newId(),
      taskId: input.taskId,
      agentSessionId: input.agentSessionId ?? null,
      category: input.category,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      status,
      confidence,
      sourceEvidenceIds: evidenceIds,
      createdBy: input.createdBy,
      hypothesisIds,
      sourceTool: input.sourceTool ?? null,
      targetIp: input.targetIp ?? null,
      observedAt: input.observedAt ?? new Date(),
      observationKind: classification.kind,
      conflictGroupId,
      conflictResolved: false,
    });
    const saved = await serialSave(this.facts, entity);

    await this.linkExplicitHypotheses(saved, hypothesisIds);

    const dto = this.toDto(saved);
    this.events.broadcast('blackboard.fact', dto);
    // 全自动流程：新冲突立刻按证据强度裁决，不留下等待人工确认的悬置状态。
    if (conflictGroupId) await this.settleConflict(input.taskId, conflictGroupId);
    return dto;
  }

  private async linkExplicitHypotheses(fact: FactEntity, hypothesisIds: string[]): Promise<void> {
    for (const hypothesisId of hypothesisIds) {
      if (await this.links.existsBy({ taskId: fact.taskId, hypothesisId, targetType: 'fact', targetId: fact.id, linkType: 'refines' })) continue;
      await serialSave(this.links, this.links.create({ id: newId(), taskId: fact.taskId, hypothesisId, linkType: 'refines', targetType: 'fact', targetId: fact.id, note: '事实显式关联，仅提供研究线索，不自动支持假设', assessmentSource: fact.createdBy === 'agent' ? 'agent' : 'user', agentSessionId: fact.agentSessionId, evidenceQuotes: [] }));
    }
  }

  async updateStatus(id: string, status: FactStatus, evidenceIds: string[] = []): Promise<FactDto> {
    const entity = await this.facts.findOne({ where: { id } });
    if (!entity) throw new NotFoundException('事实不存在');
    const merged = Array.from(new Set([...(entity.sourceEvidenceIds ?? []), ...evidenceIds]));
    assertTransition(entity.status, status, merged);
    entity.status = status;
    entity.sourceEvidenceIds = merged;
    const saved = await serialSave(this.facts, entity);
    const dto = this.toDto(saved);
    this.events.broadcast('blackboard.fact', dto);
    return dto;
  }

  /**
   * 自动裁决某个冲突组的最终取值（全自动流程，不由人工介入）。
   * 胜出者置 conflictResolved=true，其余同组事实保留原文并降级为 refuted。
   */
  async settleConflict(taskId: string, conflictGroupId: string): Promise<FactDto | null> {
    const group = await this.facts.find({ where: { taskId, conflictGroupId } });
    if (group.length < 2) return null;
    const verdict = arbitrateConflict(
      group.map((item) => ({
        id: item.id,
        status: item.status,
        observationKind: item.observationKind,
        confidence: item.confidence,
        evidenceCount: item.sourceEvidenceIds?.length ?? 0,
      })),
    );
    if (!verdict) return null;

    const rejected = new Set(verdict.loserIds);
    let winner: FactEntity | null = null;
    for (const item of group) {
      if (item.id === verdict.winnerId) {
        item.conflictResolved = true;
        winner = item;
      } else {
        item.conflictResolved = false;
        if (rejected.has(item.id)) {
          // 保留原始观测便于回溯，仅以状态表达裁决结果。
          item.status = 'refuted';
          this.events.broadcast('blackboard.fact', this.toDto(item));
        }
      }
      await serialSave(this.facts, item);
    }
    if (!winner) return null;
    const dto = this.toDto(winner);
    this.events.broadcast('blackboard.fact', dto);
    return dto;
  }

  /** 批量收敛任务内所有未解决的冲突组，返回已裁决数量。 */
  async settleOpenConflicts(taskId: string): Promise<number> {
    const rows = await this.facts.find({ where: { taskId }, select: ['id', 'conflictGroupId', 'conflictResolved'] });
    const open = new Set(rows.filter((r) => r.conflictGroupId && !r.conflictResolved).map((r) => r.conflictGroupId!));
    let settled = 0;
    for (const groupId of open) if (await this.settleConflict(taskId, groupId)) settled += 1;
    return settled;
  }

  /** 列出所有未解决的冲突组 */
  async listConflicts(taskId: string): Promise<FactConflictDto[]> {
    const rows = await this.facts
      .createQueryBuilder('f')
      .where('f.taskId = :taskId', { taskId })
      .andWhere('f.conflictGroupId IS NOT NULL')
      .orderBy('f.createdAt', 'ASC')
      .getMany();
    const grouped = new Map<string, FactEntity[]>();
    for (const row of rows) {
      if (!row.conflictGroupId) continue;
      const list = grouped.get(row.conflictGroupId) ?? [];
      list.push(row);
      grouped.set(row.conflictGroupId, list);
    }

    const conflicts: FactConflictDto[] = [];
    for (const [, items] of grouped) {
      if (items.length < 2) continue;
      const first = items[0];
      conflicts.push({
        taskId,
        subject: first.subject,
        predicate: first.predicate,
        objects: items.map((item) => ({
          factId: item.id,
          object: item.object,
          status: item.status,
          sourceTool: item.sourceTool,
          observedAt: toIso(item.observedAt),
          evidenceIds: item.sourceEvidenceIds ?? [],
          confidence: item.confidence,
        })),
        resolved: items.some((item) => item.conflictResolved),
      });
    }
    return conflicts;
  }

  async list(
    taskId: string,
    filters: { category?: string; status?: string; page?: number; pageSize?: number } = {},
  ): Promise<{ items: FactDto[]; total: number; counts: Record<string, number>; kindCounts: Record<string, number> }> {
    const { skip, take } = normalizePagination(filters.page, filters.pageSize ?? 50);
    const qb = this.facts.createQueryBuilder('f').where('f.taskId = :taskId', { taskId });
    if (filters.category) qb.andWhere('f.category = :category', { category: filters.category });
    if (filters.status) qb.andWhere('f.status = :status', { status: filters.status });
    const [rows, total] = await qb.orderBy('f.createdAt', 'DESC').skip(skip).take(take).getManyAndCount();

    const countRows = await this.facts
      .createQueryBuilder('f')
      .select('f.status', 'status')
      .addSelect('COUNT(1)', 'count')
      .where('f.taskId = :taskId', { taskId })
      .groupBy('f.status')
      .getRawMany<{ status: string; count: string | number }>();
    const counts: Record<string, number> = {};
    for (const row of countRows) counts[row.status] = Number(row.count);

    const kindRows = await this.facts
      .createQueryBuilder('f')
      .select('f.observationKind', 'kind')
      .addSelect('COUNT(1)', 'count')
      .where('f.taskId = :taskId', { taskId })
      .groupBy('f.observationKind')
      .getRawMany<{ kind: string; count: string | number }>();
    const kindCounts: Record<string, number> = {};
    for (const row of kindRows) kindCounts[row.kind] = Number(row.count);

    return { items: rows.map((r) => this.toDto(r)), total, counts, kindCounts };
  }

  async listByTask(taskId: string, limit = 200): Promise<FactDto[]> {
    const rows = await this.facts.find({
      where: { taskId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return rows.map((r) => this.toDto(r));
  }

  async counts(taskId: string): Promise<Record<FactStatus, number>> {
    const rows = await this.facts
      .createQueryBuilder('f')
      .select('f.status', 'status')
      .addSelect('COUNT(1)', 'count')
      .where('f.taskId = :taskId', { taskId })
      .groupBy('f.status')
      .getRawMany<{ status: string; count: string | number }>();
    const result: Record<FactStatus, number> = { inferred: 0, observed: 0, verified: 0, refuted: 0 };
    for (const row of rows) {
      result[row.status as FactStatus] = Number(row.count);
    }
    return result;
  }

  /** 本轮新增的证据支撑事实数（用于无进展检测） */
  async countEvidenceBacked(taskId: string): Promise<number> {
    return this.facts
      .createQueryBuilder('f')
      .where('f.taskId = :taskId', { taskId })
      .andWhere("f.status IN ('observed','verified')")
      .andWhere("f.observationKind IN ('target_state','target_negative')")
      .getCount();
  }

  async progressKeys(taskId: string): Promise<string[]> {
    const [facts, evidence] = await Promise.all([
      this.facts.find({ where: { taskId, status: In(['observed', 'verified', 'refuted']) } }),
      this.facts.manager.find(EvidenceEntity, { where: { taskId }, select: { id: true } }),
    ]);
    return knowledgeProgressKeys(facts, new Set(evidence.map((row) => row.id)));
  }

  toDto(entity: FactEntity): FactDto {
    return {
      id: entity.id,
      taskId: entity.taskId,
      agentSessionId: entity.agentSessionId,
      category: entity.category,
      subject: entity.subject,
      predicate: entity.predicate,
      object: entity.object,
      status: entity.status,
      confidence: entity.confidence,
      sourceEvidenceIds: entity.sourceEvidenceIds ?? [],
      createdBy: entity.createdBy,
      hypothesisIds: entity.hypothesisIds ?? [],
      sourceTool: entity.sourceTool,
      targetIp: entity.targetIp,
      observedAt: toIso(entity.observedAt),
      observationKind: entity.observationKind,
      conflictGroupId: entity.conflictGroupId,
      conflictResolved: entity.conflictResolved,
      createdAt: toIso(entity.createdAt) ?? '',
    };
  }
}
