import type { ScoreBreakdown } from '@vulnagent/shared';

/**
 * 可解释的探索意图综合评分。
 *
 * 默认权重刻意写成普通常量并标注「未经过实验标定」，
 * 便于后续替换为可配置参数，而不是假装已经最优。
 */
export const DEFAULT_WEIGHTS = {
  /** 证据支持程度：已有事实越多越可信，但边际递减 */
  evidenceSupport: 0.25,
  /** 未知程度：尚未被探索的方向价值更高 */
  novelty: 0.3,
  /** 潜在风险/价值：命中高危面（认证、提权、已知 CVE）加权 */
  impact: 0.25,
  /** 依赖解锁价值：能解锁后续多个意图的优先级更高 */
  unlockValue: 0.1,
  /** 执行成本：越贵越降权 */
  cost: 0.1,
} as const;

export const WEIGHT_NOTICE =
  '评分权重为默认经验值，尚未经过靶机实验标定，仅用于在同一任务内做相对排序。';

export interface ScoringFacts {
  /** 该意图关联的事实数量 */
  relatedFactCount: number;
  /** 该意图关联事实中是否已有 observed/verified */
  hasEvidenceBackedFact: boolean;
  /** 已对同一 targetIp 执行过的同类意图数量 */
  sameTargetExecutedCount: number;
  /** 该意图引用的假设置信度 0..1 */
  hypothesisConfidence: number;
  /** 预计成本档位：0..1（由工具数量与高风险等级估算） */
  estimatedCost: number;
  /** 有多少个其它待执行意图依赖本意图 */
  dependentsCount: number;
  /** 目标是否属于高价值服务（Web / SSH / SMB 等） */
  highValueTarget: boolean;
}

const HIGH_VALUE_HINTS = ['http', 'web', 'smb', 'ssh', 'ftp', 'database', 'mysql', 'rdp'];

export function scoreIntent(
  intent: { title: string; hypothesis: string; targetIp: string | null; suggestedTools: string[]; priority: number },
  facts: ScoringFacts,
): { score: number; breakdown: ScoreBreakdown; explanation: string; total: number } {
  const factSupport = Math.min(1, facts.relatedFactCount / 5) * (facts.hasEvidenceBackedFact ? 1 : 0.5);
  // 经过来源校验的假设仅作微小排序信号；冲突/待验证的 0.3 为中性，不代替事实或验收。
  const hypothesisBias = Math.max(-0.2, Math.min(0.3, facts.hypothesisConfidence - 0.3)) * 0.2;
  const evidenceSupport = Math.max(0, Math.min(1, factSupport + hypothesisBias));
  const novelty = Math.max(0, 1 - facts.sameTargetExecutedCount * 0.34);
  const impact = facts.highValueTarget ? 0.85 : 0.45;
  const unlockValue = Math.min(1, facts.dependentsCount / 3);
  const cost = Math.min(1, facts.estimatedCost);

  const total =
    evidenceSupport * DEFAULT_WEIGHTS.evidenceSupport +
    novelty * DEFAULT_WEIGHTS.novelty +
    impact * DEFAULT_WEIGHTS.impact +
    unlockValue * DEFAULT_WEIGHTS.unlockValue +
    (1 - cost) * DEFAULT_WEIGHTS.cost;

  // Planner 给出的 priority 只作为轻微偏置（±5%），不能主导排序
  const priorityBias = ((intent.priority ?? 50) - 50) / 50 * 0.05;
  const score = Number((total + priorityBias).toFixed(4));

  const breakdown: ScoreBreakdown = {
    evidenceSupport: Number(evidenceSupport.toFixed(3)),
    novelty: Number(novelty.toFixed(3)),
    impact: Number(impact.toFixed(3)),
    unlockValue: Number(unlockValue.toFixed(3)),
    cost: Number(cost.toFixed(3)),
  };

  return {
    score,
    breakdown,
    total,
    explanation: describe(breakdown, score, facts),
  };
}

function describe(b: ScoreBreakdown, score: number, facts: ScoringFacts): string {
  const parts: string[] = [];
  if (facts.hasEvidenceBackedFact) parts.push('已有证据支撑');
  if (b.novelty > 0.6) parts.push('该目标尚未充分探索');
  if (fix(facts.highValueTarget)) parts.push('命中高价值服务');
  if (b.unlockValue > 0) parts.push(`可解锁 ${facts.dependentsCount} 个后续任务`);
  if (b.cost > 0.6) parts.push('执行成本较高');
  if (facts.sameTargetExecutedCount > 0) parts.push(`同目标已执行 ${facts.sameTargetExecutedCount} 次`);
  if (facts.hypothesisConfidence > 0.3) parts.push('明确关联的假设依据提供轻微排序加权');
  if (facts.hypothesisConfidence < 0.3) parts.push('关联假设有反驳依据，轻微降低排序但仍允许验证');
  return `评分 ${score.toFixed(3)}：${parts.join('；') || '常规探索价值'}`;
}

function fix(v: boolean): boolean {
  return v;
}

export function isHighValueTarget(text: string): boolean {
  const lower = text.toLowerCase();
  return HIGH_VALUE_HINTS.some((hint) => lower.includes(hint));
}

export function estimateCost(toolCount: number, hasHighRiskTool: boolean): number {
  const base = Math.min(1, toolCount / 8);
  return hasHighRiskTool ? Math.min(1, base + 0.3) : base;
}
