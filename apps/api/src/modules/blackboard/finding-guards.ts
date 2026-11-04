/**
 * 漏洞候选与验证排队的约束（纯函数，不依赖实体与数据库）。
 *
 * 抽成独立模块的目的：
 * 1. 让核心规则可以脱离 TypeORM 单独测试；
 * 2. 把"验证不能自我繁殖"这条约束集中在一个可读位置，
 *    避免再被后续改动（例如新增 Worker 收尾逻辑）无意绕过。
 */

export interface SessionOrigin {
  role: string;
  profileId: string | null;
}

export interface VerificationOutcomeRecord {
  outcome: string;
}

/**
 * 验证会话的职责是判定既有候选是否成立，不能反过来制造新的候选。
 *
 * 若允许它产出候选，就会出现"验证 → 新候选 → 再验证"的自我繁殖：
 * 每条验证结果都会变成下一轮验证的输入，预算持续被消耗却不收敛。
 */
export function assertCandidateSource(session: SessionOrigin | null): string | null {
  if (!session) return null;
  if (session.role === 'verifier' || session.profileId === 'verification') {
    return '验证会话不能上报新的漏洞候选；请把结论写入 verification 结果，由系统回写原候选。';
  }
  return null;
}

/**
 * 已经"无法形成结论"的候选不再自动重复排队。
 *
 * 同一候选反复验证不出结果，只会消耗预算而不产生新知识；
 * 需要继续研究时应由规划器提出新的假设，而不是重复同一次验证。
 * 已确认/已排除的候选允许复查，以便结论变化时重新核对。
 */
export function assertNotExhausted(previous: VerificationOutcomeRecord | null, hasNewEvidence = false): string | null {
  if (previous?.outcome === 'inconclusive' && !hasNewEvidence) {
    return '该候选此前无法形成有效结论，不再自动重复排队验证';
  }
  return null;
}
