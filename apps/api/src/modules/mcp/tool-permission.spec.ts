import { describe, expect, it } from 'vitest';
import { toolPermission } from './tool-permission';
const grant = { agentRole: 'verifier', toolPattern: '*', allowed: true, requireApproval: false };
describe('工具权限交集', () => {
  it('无匹配或角色不匹配默认拒绝', () => {
    expect(toolPermission([], 'verifier', 'http_repeater').allowed).toBe(false);
    expect(toolPermission([grant], 'analysis', 'http_repeater').allowed).toBe(false);
  });
  it('显式拒绝覆盖通配授权，与规则顺序无关', () => {
    const deny = { ...grant, toolPattern: 'run_*', allowed: false };
    for (const rules of [[grant, deny], [deny, grant]]) expect(toolPermission(rules, 'verifier', 'run_shell_command').allowed).toBe(false);
    expect(toolPermission([grant, deny], 'verifier', 'http_repeater').allowed).toBe(true);
  });
  it('多个授权中任一要求审批就保留审批，其他角色规则不参与', () => {
    expect(toolPermission([grant, { ...grant, toolPattern: 'run_shell_command', requireApproval: true }], 'verifier', 'run_shell_command')).toEqual({ allowed: true, requireApproval: true });
    expect(toolPermission([grant, { ...grant, agentRole: 'analysis', allowed: false }], 'verifier', 'http_repeater').allowed).toBe(true);
  });
});
