import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttackSurfacePage } from './attack-surface-page';
import { api } from '../../api/client';
import { tasksApi } from '../../api/tasks';

vi.mock('../../api/client', () => ({ api: { get: vi.fn() } }));
vi.mock('../../api/tasks', () => ({ tasksApi: { list: vi.fn() } }));
let container: HTMLDivElement; let root: Root; let client: QueryClient;
const observation = { factId: 'f', subject: 'http://192.168.56.101/admin', predicate: 'responds_with_status', value: 'HTTP 200', evidenceIds: ['e'], observedAt: '2026-11-02T00:00:00Z', conflicting: false };
const asset = { address: '192.168.56.101', kind: 'host', hostname: null, configured: true, inScope: true, aliveObserved: true, ports: [{ port: 80, protocol: 'tcp', states: ['open'], services: ['http Apache 2.4.29'], observations: [observation] }], technologies: [], endpoints: [observation], probeErrors: 0, inferredFacts: 0, findings: [{ id: 'v', title: '候选漏洞', status: 'candidate' }], gaps: ['需要复核端点用途'] };
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); }
async function mount() {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/attack-surface?task=t']}><AttackSurfacePage /></MemoryRouter></QueryClientProvider>));
  await flush(); await flush();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  vi.mocked(tasksApi.list).mockResolvedValue({ items: [{ id: 't', name: '任务一' }, { id: 't2', name: '任务二' }], total: 2 } as never);
  vi.mocked(api.get).mockResolvedValue({ taskId: 't', assets: [asset, { ...asset, address: '10.0.0.1', inScope: false, aliveObserved: false, ports: [], technologies: [], endpoints: [], findings: [] }], excludedFacts: 2, gaps: [] });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks(); });

describe('攻击面视图', () => {
  it('显示真实端点、范围外和未知状态，并可跳转证据与候选', async () => {
    await mount();
    expect(container.textContent).toContain('80/tcp');
    expect(container.textContent).toContain('http://192.168.56.101/admin');
    expect(container.textContent).toContain('范围外观测'); expect(container.textContent).toContain('存活未知');
    expect(container.querySelector('a[href="/evidence?task=t&id=e"]')).not.toBeNull();
    expect(container.querySelector('a[href="/vulnerabilities?task=t&id=v"]')).not.toBeNull();
  });
  it('支持服务筛选，切换任务时清空筛选并请求当前任务', async () => {
    await mount();
    const input = container.querySelector('input') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'no-match'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(container.textContent).toContain('没有匹配的资产');
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => { select.value = 't2'; select.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('');
    expect(vi.mocked(api.get)).toHaveBeenCalledWith('/tasks/t2/attack-surface');
  });
  it('显示服务端错误并可重试', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('任务不存在'));
    await mount(); expect(container.textContent).toContain('任务不存在'); expect(container.textContent).toContain('重试');
  });
});
