import { isValidPortSpec } from '@vulnagent/shared';
import { extractTargets, type ExtractedTarget } from './scope-guard';

export interface ScanLimits { maxHosts: number; maxPorts: number; maxProbes: number }
export const DEFAULT_SCAN_LIMITS: ScanLimits = { maxHosts: 256, maxPorts: 1024, maxProbes: 4096 };
export interface WorkloadDecision { allow: boolean; kind?: 'invalid_input' | 'workload_limit' | 'unauthorised_target'; reason: string; suggestion: string; hosts?: number; ports?: number; probes?: number }
const deny = (kind: WorkloadDecision['kind'], reason: string, suggestion: string): WorkloadDecision => ({ allow: false, kind, reason, suggestion });
const OK: WorkloadDecision = { allow: true, reason: '', suggestion: '' };

function numericPorts(value: unknown): Set<number> | null {
  const text = typeof value === 'number' ? String(value) : Array.isArray(value) ? value.join(',') : String(value ?? '');
  const spec = text === '-' ? '1-65535' : text;
  if (!isValidPortSpec(spec)) return null;
  const ports = new Set<number>();
  for (const group of spec.split(',')) { const [a, b] = group.split('-').map(Number); for (let port = a; port <= (b ?? a); port++) ports.add(port); }
  return ports;
}
/** Does not expand CIDRs; overlapping targets are conservatively counted. */
export function targetCount(targets: ExtractedTarget[]): number {
  return targets.reduce((count, t) => count + (t.kind === 'cidr' ? 2 ** (32 - Number(t.normalized.split('/')[1])) : 1), 0);
}
function fields(args: Record<string, unknown>, keys: string[]): unknown[] { return Object.entries(args).filter(([key, value]) => keys.includes(key.toLowerCase()) && value !== null && value !== undefined && value !== '').map(([, value]) => value); }

/** Bounds known port-scanner parameters without rewriting approved or model-supplied arguments. */
export function checkToolWorkload(tool: string, args: Record<string, unknown>, scopePorts: string | null, limits = DEFAULT_SCAN_LIMITS): WorkloadDecision {
  const authorized = scopePorts ? numericPorts(scopePorts) : null;
  if (scopePorts && !authorized) return deny('unauthorised_target', '任务端口范围无效，不能确定执行授权', '修正任务端口范围后再执行');
  // Explicit URL/port endpoints are checked for every tool, excluding payloads and headers.
  const endpointPorts = new Set<number>();
  const addEndpoint = (entry: unknown) => {
    if (Array.isArray(entry)) { for (const item of entry) addEndpoint(item); return; }
    if (typeof entry !== 'string') return;
    try { const u = new URL(entry); if (u.port) endpointPorts.add(Number(u.port)); else if (u.protocol === 'https:') endpointPorts.add(443); else if (u.protocol === 'http:') endpointPorts.add(80); } catch { const port = entry.match(/^[^\s/:]+:(\d+)$/)?.[1]; if (port) endpointPorts.add(Number(port)); }
  };
  const visit = (value: unknown, depth = 0) => {
    if (depth > 6 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:body|data|headers|cookie|token|output|wordlist|wordlist_path)$/i.test(key)) continue;
      if (/^(?:port|rport|target_port)$/i.test(key) && /^\d+$/.test(String(entry))) endpointPorts.add(Number(entry));
      if (/(?:target|url|host|address)/i.test(key)) addEndpoint(entry);
      if (typeof entry === 'object') visit(entry, depth + 1);
    }
  };
  visit(args);
  if (authorized && [...endpointPorts].some((p) => !authorized.has(p))) return deny('unauthorised_target', '请求端点端口超出任务授权范围', `只允许端口 ${scopePorts}；不要通过 URL 或嵌套 port 字段扩大范围`);
  if (!/(?:^|[_-])(?:nmap|masscan|rustscan|portscan)(?:$|[_-])|^nmap|^masscan|^rustscan/i.test(tool)) return OK;
  const targets = extractTargets(args);
  if (targets.some((t) => t.kind === 'cidr' && (!/\/\d+$/.test(t.normalized) || Number(t.normalized.split('/')[1]) > 32))) return deny('invalid_input', '扫描 CIDR 前缀无效', '使用有效的 IPv4 CIDR');
  const hosts = targetCount(targets);
  if (!hosts) return deny('invalid_input', '无法计算扫描目标数量', '显式提供 IP、IP 数组或 CIDR，不能使用隐藏目标列表');
  const flags = fields(args, ['scan_type', 'additional_args', 'options', 'flags', 'arguments', 'args']).map(String).join(' ');
  if (fields(args, ['target_file', 'targets_file', 'include_file', 'input_file', 'resume_file']).length) return deny('invalid_input', '文件内目标未逐项核验，不能用于自动扫描', '显式提供 IP、IP 数组或 CIDR');
  if (/[;&|`\r\n]|\$\(|(?:^|\s)-(?:iL|iR)(?:\s|\S)|--(?:include(?:-file)?|readscan|resume|targets?)(?:\s|=|$)/.test(flags)) return deny('invalid_input', '扫描参数包含额外目标来源或不可解析的命令组合', '目标只能放在 target/targets 字段；一次调用只执行一个有界扫描');
  // Preserve quoted single-token values; reject incomplete quoting rather than guessing.
  const tokens = flags.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+/g)?.map((t) => t.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
  if (tokens.some((t) => /['"]/.test(t))) return deny('invalid_input', '扫描选项引号不完整或无法解析', '使用简单、明确的参数字符串');
  if (tokens.some((t, index) => !['--script', '--datadir', '--servicedb', '--versiondb', '-oN', '-oX', '-oG', '-oA'].includes(tokens[index - 1]) && !t.startsWith('--script=') && t.split(/[=,]/).some((part) => !part.startsWith('-') && extractTargets(part).length))) return deny('invalid_input', '扫描选项包含未通过 target 字段核验的地址', '把所有目标放在 target/targets 字段，不能用附加选项增加目标');
  const selectors = fields(args, ['ports', 'port', 'tcp_ports', 'udp_ports']).map(numericPorts);
  let top: number | null = null; let fast = false; let discovery = false;
  const topFields = fields(args, ['top_ports', 'topports']);
  if (topFields.length) { const value = String(topFields[0]); if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535 || topFields.some((v) => String(v) !== value)) return deny('invalid_input', 'top_ports 必须是明确的 1 到 65535 整数', '优先使用显式 ports'); top = Number(value); }
  const protocols = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-sn' || token === '-sL') discovery = true;
    if (/^-s[A-Z]+$/.test(token)) for (const code of token.slice(2)) protocols.add(code === 'U' ? 'udp' : code === 'O' ? 'ip' : ['Y', 'Z'].includes(code) ? 'sctp' : 'tcp');
    if (token === '-F') fast = true;
    if (/^--(?:port-ratio|exclude-ports)(?:=|$)/.test(token)) return deny('invalid_input', '扫描选择器无法确定精确范围', '使用显式数字 ports，避免端口比例或排除参数');
    if (/^--top-ports(?:=|$)/.test(token)) { const n = token.includes('=') ? token.split('=')[1] : tokens[++i]; if (!/^\d+$/.test(n ?? '') || Number(n) < 1 || Number(n) > 65535) return deny('invalid_input', 'top-ports 必须是 1 到 65535 的整数', '优先用显式数字 ports'); if (top !== null) return deny('invalid_input', '重复 top-ports 选择器', '一次调用只保留一个端口选择器'); top = Number(n); }
    if (/^-p/.test(token) || /^--ports(?:=|$)/.test(token)) {
      const spec = token === '-p' || token === '--ports' ? tokens[++i] : token.startsWith('--ports=') ? token.slice(8) : token.slice(2);
      selectors.push(numericPorts(spec));
    }
  }
  if (selectors.some((s) => !s)) return deny('invalid_input', '无法确定数字端口范围', '使用 1-65535 内的数字、逗号列表或闭区间；协议通过扫描选项单独指定');
  const selected = selectors[0] ?? null;
  if (selected && selectors.some((s) => s!.size !== selected.size || [...s!].some((p) => !selected.has(p)))) return deny('invalid_input', 'ports 与选项中的端口选择器不一致', '只保留一个明确的 ports 值，避免覆盖或扩大范围');
  if ((selected && (top !== null || fast)) || (top !== null && fast) || (discovery && (selected || top !== null || fast))) return deny('invalid_input', '扫描端口与模式选择器冲突', '发现扫描和端口扫描分开，端口扫描只保留一种范围选择器');
  if (protocols.has('ip') || protocols.has('sctp')) return deny('invalid_input', '该扫描模式不能按当前 TCP/UDP 工作量规则核验', '把 TCP/UDP 探测拆成明确的数字端口扫描；IP 协议和 SCTP 扫描需单独配置支持');
  if (tokens.some((t) => /^-P[SAUY]/.test(t))) return deny('invalid_input', '额外的端口发现探针未包含在显式 ports 中', '使用 -Pn 执行所选端口扫描，或拆成单独受控的发现步骤');
  if (authorized && !tokens.includes('-Pn') && !tokens.includes('-sL') && !tokens.some((t) => ['-PE', '-PP', '-PM'].includes(t))) return deny('unauthorised_target', '默认主机发现可能使用所选范围以外的端口', '使用 -Pn 扫描明确授权端口；或为独立发现步骤显式使用 ICMP 选项');
  if (authorized && !discovery && (!selected || [...selected].some((p) => !authorized.has(p)))) return deny('unauthorised_target', '扫描端口未明确限定在任务授权范围内', `任务仅允许 ${scopePorts}；使用显式 ports，不能依赖工具默认端口或 top-ports`);
  const ports = discovery ? 0 : selected?.size ?? top ?? (fast ? 100 : 1000);
  const protocolCount = protocols.size || 1;
  const probes = hosts * (ports || 1) * protocolCount;
  const allowedPerHost = Math.max(1, Math.min(limits.maxPorts, Math.floor(limits.maxProbes / Math.max(1, hosts) / protocolCount)));
  const suggestion = `拆分为每批最多 ${limits.maxHosts} 个地址、${limits.maxPorts} 个端口、${limits.maxProbes} 个地址×端口×协议组合；当前目标数下每批端口不超过 ${allowedPerHost}。保留原目标与协议，只缩小本批范围，后续继续补齐验收缺口。`;
  if (hosts > limits.maxHosts || ports > limits.maxPorts || probes > limits.maxProbes) return { ...deny('workload_limit', `单次扫描工作量过大：${hosts} 个地址、${ports} 个端口、${protocolCount} 个协议，共 ${probes} 个组合`, suggestion), hosts, ports, probes };
  return { ...OK, hosts, ports, probes };
}
