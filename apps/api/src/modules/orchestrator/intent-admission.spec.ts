import { describe, expect, it } from 'vitest';
import { admitIntents, type AdmissionContext, type AdmissionCandidate } from './intent-admission';

const base = (over: Partial<AdmissionCandidate> = {}): AdmissionCandidate => ({
  id: 'i1',
  title: '扫描 80 端口',
  dedupeKey: 'recon-80',
  targetIp: '192.168.56.101',
  suggestedTools: ['nmap_scan'],
  dependencies: [],
  status: 'proposed',
  prerequisites: [],
  ...over,
});

const ctx = (over: Partial<AdmissionContext> = {}): AdmissionContext => ({
  authorizedIps: ['192.168.56.101'],
  existingDedupeKeys: new Set<string>(),
  satisfiedIntentIds: new Set<string>(),
  allowedTools: new Set(['nmap_scan', 'gobuster_dir']),
  catalogTools: new Set(['nmap_scan', 'gobuster_dir']),
  ...over,
});

describe('意图准入', () => {
  it('拒绝修复平台镜像，不误拦目标服务测试', () => {
    expect(admitIntents([base({ title: '在编排/镜像层修复 FTP 客户端' })], ctx()).rejected[0].reason).toBe('platform_maintenance');
    expect(admitIntents([base({ title: '核实目标 MCP server 已安装组件的版本' })], ctx()).accepted).toHaveLength(1);
  });
  it('允许授权 CIDR 中新发现的主机，不要求它预先在显式 IP 列表中', () => {
    const result = admitIntents([base({ targetIp: '192.168.56.102' })], ctx({ authorizedIps: [], authorizedCidrs: ['192.168.56.0/24'] }));
    expect(result.accepted).toHaveLength(1);
  });
  it('CIDR 准入仍拒绝范围外或无法解析的目标', () => {
    expect(admitIntents([base({ targetIp: '10.0.0.1' })], ctx({ authorizedCidrs: ['192.168.56.0/24'] })).rejected[0].reason).toBe('out_of_scope');
    expect(admitIntents([base({ targetIp: '???' })], ctx({ authorizedCidrs: ['192.168.56.0/24'] })).rejected[0].reason).toBe('out_of_scope');
  });
  it('合法意图被接受', () => {
    const result = admitIntents([base()], ctx());
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('重复 dedupeKey 被拒绝', () => {
    const result = admitIntents([base()], ctx({ existingDedupeKeys: new Set(['recon-80']) }));
    expect(result.rejected[0].reason).toBe('duplicate');
  });

  it('同批次内重复 dedupeKey 只接受一个', () => {
    const result = admitIntents([base(), base({ id: 'i2' })], ctx());
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('duplicate');
  });

  it('超出授权范围被拒绝', () => {
    const result = admitIntents([base({ targetIp: '10.0.0.5' })], ctx());
    expect(result.rejected[0].reason).toBe('out_of_scope');
  });

  it('工具未授权被拒绝', () => {
    const result = admitIntents([base({ suggestedTools: ['sqlmap_run'] })], ctx());
    expect(result.rejected[0].reason).toBe('tool_not_allowed');
  });

  it('工具不在 MCP 目录被拒绝', () => {
    const result = admitIntents(
      [base({ suggestedTools: ['nmap_scan'] })],
      ctx({ catalogTools: new Set(['gobuster_dir']) }),
    );
    expect(result.rejected[0].reason).toBe('tool_not_allowed');
    expect(result.rejected[0].detail).toContain('MCP 目录');
  });

  it('依赖未完成被拒绝', () => {
    const result = admitIntents([base({ dependencies: ['intent-x'] })], ctx());
    expect(result.rejected[0].reason).toBe('prerequisite');
  });

  it('依赖已完成时通过', () => {
    const result = admitIntents(
      [base({ dependencies: ['intent-x'] })],
      ctx({ satisfiedIntentIds: new Set(['intent-x']) }),
    );
    expect(result.accepted).toHaveLength(1);
  });

  it('无目标 IP 的意图允许通过（如全局分析）', () => {
    const result = admitIntents([base({ targetIp: null })], ctx());
    expect(result.accepted).toHaveLength(1);
  });

  it('缺少去重键被拒绝', () => {
    const result = admitIntents([base({ dedupeKey: '  ' })], ctx());
    expect(result.rejected[0].reason).toBe('duplicate');
  });

  it('同批次新生成的意图不会被自己的 dedupeKey 误判为重复', () => {
    // existingDedupeKeys 只应包含已派发/已完成的历史意图
    const result = admitIntents(
      [base({ id: 'a', dedupeKey: 'recon-1' }), base({ id: 'b', dedupeKey: 'recon-2' })],
      ctx({ existingDedupeKeys: new Set<string>() }),
    );
    expect(result.accepted).toHaveLength(2);
  });

  it('工具目录为空时给出明确的排查提示', () => {
    const result = admitIntents([base()], ctx({ catalogTools: new Set<string>() }));
    expect(result.rejected[0].reason).toBe('tool_not_allowed');
    expect(result.rejected[0].detail).toContain('MCP 工具目录为空');
  });
});
