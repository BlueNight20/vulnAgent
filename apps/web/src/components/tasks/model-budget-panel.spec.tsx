import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelBudgetDto } from '@vulnagent/shared';
import { api } from '../../api/client';
import { ModelBudgetPanel } from './model-budget-panel';

vi.mock('../../api/client', () => ({ api: { get: vi.fn() } }));
let container: HTMLDivElement; let root: Root; let client: QueryClient;
const data: ModelBudgetDto = {
  tokenBudget: 10000, usableTokens: 9000, knownTokens: 25, committedTokens: 1975, remainingTokens: 7000, total: 26, note: '输入为预估',
  items: [{ id: 'request-1', sessionId: 'session-1', currentRun: true, state: 'uncertain', modelName: 'fixture', inputEstimate: 500,
    maxOutputTokens: 1500, reservedTokens: 2000, committedTokens: 1975, inputTokens: 20, outputTokens: 5, costUsd: null,
    errorMessage: '连接中断', createdAt: '2026-11-02T00:00:00Z', finishedAt: null }],
};
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); }
async function mount(id = 'task-1') {
  await act(async () => root.render(<QueryClientProvider client={client}><ModelBudgetPanel key={id} taskId={id} /></QueryClientProvider>));
  await flush();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.resetAllMocks(); });
describe('模型预算账本', () => {
  it('分开展示已报告和未确认占用，保留部分用量及中断说明', async () => {
    vi.mocked(api.get).mockResolvedValue(data); await mount();
    expect(container.textContent).toContain('本轮已报告 25 · 在途/未确认占用 1975 · 可用余额 7000');
    expect(container.textContent).toContain('20 / 5（可能不完整）');
    expect(container.textContent).toContain('同一会话不会自动重试');
    expect(container.textContent).toContain('连接中断');
  });
  it('翻页后切换历史重置第一页，切换任务不沿用旧范围', async () => {
    vi.mocked(api.get).mockResolvedValue(data); await mount();
    await act(async () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '下一页')!.click()); await flush();
    expect(api.get).toHaveBeenLastCalledWith('/tasks/task-1/model-budget?page=2&history=false');
    await act(async () => container.querySelector('input')!.click()); await flush();
    expect(api.get).toHaveBeenLastCalledWith('/tasks/task-1/model-budget?page=1&history=true');
    await mount('task-2');
    expect(api.get).toHaveBeenLastCalledWith('/tasks/task-2/model-budget?page=1&history=false');
    expect(container.querySelector('input')!.checked).toBe(false);
  });
  it('读取失败显示错误，不伪造零消耗和可用余额', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('账本暂不可用')); await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('账本暂不可用');
    expect(container.textContent).not.toContain('本轮已报告');
  });
});
