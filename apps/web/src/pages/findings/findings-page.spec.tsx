import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FindingsPage } from './findings-page';
import { api } from '../../api/client';
import { tasksApi } from '../../api/tasks';

vi.mock('../../api/client', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../../api/tasks', () => ({ tasksApi: { list: vi.fn() } }));
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let queued = false;
const finding = { id: 'f', taskId: 't', title: '待验证的备份暴露', description: '候选需要独立复核', status: 'candidate', severity: 'info', evidenceIds: ['source'], targetIp: '192.168.56.101' };
const record = { id: 'v', taskId: 't', findingId: 'f', intentId: 'i', outcome: 'pending', summary: '已进入验证队列', evidenceQuotes: [], createdAt: '2026-11-02T00:00:00Z' };
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); }
async function mount() {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/vulnerabilities?task=t&id=f']}><FindingsPage /></MemoryRouter></QueryClientProvider>));
  await flush(); await flush();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  queued = false; container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  vi.mocked(tasksApi.list).mockResolvedValue({ items: [{ id: 't', name: '任务一' }, { id: 't2', name: '任务二' }], total: 2 } as never);
  vi.mocked(api.get).mockImplementation((async (url: string) => {
    const current = { ...finding, status: queued ? 'verifying' : 'candidate' };
    return url.endsWith('/f') ? { finding: current, verifications: queued ? [record] : [] } : { items: [current], total: 30 };
  }) as typeof api.get);
  vi.mocked(api.post).mockImplementation((async () => { queued = true; return record; }) as typeof api.post);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks(); });

describe('漏洞发现页面', () => {
  it('安排验证后显示队列状态且禁止重复点击，候选证据可跳转', async () => {
    await mount();
    const source = container.querySelector('a[href*="id=source"]');
    expect(source?.getAttribute('href')).toBe('/evidence?task=t&id=source');
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '安排独立验证')!;
    await act(async () => button.click()); await flush(); await flush();
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/tasks/t/findings/f/verify');
    expect(container.textContent).toContain('验证已入队');
    expect(container.textContent).toContain('已进入验证队列');
    expect(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '重新验证')?.disabled).toBe(true);
  });
  it('证据不足等服务端错误显示给用户，不显示入队成功', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('候选漏洞缺少完整且可溯源的工具证据'));
    await mount();
    await act(async () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '安排独立验证')!.click()); await flush();
    expect(container.textContent).toContain('缺少完整且可溯源');
    expect(container.textContent).not.toContain('验证已入队');
  });
  it('筛选重置分页，切换任务关闭旧详情', async () => {
    await mount();
    await act(async () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '下一页')!.click()); await flush();
    const status = container.querySelector('select[aria-label="漏洞状态"]') as HTMLSelectElement;
    await act(async () => { status.value = 'refuted'; status.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect(vi.mocked(api.get).mock.calls.some(([url]) => url.endsWith('page=1&clueLevel=actionable&status=refuted'))).toBe(true);
    const task = container.querySelector('select[aria-label="选择任务"]') as HTMLSelectElement;
    await act(async () => { task.value = 't2'; task.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect(container.textContent).toContain('选择候选查看详情');
    expect(vi.mocked(api.get).mock.calls.some(([url]) => url === '/tasks/t2/findings?page=1&clueLevel=actionable')).toBe(true);
  });
});
