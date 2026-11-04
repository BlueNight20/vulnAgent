/**
 * 目标 Scope 校验（纯函数，无框架依赖）。
 *
 * 设计原则：**宁可拒绝，不可放过**。
 * - 递归扫描参数（含数组、嵌套对象），提取所有可能出现的目标
 * - 识别 IPv4 / CIDR / 域名 / URL 四类目标
 * - 只要有一个目标不在授权集合内就拒绝
 * - 无法判定「是否为目标字段」但看起来像目标的值，同样纳入校验
 */

export type TargetKind = 'ip' | 'cidr' | 'hostname';

export interface ExtractedTarget {
  raw: string;
  kind: TargetKind;
  /** 对于 CIDR，这里是被展开的网段基址 */
  normalized: string;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR_RE = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

/** 明确表示「目标」的参数名（命中则强制纳入校验） */
const TARGET_KEY_HINTS = [
  'target', 'targets', 'target_url', 'targets_url', 'ip', 'ips', 'host', 'hosts',
  'hostname', 'hostnames', 'url', 'urls', 'address', 'addresses', 'rhost', 'rhosts',
  'destination', 'dst', 'subnet', 'cidr', 'range', 'scope', 'domain', 'domains',
];

/** 明确不是目标的参数名（跳过，避免把端口/路径误判为目标） */
const NON_TARGET_KEYS = [
  'ports', 'port', 'scan_type', 'flags', 'arguments', 'args', 'options', 'wordlist',
  'threads', 'timeout', 'output', 'format', 'user_agent', 'method', 'body', 'data',
  'headers', 'cookie', 'token', 'wordlist_path', 'extensions', 'status_codes',
];

export function parseIpv4(value: string): number[] | null {
  const match = value.trim().match(IPV4_RE);
  if (!match) return null;
  const parts = match.slice(1, 5).map((p) => Number(p));
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts;
}

export function ipToInt(ip: string): number | null {
  const parts = parseIpv4(ip);
  if (!parts) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** 判断某个 IP 是否落在 CIDR 内 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const cidrMatch = cidr.trim().match(CIDR_RE);
  if (!cidrMatch) return false;
  const baseInt = ipToInt(cidrMatch[1]);
  const ipInt = ipToInt(ip);
  const prefix = Number(cidrMatch[2]);
  if (baseInt === null || ipInt === null || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** 从任意字符串中提取目标（URL 拆出 host、CIDR、纯 IP、域名） */
export function extractTargetsFromString(value: string): ExtractedTarget[] {
  const text = value.trim();
  if (!text) return [];
  const found: ExtractedTarget[] = [];
  const push = (item: ExtractedTarget) => {
    if (!found.some((f) => f.kind === item.kind && f.normalized === item.normalized)) found.push(item);
  };

  // URL：取 host 部分
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let host: string;
    try { host = new URL(text).hostname; } catch { return found; }
    if (parseIpv4(host)) push({ raw: text, kind: 'ip', normalized: host });
    else if (HOSTNAME_RE.test(host)) push({ raw: text, kind: 'hostname', normalized: host.toLowerCase() });
    return found;
  }

  // CIDR
  const cidrMatch = text.match(CIDR_RE);
  if (cidrMatch && ipToInt(cidrMatch[1]) !== null && Number(cidrMatch[2]) <= 32) {
    push({ raw: text, kind: 'cidr', normalized: `${cidrMatch[1]}/${cidrMatch[2]}` });
    return found;
  }

  const endpoint = text.match(/^([^\s/:]+):(\d+)$/);
  if (endpoint && Number(endpoint[2]) >= 1 && Number(endpoint[2]) <= 65535) {
    if (parseIpv4(endpoint[1])) push({ raw: text, kind: 'ip', normalized: endpoint[1] });
    else if (HOSTNAME_RE.test(endpoint[1])) push({ raw: text, kind: 'hostname', normalized: endpoint[1].toLowerCase() });
    return found;
  }

  // 纯 IP
  if (parseIpv4(text)) {
    push({ raw: text, kind: 'ip', normalized: text.trim() });
    return found;
  }

  // 域名
  const bare = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/:?#]/)[0];
  if (HOSTNAME_RE.test(bare)) {
    push({ raw: text, kind: 'hostname', normalized: bare.toLowerCase() });
  }
  return found;
}

/**
 * 递归提取参数中所有可能的目标。
 * 对目标字段强制提取；对其他字段仅在值形似 IP/CIDR 时也提取（防绕过）。
 */
export function extractTargets(args: unknown, depth = 0): ExtractedTarget[] {
  if (depth > 6) return [];
  const results: ExtractedTarget[] = [];
  const pushAll = (items: ExtractedTarget[]) => {
    for (const item of items) {
      if (!results.some((r) => r.kind === item.kind && r.normalized === item.normalized)) results.push(item);
    }
  };

  if (Array.isArray(args)) {
    for (const item of args) pushAll(extractTargets(item, depth + 1));
    return results;
  }

  if (args && typeof args === 'object') {
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (NON_TARGET_KEYS.includes(lower)) continue;
      const isTargetKey = TARGET_KEY_HINTS.some((hint) => lower.includes(hint));

      if (typeof value === 'string') {
        const extracted = extractTargetsFromString(value);
        if (extracted.length > 0 && (isTargetKey || extracted.some((e) => e.kind !== 'hostname'))) {
          pushAll(extracted);
        }
      } else if (value && typeof value === 'object') {
        pushAll(extractTargets(value, depth + 1));
      }
    }
    return results;
  }

  if (typeof args === 'string') {
    pushAll(extractTargetsFromString(args));
  }
  return results;
}

export interface ScopePolicy {
  /** 授权 IP 列表（精确匹配） */
  allowedIps: string[];
  /** 授权网段（CIDR） */
  allowedCidrs: string[];
  /** 授权域名 */
  allowedHostnames: string[];
}

export interface ScopeVerdict {
  allow: boolean;
  /** 被拒绝的目标（allow=false 时非空） */
  violations: ExtractedTarget[];
  /** 本次提取到的全部目标 */
  targets: ExtractedTarget[];
  /** 是否需要目标才能执行（无目标时给出提示） */
  noTarget: boolean;
}

/**
 * 校验所有目标是否都在授权范围内。
 * 空目标不直接放行：交由调用方根据工具特性决定（部分工具确实无目标）。
 */
export function checkScope(targets: ExtractedTarget[], policy: ScopePolicy): ScopeVerdict {
  if (targets.length === 0) {
    return { allow: true, violations: [], targets: [], noTarget: true };
  }

  const violations = targets.filter((target) => !isTargetAllowed(target, policy));
  return {
    allow: violations.length === 0,
    violations,
    targets,
    noTarget: false,
  };
}

function isTargetAllowed(target: ExtractedTarget, policy: ScopePolicy): boolean {
  switch (target.kind) {
    case 'ip':
      return (
        policy.allowedIps.includes(target.normalized) ||
        policy.allowedCidrs.some((cidr) => ipInCidr(target.normalized, cidr))
      );
    case 'cidr': {
      // 请求的网段必须完全落在某个授权网段内
      const [base, prefixText] = target.normalized.split('/');
      const prefix = Number(prefixText);
      return policy.allowedCidrs.some((cidr) => {
        const [, allowedPrefixText] = cidr.split('/');
        const allowedPrefix = Number(allowedPrefixText);
        return allowedPrefix <= prefix && ipInCidr(base, cidr);
      });
    }
    case 'hostname':
      return policy.allowedHostnames.some(
        (allowed) =>
          allowed.toLowerCase() === target.normalized ||
          target.normalized.endsWith(`.${allowed.toLowerCase()}`),
      );
    default:
      return false;
  }
}

/** 生成工具调用的参数指纹，用于重复动作识别 */
export function argumentFingerprint(toolName: string, args: Record<string, unknown>): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = normalize((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return `${toolName}::${JSON.stringify(normalize(args ?? {}))}`;
}
