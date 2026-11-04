import { isIP } from 'node:net';
import type { AttackSurfaceDto, FactDto, FindingDto, SurfaceAsset, SurfaceObservation, SurfacePort, TargetDto, TaskScope } from '@vulnagent/shared';
import { checkScope, extractTargets } from '../mcp/scope-guard';

export function buildAttackSurface(taskId: string, targets: TargetDto[], scope: TaskScope, facts: FactDto[], findings: FindingDto[], validEvidenceIds: string[]): AttackSurfaceDto {
  const evidence = new Set(validEvidenceIds);
  const assets = new Map<string, SurfaceAsset>();
  const policy = { allowedIps: targets.filter((t) => t.inScope && t.kind === 'host').map((t) => t.ip), allowedCidrs: [...(scope.cidrs ?? []), ...targets.filter((t) => t.inScope && t.kind === 'cidr').map((t) => t.ip)], allowedHostnames: targets.filter((t) => t.inScope && t.hostname).map((t) => t.hostname!) };
  const ensure = (address: string): SurfaceAsset => {
    let asset = assets.get(address);
    if (!asset) {
      const configured = targets.find((t) => t.ip === address);
      const extracted = extractTargets({ target: address });
      asset = { address, kind: configured?.kind ?? 'host', hostname: configured?.hostname ?? null,
        configured: Boolean(configured), inScope: Boolean(extracted.length && checkScope(extracted, policy).allow), aliveObserved: false,
        ports: [], technologies: [], endpoints: [], probeErrors: 0, inferredFacts: 0, findings: [], gaps: [] };
      assets.set(address, asset);
    }
    return asset;
  };
  targets.forEach((t) => ensure(t.ip));
  const usable = facts.filter((f) => f.taskId === taskId && factAddress(f) && ['observed', 'verified'].includes(f.status) && ['target_state', 'target_negative'].includes(f.observationKind) && f.sourceEvidenceIds.some((id) => evidence.has(id)));
  const protocols = new Map<string, Set<string>>();
  for (const fact of usable) {
    const address = factAddress(fact);
    const port = portOf(fact);
    if (!address || !port?.protocol) continue;
    const key = `${address}|${port.port}`;
    const set = protocols.get(key) ?? new Set(); set.add(port.protocol); protocols.set(key, set);
  }
  for (const fact of facts) {
    const address = factAddress(fact);
    if (!address) continue;
    const asset = ensure(address);
    if (fact.observationKind === 'probe_error') { asset.probeErrors++; continue; }
    if (fact.status === 'inferred' || fact.observationKind === 'inference') { asset.inferredFacts++; continue; }
  }
  for (const fact of usable) {
    const address = factAddress(fact);
    if (!address) continue;
    const asset = ensure(address);
    const observation: SurfaceObservation = { factId: fact.id, subject: fact.subject, predicate: fact.predicate, value: fact.object,
      evidenceIds: fact.sourceEvidenceIds.filter((id) => evidence.has(id)), observedAt: fact.observedAt ?? fact.createdAt,
      conflicting: Boolean(fact.conflictGroupId && !fact.conflictResolved) };
    if (fact.predicate === 'is_alive') asset.aliveObserved = true;
    const parsed = portOf(fact);
    if (parsed && ['has_open_port', 'port_closed', 'port_filtered', 'runs_service'].includes(fact.predicate)) {
      const known = protocols.get(`${address}|${parsed.port}`);
      const protocol = parsed.protocol ?? (known?.size === 1 ? [...known][0] : 'unknown') as SurfacePort['protocol'];
      let port = asset.ports.find((p) => p.port === parsed.port && p.protocol === protocol);
      if (!port) { port = { port: parsed.port, protocol, states: [], services: [], versionObserved: false, observations: [] }; asset.ports.push(port); }
      port.observations.push(observation);
      if (fact.predicate === 'has_open_port') { port.states.push('open'); asset.aliveObserved = true; }
      if (fact.predicate === 'port_closed') port.states.push('closed');
      if (fact.predicate === 'port_filtered') port.states.push(fact.object.includes('open|filtered') ? 'open|filtered' : 'filtered');
      if (fact.predicate === 'runs_service') { port.services.push(fact.object); port.versionObserved ||= /\b\d+\.\d+(?:\.\d+)?\b/.test(fact.object); }
    }
    if (['responds_with_status', 'exposes_path'].includes(fact.predicate)) asset.endpoints.push(observation);
    if (['server_header', 'os_fingerprint', 'page_title'].includes(fact.predicate) || (fact.category === 'technology' && !['responds_with_status', 'exposes_path'].includes(fact.predicate))) asset.technologies.push(observation);
  }
  for (const finding of findings) {
    if (finding.targetIp) ensure(finding.targetIp).findings.push({ id: finding.id, title: finding.title, status: finding.status });
  }
  for (const asset of assets.values()) {
    asset.ports.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
    for (const port of asset.ports) {
      port.states = [...new Set(port.states)]; port.services = [...new Set(port.services)];
      if (port.states.includes('open') && !port.versionObserved) asset.gaps.push(`${port.port}/${port.protocol} 缺少明确服务版本`);
      if (port.states.length > 1 || port.observations.some((o) => o.conflicting)) asset.gaps.push(`${port.port}/${port.protocol} 存在多种观测，需按时间和证据复核`);
      if (port.protocol === 'unknown') asset.gaps.push(`${port.port} 的传输协议未明确，不能自动归入 TCP 或 UDP`);
    }
    if (asset.kind === 'cidr') asset.gaps.push('网段是授权范围，不能将它视为已识别的单台主机');
    else if (!asset.aliveObserved) asset.gaps.push('尚无有效存活或开放端口证据');
    if (asset.probeErrors) asset.gaps.push(`${asset.probeErrors} 条探测失败不能作为目标状态依据`);
  }
  const result = [...assets.values()].sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true }));
  return { taskId, assets: result, excludedFacts: facts.length - usable.length,
    gaps: result.flatMap((a) => a.gaps.map((gap) => `${a.address}: ${gap}`)) };
}

function factAddress(fact: FactDto): string | null {
  const direct = fact.subject.match(/^\[([^\]]+)\](?::\d+)?/)?.[1] ?? fact.subject.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?/)?.[1];
  let explicit = direct && isIP(direct) ? direct : null;
  if (!explicit) try { const host = new URL(fact.subject).hostname.replace(/^\[|\]$/g, ''); explicit = isIP(host) ? host : null; } catch { /* 非 URL 主体。 */ }
  if (explicit && fact.targetIp && isIP(fact.targetIp) && explicit !== fact.targetIp) return null;
  return explicit ?? (fact.targetIp && isIP(fact.targetIp) ? fact.targetIp : null);
}
function portOf(fact: FactDto): { port: number; protocol?: 'tcp' | 'udp' } | null {
  const raw = fact.subject.match(/(?:\]|\d):([0-9]{1,5})(?:\/(tcp|udp))?$/i);
  if (!raw || +raw[1] < 1 || +raw[1] > 65535) return null;
  const protocol = raw[2]?.toLowerCase() ?? fact.object.match(/^\d+\/(tcp|udp)\b/i)?.[1]?.toLowerCase();
  return { port: +raw[1], ...(protocol ? { protocol: protocol as 'tcp' | 'udp' } : {}) };
}
