import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportsPage } from './reports-page';
import { api } from '../../api/client';
import { tasksApi } from '../../api/tasks';
import { downloadReportFile } from '../../api/report-download';

vi.mock('../../api/client', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../../api/tasks', () => ({ tasksApi: { list: vi.fn() } }));
vi.mock('../../api/report-download', () => ({ downloadReportFile: vi.fn() }));
let container: HTMLDivElement; let root: Root; let client: QueryClient;
const stats = { kind: 'progress', findingCounts: { confirmed: 1, candidate: 2, unconfirmed: 1, verifying: 0, refuted: 0 }, unmetChecks: 2 };
const detail = { id: 'r', taskId: 't', title: '阶段报告', createdAt: '2026-11-02T00:00:00Z', generatedAt: null, status: 'ready', stats, integrity: 'match', content: '# 阶段报告\n\n## 验收缺口\n\n尚有端口未观测。\n\n<script>alert(1)</script>\n\n![external](https://example.invalid/track.png)\n\n[link](javascript:alert(1))', evidence: [{ id: 'e', title: '原始响应', integrity: 'match', provenanceValid: true, computedSizeBytes: 200 }] };
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); }
async function mount(path = '/reports?task=t&id=r') { await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><ReportsPage /></MemoryRouter></QueryClientProvider>)); await flush(); await flush(); }
async function click(label: string) { await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === label)!.click()); await flush(); }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  vi.mocked(tasksApi.list).mockResolvedValue({ items: [{ id: 't', name: '任务一' }, { id: 't2', name: '任务二' }], total: 2 } as never);
  vi.mocked(api.get).mockImplementation(async (path) => path.includes('?page=') ? { items: [detail], total: 1 } : detail as never);
  vi.mocked(api.post).mockResolvedValue({ ...detail, id: 'new' }); vi.mocked(downloadReportFile).mockResolvedValue();
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks(); });

describe('报告中心', () => {
  it('显示阶段状态与验收缺口，Markdown 预览不执行 HTML 或加载远程图片', async () => {
    await mount(); expect(container.textContent).toContain('尚有端口未观测'); expect(container.textContent).toContain('确认 1');
    expect(container.querySelector('script')).toBeNull(); expect(container.querySelector('img')).toBeNull(); expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('a[href="/evidence?task=t&id=e"]')).not.toBeNull();
  });
  it('生成快照并选择新报告，导出同一快照的 PDF 和完整附件', async () => {
    await mount(); await click('生成报告快照'); expect(api.post).toHaveBeenCalledWith('/tasks/t/reports');
    await click('导出 PDF'); expect(downloadReportFile).toHaveBeenCalledWith('/tasks/t/reports/new/download?format=pdf', 'report-new.pdf');
    await click('下载快照'); expect(downloadReportFile).toHaveBeenCalledWith('/tasks/t/reports/new/evidence/e', 'evidence-e.txt');
    await click('下载 ZIP 包'); expect(downloadReportFile).toHaveBeenCalledWith('/tasks/t/reports/new/download?format=bundle', 'report-new.zip');
  });
  it('完整性异常禁止导出，服务端导出错误可见', async () => {
    vi.mocked(downloadReportFile).mockRejectedValue(new Error('报告超过 PDF 页数上限'));
    await mount(); await click('导出 PDF'); expect(container.textContent).toContain('报告超过 PDF 页数上限');
    await act(async () => { client.setQueryData(['report', 't', 'r'], { ...detail, integrity: 'mismatch' }); }); await flush();
    expect(([...container.querySelectorAll('button')].find((b) => b.textContent === '导出 PDF') as HTMLButtonElement).disabled).toBe(true);
  });
  it('切换任务清空旧报告，不导出上一任务数据', async () => {
    await mount(); const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => { select.value = 't2'; select.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect(container.textContent).toContain('选择报告或生成新快照'); expect(container.querySelector('[aria-label="报告正文"]')).toBeNull();
    expect(api.get).toHaveBeenCalledWith('/tasks/t2/reports?page=1');
  });
  it('生成期间切换任务，旧请求完成后不会跳回旧任务', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api.post).mockImplementation(() => new Promise((resolve) => { finish = resolve; }) as never);
    await mount(); await click('生成报告快照');
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => { select.value = 't2'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { finish({ ...detail, id: 'late-report' }); }); await flush();
    expect(select.value).toBe('t2'); expect(container.textContent).toContain('选择报告或生成新快照');
  });
});
