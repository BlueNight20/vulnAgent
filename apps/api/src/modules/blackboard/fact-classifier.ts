import type { FactObservationKind, FactStatus } from '@vulnagent/shared';

/**
 * 事实观测类别判定（纯函数）。
 *
 * 核心目的：**不允许把「探测失败」写成「目标状态」**。
 * 例如：
 *   - `nikto: Unable to connect` → probe_error（探测失败），而不是「目标没有 Web 服务」
 *   - `Connection refused / Errno 111` → target_negative（目标明确拒绝）
 *   - `80/tcp open http` → target_state（真实观测）
 */

/**
 * 探测过程失败的信号词（工具自身错误、超时、权限、依赖缺失）。
 *
 * 特别注意「工具包装器缺二进制」这一类：
 * `/bin/sh: smbmap: not found`、`return_code 127` 说明**工具没装**，
 * 与目标状态毫无关系，绝不能记成 target_negative。
 */
const PROBE_ERROR_PATTERNS = [
  /timed?\s*out/i,
  /timeout/i,
  /unable to connect/i,
  /could not connect/i,
  /connection (?:reset|aborted)/i,
  /no route to host/i,
  /network is unreachable/i,
  /permission denied/i,
  /command not found/i,
  /not found/i,
  /return_code\s*127/i,
  /failed_with/i,
  /no such file/i,
  /tool not found/i,
  /internal error/i,
  /\berror\b/i,
  /\bfailed\b/i,
  /exception/i,
  /traceback/i,
  /max retries/i,
  /rate limit/i,
  /request timed out/i,
];

/**
 * 目标明确否定的信号词。
 *
 * 注意：不能把裸 `not found` 放在这里——它同时匹配
 * `smbmap: not found`（工具缺失）。HTTP 404 用 `404` 精确定位。
 */
const TARGET_NEGATIVE_PATTERNS = [
  /connection refused/i,
  /errno 111/i,
  /port (?:is )?closed/i,
  /^\s*\d{1,5}\/(?:tcp|udp)\s+closed/m,
  /\bfiltered\b/i,
  /host is down/i,
  /no service/i,
  /\b404\b/,
  /does not exist/i,
];

/** 目标真实状态的信号词（端口/服务/版本/路径） */
const TARGET_STATE_PATTERNS = [
  /\bopen\b/i,
  /\d{1,5}\/tcp\b/i,
  /\d{1,5}\/udp\b/i,
  /\bservice\b/i,
  /server:/i,
  /\bversion\b/i,
  /http\/\d\.\d/i,
  /\bstatus\b/i,
  /\b[23]\d{2}\b/,
  /\bcpe:\//i,
];

export interface ClassifyInput {
  object: string;
  /** 产出该事实的工具名 */
  sourceTool?: string | null;
  /** 模型给出的原始置信度 */
  rawConfidence?: number;
  /** 该事实是否有关联证据 */
  hasEvidence: boolean;
}

export interface ClassifyResult {
  kind: FactObservationKind;
  /** 建议的置信度上限 */
  confidence: number;
  /** 人类可读的判定依据，写入日志与结果卡 */
  reason: string;
}

/**
 * 判定一条事实的观测类别与可信置信度。
 *
 * 规则优先级：
 * 1. 无证据 → inference（模型推断）
 * 2. 命中探测失败信号 → probe_error（无论是否命中其他信号，失败优先）
 * 3. 命中目标否定信号 → target_negative
 * 4. 命中目标状态信号 → target_state
 * 5. 其他有证据的内容 → target_state（保守视为观测，但置信度不抬高）
 */
export function classifyFact(input: ClassifyInput): ClassifyResult {
  const text = input.object ?? '';
  const raw = input.rawConfidence ?? 0.6;

  if (!input.hasEvidence) {
    return {
      kind: 'inference',
      confidence: Math.min(0.5, raw),
      reason: '无工具证据支撑，归为模型推断，置信度上限 0.5',
    };
  }

  if (PROBE_ERROR_PATTERNS.some((re) => re.test(text))) {
    return {
      kind: 'probe_error',
      confidence: Math.min(0.4, raw),
      reason: '内容命中探测失败信号（超时/工具报错/权限），不得据此推断目标状态',
    };
  }

  if (TARGET_NEGATIVE_PATTERNS.some((re) => re.test(text))) {
    return {
      kind: 'target_negative',
      confidence: Math.min(0.8, raw),
      reason: '内容表明目标明确否定（拒绝/关闭/过滤），可作为否定性事实',
    };
  }

  if (TARGET_STATE_PATTERNS.some((re) => re.test(text))) {
    return {
      kind: 'target_state',
      confidence: Math.min(0.9, raw),
      reason: '内容包含端口/服务/版本等正向观测，作为目标状态事实',
    };
  }

  return {
    kind: 'target_state',
    confidence: Math.min(0.7, raw),
    reason: '有工具证据但未命中典型信号，保守归为观测事实',
  };
}

/** probe_error 类别的事实不允许被当作漏洞证据 */
export function isEvidenceBackedKind(kind: FactObservationKind): boolean {
  return kind === 'target_state' || kind === 'target_negative';
}

/**
 * 线索等级：判断一条“漏洞类”事实是否真的能推进攻击链。
 *
 * 目的不是否定这些现象，而是把它们放到正确的位置：
 * - actionable：指向可进一步利用的东西（命令执行、文件读写、认证绕过、凭据泄露、注入点）
 * - weakness：配置加固缺失（安全响应头、目录索引、版本暴露等），可作为建议但通常不可直接利用
 * - non-finding：**否定性观测**（登录被拒绝、爆破无结果、端口关闭），本质上是安全的表现
 *
 * 只依据事实的语义形态判断，不依赖具体产品名或目标。
 */
export type ClueLevel = 'actionable' | 'weakness' | 'non-finding';

const ACTIONABLE_HINTS = [
  /command_inject|code_exec|rce|os_command/i,
  /sql_?inject|xss|ssti|xxe|ssrf|deserial|insecure_deserial/i,
  /file_upload|unrestricted_upload|arbitrary_write|write_file|文件写入|任意写/i,
  /lfi|rfi|path_traversal|directory_traversal|local_file_inclusion|任意文件读取|文件包含/i,
  /password|passwd|credential|secret|token|api_key|私钥|口令|凭据|密码/i,
  /auth_?bypass|default_credential|weak_password|匿名可写|未授权访问/i,
  /privilege_?escalation|sudo|setuid|提权/i,
];

const WEAKNESS_HINTS = [
  /missing_security_header|security_header|缺少.*头|missing.*header|安全响应头/i,
  /directory_?listing|autoindex|目录索引|目录浏览/i,
  /version_disclosure|banner|版本泄露|server_header|信息泄露/i,
  /cookie.*(?:secure|httponly|samesite)|缺少.*标志/i,
];

const NEGATIVE_HINTS = [
  /\bdenied\b|login_incorrect|access_denied|拒绝|失败|not_allowed|forbidden|unauthor/i,
  /no valid account|no_valid|未发现|未找到|不存在|not_found|无结果|empty result/i,
  /disabled|anonymous_login_denied|匿名.*被拒|已禁用/i,
];

export function classifyClue(input: { predicate: string; object: string }): { level: ClueLevel; reason: string } {
  const text = `${input.predicate} ${input.object}`;
  if (NEGATIVE_HINTS.some((re) => re.test(text))) {
    return { level: 'non-finding', reason: '是否定性观测（拒绝/未发现/禁用），本身不构成漏洞' };
  }
  if (ACTIONABLE_HINTS.some((re) => re.test(text))) {
    return { level: 'actionable', reason: '指向可进一步利用的能力或数据' };
  }
  if (WEAKNESS_HINTS.some((re) => re.test(text))) {
    return { level: 'weakness', reason: '属于配置加固缺失，通常不能直接利用' };
  }
  return { level: 'weakness', reason: '未命中可利用特征，按加固建议处理' };
}

/**
 * 把事实对象归一化成语义指纹，用于判断「措辞不同但含义相同」。
 *
 * 典型误报：同一条 nmap 结果被两个 Worker 分别写成
 *   `ftp (open, 服务名来自 nmap 默认端口映射，版本未知)`
 *   `ftp (port open, version unknown)`
 * 二者语义完全一致，不应算冲突。
 */
export function normalizeFactObject(object: string): string {
  return object
    .toLowerCase()
    // 去掉括号内的补充说明，只保留核心取值
    .replace(/[（(][^）)]*[）)]/g, ' ')
    // 常见同义表述归一
    .replace(/port\s+open/g, 'open')
    .replace(/服务名来自[^\s,，]*/g, ' ')
    .replace(/版本未知|version unknown|未知版本|版本\/server\s*头未知/g, ' ')
    .replace(/服务\/版本未识别/g, ' ')
    .replace(/[，,;；:：\s]+/g, ' ')
    .replace(/[._-]+/g, ' ')
    .trim();
}

/**
 * 判断两个同 subject+predicate 的事实是否构成冲突。
 *
 * 排除情形：
 * - 归一化后相同（措辞差异）
 * - 任一方是 probe_error（只是「没测出来」）
 * - 任一方是 inference（模型推断，未经观测）
 */
export function isConflict(
  a: { object: string; kind: FactObservationKind },
  b: { object: string; kind: FactObservationKind },
): boolean {
  const left = normalizeFactObject(a.object);
  const right = normalizeFactObject(b.object);
  if (left === right) return false;
  // 归一化后一方包含另一方（如 "ftp open" vs "ftp"），视为同一观测
  if (left.length > 0 && right.length > 0 && (left.includes(right) || right.includes(left))) {
    return false;
  }
  if (a.kind === 'probe_error' || b.kind === 'probe_error') return false;
  if (a.kind === 'inference' || b.kind === 'inference') return false;
  // target_state vs target_negative 是典型冲突（如 80 open vs 80 closed）
  return true;
}

export interface ConflictCandidate {
  id: string;
  status: FactStatus;
  observationKind: FactObservationKind;
  confidence: number;
  evidenceCount: number;
}

const STATUS_RANK: Record<string, number> = { verified: 3, observed: 2, inferred: 1, refuted: 0 };

/**
 * 自动裁决一个冲突组（纯函数，取代人工「采纳」）。
 *
 * 排序依据：证据类别 > 事实状态 > 独立证据条数 > 置信度 > 采集时间。
 * 胜出者保留并标记冲突已解决，其余保留原文但降级为 refuted，
 * 保证结论可无人值守推进，同时不丢失原始观测。
 */
export function arbitrateConflict(candidates: ConflictCandidate[]): { winnerId: string; loserIds: string[] } | null {
  const usable = candidates.filter((c) => c.status !== 'refuted');
  if (usable.length < 2) return null;
  const ranked = [...usable].sort((a, b) => {
    if (a.observationKind !== b.observationKind) return a.observationKind === 'target_state' ? -1 : 1;
    const rank = (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0);
    if (rank !== 0) return rank;
    if (a.evidenceCount !== b.evidenceCount) return b.evidenceCount - a.evidenceCount;
    return b.confidence - a.confidence;
  });
  const [winner, ...losers] = ranked;
  return { winnerId: winner.id, loserIds: losers.map((l) => l.id) };
}
