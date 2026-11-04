import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvidenceAttachments } from './evidence-attachments';
import { api } from '../../api/client';
import { downloadReportFile } from '../../api/report-download';

vi.mock('../../api/client', () => ({ api: { get: vi.fn() } }));
vi.mock('../../api/report-download', () => ({ downloadReportFile: vi.fn() }));
let container: HTMLDivElement; let root: Root; let client: QueryClient;
const item = { id: 'a', evidenceId: 'e', filename: '测试截图.png', mimeType: 'image/png', sha256: 'hash', sizeBytes: 68, computedSha256: 'hash', computedSizeBytes: 68, integrity: 'match', previewable: true, sourceUri: null };
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); }
async function mount() { await act(async () => root.render(<QueryClientProvider client={client}><EvidenceAttachments taskId="t" evidenceId="e" /></QueryClientProvider>)); await flush(); }
async function click(label: string) { await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === label)!.click()); await flush(); }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  vi.mocked(api.get).mockResolvedValue({ items: [item], references: [], missingIds: [] }); vi.mocked(downloadReportFile).mockResolvedValue();
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks(); });

describe('证据二进制附件', () => {
  it('按任务和证据下载附件，仅点击时预览一张受控图片', async () => {
    await mount(); expect(container.textContent).toContain('测试截图.png'); expect(container.querySelector('img')).toBeNull();
    await click('预览图片'); expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/tasks/t/evidence/e/attachments/a/preview');
    await click('下载附件'); expect(downloadReportFile).toHaveBeenCalledWith('/tasks/t/evidence/e/attachments/a/download', '测试截图.png');
    await click('收起图片'); expect(container.querySelector('img')).toBeNull();
  });
  it('来源损坏或丢失会明确提示，禁止导出损坏字节', async () => {
    vi.mocked(api.get).mockResolvedValue({ items: [{ ...item, integrity: 'mismatch', previewable: false }], missingIds: ['missing'] });
    await mount(); expect(container.textContent).toContain('来源附件已丢失'); expect(container.textContent).toContain('附件完整性不一致');
    expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(true); expect(container.querySelector('img')).toBeNull();
  });
  it('外部引用按文字展示，下载错误可见', async () => {
    vi.mocked(api.get).mockResolvedValue({ items: [item], references: [{ name: '<script>alert(1)</script>', uri: 'https://unfetched.invalid/file' }] });
    vi.mocked(downloadReportFile).mockRejectedValue(new Error('附件完整性不一致'));
    await mount(); expect(container.textContent).toContain('尚未下载'); expect(container.querySelector('a')).toBeNull(); expect(container.querySelector('script')).toBeNull();
    await click('下载附件'); expect(container.textContent).toContain('附件完整性不一致');
  });
});
