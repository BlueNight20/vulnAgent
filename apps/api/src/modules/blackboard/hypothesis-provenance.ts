import { createHash } from 'node:crypto';
import { In, type EntityManager, type ObjectLiteral } from 'typeorm';
import type { HypothesisLinkDto } from '@vulnagent/shared';
import { AgentSessionEntity, EvidenceEntity, FactEntity, HypothesisEntity, HypothesisLinkEntity, IntentEntity, TargetEntity, TaskEntity, ToolCallEntity } from '../../database/entities';
import { checkScope, extractTargets, type ScopePolicy } from '../mcp/scope-guard';
import { checkToolWorkload } from '../mcp/tool-workload';

export type Quote = { evidenceId: string; quote: string };
type Validation = { validation: NonNullable<HypothesisLinkDto['validation']>; invalidReason: string | null; hashes: string[] };
interface Proof { target: string | null; targets: string[]; hash: string; quotes: Set<string>; invalid: string | null; stale: boolean }
export interface GraphContext {
  policy: ScopePolicy;
  facts: Map<string, FactEntity>;
  intents: Map<string, IntentEntity>;
  sessions: Set<string>;
  proofs: Map<string, Proof>;
}

export function targetWithin(target: string | null, parent: string | null): boolean {
  if (!target || !parent) return false;
  return checkScope(extractTargets({ target }), { allowedIps: parent.includes('/') ? [] : [parent], allowedCidrs: parent.includes('/') ? [parent] : [], allowedHostnames: [] }).allow;
}
export function validQuotes(value: unknown): value is Quote[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 10 && value.every((q) => q && typeof q.evidenceId === 'string' && q.evidenceId.length <= 64 && typeof q.quote === 'string' && q.quote.trim().length >= 8 && q.quote.length <= 2000);
}
function quoteNamesTarget(quote: string, target: string): boolean {
  // 不能把 .10 当成 .101 的前缀，或把单个 IP 当成 CIDR 字面量中的主机观测。
  return [...quote.matchAll(/(?<![\d./])(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?(?![\d./])/g)].some((m) => m[0] === target);
}

async function byIds<T extends ObjectLiteral>(manager: EntityManager, entity: new () => T, taskId: string, ids: string[]): Promise<T[]> {
  const rows: T[] = [];
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 100) rows.push(...await manager.getRepository(entity).find({ where: { taskId, id: In(unique.slice(i, i + 100)) } as never }));
  return rows;
}

/** 每次读取重新验证；逐条读取全文，只保留哈希与引用命中结果，避免把整份证据库常驻内存。 */
export async function loadGraphContext(manager: EntityManager, task: TaskEntity, links: HypothesisLinkEntity[]): Promise<GraphContext> {
  const targets = await manager.find(TargetEntity, { where: { taskId: task.id, inScope: true } });
  const policy: ScopePolicy = {
    allowedIps: targets.filter((t) => !t.ip.includes('/')).map((t) => t.ip),
    allowedCidrs: [...(task.scope?.cidrs ?? []), ...targets.filter((t) => t.ip.includes('/')).map((t) => t.ip)],
    allowedHostnames: [],
  };
  const facts = new Map((await byIds(manager, FactEntity, task.id, links.filter((l) => l.targetType === 'fact').map((l) => l.targetId))).map((f) => [f.id, f]));
  const intents = new Map((await byIds(manager, IntentEntity, task.id, links.filter((l) => l.targetType === 'intent').map((l) => l.targetId))).map((i) => [i.id, i]));
  const sessions = new Set((await byIds(manager, AgentSessionEntity, task.id, links.flatMap((l) => l.agentSessionId ? [l.agentSessionId] : []))).map((s) => s.id));
  const wanted = new Map<string, Set<string>>();
  for (const link of links) {
    if (link.targetType === 'evidence' && !wanted.has(link.targetId)) wanted.set(link.targetId, new Set());
    for (const q of validQuotes(link.evidenceQuotes) ? link.evidenceQuotes : []) {
      if (!wanted.has(q.evidenceId)) wanted.set(q.evidenceId, new Set());
      wanted.get(q.evidenceId)!.add(q.quote);
    }
  }
  const cutoff = Math.max(task.startedAt?.getTime() ?? task.createdAt.getTime(), task.goal?.configuredAt ? new Date(task.goal.configuredAt).getTime() : 0);
  const proofs = new Map<string, Proof>();
  const sourceSessions = new Map<string, boolean>();
  for (const [id, quotes] of wanted) {
    const row = await manager.findOne(EvidenceEntity, { where: { id, taskId: task.id } });
    if (!row) continue;
    let invalid: string | null = null;
    const hash = typeof row.content === 'string' ? createHash('sha256').update(row.content).digest('hex') : '';
    if (!row.content?.trim() || !row.sha256 || hash !== row.sha256 || row.sizeBytes !== Buffer.byteLength(row.content, 'utf8')) invalid = '原始文本缺失或完整性不匹配';
    const call = row.toolCallId ? await manager.findOne(ToolCallEntity, { where: { id: row.toolCallId, taskId: task.id, status: 'success', rawOutputRef: id } }) : null;
    if (!call || call.decision !== 'allow' || call.failureKind || call.agentSessionId !== row.agentSessionId || call.toolName !== row.meta?.tool) invalid = '缺少匹配的成功工具调用来源';
    if (row.agentSessionId) {
      if (!sourceSessions.has(row.agentSessionId)) sourceSessions.set(row.agentSessionId, await manager.exists(AgentSessionEntity, { where: { id: row.agentSessionId, taskId: task.id } }));
      if (!sourceSessions.get(row.agentSessionId)) invalid = '原始证据的会话不存在或不属于此任务';
    }
    if (!Number.isFinite(cutoff)) invalid = '任务验收时间边界无效';
    const actualTargets = call ? extractTargets(call.arguments) : [];
    const sourceTargets = [...new Set(actualTargets.map((t) => t.normalized))];
    const metaTarget = typeof row.meta?.targetIp === 'string' ? row.meta.targetIp : null;
    if (!sourceTargets.length || !checkScope(actualTargets, policy).allow || (metaTarget && !sourceTargets.includes(metaTarget)) || (call?.targetIp && metaTarget !== call.targetIp)) invalid = '工具参数目标、证据目标或当前授权范围不一致';
    if (task.scope?.ports && call && !checkToolWorkload(call.toolName, call.arguments, task.scope.ports, { maxHosts: Number.MAX_SAFE_INTEGER, maxPorts: 65535, maxProbes: Number.MAX_SAFE_INTEGER }).allow) invalid = '原调用的端口或选择器不符合当前授权范围';
    proofs.set(id, { target: metaTarget ?? (sourceTargets.length === 1 ? sourceTargets[0] : null), targets: sourceTargets, hash, quotes: new Set([...quotes].filter((q) => row.content?.includes(q))), invalid, stale: row.createdAt.getTime() < cutoff || Boolean(call && call.createdAt.getTime() < cutoff) });
  }
  return { policy, facts, intents, sessions, proofs };
}

export function validateRelation(hypothesis: HypothesisEntity, link: HypothesisLinkEntity, ctx: GraphContext): Validation {
  const fail = (invalidReason: string, validation: Validation['validation'] = 'invalid'): Validation => ({ validation, invalidReason, hashes: [] });
  if (link.taskId !== hypothesis.taskId || link.hypothesisId !== hypothesis.id) return fail('任务或假设归属不匹配');
  if (!hypothesis.targetIp || !checkScope(extractTargets({ target: hypothesis.targetIp }), ctx.policy).allow) return fail('假设未绑定当前授权目标');
  const target = link.targetType === 'fact' ? ctx.facts.get(link.targetId) : link.targetType === 'intent' ? ctx.intents.get(link.targetId) : ctx.proofs.get(link.targetId);
  if (!target) return fail('关联对象不存在或不属于此任务');
  const targetIp = 'targetIp' in target ? target.targetIp : target.target;
  // 引用宽范围证据可以覆盖单个目标；事实/意图必须落在假设的目标内。
  const targetMatches = link.targetType === 'evidence'
    ? ctx.proofs.get(link.targetId)!.targets.some((t) => targetWithin(t, hypothesis.targetIp) || targetWithin(hypothesis.targetIp, t))
    : targetWithin(targetIp, hypothesis.targetIp);
  if (!targetMatches) return fail('关联对象与假设目标不一致');
  if (!['supports', 'contradicts'].includes(link.linkType)) return { validation: 'valid', invalidReason: null, hashes: [] };
  if (link.assessmentSource === 'legacy') return fail('旧关联未记录明确原文，不计入判断', 'legacy');
  if (!['agent', 'user'].includes(link.assessmentSource)) return fail('未知关联来源，不能计入判断');
  if (link.assessmentSource === 'agent' && (!link.agentSessionId || !ctx.sessions.has(link.agentSessionId))) return fail('模型关联缺少同任务会话来源');
  if (!link.note?.trim() || link.note.trim().length < 8) return fail('缺少关系解释');
  if (link.targetType === 'intent') return fail('意图是计划，不能作为支持或反驳证据');
  if (!validQuotes(link.evidenceQuotes)) return fail('需要 1～10 条明确证据 ID 与 8～2000 字连续原文');
  const fact = link.targetType === 'fact' ? ctx.facts.get(link.targetId)! : null;
  if (fact && (!['observed', 'verified'].includes(fact.status) || !['target_state', 'target_negative'].includes(fact.observationKind) || (fact.conflictGroupId && !fact.conflictResolved))) return fail('推断、探测失败、已推翻或未解决冲突的事实不能计入判断');
  const hashes: string[] = [];
  for (const q of link.evidenceQuotes) {
    if ((link.targetType === 'evidence' && q.evidenceId !== link.targetId) || (fact && !fact.sourceEvidenceIds.includes(q.evidenceId))) return fail('引用原文不属于明确关联对象的来源');
    const proof = ctx.proofs.get(q.evidenceId);
    if (!proof || proof.invalid) return fail(proof?.invalid ?? '引用证据不存在或不属于此任务');
    if (proof.stale) return fail('引用早于当前运行或验收配置，仅保留历史关系', 'stale');
    if (!proof.quotes.has(q.quote)) return fail('引用不是证据中的连续原文');
    const matching = proof.targets.filter((t) => targetWithin(hypothesis.targetIp, t) || targetWithin(t, hypothesis.targetIp));
    if (!matching.length) return fail('原始证据的目标不匹配');
    if (link.targetType === 'evidence' && (proof.targets.length > 1 || matching.every((t) => t !== hypothesis.targetIp && targetWithin(hypothesis.targetIp, t))) && !quoteNamesTarget(q.quote, hypothesis.targetIp)) return fail('宽范围证据引用需要包含此假设的明确目标，或改为引用对应目标的事实');
    hashes.push(proof.hash);
  }
  return { validation: 'valid', invalidReason: null, hashes: [...new Set(hashes)] };
}
