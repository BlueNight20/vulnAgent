import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionDto } from '@vulnagent/shared';
import { SessionPanel } from './session-panel';
import { blackboardApi } from '../../api/agents';

vi.mock('../../api/agents', () => ({ agentsApi: {}, blackboardApi: { hints: vi.fn(), createHint: vi.fn() } }));
let root: Root; let container: HTMLDivElement; let client: QueryClient;
const session: SessionDto = { id: 'worker-session', taskId: 'task', role: 'explore', profileId: null, parentSessionId: null, sessionKey: 'fixture', modelName: 'fixture', state: 'running', tokenInput: 0, tokenOutput: 0, costUsd: 0, stateCard: null, errorMessage: null, startedAt: null, endedAt: null, createdAt: '', messageCount: 0 };
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); }); };
const button = (text: string) => [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(text))!;
async function type(text: string) { await act(async () => { const textarea = container.querySelector('textarea')!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text); textarea.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function chooseTask() { await act(async () => { const select = container.querySelector('select')!; select.value = 'task'; select.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function mount(state: SessionDto['state'] = 'running') { await act(async () => root.render(<QueryClientProvider client={client}><SessionPanel taskId="task" session={{ ...session, state }} /></QueryClientProvider>)); await flush(); }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(blackboardApi.hints).mockResolvedValue({ items: [] });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.resetAllMocks(); });

it('明确区分会话定向和任务规划提示，保存期间阻止重复提交并显示归属', async () => {
  const hint = { id: 'hint', taskId: 'task', agentSessionId: session.id, appliedToSessionId: null, content: '只给当前会话', status: 'pending' as const, consumedAt: null, createdAt: '' };
  vi.mocked(blackboardApi.hints).mockResolvedValue({ items: [hint] });
  let finish!: (value: typeof hint) => void;
  vi.mocked(blackboardApi.createHint).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await mount(); await type('只给当前会话'); await act(async () => button('提交给该会话').click()); await flush();
  expect(blackboardApi.createHint).toHaveBeenCalledWith('task', '只给当前会话', session.id);
  expect(button('提交给该会话').disabled).toBe(true); expect(container.querySelector('select')?.disabled).toBe(true);
  expect(container.textContent).toContain('定向 worker-s'); expect(container.textContent).toContain('待消费');
  await act(async () => finish(hint)); await flush(); expect(container.querySelector('textarea')?.value).toBe('');
  await chooseTask(); await type('供后续规划'); vi.mocked(blackboardApi.createHint).mockResolvedValueOnce({ ...hint, agentSessionId: null });
  await act(async () => button('提交任务提示').click()); await flush();
  expect(blackboardApi.createHint).toHaveBeenLastCalledWith('task', '供后续规划', undefined);
  expect(container.textContent).toContain('不自动启动或恢复任务');
});

it('终态会话不能定向提交；任务提示失败保留原文供人工重试', async () => {
  await mount('completed'); await type('待人工确认'); expect(button('提交给该会话').disabled).toBe(true);
  expect(container.textContent).toContain('该会话已结束'); expect(container.querySelector('textarea')?.maxLength).toBe(2000);
  await chooseTask(); vi.mocked(blackboardApi.createHint).mockRejectedValueOnce(new Error('任务已结束，请重新运行后提交提示'));
  await act(async () => button('提交任务提示').click()); await flush();
  expect(container.textContent).toContain('任务已结束，请重新运行后提交提示'); expect(container.querySelector('textarea')?.value).toBe('待人工确认');
  expect(blackboardApi.createHint).toHaveBeenCalledTimes(1);
});
