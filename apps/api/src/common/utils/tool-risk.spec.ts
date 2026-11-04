import { describe, expect, it } from 'vitest';
import { inferToolRisk } from './id';

describe('MCP 工具风险推断', () => {
  it('工具清单与状态查询为只读安全', () => {
    expect(inferToolRisk('list_available_tools', 'list all attack tools including payload generators')).toBe(
      'safe',
    );
    expect(inferToolRisk('msf_status', 'metasploit status')).toBe('safe');
    // search_exploits 命中 exploit 关键字，归为破坏性，需要显式审批
    expect(inferToolRisk('search_exploits', 'search exploit db')).toBe('destructive');
  });

  it('描述中的 payload/exploit 不会把只读工具误判为 destructive', () => {
    // 这是此前的真实 bug：描述里提到 payload 就被标记为高危机，导致侦察被审批阻塞
    expect(
      inferToolRisk('list_available_tools', 'Includes exploit modules and payload templates'),
    ).toBe('safe');
  });

  it('主动扫描为 intrusive', () => {
    expect(inferToolRisk('nmap_scan', null)).toBe('intrusive');
    expect(inferToolRisk('gobuster_scan', null)).toBe('intrusive');
    expect(inferToolRisk('httpx_probe', null)).toBe('intrusive');
    expect(inferToolRisk('netexec_scan', null)).toBe('intrusive');
    expect(inferToolRisk('smbmap_scan', null)).toBe('intrusive');
  });

  it('利用类工具为 destructive', () => {
    expect(inferToolRisk('sqlmap_scan', null)).toBe('destructive');
    expect(inferToolRisk('msf_run_module', null)).toBe('destructive');
    expect(inferToolRisk('run_shell_command', null)).toBe('destructive');
    expect(inferToolRisk('generate_payload', null)).toBe('destructive');
  });

  it('未知工具默认安全（不阻塞）', () => {
    expect(inferToolRisk('take_screenshot', null)).toBe('safe');
  });
});
