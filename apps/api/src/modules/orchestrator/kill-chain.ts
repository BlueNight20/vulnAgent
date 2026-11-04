import type { FactStatus } from '@vulnagent/shared';

/**
 * 攻击链推理模型（纯函数，与具体目标无关）。
 *
 * 目的：把"专家怎么想"变成结构化输入，而不是只写在提示词里。
 * 规划器据此知道当前处在攻击链哪一段、哪些线索还没被利用、
 * 哪些方向已经被证伪，从而减少重复枚举与无价值发散。
 */

/** 攻击链阶段，按推进顺序排列；允许跳跃和回退。 */
export const KILL_CHAIN_STAGES = [
  'recon',
  'service-id',
  'entry-point',
  'foothold',
  'lateral',
  'privilege',
  'objective',
] as const;

export type KillChainStage = (typeof KILL_CHAIN_STAGES)[number];

export const STAGE_LABEL: Record<KillChainStage, string> = {
  recon: '侦察与资产确认',
  'service-id': '服务识别',
  'entry-point': '入口点发现',
  foothold: '利用与立足点',
  lateral: '凭据与横向扩展',
  privilege: '权限提升',
  objective: '目标验证',
};

export interface StageFact {
  category: string;
  predicate: string;
  status: FactStatus;
  observationKind: string;
}

/**
 * 判断当前最靠后的攻击链阶段。
 *
 * 只依据已完成的事实类别，不做目标特定推断：
 * - 有权限/提权类事实 → privilege
 * - 有凭据 → lateral
 * - 有漏洞类事实或命令执行特征 → foothold
 * - 有路径/参数/文件等技术面线索 → entry-point
 * - 有服务 → service-id
 * - 仅资产存活 → recon
 */
export function inferStage(facts: StageFact[]): KillChainStage {
  const usable = facts.filter((f) => f.status !== 'refuted' && f.observationKind !== 'probe_error');
  const has = (category: string) => usable.some((f) => f.category === category);

  if (has('privilege')) return 'privilege';
  if (has('credential')) return 'lateral';
  if (has('vulnerability')) return 'foothold';
  if (usable.some((f) => f.category === 'technology' || f.category === 'vulnerability')) return 'entry-point';
  if (has('service')) return 'service-id';
  return 'recon';
}

/** 进入下一阶段所缺的信息，用于提示规划器"唯一缺失的那条信息"。 */
export const STAGE_NEXT_NEED: Record<KillChainStage, string> = {
  recon: '目标是否存活，以及开放了哪些端口与协议',
  'service-id': '每个开放端口的服务名与版本，以确定后续可能的技术路径',
  'entry-point': '可交互输入点、可读/可下载文件、可访问接口或可复用凭据',
  foothold: '一个能稳定复现的立足点（命令执行、文件读写、会话或凭据登录成功）',
  lateral: '新获得的凭据/身份能否用于其它服务，以及能否访问更多资源',
  privilege: '从当前身份提升到更高权限的可复现路径',
  objective: '可核验的最终目标证据',
};

export interface AttemptRecord {
  /** 意图标题，用于识别同类尝试 */
  title: string;
  status: string;
  rejectedReason?: string | null;
  /** Worker 侧失败原因 */
  failure?: string | null;
}

export interface DeadEnd {
  /** 被判定为死路的方向描述 */
  direction: string;
  /** 判定依据：尝试次数与失败类型 */
  reason: string;
}

/**
 * 识别已经尝试多次仍无产出的方向。
 *
 * 只统计"目标侧明确失败"或"已结束"的尝试；因工具缺失、授权越界、
 * 引擎中断等环境性失败不计入，避免把环境问题误判成目标结论。
 */
export function detectDeadEnds(attempts: AttemptRecord[], minAttempts = 2): DeadEnd[] {
  const environmentFailure = /tool_not_allowed|out_of_scope|not found|缺少|未授权|引擎已停止|容量|并发/i;
  const groups = new Map<string, { title: string; failures: number; successes: number }>();

  for (const attempt of attempts) {
    const key = normalizeDirection(attempt.title);
    if (!key) continue;
    const entry = groups.get(key) ?? { title: attempt.title, failures: 0, successes: 0 };
    const failed = attempt.status === 'rejected' || attempt.status === 'failed' || attempt.status === 'cancelled';
    if (failed) {
      const text = `${attempt.rejectedReason ?? ''} ${attempt.failure ?? ''}`;
      if (!environmentFailure.test(text)) entry.failures += 1;
    } else if (attempt.status === 'done' || attempt.status === 'succeeded') {
      entry.successes += 1;
    }
    groups.set(key, entry);
  }

  return [...groups.values()]
    .filter((g) => g.successes === 0 && g.failures >= minAttempts)
    .map((g) => ({ direction: g.title, reason: `已尝试 ${g.failures} 次仍无有效产出，且失败原因不是工具或环境限制` }));
}

/** 归一化方向描述：去掉批次/次数等装饰词，让同类尝试聚到一起。 */
function normalizeDirection(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return '';
  return trimmed
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/\d+-\d+/g, '<range>')
    .replace(/\b\d{2,5}\b/g, '<n>')
    .replace(/第\s*\d+\s*(?:次|轮)/g, ' ')
    .replace(/补扫|重测|复核|再次|本轮|完成验收|拼接完成|独立复现|本次/g, ' ')
    .replace(/[\s，,。；;：:·、]+/g, ' ')
    .trim();
}

export interface ClueFact {
  id: string;
  category: string;
  subject: string;
  predicate: string;
  object: string;
  status: FactStatus;
}

export interface LooseEnd {
  factId: string;
  /** 尚未被利用的线索 */
  clue: string;
  /** 值得继续检查的原因 */
  why: string;
}

/**
 * 列出"已被发现但还没被利用"的线索。
 *
 * 这些是专家最关心的部分：拿到用户名、路径、配置、凭据之后，
 * 是否已经在其它服务上复用过。规则只依赖事实形态，不含目标特定知识。
 */
export function findLooseEnds(facts: ClueFact[], consumed: Set<string>): LooseEnd[] {
  const ends: LooseEnd[] = [];
  for (const fact of facts) {
    if (fact.status === 'refuted' || consumed.has(fact.id)) continue;
    const text = `${fact.predicate} ${fact.object}`.toLowerCase();

    if (fact.category === 'credential') {
      ends.push({ factId: fact.id, clue: `${fact.subject} ${fact.object}`, why: '已获得凭据/身份，检查是否可用于其它已开放服务或需要认证的接口' });
      continue;
    }
    if (/password|passwd|secret|token|user(name)?|凭据|口令|账号/i.test(text) && fact.category !== 'service') {
      ends.push({ factId: fact.id, clue: `${fact.subject} ${fact.object}`, why: '疑似发现账号或口令信息，考虑在已发现的服务上验证复用' });
      continue;
    }
    if (/exposes_path|accessible_directory|accessible_page|referenced_dynamic_endpoint|has_parameter/i.test(fact.predicate)) {
      ends.push({ factId: fact.id, clue: `${fact.subject} ${fact.object}`, why: '已发现可访问路径或带参数的接口，是入口点的候选' });
      continue;
    }
    // 服务指纹（runs_service / version / banner）只要对象里带有具体标识，
    // 就值得判断是否存在已知缺陷或默认配置问题。
    if (/runs_service|version|banner|server_header|service/i.test(`${fact.predicate} ${fact.object}`) && /\d|http|ftp|ssh|smb|sql|smtp|dns/i.test(fact.object)) {
      ends.push({ factId: fact.id, clue: `${fact.subject} ${fact.object}`, why: '已获得服务标识或版本信息，可据此判断是否存在已知缺陷或默认配置问题' });
    }
  }
  return ends;
}
