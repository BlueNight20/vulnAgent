import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskAcceptance, TaskDetail } from '@vulnagent/shared';
import { TaskGoalPanel } from './task-goal-panel';
import { api } from '../../api/client';

vi.mock('../../api/client', () => ({ api: { get: vi.fn(), put: vi.fn() } }));
let container: HTMLDivElement; let root: Root; let client: QueryClient;
const goal = { mode: 'recon' as const, targets: ['192.168.56.101'], ports: '80,443', protocol: 'tcp' as const, evidenceText: null, configuredAt: '2026-11-02T00:00:00Z' };
const acceptance: TaskAcceptance = { goal, configured: true, complete: false, checks: [{ id: 'ports', label: '已观测 1/2 个端口', passed: false, evidenceIds: ['e'] }], notes: ['未响应不能证明服务不存在'] };
const task: TaskDetail = { id: 't', name: '任务', status: 'paused', goal, targetIps: goal.targets, scope: { cidrs: [], ports: '80,443' }, description: null, authorizationRef: null, targets: [], modelProvider: 'fixture', modelName: 'fixture', tokenBudget: 10000, tokensUsed: 0, costUsd: 0, timeBudgetMinutes: 10, workerCount: 1, progress: 0, currentPhase: null, startedAt: null, finishedAt: null, lastError: null, createdAt: goal.configuredAt, updatedAt: goal.configuredAt };
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); }
async function mount(current = task) { await act(async () => root.render(<QueryClientProvider client={client}><TaskGoalPanel task={current} /></QueryClientProvider>)); await flush(); }
async function click(label: string) { const button = [...container.querySelectorAll('button')].find((b) => b.textContent === label)!; await act(async () => button.click()); await flush(); }
async function change(selector: string, value: string) {
  const element = container.querySelector(selector) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  vi.mocked(api.get).mockResolvedValue(acceptance); vi.mocked(api.put).mockResolvedValue(acceptance);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks(); });

describe('任务验收目标', () => {
  it('展示缺口与观测限制，运行时禁止修改已配置目标', async () => {
    await mount({ ...task, status: 'running' });
    expect(container.textContent).toContain('已观测 1/2 个端口');
    expect(container.textContent).toContain('未响应不能证明服务不存在');
    expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  });
  it('暂停后保存标记目标，刷新时保留正在编辑的内容', async () => {
    await mount(); await click('修改目标');
    await change('[aria-label="验收类型"]', 'evidence');
    await change('[aria-label="精确证据标记"]', 'expected-marker-123');
    await act(async () => { await client.invalidateQueries({ queryKey: ['task-goal', 't'] }); }); await flush();
    expect((container.querySelector('[aria-label="精确证据标记"]') as HTMLTextAreaElement).value).toBe('expected-marker-123');
    await click('保存目标');
    expect(api.put).toHaveBeenCalledWith('/tasks/t/goal', { mode: 'evidence', targets: goal.targets, ports: null, protocol: 'tcp', evidenceText: 'expected-marker-123' });
    expect(container.querySelector('[aria-label="精确证据标记"]')).toBeNull();
  });
  it('保存失败保留输入并展示服务端原因', async () => {
    vi.mocked(api.put).mockRejectedValue(new Error('验收端口超出授权范围'));
    await mount(); await click('修改目标'); await change('[aria-label="验收端口"]', '9999'); await click('保存目标');
    expect(container.textContent).toContain('验收端口超出授权范围');
    expect((container.querySelector('[aria-label="验收端口"]') as HTMLInputElement).value).toBe('9999');
  });
  it('旧任务可补配目标，已结束任务禁止编辑', async () => {
    vi.mocked(api.get).mockResolvedValue({ goal: null, configured: false, complete: false, checks: [], notes: ['旧任务未配置验收目标'] });
    await mount({ ...task, status: 'running' });
    expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
    await click('配置目标');
    expect((container.querySelector('[aria-label="验收目标"]') as HTMLInputElement).value).toBe(goal.targets[0]);
    await mount({ ...task, status: 'completed' });
    expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
