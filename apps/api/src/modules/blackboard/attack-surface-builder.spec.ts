import { describe, expect, it } from 'vitest';
import type { FactDto, TargetDto } from '@vulnagent/shared';
import { buildAttackSurface } from './attack-surface-builder';

const address = '192.168.56.101';
const target: TargetDto = { id: 'host', taskId: 't', ip: address, kind: 'host', hostname: null, inScope: true, note: null };
const fact = (over: Partial<FactDto> = {}): FactDto => ({
  id: 'f', taskId: 't', agentSessionId: null, category: 'service', subject: `${address}:80/tcp`, predicate: 'has_open_port', object: '80/tcp http', status: 'observed', confidence: 0.9, sourceEvidenceIds: ['e'], createdBy: 'tool', hypothesisIds: [], sourceTool: 'nmap_scan', targetIp: address, observedAt: '2026-11-02T00:00:00Z', observationKind: 'target_state', conflictGroupId: null, conflictResolved: false, createdAt: '2026-11-02T00:00:00Z', ...over,
});
const surface = (facts: FactDto[], valid = ['e']) => buildAttackSurface('t', [target], { cidrs: ['192.168.56.0/24'], ports: null }, facts, [], valid);

describe('资产与服务聚合', () => {
  it('配置目标不会被伪装成已存活主机', () => {
    const asset = surface([]).assets[0];
    expect(asset.aliveObserved).toBe(false); expect(asset.ports).toEqual([]);
    expect(asset.gaps.join(' ')).toContain('尚无有效');
  });
  it('TCP/UDP 分开聚合，服务版本及证据保留', () => {
    const asset = surface([fact(), fact({ id: 'v', predicate: 'runs_service', object: 'http Apache 2.4.29' }), fact({ id: 'udp', subject: `${address}:80/udp`, object: '80/udp unknown' })]).assets[0];
    expect(asset.ports).toHaveLength(2);
    expect(asset.ports.find((p) => p.protocol === 'tcp')?.versionObserved).toBe(true);
    expect(asset.ports.find((p) => p.protocol === 'udp')?.services).toEqual([]);
    expect(asset.ports[0].observations[0].evidenceIds).toEqual(['e']);
  });
  it('旧版未注明协议的服务不会在 TCP/UDP 同号端口之间随意归属', () => {
    const ports = surface([fact({ subject: `${address}:53`, object: '53/tcp domain' }), fact({ id: 'u', subject: `${address}:53/udp`, object: '53/udp domain' }), fact({ id: 's', subject: `${address}:53`, predicate: 'runs_service', object: 'domain DNS 1.0' })]).assets[0].ports;
    expect(ports.find((p) => p.protocol === 'unknown')?.services).toEqual(['domain DNS 1.0']);
  });
  it('失败、模型推断及没有有效证据的端口不形成确认状态', () => {
    const result = surface([fact({ observationKind: 'probe_error' }), fact({ id: 'i', status: 'inferred', observationKind: 'inference' }), fact({ id: 'bad', sourceEvidenceIds: ['missing'] })]);
    expect(result.assets[0].ports).toEqual([]); expect(result.excludedFacts).toBe(3);
    expect(result.assets[0].probeErrors).toBe(1); expect(result.assets[0].inferredFacts).toBe(1);
  });
  it('授权网段内新主机与范围外观测明确区分，不自动写入授权列表', () => {
    const result = surface([fact({ targetIp: '192.168.56.102', subject: '192.168.56.102:22/tcp' }), fact({ id: 'o', targetIp: '10.0.0.1', subject: '10.0.0.1:80/tcp' })]);
    expect(result.assets.find((a) => a.address === '192.168.56.102')?.inScope).toBe(true);
    expect(result.assets.find((a) => a.address === '192.168.56.102')?.configured).toBe(false);
    expect(result.assets.find((a) => a.address === '10.0.0.1')?.inScope).toBe(false);
  });
  it('保留相反观测和时间，提示复核而不覆盖为最后一个状态', () => {
    const asset = surface([fact(), fact({ id: 'closed', predicate: 'port_closed', object: '80/tcp closed', observationKind: 'target_negative', observedAt: '2026-11-02T00:01:00Z' })]).assets[0];
    expect(asset.ports[0].states).toEqual(['open', 'closed']);
    expect(asset.ports[0].observations[1].observedAt).toContain('00:01');
    expect(asset.gaps.join(' ')).toContain('复核');
  });
  it('排除跨任务数据、目标归属不一致和已推翻的观测', () => {
    const result = surface([fact({ taskId: 'other' }), fact({ id: 'mismatch', subject: '192.168.56.102:80/tcp' }), fact({ id: 'refuted', status: 'refuted' })]);
    expect(result.assets[0].ports).toEqual([]); expect(result.excludedFacts).toBe(3);
  });
});
