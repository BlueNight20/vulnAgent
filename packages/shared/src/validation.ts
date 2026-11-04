/**
 * 前后端共享的输入校验工具。
 * 后端在 service 层做最终校验，前端用于表单即时反馈（单一实现，避免规则漂移）。
 */

const IPV4_SEGMENT = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${IPV4_SEGMENT}(\\.${IPV4_SEGMENT}){3}$`);
const CIDR_RE = new RegExp(`^${IPV4_SEGMENT}(\\.${IPV4_SEGMENT}){3}/([0-9]|[12][0-9]|3[0-2])$`);

export function isValidIPv4(value: string): boolean {
  return IPV4_RE.test(value.trim());
}

export function isValidCidr(value: string): boolean {
  return CIDR_RE.test(value.trim());
}

/**
 * 域名规则按 DNS 实际可解析范围放宽：末段允许字母或数字（如内部域名 .local、.test、
 * 以及 Kubernetes 服务名），并允许下划线前缀（如 _service._tcp）。
 * 这里只做格式校验，解析与连通性由执行引擎在运行时确认。
 */
const HOSTNAME_LABEL = '(?:[a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?)';
/** 单标签主机（如 http://host:8080）允许无点，后缀按字母起头以区别纯数字错误地址。 */
const HOSTNAME_RE = new RegExp(`^(?=.{1,253}$)(${HOSTNAME_LABEL}\\.)*[a-zA-Z][a-zA-Z0-9-]{0,62}$`);
/** 本包编译目标不含 DOM lib，URL 只能用字符串规则解析。 */
const URL_HEAD_RE = /^(https?):\/\/([^/\s?#]+)([^\s]*)$/i;

export interface ParsedTargetUrl {
  protocol: 'http' | 'https';
  hostname: string;
  port: number | null;
  /** 含协议、主机与端口的根地址 */
  origin: string;
  path: string;
}

export function isUrlLike(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
}

export function parseTargetUrl(value: string): ParsedTargetUrl | null {
  const match = value.trim().match(URL_HEAD_RE);
  if (!match) return null;
  const protocol = match[1].toLowerCase() as 'http' | 'https';
  const authority = match[2];
  const path = match[3] || '/';
  const hostPort = authority.match(/^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/);
  if (!hostPort) return null;
  const hostname = hostPort[1].replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) return null;
  const port = hostPort[2] ? Number(hostPort[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  if (!isValidIPv4(hostname) && !HOSTNAME_RE.test(hostname) && hostname !== 'localhost') return null;
  return { protocol, hostname, port, origin: `${protocol}://${hostPort[0]}`, path };
}

/** 允许 http/https 的公开 URL（可带端口与路径） */
export function isValidHttpUrl(value: string): boolean {
  return parseTargetUrl(value) !== null;
}

/**
 * 用户只写了 `host:port` 或 `host:port/path`（漏写协议）。
 * 这类输入无法确定 http/https，交给用户补全，而不是猜测后静默改写。
 */
export function isMissingUrlScheme(value: string): boolean {
  return /^(?:\[[0-9a-f:.]+\]|[^\s/?#:]+):\d{1,5}(?:[/?#].*)?$/i.test(value.trim());
}

/** 裸域名（可带 :端口） */
export function isValidHostname(value: string): boolean {
  const v = value.trim();
  const withoutPort = v.replace(/:\d{1,5}$/, '');
  return HOSTNAME_RE.test(withoutPort);
}

/** 允许 IPv4、CIDR、域名或 http(s) URL（授权目标输入框） */
export function isValidTarget(value: string): boolean {
  const v = value.trim();
  return isValidIPv4(v) || isValidCidr(v) || isValidHttpUrl(v) || isValidHostname(v);
}

/** URL → origin（协议 + 主机 + 端口），其他目标原样返回。 */
export function targetOrigin(value: string): string {
  const parsed = parseTargetUrl(value);
  return parsed ? parsed.origin : value.trim();
}

/** 目标中的主机部分（URL 取 hostname），其他目标原样返回（小写化处理见调用方）。 */
export function targetHost(value: string): string {
  const parsed = parseTargetUrl(value);
  return parsed ? parsed.hostname : value.trim();
}

export function isPrivateIPv4(value: string): boolean {
  if (!isValidIPv4(value)) return false;
  const [a, b] = value.split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  return false;
}

/**
 * 端口范围表达式，如 "1-1000"、"80,443,8000-8080"、""。
 *
 * 注意：不能写成 `const [from, to] = part.split('-').map(Number)` 后判断
 * `Number.isNaN(to)` —— 单端口时 `to` 是 undefined，`Number.isNaN(undefined)` 为 false，
 * 会把 `max` 取成 undefined 导致整条校验失败（曾经的真实 bug）。
 */
export function isValidPortSpec(value: string): boolean {
  const v = value.trim();
  if (v === '') return true;
  return v
    .split(',')
    .map((part) => part.trim())
    .every((part) => {
      if (!/^([0-9]{1,5})(?:-([0-9]{1,5}))?$/.test(part)) return false;
      const segments = part.split('-');
      const from = Number(segments[0]);
      const to = segments.length > 1 ? Number(segments[1]) : from;
      if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
      return from >= 1 && from <= 65535 && to >= from && to <= 65535;
    });
}

/**
 * 拆分用户输入的目标列表。
 * URL 里可能自带逗号（如 `/x,y`）或查询串分隔符，因此按下标切分：
 * 以 http(s):// 开头的片段只按空白/分号结束，其余片段再按逗号拆分。
 */
export function normalizeTargets(raw: string): string[] {
  const parts = raw.split(/[\s;]+/).flatMap((token) => (isUrlLike(token) ? [token] : token.split(',')));
  return parts.map((s) => s.trim()).filter(Boolean);
}
