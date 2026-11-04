import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';
import { targetHost, type TaskAcceptance, type TaskGoalInput } from '@vulnagent/shared';
import { AuditLogEntity, EvidenceEntity, FactEntity, FindingEntity, FindingVerificationEntity, IntentEntity, ModelRequestEntity, TargetEntity, TaskEntity, ToolCallEntity, WorkerTaskEntity, WorkerResultCardEntity } from '../../database/entities';
import { serialTransaction } from '../../database/serial-transaction';
import { newId } from '../../common/utils/id';
import { checkScope, extractTargets } from '../mcp/scope-guard';
import { extractFacts } from '../orchestrator/evidence-fact-extractor';
import { configureGoal, evaluateGoal, proofCoversTarget, proofsCoverRange, type GoalProof } from './task-goal-rules';
import { FindingsService } from './findings.service';

export interface GoalDataset {
  models?: ModelRequestEntity[];
  facts: FactEntity[]; evidence: EvidenceEntity[]; calls: ToolCallEntity[]; findings: FindingEntity[];
  records: FindingVerificationEntity[]; intents: IntentEntity[]; workers: WorkerTaskEntity[]; cards: WorkerResultCardEntity[];
}

@Injectable()
export class TaskGoalsService {
  constructor(@InjectRepository(TaskEntity) private readonly tasks: Repository<TaskEntity>, private readonly findings: FindingsService) {}

  async set(taskId: string, input: TaskGoalInput): Promise<TaskAcceptance> {
    await serialTransaction(this.tasks.manager, async (manager) => {
      const task = await manager.findOne(TaskEntity, { where: { id: taskId } });
      if (!task) throw new NotFoundException('任务不存在');
      if ((task.status === 'running' && task.engineStatus === 'running') || ['completed', 'stopped'].includes(task.status)) throw new BadRequestException('请先暂停任务或重跑后再修改验收目标');
      const targets = await manager.find(TargetEntity, { where: { taskId, inScope: true } });
      const goal = configureGoal(input, targets.map((t) => t.ip), { cidrs: targets.filter((t) => t.kind === 'cidr').map((t) => t.ip), ports: task.scope?.ports ?? null });
      await manager.update(TaskEntity, { id: taskId }, { goal });
      await manager.insert(AuditLogEntity, { id: newId(), actor: 'local-operator', taskId, action: 'task.goal_changed', entityType: 'task', entityId: taskId, detail: { mode: goal.mode, targets: goal.targets, ports: goal.ports ?? '', protocol: goal.protocol } });
    });
    return this.evaluate(taskId);
  }

  async evaluate(taskId: string): Promise<TaskAcceptance> {
    const manager = this.tasks.manager;
    const task = await this.tasks.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException('任务不存在');
    if (!task.goal) return evaluateGoal(null, [], [], [], false);
    const [facts, evidence, calls, findings, records, intents, workers, cards] = await Promise.all([
      manager.find(FactEntity, { where: { taskId } }), manager.find(EvidenceEntity, { where: { taskId } }),
      manager.find(ToolCallEntity, { where: { taskId } }), manager.find(FindingEntity, { where: { taskId } }),
      manager.find(FindingVerificationEntity, { where: { taskId } }), manager.find(IntentEntity, { where: { taskId } }),
      manager.find(WorkerTaskEntity, { where: { taskId } }),
      manager.find(WorkerResultCardEntity, { where: { taskId } }),
    ]);
    const models = await manager.find(ModelRequestEntity, { where: { taskId, state: 'reserved' } });
    return this.evaluateSnapshot(task, { facts, evidence, calls, findings, records, intents, workers, cards, models });
  }

  /** Evaluate exactly the rows captured for a report, without reading a later live state. */
  evaluateSnapshot(task: TaskEntity, { facts, evidence, calls, findings, records, intents, workers, cards, models = [] }: GoalDataset): TaskAcceptance {
    if (!task.goal) return evaluateGoal(null, [], [], [], false);
    const cutoff = Math.max(task.startedAt?.getTime() ?? task.createdAt.getTime(), new Date(task.goal.configuredAt).getTime());
    const valid = new Map<string, EvidenceEntity>(); const proofs: GoalProof[] = [];
    const callMap = new Map(calls.map((c) => [c.id, c]));
    for (const row of evidence) {
      const call = callMap.get(row.toolCallId ?? '');
      if (!call || call.rawOutputRef !== row.id || call.status !== 'success' || !row.content?.trim() || row.sha256 !== createHash('sha256').update(row.content).digest('hex') || (row.sizeBytes !== null && row.sizeBytes !== Buffer.byteLength(row.content, 'utf8'))) continue;
      let text = row.content;
      try {
        const json = JSON.parse(text); const output = json?.result ?? json;
        if (typeof output?.return_code === 'number' && output.return_code !== 0) continue;
        if (typeof output?.stdout === 'string') text = output.stdout;
      } catch { /* 普通文本。 */ }
      const targetIp = typeof row.meta?.targetIp === 'string' ? row.meta.targetIp : call.targetIp;
      if (targetIp && call.targetIp && targetIp !== call.targetIp) continue;
      if (extractFacts(call.toolName, targetIp, text).some((f) => f.observationKind === 'probe_error')) continue;
      valid.set(row.id, row);
      if (row.createdAt.getTime() >= cutoff) proofs.push({ id: row.id, targetIp, toolName: call.toolName, args: call.arguments, text });
    }
    const freshIds = new Set(proofs.map((p) => p.id));
    const policy = { allowedIps: task.goal.targets.filter((t) => !t.includes('/')), allowedCidrs: task.goal.targets.filter((t) => t.includes('/')), allowedHostnames: task.goal.targets.map((t) => targetHost(t).toLowerCase()) };
    const related = findings.filter((f) => !f.targetIp || checkScope(extractTargets({ target: f.targetIp }), policy).allow).map((finding) => {
      const record = records.find((r) => r.findingId === finding.id && ['confirmed', 'refuted'].includes(r.outcome) && r.outcome === finding.status && r.updatedAt.getTime() >= cutoff && r.baselineEvidenceIds.length > 0 && r.baselineEvidenceIds.every((id) => valid.has(id)) && r.evidenceIds.length > 0 && r.evidenceIds.every((id) => freshIds.has(id)) && r.evidenceQuotes.length > 0 && r.evidenceQuotes.every((q) => valid.get(q.evidenceId)?.content?.includes(q.quote)));
      return { id: finding.id, title: finding.title, passed: Boolean(record) };
    });
    for (const fact of facts) if (task.goal.mode === 'assessment' && fact.category === 'vulnerability' && fact.predicate !== 'verification_result' && fact.status !== 'refuted' && (!fact.targetIp || checkScope(extractTargets({ target: fact.targetIp }), policy).allow) && !findings.some((f) => f.id === fact.id)) related.push({ id: fact.id, title: `漏洞类事实尚未形成候选：${fact.object}`, passed: false });
    const pending = models.some((m) => m.state === 'reserved') || intents.some((i) => ['proposed', 'dispatched'].includes(i.status)) || workers.some((w) => ['queued', 'running'].includes(w.status)) || calls.some((c) => c.status === 'pending_approval');
    const analysedIds = new Set(cards.filter((card) => !card.synthetic && card.summary.trim() && card.summary !== '(无摘要)' && workers.some((w) => w.id === card.workerTaskId && w.profileId === 'vuln-analysis' && w.status === 'succeeded' && w.createdAt.getTime() >= cutoff)).flatMap((card) => card.evidenceIds));
    const analysisProofs = proofs.filter((p) => analysedIds.has(p.id));
    const analysedTargets = task.goal.targets.filter((target) => target.includes('/') ? proofsCoverRange(analysisProofs, target) : analysisProofs.some((p) => proofCoversTarget(p, target)));
    return evaluateGoal(task.goal, facts.map((f) => ({ ...f, observedAt: f.observedAt?.toISOString() ?? null, createdAt: f.createdAt.toISOString() })), proofs, related, pending, analysedTargets);
  }

  async summary(taskId: string): Promise<string> {
    const result = await this.evaluate(taskId);
    if (!result.goal) return result.notes.join('\n');
    return [`目标类型 ${result.goal.mode}；目标 ${result.goal.targets.join(', ')}；协议 ${result.goal.protocol}；端口 ${result.goal.ports ?? '按证据标记'}。`,
      ...(result.goal.mode === 'evidence' ? [`要求原文标记：${result.goal.evidenceText}`] : []),
      ...result.checks.map((c) => `[${c.passed ? '满足' : '未满足'}] ${c.label}`), ...result.notes,
      '优先提出能补齐未满足验收项的意图；只有实际证据满足全部项目才算目标达成。',
      '在途工作项由编排器维护，不要为了消除在途计数而创建新意图。',
    ].join('\n');
  }

  async prepare(taskId: string): Promise<void> {
    const task = await this.tasks.findOne({ where: { id: taskId } });
    if (!task?.goal || task.goal.mode !== 'assessment' || task.status !== 'running' || task.engineStatus !== 'running') return;
    await this.findings.captureCandidates(taskId);
    const manager = this.tasks.manager;
    const cutoff = Math.max(task.startedAt?.getTime() ?? task.createdAt.getTime(), new Date(task.goal.configuredAt).getTime());
    const [findings, records] = await Promise.all([manager.find(FindingEntity, { where: { taskId } }), manager.find(FindingVerificationEntity, { where: { taskId } })]);
    const policy = { allowedIps: task.goal.targets.filter((t) => !t.includes('/')), allowedCidrs: task.goal.targets.filter((t) => t.includes('/')), allowedHostnames: task.goal.targets.map((t) => targetHost(t).toLowerCase()) };
    for (const finding of findings) {
      if (!finding.targetIp || !checkScope(extractTargets({ target: finding.targetIp }), policy).allow || records.some((r) => r.findingId === finding.id && r.createdAt.getTime() >= cutoff)) continue;
      try { await this.findings.requestVerification(taskId, finding.id); }
      catch (error) { if (!(error instanceof BadRequestException)) throw error; }
    }
  }
}
