import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AGENT_ROLE_LABEL } from '@vulnagent/shared';
import type { AgentRole, McpPermissionMatrix } from '@vulnagent/shared';
import { TableShell, Td, Th } from '../ui/panel';
import { Input, Select, Switch } from '../ui/input';
import { Button } from '../ui/button';
import { NoticeBanner } from '../common/notice-banner';
import { mcpApi } from '../../api/mcp';

/** 常用权限模式（非具体工具名，而是策略模式），避免在无目录时出现空表 */
const PATTERN_ROWS = [
  { pattern: '*', label: '全部工具（默认策略）' },
  { pattern: 'nmap*', label: 'nmap*（端口与服务扫描）' },
  { pattern: 'http*', label: 'http*（HTTP 探测）' },
  { pattern: 'nuclei*', label: 'nuclei*（模板化检测）' },
  { pattern: 'sqlmap*', label: 'sqlmap*（注入验证）' },
  { pattern: 'msf*', label: 'msf*（Metasploit 利用）' },
  { pattern: 'searchsploit*', label: 'searchsploit*（漏洞库查询）' },
];

const ROLES: AgentRole[] = ['bootstrap', 'explore', 'analysis', 'verifier', 'reporter', 'planner'];

export function McpPermissionsTab({ matrix }: { matrix: McpPermissionMatrix | undefined }) {
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [newPattern, setNewPattern] = useState('');
  const [newRole, setNewRole] = useState<AgentRole>('verifier');
  const [newAllowed, setNewAllowed] = useState(false);
  const [newApproval, setNewApproval] = useState(true);

  const mutation = useMutation({
    mutationFn: (input: { agentRole: AgentRole; toolPattern: string; allowed: boolean; requireApproval?: boolean }) =>
      mcpApi.updatePermission(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mcp', 'permissions'] }),
  });

  const globalRules = matrix?.permissions.filter((p) => p.taskId === null) ?? [];
  const find = (role: AgentRole, pattern: string) => globalRules.find((p) => p.agentRole === role && p.toolPattern === pattern);
  const rows = new Map(PATTERN_ROWS.map((row) => [row.pattern, row]));
  for (const rule of globalRules) if (!rows.has(rule.toolPattern)) rows.set(rule.toolPattern, { pattern: rule.toolPattern, label: '已保存规则' });
  for (const tool of matrix?.tools ?? []) if (!rows.has(tool.name)) rows.set(tool.name, { pattern: tool.name, label: '目录工具（精确名称）' });
  const visible = [...rows.values()].filter((row) => row.pattern.toLowerCase().includes(keyword.toLowerCase().trim()));

  return (
    <div className="p-4">
      <NoticeBanner tone="warning" text={matrix?.notice ?? '权限矩阵加载中'} />

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-400">
        <span>全局规则 {globalRules.length} 条</span>
        <span>· 当前目录展示 {matrix?.tools.length ?? 0} 个工具</span>
        <span>· 修改与审计同时保存，执行时重新检查权限</span>
      </div>

      <p className="mt-2 text-xs text-ink-500">本页编辑全局规则。开关表示该条规则；未配置与显式拒绝不同，最终执行结果合并全部匹配规则，显式拒绝优先。需审批开关不会执行工具。</p>
      {mutation.error && <p role="alert" className="mt-2 text-xs text-red-700">保存失败：{mutation.error.message}</p>}
      {mutation.isSuccess && <p role="status" className="mt-2 text-xs">规则与审计已保存。</p>}
      <div className="mt-3"><Input aria-label="筛选工具规则" placeholder="按工具名或模式筛选" value={keyword} onChange={(event) => setKeyword(event.target.value)} /></div>
      <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (newPattern.trim()) mutation.mutate({ agentRole: newRole, toolPattern: newPattern.trim(), allowed: newAllowed, requireApproval: newApproval }); }}>
        <Input aria-label="新增工具模式" className="w-64" placeholder="新增精确工具名或通配模式" required maxLength={140} value={newPattern} disabled={!matrix || mutation.isPending} onChange={(event) => setNewPattern(event.target.value)} />
        <Select aria-label="新增规则角色" value={newRole} disabled={!matrix || mutation.isPending} onChange={(event) => setNewRole(event.target.value as AgentRole)}>{ROLES.map((role) => <option key={role} value={role}>{AGENT_ROLE_LABEL[role]}</option>)}</Select>
        <label className="flex items-center gap-1 text-xs"><input aria-label="新增规则允许" type="checkbox" checked={newAllowed} disabled={!matrix || mutation.isPending} onChange={(event) => setNewAllowed(event.target.checked)} />允许</label>
        <label className="flex items-center gap-1 text-xs"><input aria-label="新增规则需审批" type="checkbox" checked={newApproval} disabled={!matrix || mutation.isPending} onChange={(event) => setNewApproval(event.target.checked)} />需审批</label>
        <Button type="submit" disabled={!matrix || !newPattern.trim()} loading={mutation.isPending}>保存全局规则</Button>
      </form>

      <div className="mt-3">
        <TableShell>
          <thead>
            <tr>
              <Th className="w-[260px]">工具模式 / Agent 角色</Th>
              {ROLES.map((role) => (
                <Th key={role} className="text-center">
                  {AGENT_ROLE_LABEL[role]}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.pattern} className="transition-colors hover:bg-slate-50/70">
                <Td>
                  <p className="font-mono text-[12px]">{row.pattern}</p>
                  <p className="text-[11px] text-ink-400">{row.label}</p>
                </Td>
                {ROLES.map((role) => {
                  const perm = find(role, row.pattern);
                  const allowed = perm?.allowed ?? false;
                  return (
                    <Td key={role} className="text-center">
                      <div className="flex flex-col items-center gap-1">
                        <Switch
                          size="sm"
                          checked={allowed}
                          disabled={!matrix || mutation.isPending}
                          label={`${role}-${row.pattern}`}
                          onCheckedChange={(next) =>
                            mutation.mutate({
                              agentRole: role,
                              toolPattern: row.pattern,
                              allowed: next,
                              requireApproval: perm?.requireApproval ?? false,
                            })
                          }
                        />
                        <span className="text-[10px] text-ink-500">{perm ? (allowed ? '允许' : '显式拒绝') : '未配置'}</span>
                        {perm && <label className="flex items-center gap-1 text-[10px] text-ink-500"><input type="checkbox" aria-label={`${role}-${row.pattern}-需审批`} checked={perm.requireApproval} disabled={mutation.isPending} onChange={(event) => mutation.mutate({ agentRole: role, toolPattern: row.pattern, allowed, requireApproval: event.target.checked })} />需审批</label>}
                      </div>
                    </Td>
                  );
                })}
              </tr>
            ))}
            {!visible.length && <tr><Td colSpan={ROLES.length + 1}>没有匹配规则，可在上方填写完整工具名或模式。</Td></tr>}
          </tbody>
        </TableShell>
      </div>
    </div>
  );
}
