import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HypothesisPanel } from './hypothesis-panel';
import { api } from '../../api/client';
vi.mock('../../api/client', () => ({ api: { get: vi.fn() } }));
let container: HTMLDivElement; let root: Root; let client: QueryClient;
const hypothesis = { id: 'h', title: '备份访问假设', description: '保留互相冲突的原文，需要独立复核', targetIp: '192.168.56.101', status: 'proposed', supportCount: 1, contradictCount: 1, conflicted: true, invalidLinkCount: 1 };
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); }
async function mount() { await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/workflow?task=t&hypothesis=h']}><HypothesisPanel taskId="t" /></MemoryRouter></QueryClientProvider>)); await flush(); }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.resetAllMocks(); });
describe('假设依据', () => {
  it('从深链接展示冲突与失效依据，原文按文字显示并能跳转同任务证据', async () => {
    vi.mocked(api.get).mockImplementation(async (url) => url.endsWith('/h') ? { hypothesis, links: [{ id: 'l', linkType: 'supports', targetType: 'evidence', targetId: 'e', assessmentSource: 'agent', validation: 'invalid', invalidReason: '原始文本完整性不匹配', counted: false, note: '模型解释', evidenceQuotes: [{ evidenceId: 'e', quote: '<img src="https://unfetched.invalid/pixel">引用原文' }] }] } : { items: [hypothesis] });
    await mount(); expect(container.textContent).toContain('依据冲突，待验证'); expect(container.textContent).toContain('未计入当前判断');
    expect(container.textContent).toContain('原始文本完整性不匹配'); expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/evidence?task=t&id=e');
    expect(api.get).toHaveBeenCalledWith('/tasks/t/hypotheses/h');
  });
  it('关联请求失败可见，不以存储的旧状态替代当前校验', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('假设不存在'));
    await mount(); expect(container.querySelector('[role="alert"]')?.textContent).toContain('假设不存在');
    expect(container.textContent).not.toContain('有支持解释');
  });
});
