import { describe, expect, it } from 'vitest';
import { getProfile, listProfiles, matchPattern, selectTools } from './profiles';

describe('Worker Profile 与工具选择', () => {
  it('Linux 审计和独立验证使用有审批能力的角色与命令目录', () => {
    expect(getProfile('linux-audit').role).toBe('verifier');
    expect(selectTools(getProfile('verification'), ['run_shell_command', 'run_kali_tool', 'msf_console_execute', 'msf_run_module'])).toHaveLength(4);
    expect(getProfile('linux-audit').skills.map((skill) => skill.guidance).join(' ')).toContain('不在 MCP 执行机上冒充靶机审计');
  });
  it('通配符匹配工具名', () => {
    expect(matchPattern('nmap*', 'nmap_scan')).toBe(true);
    expect(matchPattern('nmap*', 'gobuster')).toBe(false);
    expect(matchPattern('*scan*', 'masscan_ports')).toBe(true);
    expect(matchPattern('curl', 'curl')).toBe(true);
  });

  it('侦察档案只选择扫描类工具（真实 HexStrike 工具名）', () => {
    const profile = getProfile('recon');
    const tools = selectTools(profile, [
      'nmap_scan',
      'nmap_advanced_scan',
      'gobuster_scan',
      'sqlmap_scan',
    ]);
    expect(tools).toContain('nmap_scan');
    expect(tools).toContain('nmap_advanced_scan');
    expect(tools).not.toContain('sqlmap_scan');
  });

  it('侦察技能要求显式限定扫描范围，避免全端口超时', () => {
    const guidance = getProfile('recon').skills.map((s) => s.guidance).join(' ');
    expect(guidance).toContain('全端口 1-65535 应拆成有界小批');
    expect(guidance).toContain('-Pn');
  });

  it('侦察技能区分 filtered 与 closed', () => {
    const guidance = getProfile('recon').skills.map((s) => s.guidance).join(' ');
    expect(guidance).toContain('filtered 不等于 closed');
  });

  it('所有 Profile 都加载工具纪律技能', () => {
    for (const id of [
      'recon',
      'web',
      'service',
      'linux-audit',
      'vuln-analysis',
      'verification',
    ] as const) {
      const ids = getProfile(id).skills.map((s) => s.id);
      expect(ids).toContain('common.tool-discipline');
    }
  });

  it('Web 档案选择目录枚举工具', () => {
    const profile = getProfile('web');
    const tools = selectTools(profile, [
      'nmap_scan',
      'gobuster_scan',
      'ffuf_scan',
      'nikto_scan',
      'sqlmap_scan',
    ]);
    expect(tools).toEqual(['gobuster_scan', 'ffuf_scan', 'nikto_scan']);
  });

  it('验证档案开放高危扫描但不包含侦察工具', () => {
    const profile = getProfile('verification');
    const tools = selectTools(profile, ['nuclei_scan', 'sqlmap_scan', 'nmap_scan']);
    expect(tools).toContain('sqlmap_scan');
    expect(tools).not.toContain('nmap_scan');
  });

  it('无匹配时返回空数组', () => {
    expect(selectTools(getProfile('verification'), ['unknown_tool'])).toEqual([]);
  });

  it('每个档案都有技能、预算份额与超时设置', () => {
    for (const profile of listProfiles()) {
      expect(profile.skills.length).toBeGreaterThan(0);
      expect(profile.tokenBudgetShare).toBeGreaterThan(0);
      expect(profile.timeoutSeconds).toBeGreaterThan(0);
      expect(profile.expectedEvidence.length).toBeGreaterThan(0);
    }
  });
});
