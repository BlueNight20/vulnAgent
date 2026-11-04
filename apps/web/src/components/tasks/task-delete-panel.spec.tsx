import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskSummary } from '@vulnagent/shared';
import { TaskDeletePanel } from './task-delete-panel';
import { tasksApi } from '../../api/tasks';
vi.mock('../../api/tasks', () => ({ tasksApi: { remove: vi.fn() } }));
let container: HTMLDivElement; let root: Root; let client: QueryClient;
const onDeleted = vi.fn();
const task = { id: 'task-id', name: '授权实验任务', status: 'stopped' } as TaskSummary;
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); }
async function mount(value = task) { await act(async () => root.render(<QueryClientProvider client={client}><TaskDeletePanel task={value} onDeleted={onDeleted} /></QueryClientProvider>)); }
async function confirm() {
  await act(async () => {
    const input = container.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, task.name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.resetAllMocks(); });
describe('任务删除', () => {
  it('显示删除范围，名称确认后才发出请求；成功关闭详情并刷新数据', async () => {
    vi.mocked(tasksApi.remove).mockResolvedValue({ deleted: true });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await mount(); expect(container.textContent).toContain('包括二进制附件');
    expect(container.querySelector('button')?.disabled).toBe(true);
    expect(tasksApi.remove).not.toHaveBeenCalled();
    await confirm(); expect(container.querySelector('button')?.disabled).toBe(false);
    await act(async () => container.querySelector('button')!.click()); await flush();
    expect(tasksApi.remove).toHaveBeenCalledWith('task-id'); expect(onDeleted).toHaveBeenCalledOnce(); expect(invalidate).toHaveBeenCalled();
  });
  it('运行中隐藏删除操作', async () => {
    await mount({ ...task, status: 'running' });
    expect(container.textContent).toContain('先停止任务'); expect(container.querySelector('button')).toBeNull();
  });
  it('未完成审批或其他服务端错误保留名称并提示，不关闭详情', async () => {
    vi.mocked(tasksApi.remove).mockRejectedValue(new Error('仍有待审批或结果待核实的调用'));
    await mount(); await confirm(); await act(async () => container.querySelector('button')!.click()); await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('结果待核实');
    expect(container.querySelector('input')?.value).toBe(task.name); expect(onDeleted).not.toHaveBeenCalled();
  });
});
