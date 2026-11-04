import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvidencePage } from './evidence-page';
import { api } from '../../api/client';
import { tasksApi } from '../../api/tasks';

vi.mock('../../api/client', () => ({ api: { get: vi.fn() } }));
vi.mock('../../api/tasks', () => ({ tasksApi: { list: vi.fn() } }));

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
const evidence = { id: 'e', taskId: 't', title: 'HTTP 观测', kind: 'command_output', createdAt: '2026-11-02T00:00:00Z', preview: 'preview', content: '<img src=x onerror=alert(1)>', integrity: 'mismatch', sha256: 'old', computedSha256: 'new', sizeBytes: 100, computedSizeBytes: 26, agentSessionId: 's', toolCallId: 'call' };

async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); }
async function mount(entry: string) {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry]}><EvidencePage /></MemoryRouter></QueryClientProvider>));
  await flush();
  await flush();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  vi.mocked(tasksApi.list).mockResolvedValue({ items: [{ id: 't', name: '任务一' }, { id: 't2', name: '任务二' }], total: 2 } as never);
  vi.mocked(api.get).mockImplementation((async (path: string) => path.includes('/evidence/e') ? evidence : { items: [evidence], total: 30 }) as typeof api.get);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear(); container.remove(); vi.clearAllMocks();
});

describe('证据浏览交互', () => {
  it('从事实深链接打开证据，显示校验不一致，工具输出按纯文本渲染', async () => {
    await mount('/evidence?task=t&id=e');
    expect(container.textContent).toContain('完整性不一致');
    expect(container.textContent).toContain('旧版截断');
    expect(container.querySelector('pre')?.textContent || container.textContent).toContain('preview');
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '导出原始文本')).toBe(true);
  });
  it('翻页后切换类型会请求第一页，切换任务会关闭旧证据详情', async () => {
    await mount('/evidence?task=t&id=e');
    const next = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '下一页')!;
    await act(async () => next.click()); await flush();
    expect(vi.mocked(api.get).mock.calls.some(([path]) => path.includes('page=2'))).toBe(true);
    const kind = container.querySelector('select[aria-label="证据类型"]') as HTMLSelectElement;
    await act(async () => { kind.value = 'note'; kind.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect(vi.mocked(api.get).mock.calls.some(([path]) => path.includes('page=1&pageSize=25&kind=note'))).toBe(true);
    const task = container.querySelector('select[aria-label="选择任务"]') as HTMLSelectElement;
    await act(async () => { task.value = 't2'; task.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect(container.textContent).toContain('选择一条证据');
    expect(container.textContent).not.toContain('完整性不一致');
    expect(vi.mocked(api.get).mock.calls.some(([path]) => path.includes('/tasks/t2/evidence?page=1'))).toBe(true);
  });
  it('服务返回错误时展示错误并提供重试入口', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('证据不存在'));
    await mount('/evidence?task=t&id=e');
    expect(container.textContent).toContain('证据不存在');
    expect(container.textContent).toContain('重试');
  });
});
