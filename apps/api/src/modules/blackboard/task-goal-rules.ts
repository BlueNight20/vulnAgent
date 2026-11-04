import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import { isValidIPv4, isValidPortSpec, isValidTarget, targetHost, type FactDto, type TaskAcceptance, type TaskGoal, type TaskGoalInput, type TaskScope } from '@vulnagent/shared';
import { checkScope, extractTargets, ipToInt } from '../mcp/scope-guard';
import { extractFacts } from '../orchestrator/evidence-fact-extractor';

export interface GoalProof {
  id: string;
  targetIp: string | null;
  toolName: string;
  args: Record<string, unknown>;
  text: string;
}

export function portSet(spec: string | null): Set<number> {
  const ports = new Set<number>();
  if (!spec?.trim() || !isValidPortSpec(spec)) return ports;
  for (const part of spec.split(',')) {
    const [start, end] = part.trim().split('-').map(Number);
    for (let port = start; port <= (end ?? start); port++) ports.add(port);
  }
  return ports;
}

/** 目标的规范化文本：URL 取 host（域名为小写），其余原样。用于与工具输出里的主机名比较。 */
export function targetHostKey(target: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target.trim()) ? targetHost(target).toLowerCase() : target.trim();
}

function isUrlTarget(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target.trim());
}

function isCidrTarget(target: string): boolean {
  return target.includes('/') && !isUrlTarget(target);
}

/** URL 或域名目标：以 HTTP 响应验收，而非端口扫描清单。 */
function isHttpStyleTarget(target: string): boolean {
  const v = target.trim();
  return isUrlTarget(v) || (!isValidIPv4(v) && !isCidrTarget(v));
}

export function configureGoal(input: TaskGoalInput, allowedTargets: string[], scope: TaskScope): TaskGoal {
  if (!['recon', 'assessment', 'evidence'].includes(input.mode)) throw new BadRequestException('未知任务目标类型');
  if (!['tcp', 'udp'].includes(input.protocol)) throw new BadRequestException('验收协议必须是 tcp 或 udp');
  const targets = [...new Set(input.targets.map((t) => t.trim()))];
  if (!targets.length || targets.length > 64 || targets.some((t) => !isValidTarget(t))) throw new BadRequestException('验收目标必须是合法的 URL、域名、IPv4 或 CIDR，且最多 64 项');
  const allowed = allowedTargets.map((t) => t.trim());
  const allowedKeys = new Set(allowed.map(targetHostKey));
  const outside = targets.filter((t) => !allowedKeys.has(targetHostKey(t)) && !isCidrTarget(t));
  if (outside.length) throw new BadRequestException(`验收目标必须属于任务当前授权范围：${outside.join(', ')}`);
  const selected = portSet(input.ports);
  const authorized = portSet(scope.ports);
  // URL / 域名目标以 HTTP 响应验收，不要求配置端口扫描清单；端口超出范围仍然拒绝。
  const httpOnly = targets.every(isHttpStyleTarget);
  if (input.mode !== 'evidence' && httpOnly) {
    if (selected.size && authorized.size && [...selected].some((p) => !authorized.has(p))) throw new BadRequestException('验收端口不能为空或超出任务端口范围');
  } else if (input.mode !== 'evidence' && (!selected.size || (authorized.size && [...selected].some((p) => !authorized.has(p))))) throw new BadRequestException('验收端口不能为空或超出任务端口范围');
  const text = input.evidenceText?.trim() ?? null;
  if (input.mode === 'evidence' && (!text || text.length < 8 || text.length > 2000)) throw new BadRequestException('指定证据标记应为 8 到 2000 个字符');
  return { mode: input.mode, targets, ports: input.mode === 'evidence' ? null : (input.ports ?? '').trim() || null, protocol: input.protocol, evidenceText: input.mode === 'evidence' ? text : null, configuredAt: new Date().toISOString() };
}

/** 比较的是实际完成的观测范围，不将未响应或 filtered 当作服务不存在。 */
export function evaluateGoal(goal: TaskGoal | null, facts: FactDto[], proofs: GoalProof[], findings: { id: string; title: string; passed: boolean }[], pendingWork: boolean, analysedTargets: string[] = []): TaskAcceptance {
  if (!goal) return { goal, configured: false, complete: false, checks: [], notes: ['旧任务未配置验收目标；请先明确范围和期望结果。'] };
  const checks: TaskAcceptance['checks'] = [];
  const ids = new Set(proofs.map((p) => p.id));
  for (const target of goal.targets) {
    if (goal.mode === 'evidence') {
      const matched = proofs.filter((p) => targetText(p, target).includes(goal.evidenceText!));
      checks.push({ id: `marker:${target}`, label: `${target} 的成功工具输出包含指定证据标记`, passed: matched.length > 0, evidenceIds: matched.map((p) => p.id) });
      continue;
    }
    const required = portSet(goal.ports);
    const observed = new Set<number>();
    const used = new Set<string>();
    const rangesByPort = new Map<number, [number, number][]>();
    if (isUrlTarget(target)) {
      // URL 目标：以 HTTP 探测对同一主机的成功响应作为观测依据，不展开全端口扫描。
      const url = parseUrl(target);
      let status: number | null = null;
      for (const proof of proofs) {
        const found = url ? httpObservedStatus(proof, url.hostname.toLowerCase(), url.port) : null;
        if (found !== null) { used.add(proof.id); status = found; }
      }
      const port = url ? (url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80) : null;
      checks.push({ id: `http:${target}`, label: `${target} 已通过 HTTP 探测获得响应${status !== null ? `（${port ?? ''} · 状态 ${status}）` : ''}`, passed: status !== null, evidenceIds: [...used] });
      if (goal.mode === 'assessment') checks.push({ id: `analysis:${target}`, label: `${target} 已完成有当前证据支持的结构化漏洞分析`, passed: analysedTargets.includes(target), evidenceIds: [] });
      continue;
    }
    for (const proof of proofs) {
      if (!target.includes('/') && /nmap|masscan|rustscan|port[_-]?scan/i.test(proof.toolName)) for (const fact of extractFacts(proof.toolName, proof.targetIp, proof.text)) {
        if (fact.targetIp !== target || !['has_open_port', 'port_closed', 'port_filtered'].includes(fact.predicate)) continue;
        const port = fact.subject.match(/:(\d+)\/(tcp|udp)$/i);
        if (port && port[2] === goal.protocol) { observed.add(Number(port[1])); used.add(proof.id); }
      }
      if (target.includes('/')) {
        const ranges = completedAddressRanges(proof, target);
        const source = extractTargets(proof.args)[0]?.normalized;
        const covered = source && ranges.length ? completedNmapPorts(proof, source, goal.protocol, true) : new Set<number>();
        if (covered.size) { for (const port of covered) if (required.has(port)) rangesByPort.set(port, [...(rangesByPort.get(port) ?? []), ...ranges]); used.add(proof.id); }
      } else {
        const covered = completedNmapPorts(proof, target, goal.protocol);
        if (covered.size) { covered.forEach((p) => observed.add(p)); used.add(proof.id); }
      }
    }
    if (target.includes('/')) for (const [port, ranges] of rangesByPort) if (coversRange(target, ranges)) observed.add(port);
    const count = [...required].filter((port) => observed.has(port)).length;
    const conflict = facts.some((f) => f.targetIp === target && f.category === 'service' && ['observed', 'verified'].includes(f.status) && f.conflictGroupId && !f.conflictResolved && f.sourceEvidenceIds.some((id) => ids.has(id)) && required.has(Number(f.subject.match(/:(\d+)(?:\/(?:tcp|udp))?$/i)?.[1])));
    const missing = compactPorts([...required].filter((p) => !observed.has(p)));
    const missingAddresses = target.includes('/') && count < required.size ? [...required].filter((p) => !observed.has(p)).slice(0, 3).map((p) => `${p}/${goal.protocol}: ${uncoveredAddresses(target, rangesByPort.get(p) ?? [])}`).join('；') : '';
    checks.push({ id: `ports:${target}`, label: `${target} 的 ${goal.protocol} ${goal.ports} ${target.includes('/') ? '网段扫描流程' : '观测覆盖'} ${count}/${required.size}${conflict ? '，存在未解决冲突' : ''}${missing ? `；尚缺 ${missing}` : ''}${missingAddresses ? `；未覆盖地址示例 ${missingAddresses}` : ''}`, passed: required.size > 0 && count === required.size && !conflict, evidenceIds: [...used] });
    if (goal.mode === 'assessment') checks.push({ id: `analysis:${target}`, label: `${target} 已完成有当前证据支持的结构化漏洞分析`, passed: analysedTargets.includes(target), evidenceIds: [] });
  }
  if (goal.mode === 'assessment') for (const finding of findings) checks.push({ id: `finding:${finding.id}`, label: `候选已形成有效独立复核结论：${finding.title}`, passed: finding.passed, evidenceIds: [] });
  checks.push({ id: 'settled', label: '没有未完成意图、Worker 或待审批调用', passed: !pendingWork, evidenceIds: [] });
  return { goal, configured: true, complete: checks.every((c) => c.passed), checks, notes: [
    '端口覆盖代表已完成所选范围的观测，不代表过滤或未响应的目标没有服务。',
    ...(goal.targets.some((t) => t.includes('/')) ? ['网段覆盖依据工具完成记录；未发现主机不等于主机不存在。'] : []),
    ...(goal.mode === 'assessment' && !findings.length ? ['当前没有漏洞候选，不能据此宣称目标不存在漏洞。'] : []),
  ] };
}

export function proofCoversTarget(proof: GoalProof, target: string): boolean {
  const extracted = extractTargets(proof.args);
  if (isUrlTarget(target)) {
    const url = parseUrl(target);
    if (!url) return false;
    const host = url.hostname.toLowerCase();
    return (
      proof.targetIp === host || proof.targetIp === target.trim() ||
      extracted.some((t) => t.normalized === host) ||
      extractFacts(proof.toolName, proof.targetIp, proof.text).some((f) => f.targetIp === host)
    );
  }
  if (target.includes('/')) return extracted.some((t) => t.kind === 'cidr' && checkScope([t], { allowedIps: [], allowedCidrs: [target], allowedHostnames: [] }).allow && checkScope(extractTargets({ target }), { allowedIps: [], allowedCidrs: [t.normalized], allowedHostnames: [] }).allow);
  return proof.targetIp === target || extracted.some((t) => t.kind === 'ip' && t.normalized === target) || extractFacts(proof.toolName, proof.targetIp, proof.text).some((f) => f.targetIp === target);
}

function completedNmapPorts(proof: GoalProof, target: string, protocol: string, rangeFlow = false): Set<number> {
  if (!/nmap/i.test(proof.toolName) || !proofCoversTarget(proof, target) || !/^Nmap done:/im.test(proof.text)) return new Set();
  const flags = [proof.args.scan_type, proof.args.additional_args, proof.args.options, proof.args.flags, proof.args.arguments, proof.args.args].filter((v) => typeof v === 'string').join(' ');
  if (/(?:^|\s)(?:-sn|-sL|-F|--top-ports|--exclude-ports|--exclude)(?:\s|=|$)/.test(flags)) return new Set();
  const codes = [...flags.matchAll(/(?:^|\s)-s([A-Z]+)/g)].flatMap((m) => m[1].split(''));
  if (codes.some((c) => ['O', 'Y', 'Z'].includes(c))) return new Set();
  const udp = codes.includes('U') || /\budp\b/i.test(flags);
  if (udp && codes.some((c) => ['S', 'T', 'A', 'W', 'M', 'N', 'F', 'X'].includes(c))) return new Set();
  if ((udp ? 'udp' : 'tcp') !== protocol) return new Set();
  const declared = typeof proof.args.ports === 'string' ? proof.args.ports : '';
  const specified = flags.match(/(?:^|\s)-p\s*([\d,-]+)(?=\s|$)/)?.[1];
  const explicit = specified === '-' ? '1-65535' : specified;
  if (explicit && declared) { const a = portSet(explicit); const b = portSet(declared); if (a.size !== b.size || [...a].some((p) => !b.has(p))) return new Set(); }
  const ports = portSet(declared || explicit || null);
  if (!ports.size) return ports;
  if (rangeFlow) return ports;
  if (target.includes('/')) {
    const prefix = Number(target.split('/')[1]);
    const count = proof.text.match(/^Nmap done:\s*(\d+) IP address/im)?.[1];
    return count && Number(count) === 2 ** (32 - prefix) ? ports : new Set();
  }
  const block = targetText(proof, target);
  return /^(?:\d+\/(?:tcp|udp)\s+|All \d+ scanned ports|Not shown:)/im.test(block) ? ports : new Set();
}

function addressRange(target: string): [number, number] | null {
  const [ip, prefixText] = target.split('/'); const value = ipToInt(ip); const prefix = prefixText === undefined ? 32 : Number(prefixText);
  if (value === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const size = 2 ** (32 - prefix); const start = Math.floor(value / size) * size;
  return [start, start + size - 1];
}
function coversRange(target: string, ranges: [number, number][]): boolean {
  const wanted = addressRange(target); if (!wanted) return false;
  let next = wanted[0];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) { if (end < next) continue; if (start > next) return false; next = end + 1; if (next > wanted[1]) return true; }
  return false;
}
function uncoveredAddresses(target: string, ranges: [number, number][]): string {
  const wanted = addressRange(target); if (!wanted) return '未知';
  const text = (n: number) => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
  const gaps: string[] = []; let next = wanted[0];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (end < next) continue;
    if (start > next) gaps.push(`${text(next)}-${text(Math.min(start - 1, wanted[1]))}`);
    next = Math.max(next, end + 1); if (next > wanted[1]) break;
    if (gaps.length >= 3) return gaps.join(', ') + '…';
  }
  if (next <= wanted[1]) gaps.push(`${text(next)}-${text(wanted[1])}`);
  return gaps.join(', ') || '无';
}
export function proofsCoverRange(proofs: GoalProof[], target: string): boolean {
  return coversRange(target, proofs.flatMap((p) => extractTargets(p.args).map((t) => addressRange(t.normalized)).filter((r): r is [number, number] => Boolean(r))));
}
function completedAddressRanges(proof: GoalProof, target: string): [number, number][] {
  if (!/nmap/i.test(proof.toolName)) return [];
  const wanted = addressRange(target); if (!wanted) return [];
  const targets = extractTargets(proof.args); const ranges = targets.map((t) => addressRange(t.normalized));
  if (!ranges.length || ranges.some((r) => !r)) return [];
  const count = Number(proof.text.match(/^Nmap done:\s*(\d+) IP address/im)?.[1]);
  if (!count || count !== ranges.reduce((sum, r) => sum + r![1] - r![0] + 1, 0)) return [];
  return ranges.flatMap((r) => { const a = Math.max(r![0], wanted[0]); const b = Math.min(r![1], wanted[1]); return a <= b ? [[a, b] as [number, number]] : []; });
}
function compactPorts(values: number[]): string {
  const sorted = values.sort((a, b) => a - b); const parts: string[] = [];
  for (let i = 0; i < sorted.length;) { const start = sorted[i]; let end = start; while (sorted[i + 1] === end + 1) end = sorted[++i]; parts.push(start === end ? String(start) : `${start}-${end}`); i++; if (parts.join(',').length > 500) return parts.join(',').slice(0, 500) + '…（其余缺口省略）'; }
  return parts.join(',');
}

function targetText(proof: GoalProof, target: string): string {
  if (isUrlTarget(target)) {
    const url = parseUrl(target);
    if (!url) return '';
    const host = url.hostname.toLowerCase();
    const blocks: string[] = [];
    for (const line of [...proof.text.matchAll(/^https?:\/\/\S+.*$/gim)]) {
      try {
        const lineUrl = new URL(line[0].trim());
        if (lineUrl.hostname.toLowerCase() === host && (!url.port || (lineUrl.port || (lineUrl.protocol === 'https:' ? '443' : '80')) === url.port)) blocks.push(line[0]);
      } catch { /* 非 URL 行忽略。 */ }
    }
    if (blocks.length) return blocks.join('\n');
    return proofCoversTarget(proof, target) ? proof.text : '';
  }
  const reports = /nmap/i.test(proof.toolName) ? [...proof.text.matchAll(/^Nmap scan report for (.+)$/gim)] : [];
  if (reports.length) {
    return reports.flatMap((report, index) => {
      const address = report[1].match(/\(([^()]+)\)\s*$/)?.[1] ?? report[1].trim();
      const matches = target.includes('/') ? checkScope(extractTargets({ target: address }), { allowedIps: [], allowedCidrs: [target], allowedHostnames: [] }).allow && Boolean(isIP(address)) : address === target;
      return matches ? [proof.text.slice(report.index!, reports[index + 1]?.index ?? proof.text.length)] : [];
    }).join('\n');
  }
  if (/httpx/i.test(proof.toolName)) {
    const lines = [...proof.text.matchAll(/^(https?:\/\/\S+)\s+\[\d{3}\]/gim)];
    if (lines.length) return lines.flatMap((line, index) => {
      try { const host = new URL(line[1]).hostname.replace(/^\[|\]$/g, ''); const matches = target.includes('/') ? Boolean(isIP(host)) && checkScope(extractTargets({ target: host }), { allowedIps: [], allowedCidrs: [target], allowedHostnames: [] }).allow : host === target; return matches ? [proof.text.slice(line.index!, lines[index + 1]?.index ?? proof.text.length)] : []; } catch { return []; }
    }).join('\n');
  }
  if (!proofCoversTarget(proof, target)) return '';
  const targets = extractTargets(proof.args);
  return new Set(targets.map((t) => `${t.kind}:${t.normalized}`)).size === 1 ? proof.text : '';
}

function parseUrl(target: string): URL | null {
  try {
    return new URL(target.trim());
  } catch {
    return null;
  }
}

/**
 * 从成功证据里找出该 URL 主机的 HTTP 响应状态码。
 * 支持 httpx/nuclei 等输出里的 `http://host:port [200]` 行与 `status: 200` 字段；
 * 端口为空时接受该主机任意端口的响应。
 */
function httpObservedStatus(proof: GoalProof, host: string, port: string): number | null {
  const wanted = port || null;
  const sameEndpoint = (url: URL) => url.hostname.toLowerCase() === host && (!wanted || (url.port || (url.protocol === 'https:' ? '443' : '80')) === wanted);
  for (const match of proof.text.matchAll(/https?:\/\/\S+/g)) {
    const tail = proof.text.slice(match.index! + match[0].length, match.index! + match[0].length + 40);
    try {
      if (!sameEndpoint(new URL(match[0]))) continue;
    } catch { continue; }
    const status = tail.match(/^\s+\[(\d{3})\]|^\s+.*?\bstatus(?:[_-]?code)?["']?\s*[:=]\s*(\d{3})/i);
    if (status) return Number(status[1] ?? status[2]);
  }
  const scalar = proof.text.match(/\bstatus(?:[_-]?code)?["']?\s*[:=]\s*(\d{3})\b/i);
  return scalar ? Number(scalar[1]) : null;
}
