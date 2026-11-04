import { ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';
import type { ReportDetailDto, ReportEvidence, ReportFinding, ReportSnapshot, ReportStats, ReportSummaryDto } from '@vulnagent/shared';
import { AgentSessionEntity, AuditLogEntity, EvidenceEntity, EvidenceAttachmentEntity, ReportAttachmentEntity, FactEntity, FindingEntity, FindingVerificationEntity, IntentEntity, ModelRequestEntity, ReportEntity, TargetEntity, TaskEntity, TaskStateEventEntity, ToolCallEntity, WorkerTaskEntity, WorkerResultCardEntity } from '../../database/entities';
import { serialTransaction } from '../../database/serial-transaction';
import { newId } from '../../common/utils/id';
import { toTaskDetail } from '../tasks/task-mapper';
import { TaskGoalsService } from '../blackboard/task-goals.service';
import { buildAttackSurface } from '../blackboard/attack-surface-builder';
import { extractFacts } from '../orchestrator/evidence-fact-extractor';
import { reportMarkdown } from './report-builder';
import { attachmentDto, MAX_CALL_ATTACHMENT_BYTES, sha256 } from '../blackboard/attachment-utils';
import { HypothesisService } from '../blackboard/hypothesis.service';
import { hydrateTaskAccounting } from '../../database/model-accounting';
import { assessedFindingDto } from '../blackboard/finding-assessments';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
interface StoredReport { version: 1; summary: ReportStats; snapshot: ReportSnapshot; checksum: string }
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

@Injectable()
export class ReportsService {
  constructor(@InjectRepository(ReportEntity) private readonly reports: Repository<ReportEntity>, private readonly goals: TaskGoalsService, private readonly hypotheses: HypothesisService) {}

  async list(taskId: string, page: number): Promise<{ items: ReportSummaryDto[]; total: number }> {
    await this.requireTask(taskId);
    const [rows, total] = await this.reports.createQueryBuilder('r').select(['r.id', 'r.taskId', 'r.title', 'r.status', 'r.generatedAt', 'r.createdAt'])
      .where('r.taskId = :taskId', { taskId }).orderBy('r.createdAt', 'DESC').addOrderBy('r.id', 'DESC').skip((page - 1) * 25).take(25).getManyAndCount();
    // TypeORM entity hydration omits aliased JSON; load only the small summary, never snapshot contents.
    const summaries = rows.length ? await this.reports.createQueryBuilder('r').select('r.id', 'id').addSelect("json_extract(r.stats, '$.summary')", 'summary').whereInIds(rows.map((r) => r.id)).getRawMany<{ id: string; summary: string | null }>() : [];
    const map = new Map(summaries.map((r) => [r.id, r.summary ? JSON.parse(r.summary) as ReportStats : null]));
    return { items: rows.map((r) => this.summary(r, map.get(r.id) ?? null)), total };
  }

  async generate(taskId: string): Promise<ReportDetailDto> {
    const id = newId();
    await serialTransaction(this.reports.manager, async (manager) => {
      const task = await manager.findOne(TaskEntity, { where: { id: taskId } });
      if (!task) throw new NotFoundException('任务不存在');
      await hydrateTaskAccounting(manager, task);
      const size = await manager.getRepository(EvidenceEntity).createQueryBuilder('e').select('COALESCE(SUM(length(CAST(e.content AS BLOB))),0)', 'bytes').where('e.taskId = :taskId', { taskId }).getRawOne<{ bytes: number }>();
      if (Number(size?.bytes) > MAX_SNAPSHOT_BYTES) throw new HttpException('任务文本证据超过 32 MiB，无法生成完整快照；请先按任务拆分测试范围', 413);
      const binarySize = await manager.getRepository(EvidenceAttachmentEntity).createQueryBuilder('a').select('COALESCE(SUM(length(a.data)),0)', 'bytes').where('a.taskId = :taskId', { taskId }).getRawOne<{ bytes: number }>();
      if (Number(binarySize?.bytes) > MAX_CALL_ATTACHMENT_BYTES) throw new HttpException('任务二进制附件超过报告复制上限 32 MiB，请拆分测试任务后生成', 413);
      const [targets, evidence, calls, facts, findings, verifications, workers, sessions, events, intents, cards] = await Promise.all([
        manager.find(TargetEntity, { where: { taskId } }), manager.find(EvidenceEntity, { where: { taskId }, order: { createdAt: 'ASC', id: 'ASC' } }),
        manager.find(ToolCallEntity, { where: { taskId }, order: { createdAt: 'ASC' } }), manager.find(FactEntity, { where: { taskId } }),
        manager.find(FindingEntity, { where: { taskId }, order: { createdAt: 'ASC' } }), manager.find(FindingVerificationEntity, { where: { taskId }, order: { createdAt: 'DESC' } }),
        manager.find(WorkerTaskEntity, { where: { taskId } }), manager.find(AgentSessionEntity, { where: { taskId } }),
        manager.find(TaskStateEventEntity, { where: { taskId } }), manager.find(IntentEntity, { where: { taskId } }), manager.find(WorkerResultCardEntity, { where: { taskId } }),
      ]);
      const models = await manager.find(ModelRequestEntity, { where: { taskId, state: 'reserved' } });
      const acceptance = this.goals.evaluateSnapshot(task, { facts, evidence, calls, findings, records: verifications, workers, intents, cards, models });
      const evidenceIds = new Set(evidence.map((e) => e.id));
      const binaryRows = (await manager.getRepository(EvidenceAttachmentEntity).createQueryBuilder('a').addSelect('a.data').where('a.taskId = :taskId', { taskId }).orderBy('a.id', 'ASC').getMany()).filter((a) => evidenceIds.has(a.evidenceId));
      const attachments = binaryRows.map(attachmentDto);
      for (const e of evidence) if (Array.isArray(e.meta?.attachmentIds) && e.meta.attachmentIds.some((id) => !attachments.some((a) => a.id === id && a.evidenceId === e.id))) throw new ConflictException(`证据 ${e.id} 的来源附件已丢失，无法生成完整附件快照`);
      const callMap = new Map(calls.map((c) => [c.id, c]));
      const proofs: ReportEvidence[] = evidence.map((e) => {
        const computedSha256 = e.content === null ? null : hash(e.content);
        const computedSizeBytes = e.content === null ? null : Buffer.byteLength(e.content, 'utf8');
        const attached = attachments.filter((a) => a.evidenceId === e.id);
        const integrity = e.content === null && attached.length ? attached.every((a) => a.integrity === 'match') ? 'match' : 'mismatch' : computedSha256 === null || !e.sha256 || e.sizeBytes === null ? 'missing' : computedSha256 === e.sha256 && computedSizeBytes === e.sizeBytes ? 'match' : 'mismatch';
        const call = callMap.get(e.toolCallId ?? '');
        const targetIp = typeof e.meta?.targetIp === 'string' ? e.meta.targetIp : call?.targetIp ?? null;
        let output = e.content ?? ''; let successful = true;
        try { const parsed = JSON.parse(output); const result = parsed?.result ?? parsed; if (typeof result?.return_code === 'number' && result.return_code !== 0) successful = false; if (typeof result?.stdout === 'string') output = result.stdout; } catch { /* Plain text. */ }
        const provenanceValid = integrity === 'match' && (Boolean(e.content?.trim()) || attached.length > 0) && Boolean(call && call.status === 'success' && call.rawOutputRef === e.id && call.agentSessionId === e.agentSessionId && (!call.targetIp || !targetIp || call.targetIp === targetIp)) && successful && !extractFacts(call?.toolName ?? '', targetIp, output).some((f) => f.observationKind === 'probe_error');
        return { id: e.id, title: e.title, kind: e.kind, toolCallId: e.toolCallId, sessionId: e.agentSessionId, targetIp, tool: call?.toolName ?? null, createdAt: e.createdAt.toISOString(), sha256: e.sha256, computedSha256, sizeBytes: e.sizeBytes, computedSizeBytes, integrity, provenanceValid, content: e.content, references: Array.isArray(e.meta?.externalReferences) ? e.meta.externalReferences as { uri: string; name: string }[] : [] };
      });
      const proofMap = new Map(proofs.map((e) => [e.id, e]));
      const validated: ReportFinding[] = await Promise.all(findings.map(async (f) => {
        const records = verifications.filter((r) => r.findingId === f.id);
        const definitive = ['confirmed', 'refuted'].includes(f.status);
        const record = records.find((r) => r.outcome === f.status);
        const validForTarget = (id: string) => { const e = proofMap.get(id); return e?.provenanceValid && Boolean(e.content?.trim()) && Boolean(f.targetIp) && e.targetIp === f.targetIp; };
        const proof = record?.evidenceIds.map((id) => proofMap.get(id)).filter((e): e is ReportEvidence => Boolean(e)) ?? [];
        const baseline = record?.baselineEvidenceIds.map((id) => proofMap.get(id)).filter((e): e is ReportEvidence => Boolean(e)) ?? [];
        const certified = Boolean(record && record.summary.trim() && record.agentSessionId &&
          sessions.some((s) => s.id === record.agentSessionId && s.role === 'verifier' && s.profileId === 'verification' && s.state === 'completed') &&
          workers.some((w) => w.sessionId === record.agentSessionId && w.intentId === record.intentId && w.profileId === 'verification' && w.status === 'succeeded') &&
          record.baselineEvidenceIds.length && record.baselineEvidenceIds.every(validForTarget) && record.evidenceIds.length && record.evidenceIds.every(validForTarget) &&
          proof.every((e) => e.sessionId === record.agentSessionId && new Date(e.createdAt).getTime() >= record.createdAt.getTime()) &&
          baseline.some((b) => b.sessionId !== record.agentSessionId && proof.some((e) => e.toolCallId !== b.toolCallId)) &&
          record.evidenceQuotes.length && record.evidenceQuotes.every((q) => q.quote.trim().length >= 8 && record.evidenceIds.includes(q.evidenceId) && proofMap.get(q.evidenceId)?.content?.includes(q.quote)));
        const pendingRecord = records.find((r) => r.outcome === 'pending');
        const pendingIntent = pendingRecord && intents.find((i) => i.id === pendingRecord.intentId);
        const pendingWorker = pendingRecord && workers.filter((w) => w.intentId === pendingRecord.intentId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        const abandoned = f.status === 'verifying' && (!pendingIntent || ['done', 'rejected'].includes(pendingIntent.status) || (pendingWorker && ['failed', 'timeout', 'cancelled'].includes(pendingWorker.status)));
        return { finding: await assessedFindingDto(manager, f), effectiveStatus: (definitive && !certified) || abandoned ? 'unconfirmed' : f.status,
          validationNote: definitive && !certified ? '存储结论缺少当前可校验的独立复核证据，报告降为未确认；原状态和验证历史保留供审阅。' : abandoned ? '验证工作已结束或丢失，尚未形成有效结论，报告按未确认展示。' : null,
          verifications: records.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() })) };
      }));
      const snapshot: ReportSnapshot = { version: 1, capturedAt: new Date().toISOString(), task: toTaskDetail(task, targets), engineStatus: task.engineStatus, stopReason: task.stopReason,
        acceptance, findings: validated, evidence: proofs, attachments, hypotheses: await this.hypotheses.readSnapshot(manager, taskId),
        analysis: cards.map((c) => { const worker = workers.find((w) => w.id === c.workerTaskId); return { id: c.id, workerId: c.workerTaskId, sessionId: c.sessionId, profileId: worker?.profileId ?? null, workerCreatedAt: worker?.createdAt.toISOString() ?? null, workerStatus: worker?.status ?? 'missing', summary: c.summary, synthetic: c.synthetic, evidenceIds: c.evidenceIds }; }),
        surface: buildAttackSurface(taskId, targets, task.scope, facts.map((f) => ({ ...f, createdAt: f.createdAt.toISOString(), observedAt: f.observedAt?.toISOString() ?? null })), validated.map((f) => ({ ...f.finding, status: f.effectiveStatus })), proofs.filter((e) => e.provenanceValid && e.content?.trim()).map((e) => e.id)),
        timeline: [
          ...calls.map((c) => ({ id: c.id, at: c.createdAt.toISOString(), kind: 'tool' as const, label: `${c.toolName} → ${c.targetIp ?? '目标未记录'}`, status: c.status, detail: c.errorMessage ?? c.decisionReason, evidenceIds: c.rawOutputRef ? [c.rawOutputRef] : [] })),
          ...workers.map((w) => ({ id: w.id, at: w.createdAt.toISOString(), kind: 'worker' as const, label: w.title, status: w.status, detail: w.errorMessage, evidenceIds: w.evidenceIds })),
          ...events.map((e) => ({ id: e.id, at: e.createdAt.toISOString(), kind: 'event' as const, label: e.eventType, status: e.consumedAt ? 'consumed' : 'pending', detail: null, evidenceIds: [] })),
        ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
        warnings: ['报告汇总任务历史观测与验证记录，验收进度仅评价当前运行和当前目标；历史观测不代表目标当前状态。', '结论依赖已保存证据与验证方法，不能证明未观测范围不存在漏洞。', '快照复制数据库内已保存的二进制附件；仅有路径或外部 URI 的记录保留引用，不读取磁盘路径或外部 URL。', 'PDF 字体未覆盖的字符显示为 [U+编码]，精确原文请查看 Markdown 或证据附件。'],
      };
      if (task.status !== 'completed' || !acceptance.complete || validated.some((f) => f.validationNote)) snapshot.warnings.push('这是阶段报告，任务未通过全部验收、尚未正常结束或存在无法校验的确认结论。');
      if (snapshot.hypotheses?.length) snapshot.warnings.push('假设关系及来源校验结果已冻结；支持/反驳是分析解释，不代表漏洞已确认或排除。引用校验不自动证明解释在语义上充分。');
      if (snapshot.hypotheses?.some((h) => h.hypothesis.conflicted)) snapshot.warnings.push('存在支持与反驳依据冲突的假设，仍需复核；报告保留双方解释与原文。');
      if (proofs.some((e) => !e.provenanceValid)) snapshot.warnings.push('存在损坏、无成功调用来源或缺少文本的证据，已从可信资产观测与确认依据中排除。');
      if (validated.some((entry) => entry.finding.assessment && !entry.finding.assessment.valid)) snapshot.warnings.push('存在失效的人工维护依据；对应评级、CVE/CWE、CVSS 和修复建议未采用，原维护记录保留供审阅。');
      if (attachments.some((a) => a.integrity !== 'match')) snapshot.warnings.push('存在来源校验不一致的二进制附件；报告保留现存字节，但不能作为可信观测依据。');
      if (facts.some((f) => f.category === 'vulnerability' && f.predicate !== 'verification_result' && !findings.some((v) => v.id === f.id))) snapshot.warnings.push('存在尚未同步为候选的漏洞类事实，请先在漏洞页面刷新候选并复核；本报告不把这些事实当作已确认漏洞。');
      const stats: ReportStats = { kind: task.status === 'completed' && acceptance.complete && !validated.some((f) => f.validationNote) ? 'final' : 'progress', findingCounts: { candidate: 0, verifying: 0, confirmed: 0, refuted: 0, unconfirmed: 0 }, evidenceCount: proofs.length, invalidEvidenceCount: proofs.filter((e) => !e.provenanceValid).length, unmetChecks: acceptance.checks.filter((c) => !c.passed).length, contentSha256: '', snapshotSha256: hash(JSON.stringify(snapshot)) };
      for (const f of validated) stats.findingCounts[f.effectiveStatus]++;
      stats.attachmentCount = attachments.length; stats.attachmentBytes = binaryRows.reduce((n, a) => n + a.data.length, 0); stats.invalidAttachmentCount = attachments.filter((a) => a.integrity !== 'match').length;
      const content = reportMarkdown(snapshot, stats); stats.contentSha256 = hash(content);
      const stored: StoredReport = { version: 1, summary: stats, snapshot, checksum: hash(JSON.stringify({ summary: stats, snapshot })) };
      if (Buffer.byteLength(JSON.stringify(stored)) + Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) throw new HttpException('完整报告快照超过 32 MiB，请拆分测试任务后生成；未截断或保存不完整报告', 413);
      const entity = manager.create(ReportEntity, { id, taskId, format: 'markdown', title: `${task.name} - ${stats.kind === 'final' ? '验收报告' : '阶段报告'}`.slice(0, 200), content, filePath: null, status: 'ready', generatedAt: new Date(), createdAt: new Date() });
      entity.stats = stored as unknown as Record<string, unknown>;
      await manager.save(entity);
      for (const a of binaryRows) await manager.save(manager.create(ReportAttachmentEntity, { reportId: id, attachmentId: a.id, taskId, evidenceId: a.evidenceId, filename: a.filename, mimeType: a.mimeType, sha256: sha256(a.data), sizeBytes: a.data.length, data: a.data }));
      await manager.insert(AuditLogEntity, { id: newId(), taskId, actor: 'local-operator', action: 'report.generated', entityType: 'report', entityId: id, detail: { contentSha256: stats.contentSha256, snapshotSha256: stats.snapshotSha256, kind: stats.kind } });
    });
    return this.detail(taskId, id);
  }

  async detail(taskId: string, id: string): Promise<ReportDetailDto> {
    const row = await this.row(taskId, id); const stored = row.stats as unknown as StoredReport | null;
    const files = await this.files(taskId, id);
    const integrity = this.integrity(row) === 'match' && !this.filesIntact(stored!, files) ? 'mismatch' : this.integrity(row);
    return { ...this.summary(row, stored?.summary ?? null), content: row.content ?? '', integrity, evidence: stored?.snapshot?.evidence?.map(({ content: _content, ...e }) => e) ?? [], attachments: stored?.snapshot?.attachments ?? [] };
  }

  async export(taskId: string, id: string) {
    const row = await this.row(taskId, id);
    if (this.integrity(row) !== 'match') throw new ConflictException('报告完整性校验未通过，请重新生成报告');
    const stored = row.stats as unknown as StoredReport;
    const files = await this.files(taskId, id);
    if (!this.filesIntact(stored, files)) throw new ConflictException('报告附件快照完整性校验未通过，已停止导出');
    return { content: row.content!, snapshot: stored.snapshot, stats: stored.summary, files };
  }
  private files(taskId: string, reportId: string) { return this.reports.manager.getRepository(ReportAttachmentEntity).createQueryBuilder('a').addSelect('a.data').where('a.taskId = :taskId AND a.reportId = :reportId', { taskId, reportId }).getMany(); }
  private filesIntact(stored: StoredReport, files: ReportAttachmentEntity[]): boolean {
    const expected = stored.snapshot.attachments ?? [];
    return files.length === expected.length && files.every((a) => expected.some((e) => e.id === a.attachmentId && e.evidenceId === a.evidenceId && e.filename === a.filename && e.mimeType === a.mimeType && e.computedSha256 === a.sha256 && e.computedSizeBytes === a.sizeBytes) && sha256(a.data) === a.sha256 && a.data.length === a.sizeBytes);
  }
  private integrity(row: ReportEntity): 'match' | 'mismatch' | 'missing' {
    const stored = row.stats as unknown as StoredReport | null;
    if (stored?.version !== 1 || !stored.checksum || !stored.snapshot || !stored.summary?.contentSha256 || !stored.summary.snapshotSha256 || row.content === null) return 'missing';
    return hash(row.content) === stored.summary.contentSha256 && hash(JSON.stringify(stored.snapshot)) === stored.summary.snapshotSha256 && hash(JSON.stringify({ summary: stored.summary, snapshot: stored.snapshot })) === stored.checksum ? 'match' : 'mismatch';
  }
  private async row(taskId: string, id: string) {
    await this.requireTask(taskId); const row = await this.reports.findOne({ where: { id, taskId } });
    if (!row) throw new NotFoundException('报告不存在'); return row;
  }
  private async requireTask(taskId: string) { if (!await this.reports.manager.existsBy(TaskEntity, { id: taskId })) throw new NotFoundException('任务不存在'); }
  private summary(row: ReportEntity, stats: ReportStats | null): ReportSummaryDto { return { id: row.id, taskId: row.taskId, title: row.title, status: row.status, generatedAt: row.generatedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), stats }; }
}
