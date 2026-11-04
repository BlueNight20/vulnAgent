import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { McpPermissionMatrix } from '@vulnagent/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpPermissionsTab } from './mcp-permissions-tab';
import { mcpApi } from '../../api/mcp';
vi.mock('../../api/mcp', () => ({ mcpApi: { updatePermission: vi.fn() } }));
let container: HTMLDivElement; let root: Root; let client: QueryClient;
const matrix: McpPermissionMatrix = { roles: ['verifier'], notice: '显式拒绝优先', tools: [{ name: 'run_shell_command', serverName: 'fixture', riskLevel: 'destructive' }], permissions: [
  { id: 'p', taskId: null, agentRole: 'verifier', toolPattern: 'run_shell_command', allowed: true, requireApproval: true },
  { id: 'q', taskId: null, agentRole: 'analysis', toolPattern: 'legacy_custom*', allowed: false, requireApproval: false },
] };
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); }
async function mount(data: McpPermissionMatrix | undefined = matrix) { await act(async () => root.render(<QueryClientProvider client={client}><McpPermissionsTab matrix={data} /></QueryClientProvider>)); await flush(); }
async function input(label: string, value: string) { const node = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function click(label: string) { await act(async () => (container.querySelector(`[aria-label="${label}"]`) as HTMLElement).click()); await flush(); }
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.resetAllMocks(); });
describe('全局工具权限维护', () => {
  it('展示实际精确工具及已存自定义模式，区分未配置/拒绝，编辑时保留审批要求', async () => {
    vi.mocked(mcpApi.updatePermission).mockResolvedValue(matrix.permissions[0]);
    const invalidate = vi.spyOn(client, 'invalidateQueries'); await mount();
    expect(container.textContent).toContain('legacy_custom*'); expect(container.textContent).toContain('未配置'); expect(container.textContent).toContain('显式拒绝');
    await click('verifier-run_shell_command');
    expect(mcpApi.updatePermission).toHaveBeenLastCalledWith({ agentRole: 'verifier', toolPattern: 'run_shell_command', allowed: false, requireApproval: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mcp', 'permissions'] });
    await click('verifier-run_shell_command-需审批');
    expect(mcpApi.updatePermission).toHaveBeenLastCalledWith({ agentRole: 'verifier', toolPattern: 'run_shell_command', allowed: true, requireApproval: false });
    await input('筛选工具规则', 'legacy_'); expect(container.querySelector('[aria-label="verifier-run_shell_command"]')).toBeNull(); expect(container.textContent).toContain('legacy_custom*');
  });
  it('可提交精确新规则，默认不授权且保留审批，错误可见且不伪造成功', async () => {
    vi.mocked(mcpApi.updatePermission).mockRejectedValue(new Error('审计写入失败，修改已回滚')); await mount();
    await input('新增工具模式', ' custom_tool ');
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await flush();
    expect(mcpApi.updatePermission).toHaveBeenCalledWith({ agentRole: 'verifier', toolPattern: 'custom_tool', allowed: false, requireApproval: true });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('修改已回滚'); expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[aria-label="verifier-run_shell_command"]')?.getAttribute('aria-checked')).toBe('true');
  });
  it('加载期间不允许写入，也不会用任务规则冒充全局状态', async () => {
    await act(async () => root.render(<QueryClientProvider client={client}><McpPermissionsTab matrix={undefined} /></QueryClientProvider>));
    expect((container.querySelector('[aria-label="verifier-*"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[aria-label="新增工具模式"]') as HTMLInputElement).disabled).toBe(true);
    await mount({ ...matrix, permissions: [{ ...matrix.permissions[0], taskId: 'scoped' }] });
    expect(container.querySelector('[aria-label="verifier-run_shell_command"]')?.getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('[aria-label="verifier-run_shell_command-需审批"]')).toBeNull();
  });
});
