import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineSnapshot, SessionDto, TaskSummary } from '@vulnagent/shared';
import { AgentsPage } from './agents/agents-page';
import { WorkflowPage } from './workflow/workflow-page';
import { agentsApi, blackboardApi, engineApi, workflowApi } from '../api/agents';
import { tasksApi } from '../api/tasks';

vi.mock('../api/tasks', () => ({ tasksApi: { list: vi.fn() } }));
vi.mock('../api/agents', () => ({
  engineApi: { snapshot: vi.fn(), start: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn() },
  agentsApi: { sessions: vi.fn(), messages: vi.fn(), pause: vi.fn(), resume: vi.fn(), terminate: vi.fn() },
  blackboardApi: { workers: vi.fn(), hints: vi.fn() },
  workflowApi: { graph: vi.fn() },
}));
vi.mock('../features/workflow/live-canvas', () => ({ LiveCanvas: () => null }));
vi.mock('./workflow/workflow-node-drawer', () => ({ WorkflowNodeDrawer: () => null }));
vi.mock('../components/blackboard/fact-panel', () => ({ FactPanel: () => null }));
vi.mock('../components/blackboard/tool-call-panel', () => ({ ToolCallPanel: () => null }));
vi.mock('../components/blackboard/hypothesis-panel', () => ({ HypothesisPanel: () => null }));
let root: Root; let container: HTMLDivElement; let client: QueryClient; let snapshot: EngineSnapshot;
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const accepted: TaskSummary = { id: 'fixture', name: 'fixture', status: 'running', goal: null, scope: { cidrs: [], ports: '80' }, modelProvider: 'fixture', modelName: 'fixture', tokenBudget: 10000, tokensUsed: 0, costUsd: 0, timeBudgetMinutes: 1, workerCount: 1, progress: 0, currentPhase: null, targetIps: [], startedAt: null, finishedAt: null, lastError: null, createdAt: '', updatedAt: '' };
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); }
async function mount(Page: typeof AgentsPage) {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/?task=fixture']}><Page /></MemoryRouter></QueryClientProvider>)); await flush();
}
function button(text: string) { return Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === text)!; }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  snapshot = { taskId: 'fixture', engineStatus: 'idle', orchestratorStatus: 'idle', stopReason: null, cycle: 0, activeWorkers: 0, totalWorkers: 0, maxConcurrency: 2, tokensUsed: 0, tokenBudget: 10000, elapsedSeconds: 0, timeBudgetSeconds: 60, factCounts: { observed: 0, verified: 0, inferred: 0, refuted: 0 }, intentCounts: {}, plannerSessionId: null, startedAt: null, finishedAt: null, lastError: null };
  vi.mocked(tasksApi.list).mockResolvedValue({ items: [], total: 0, stats: {} });
  vi.mocked(engineApi.snapshot).mockImplementation(async () => snapshot);
  // 工作流页按实时快照决定启动/恢复，这里必须返回同一份对象，避免固定 idle 掩盖状态。
  vi.mocked(workflowApi.graph).mockImplementation(async () => ({ source: 'live', taskId: 'fixture', taskName: 'fixture', taskStatus: 'pending', engine: snapshot, generatedAt: '', nodes: [], edges: [] }));
  vi.mocked(agentsApi.sessions).mockResolvedValue({ items: [] });
  vi.mocked(blackboardApi.workers).mockResolvedValue({ items: [] });
  vi.mocked(blackboardApi.hints).mockResolvedValue({ items: [] });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.resetAllMocks(); if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); });

describe.each([['智能体', AgentsPage], ['工作流', WorkflowPage]] as const)('%s引擎控制', (_name, Page) => {
  it('显示失败原因，不自动重试；再次提交成功后刷新实际状态', async () => {
    vi.mocked(engineApi.start).mockRejectedValueOnce(new Error('执行引擎已关闭，请在系统设置中启用'));
    await mount(Page); await act(async () => button('启动引擎').click()); await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('执行引擎已关闭');
    expect(engineApi.start).toHaveBeenCalledTimes(1);
    vi.mocked(engineApi.start).mockImplementationOnce(async () => { snapshot = { ...snapshot, orchestratorStatus: 'executing', engineStatus: 'running' }; return accepted; });
    await act(async () => button('启动引擎').click()); await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('停止'); expect(engineApi.start).toHaveBeenLastCalledWith('fixture');
  });
  it.each(['paused', 'needs_input', 'stalled'] as const)('%s 状态调用恢复，并在请求期间禁止重复或相互冲突的控制', async (status) => {
    snapshot.orchestratorStatus = status; snapshot.engineStatus = status;
    let finish!: (value: TaskSummary) => void;
    vi.mocked(engineApi.resume).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount(Page); await act(async () => { button('恢复引擎').click(); button('恢复引擎').click(); });
    expect(engineApi.resume).toHaveBeenCalledTimes(1); expect(engineApi.start).not.toHaveBeenCalled();
    expect(button('恢复引擎').disabled).toBe(true);
    await act(async () => finish(accepted)); await flush(); expect(button('恢复引擎').disabled).toBe(false);
  });
});

it('智能体页显示会话控制与消息加载错误，停止失败不伪装成功', async () => {
  const session: SessionDto = { id: 'session', taskId: 'fixture', role: 'explore', profileId: null, parentSessionId: null, sessionKey: 'session', modelName: 'fixture', state: 'running', tokenInput: 0, tokenOutput: 0, costUsd: 0, stateCard: null, errorMessage: null, startedAt: null, endedAt: null, createdAt: '', messageCount: 1 };
  vi.mocked(agentsApi.sessions).mockResolvedValue({ items: [session] });
  vi.mocked(agentsApi.messages).mockRejectedValue(new Error('消息读取失败'));
  vi.mocked(agentsApi.terminate).mockRejectedValue(new Error('会话仍在收尾'));
  await mount(AgentsPage); await flush();
  expect(container.textContent).toContain('消息读取失败');
  await act(async () => button('终止').click()); await flush();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('会话仍在收尾');
  expect(agentsApi.terminate).toHaveBeenCalledTimes(1); expect(button('暂停').disabled).toBe(false);
});

it('长会话可按返回游标加载全部后续消息，不重新显示第一页或丢失已有消息', async () => {
  const session: SessionDto = { id: 'history', taskId: 'fixture', role: 'explore', profileId: null, parentSessionId: null, sessionKey: 'history', modelName: 'fixture', state: 'completed', tokenInput: 0, tokenOutput: 0, costUsd: 0, stateCard: null, errorMessage: null, startedAt: null, endedAt: null, createdAt: '', messageCount: 625 };
  vi.mocked(agentsApi.sessions).mockResolvedValue({ items: [session] });
  vi.mocked(agentsApi.messages).mockImplementation(async (_id, afterSeq = 0) => {
    const end = Math.min(afterSeq + 300, 625);
    return { items: Array.from({ length: end - afterSeq }, (_, index) => ({ id: `message-${afterSeq + index + 1}`, sessionId: 'history', seq: afterSeq + index + 1, role: 'assistant', content: `输出 ${afterSeq + index + 1}`, messageJson: null, toolCallId: null, toolName: null, usage: null, createdAt: '' })), total: 625, nextAfterSeq: end < 625 ? end : null };
  });
  await mount(AgentsPage); await flush(); expect(container.querySelectorAll('article')).toHaveLength(300);
  await act(async () => button('加载后续消息').click()); await flush(); expect(container.querySelectorAll('article')).toHaveLength(600);
  await act(async () => button('加载后续消息').click()); await flush(); expect(container.querySelectorAll('article')).toHaveLength(625);
  expect(container.textContent).toContain('输出 625'); expect(button('加载后续消息')).toBeUndefined();
  expect(agentsApi.messages).toHaveBeenNthCalledWith(1, 'history', 0); expect(agentsApi.messages).toHaveBeenNthCalledWith(2, 'history', 300); expect(agentsApi.messages).toHaveBeenNthCalledWith(3, 'history', 600);
});
