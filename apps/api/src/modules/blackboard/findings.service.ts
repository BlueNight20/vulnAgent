import { findingIdentity, findingTitle, findingClueLevel } from './finding-identity';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { In, Repository, type EntityManager } from 'typeorm';
import type { FindingDto, FindingVerificationDto, Severity, VerificationOutcome, VerificationResult } from '@vulnagent/shared';
import { AgentSessionEntity, AuditLogEntity, EvidenceEntity, FactEntity, FindingEntity, FindingVerificationEntity, HintEntity, IntentEntity, TargetEntity, TaskEntity, TaskStateEventEntity, ToolCallEntity, WorkerTaskEntity } from '../../database/entities';
import { newId } from '../../common/utils/id';
import { normalizePagination } from '../../common/utils/pagination';
import { serialTransaction } from '../../database/serial-transaction';
import { checkScope, extractTargets } from '../mcp/scope-guard';
import { extractFacts } from '../orchestrator/evidence-fact-extractor';
import { assessedFindingDto } from './finding-assessments';
import { assertCandidateSource, assertNotExhausted } from './finding-guards';
import { classifyClue } from './fact-classifier';

@Injectable()
export class FindingsService {
  constructor(@InjectRepository(FindingEntity) private readonly findings: Repository<FindingEntity>) {}

  async captureCandidates(taskId: string, factIds?: string[]): Promise<number> {
    if (factIds?.length === 0) return 0;
    return serialTransaction(this.findings.manager, async (manager) => {
      const facts = await manager.find(FactEntity, { where: { taskId, category: 'vulnerability', ...(factIds ? { id: In(factIds) } : {}) } });
      let count = 0;
      for (const fact of facts) {
        if (fact.status === 'refuted' || fact.observationKind === 'probe_error' || fact.predicate === 'verification_result') continue;
        // 否定性观测（登录被拒、爆破无结果、匿名被禁）说明的是安全性，不是漏洞；
        // 这类事实保留在黑板，但不进入漏洞候选列表，避免下游把"失败"当成"发现"。
        if (classifyClue({ predicate: fact.predicate, object: fact.object }).level === 'non-finding') continue;
        let targetIp = fact.targetIp;
        if (!targetIp && fact.sourceEvidenceIds?.length) {
          const sources = await manager.find(EvidenceEntity, { where: { taskId, id: In(fact.sourceEvidenceIds) } });
          const targets = [...new Set(sources.map((e) => e.meta?.targetIp).filter((ip): ip is string => typeof ip === 'string'))];
          if (targets.length === 1) targetIp = targets[0];
        }
        const canonicalKey = findingIdentity({ ...fact, targetIp });
        const existing = await manager.findOne(FindingEntity, { where: [{ id: fact.id, taskId }, { canonicalKey, taskId }] });
        if (existing) {
          const newSource = !(existing.sourceFactIds ?? [existing.id]).includes(fact.id);
          existing.evidenceIds = [...new Set([...existing.evidenceIds, ...fact.sourceEvidenceIds])];
          existing.targetIp = existing.targetIp ?? targetIp;
          existing.canonicalKey = canonicalKey;
          if (findingClueLevel(fact.predicate, fact.object) === 'actionable') existing.clueLevel = 'actionable';
          existing.sourceFactIds = [...new Set([...(existing.sourceFactIds ?? []), fact.id])];
          await manager.save(existing);
          if (newSource) await manager.insert(AuditLogEntity, { id: newId(), taskId, action: 'finding.source_merged', entityType: 'finding', entityId: existing.id, detail: { factId: fact.id, evidenceIds: fact.sourceEvidenceIds } });
          continue;
        }
        await manager.insert(FindingEntity, {
          id: fact.id, taskId, clueLevel: findingClueLevel(fact.predicate, fact.object), canonicalKey, sourceFactIds: [fact.id], title: findingTitle(fact.subject, fact.predicate),
          description: `${fact.subject} ${fact.predicate} ${fact.object}`, severity: 'info',
          status: 'candidate', source: fact.createdBy === 'agent' ? 'agent' : 'tool',
          targetIp, evidenceIds: fact.sourceEvidenceIds ?? [],
          cwe: null, cve: null, cvss: null, remediation: null,
        });
        await manager.insert(AuditLogEntity, { id: newId(), taskId, action: 'finding.candidate_created', entityType: 'finding', entityId: fact.id, detail: { factId: fact.id } });
        count++;
      }
      return count;
    });
  }

  /**
   * 由模型通过 report_finding 工具直接登记的候选。
   * 与事实抽取路径共用同一张表与同一状态机：只产生 candidate，确认必须走独立验证。
   */
  async createCandidate(input: {
    taskId: string;
    title: string;
    description: string;
    severity: string;
    targetIp: string | null;
    cve: string | null;
    cwe: string | null;
    evidenceIds: string[];
    agentSessionId: string | null;
    sourceFactIds?: string[];
  }): Promise<{ id: string; status: string }> {
    if (!input.title.trim() || !input.description.trim()) throw new BadRequestException('漏洞候选需要标题与描述');
    if (!input.evidenceIds.length) throw new BadRequestException('漏洞候选必须引用证据');
    // 验证会话的职责是判定既有候选是否成立，不能反过来制造新候选；
    // 否则"验证 → 新候选 → 再验证"会不断自我繁殖，永远无法收敛。
    if (input.agentSessionId) {
      const session = await this.findings.manager.findOne(AgentSessionEntity, {
        where: { id: input.agentSessionId, taskId: input.taskId },
        select: ['id', 'role', 'profileId'],
      });
      const rejected = assertCandidateSource(session ?? null);
      if (rejected) throw new BadRequestException(rejected);
    }
    const evidenceIds = [...new Set(input.evidenceIds)];
    return serialTransaction(this.findings.manager, async (manager) => {
      const evidence = await manager.find(EvidenceEntity, { where: { taskId: input.taskId, id: In(evidenceIds) } });
      if (evidence.length !== evidenceIds.length) throw new BadRequestException('漏洞候选引用的证据不存在或不属于当前任务');
      const sourceFactIds = [...new Set(input.sourceFactIds ?? [])];
      const facts = sourceFactIds.length ? await manager.find(FactEntity, { where: { taskId: input.taskId, id: In(sourceFactIds) } }) : [];
      if (facts.length !== sourceFactIds.length || facts.some((fact) => fact.category !== 'vulnerability' || fact.status === 'refuted' || fact.observationKind === 'probe_error' || fact.predicate === 'verification_result')) throw new BadRequestException('来源事实必须是当前任务的有效漏洞线索');
      if (facts.some((fact) => classifyClue({ predicate: fact.predicate, object: fact.object }).level === 'non-finding')) throw new BadRequestException('否定性观测应记录为事实，不作为漏洞候选');
      if (facts.some((fact) => fact.targetIp && fact.targetIp !== input.targetIp)) throw new BadRequestException('来源事实与候选目标不一致');
      const identities = new Set(facts.map((fact) => findingIdentity({ ...fact, targetIp: fact.targetIp ?? input.targetIp })));
      if (identities.size > 1) throw new BadRequestException('不同资源或现象的线索请分别上报');
      // Explicit fact provenance shares identity with extraction. Without it, only exact
      // normalized reports merge; do not guess that different resources or auth contexts match.
      const normalize = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ');
      const canonicalKey = identities.values().next().value ?? createHash('sha256').update(JSON.stringify([
        'reported', input.targetIp, normalize(input.title), normalize(input.description), input.cve, input.cwe,
      ])).digest('hex');
      const clueLevel = facts.length
        ? facts.some((fact) => findingClueLevel(fact.predicate, `${fact.object} ${input.description}`) === 'actionable') ? 'actionable' : 'weakness'
        : findingClueLevel(input.title, input.description);
      const existing = await manager.findOne(FindingEntity, { where: { taskId: input.taskId, canonicalKey } });
      if (existing) {
        existing.evidenceIds = [...new Set([...existing.evidenceIds, ...evidenceIds])];
        existing.sourceFactIds = [...new Set([...(existing.sourceFactIds ?? []), ...sourceFactIds])];
        if (clueLevel === 'actionable') existing.clueLevel = 'actionable';
        await manager.save(existing);
        await manager.insert(AuditLogEntity, { id: newId(), taskId: input.taskId, action: 'finding.report_merged', entityType: 'finding', entityId: existing.id,
          detail: { evidenceIds, sourceFactIds, agentSessionId: input.agentSessionId ?? '' } });
        return { id: existing.id, status: existing.status };
      }
      const id = newId();
      await manager.insert(FindingEntity, {
        id, taskId: input.taskId, canonicalKey, sourceFactIds, clueLevel, title: input.title.trim().slice(0, 200),
        description: input.description.trim(), severity: input.severity as Severity,
        status: 'candidate', source: 'agent', targetIp: input.targetIp, evidenceIds,
        cwe: input.cwe, cve: input.cve, cvss: null as never, remediation: null as never,
      });
      await manager.insert(AuditLogEntity, {
        id: newId(), taskId: input.taskId, action: 'finding.candidate_reported', entityType: 'finding', entityId: id,
        detail: { evidenceIds, agentSessionId: input.agentSessionId ?? null, source: 'report_finding' } as never,
      });
      return { id, status: 'candidate' };
    });
  }

  async list(taskId: string, page = 1, status?: string, clueLevel?: string): Promise<{ items: FindingDto[]; total: number }> {
    await this.reconcilePending(taskId);
    const { skip, take } = normalizePagination(page, 25);
    if (clueLevel && !['actionable', 'weakness'].includes(clueLevel)) throw new BadRequestException('未知线索级别');
    if (status && !['candidate', 'verifying', 'confirmed', 'refuted', 'unconfirmed'].includes(status)) throw new BadRequestException('未知漏洞状态');
    const [rows, total] = await this.findings.findAndCount({ where: { taskId, ...(clueLevel ? { clueLevel: clueLevel as 'actionable' | 'weakness' } : {}), ...(status ? { status: status as FindingEntity['status'] } : {}) }, order: { createdAt: 'DESC', id: 'DESC' }, skip, take });
    return { items: await Promise.all(rows.map((row) => assessedFindingDto(this.findings.manager, row))), total };
  }

  async detail(taskId: string, id: string) {
    await this.reconcilePending(taskId);
    const finding = await this.findings.findOne({ where: { id, taskId } });
    if (!finding) throw new NotFoundException('漏洞不存在');
    const records = await this.findings.manager.find(FindingVerificationEntity, { where: { findingId: id, taskId }, order: { createdAt: 'DESC' } });
    return { finding: await assessedFindingDto(this.findings.manager, finding), verifications: records.map(verificationDto) };
  }

  /** 正在运行的测试自动验证新候选；无法确认的历史结果不会无界重试。 */
  async queueEligibleCandidates(taskId: string, factIds: string[]): Promise<number> {
    if (!factIds.length) return 0;
    const task = await this.findings.manager.findOne(TaskEntity, { where: { id: taskId } });
    if (!task || task.status !== 'running' || ['paused', 'stopped', 'completed', 'failed'].includes(task.engineStatus)) return 0;
    const changed = new Set(factIds);
    const candidates = (await this.findings.find({ where: { taskId, status: 'candidate', clueLevel: 'actionable' } })).filter((row) => changed.has(row.id) || row.sourceFactIds?.some((id) => changed.has(id)));
    let queued = 0;
    for (const candidate of candidates) {
      try { await this.requestVerification(taskId, candidate.id); queued++; }
      catch (error) {
        // 缺少可信来源或当前 Scope 的候选保留在列表中，不能让一个候选阻塞 Worker 收尾。
        if (!(error instanceof BadRequestException || error instanceof NotFoundException)) throw error;
      }
    }
    return queued;
  }

  async requestVerification(taskId: string, id: string): Promise<FindingVerificationDto> {
    await this.reconcilePending(taskId);
    return serialTransaction(this.findings.manager, async (manager) => {
      const finding = await manager.findOne(FindingEntity, { where: { id, taskId } });
      if (!finding) throw new NotFoundException('漏洞不存在');
      const pending = await manager.findOne(FindingVerificationEntity, { where: { findingId: id, taskId, outcome: 'pending' } });
      if (pending) return verificationDto(pending);
      // 无法形成结论的候选不再自动重复排队：同一候选反复"验证不出结果"
      // 只会消耗预算而不产生新知识。已确认/已排除的候选允许复查。
      const inconclusive = await manager.findOne(FindingVerificationEntity, {
        where: { findingId: id, taskId },
        order: { createdAt: 'DESC' },
      });
      const task = await manager.findOne(TaskEntity, { where: { id: taskId } });
      const targets = await manager.find(TargetEntity, { where: { taskId, inScope: true } });
      if (!task || !finding.targetIp || !extractTargets({ target: finding.targetIp }).length || !checkScope(extractTargets({ target: finding.targetIp }), {
        allowedIps: targets.map((t) => t.ip), allowedCidrs: task.scope?.cidrs ?? [], allowedHostnames: targets.filter((t) => t.hostname).map((t) => t.hostname!),
      }).allow) throw new BadRequestException('候选漏洞缺少当前授权范围内的明确目标');
      const baseline = await validEvidence(manager, taskId, finding.evidenceIds, finding.targetIp);
      if (!baseline.length) throw new BadRequestException('候选漏洞缺少完整且可溯源的工具证据，请先补充信息收集');
      const hasNewEvidence = baseline.some((e) => !inconclusive?.baselineEvidenceIds.includes(e.id)
        && e.createdAt > (inconclusive?.createdAt ?? new Date(0)));
      const exhausted = assertNotExhausted(inconclusive ?? null, hasNewEvidence);
      if (exhausted) throw new BadRequestException(exhausted);
      const verificationId = newId();
      const intentId = newId();
      await manager.insert(IntentEntity, {
        id: intentId, taskId, agentSessionId: null, title: `验证：${finding.title}`.slice(0, 200),
        hypothesis: finding.description,
        objective: `独立验证候选 ${finding.id}：${finding.description}。使用最小影响的方法，获取本次新证据；输出 verification，明确区分确认、排除和无法确认。`,
        rationale: `候选证据 ${baseline.map((e) => e.id).join(', ')}；版本匹配不能直接确认漏洞。`,
        workerProfileId: 'verification', prerequisites: [], suggestedTools: [],
        expectedEvidence: ['本次独立验证请求与响应', '支撑结论的原始证据片段'],
        targetIp: finding.targetIp, priority: 80, dedupeKey: `verify-finding:${verificationId}`,
        dependencies: [], factIds: [finding.id], maxAttempts: 1, status: 'proposed',
      });
      const row = manager.create(FindingVerificationEntity, {
        id: verificationId, taskId, findingId: id, intentId, agentSessionId: null,
        outcome: 'pending', summary: '已进入验证队列', baselineEvidenceIds: baseline.map((e) => e.id), evidenceIds: [], evidenceQuotes: [],
        createdAt: new Date(), updatedAt: new Date(),
      });
      const saved = await manager.save(row);
      await manager.update(FindingEntity, { id, taskId }, { status: 'verifying' });
      await manager.insert(TaskStateEventEntity, { id: verificationId, taskId, eventType: 'finding.verification_requested', payload: { findingId: id }, consumedAt: null });
      await manager.insert(AuditLogEntity, { id: newId(), actor: 'local-operator', taskId, action: 'finding.verification_requested', entityType: 'finding', entityId: id, detail: { verificationId, intentId } });
      return verificationDto(saved);
    });
  }

  async recordWorkerResult(taskId: string, intentId: string, sessionId: string, workerTaskId: string, result: VerificationResult | null, error?: string | null): Promise<void> {
    await serialTransaction(this.findings.manager, async (manager) => {
      const record = await manager.findOne(FindingVerificationEntity, { where: { taskId, intentId, outcome: 'pending' } });
      if (!record) return;
      const finding = await manager.findOneByOrFail(FindingEntity, { id: record.findingId, taskId });
      const session = await manager.findOne(AgentSessionEntity, { where: { id: sessionId, taskId, role: 'verifier', profileId: 'verification' } });
      const worker = await manager.findOne(WorkerTaskEntity, { where: { id: workerTaskId, taskId, intentId, sessionId, profileId: 'verification' } });
      let outcome: VerificationOutcome = 'inconclusive';
      let summary = error ? `执行失败：${error}` : result?.summary || '没有有效的结构化验证结论';
      let accepted: EvidenceEntity[] = [];
      let quotes: { evidenceId: string; quote: string }[] = [];
      if (!error && session && worker && session.state === 'completed' && result?.summary.trim()) {
        const offered = await validEvidence(manager, taskId, result.evidenceQuotes.map((q) => q.evidenceId), finding.targetIp);
        quotes = result.evidenceQuotes.filter((q) => q.quote.trim().length >= 8 && offered.some((e) => e.id === q.evidenceId && e.agentSessionId === sessionId && e.content!.includes(q.quote)));
        accepted = offered.filter((e) => quotes.some((q) => q.evidenceId === e.id));
        const baseline = await validEvidence(manager, taskId, record.baselineEvidenceIds, finding.targetIp);
        // 独立性来自新会话和新调用，而不是响应文本必须不同；可重复的漏洞可能返回完全相同的内容。
        const independent = baseline.some((b) => b.agentSessionId !== sessionId && accepted.some((e) => e.toolCallId !== b.toolCallId && e.createdAt.getTime() >= record.createdAt.getTime()));
        if (accepted.length && independent) outcome = result.outcome;
        else summary = `证据不足，不能采信 ${result.outcome}：缺少本次会话的有效原文引用或独立于候选来源的新证据。${summary}`;
      }
      record.outcome = outcome; record.summary = summary;
      record.updatedAt = new Date();
      record.agentSessionId = sessionId; record.evidenceIds = accepted.map((e) => e.id); record.evidenceQuotes = quotes;
      await manager.save(record);
      await manager.insert(AuditLogEntity, { id: newId(), taskId, action: 'finding.verification_finished', entityType: 'finding', entityId: finding.id, detail: { verificationId: record.id, outcome, evidenceIds: record.evidenceIds } });
      await manager.update(FindingEntity, { id: finding.id, taskId }, { status: outcome === 'inconclusive' ? 'unconfirmed' : outcome });
      await manager.insert(HintEntity, { id: record.id, taskId, agentSessionId: null, appliedToSessionId: null, status: 'pending', consumedAt: null,
        content: `候选 ${finding.id} 独立验证结果 ${outcome}：${summary}` });
      if (outcome === 'confirmed' || outcome === 'refuted') {
        const source = await manager.findOne(FactEntity, { where: { id: finding.id, taskId } });
        await manager.insert(FactEntity, {
          id: record.id, taskId, agentSessionId: sessionId, category: 'vulnerability',
          subject: source?.subject ?? finding.targetIp!, predicate: 'verification_result', object: `${finding.title}: ${outcome}`,
          status: outcome === 'confirmed' ? 'verified' : 'refuted', confidence: 0.8,
          sourceEvidenceIds: [...new Set([...record.baselineEvidenceIds, ...record.evidenceIds])], createdBy: 'tool',
          hypothesisIds: [], sourceTool: String(accepted[0]?.meta?.tool ?? 'verification'), targetIp: finding.targetIp,
          observedAt: new Date(), observationKind: outcome === 'confirmed' ? 'target_state' : 'target_negative', conflictGroupId: null, conflictResolved: false,
        });
      }
    });
  }

  /** 将调度拒绝、租约回收或收尾中断呈现为无法确认，保留历史并允许重新安排。 */
  private async reconcilePending(taskId: string): Promise<void> {
    const pending = await this.findings.manager.find(FindingVerificationEntity, { where: { taskId, outcome: 'pending' } });
    if (!pending.length) return;
    await serialTransaction(this.findings.manager, async (manager) => {
      for (const record of pending) {
        const current = await manager.findOneByOrFail(FindingVerificationEntity, { id: record.id });
        if (current.outcome !== 'pending') continue;
        const intent = await manager.findOne(IntentEntity, { where: { id: record.intentId, taskId } });
        const worker = await manager.findOne(WorkerTaskEntity, { where: { intentId: record.intentId, taskId }, order: { createdAt: 'DESC' } });
        if (!intent || ['done', 'rejected'].includes(intent.status) || (worker && ['failed', 'timeout', 'cancelled'].includes(worker.status))) {
          await manager.update(FindingVerificationEntity, { id: record.id }, { outcome: 'inconclusive', summary: `验证没有形成有效结论：${worker?.errorMessage ?? intent?.rejectedReason ?? intent?.status ?? '意图不存在'}` });
          await manager.update(FindingEntity, { id: record.findingId, taskId }, { status: 'unconfirmed' });
        }
      }
    });
  }
}

async function validEvidence(manager: EntityManager, taskId: string, ids: string[], target: string | null): Promise<EvidenceEntity[]> {
  if (!ids.length || !target) return [];
  const rows = await manager.find(EvidenceEntity, { where: { taskId, id: In([...new Set(ids)]) } });
  const valid: EvidenceEntity[] = [];
  for (const row of rows) {
    if (!row.content?.trim() || row.meta?.targetIp !== target || !row.toolCallId) continue;
    if (extractFacts(String(row.meta?.tool ?? ''), target, row.content).some((f) => f.observationKind === 'probe_error')) continue;
    if (row.sha256 !== createHash('sha256').update(row.content).digest('hex') || row.sizeBytes !== Buffer.byteLength(row.content, 'utf8')) continue;
    const call = await manager.findOne(ToolCallEntity, { where: { id: row.toolCallId, taskId, rawOutputRef: row.id, status: 'success' } });
    if (call && call.agentSessionId === row.agentSessionId) valid.push(row);
  }
  return valid;
}

function verificationDto(row: FindingVerificationEntity): FindingVerificationDto {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
