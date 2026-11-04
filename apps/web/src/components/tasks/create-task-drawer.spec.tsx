import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsResponse } from '../../api/settings';
import { settingsApi } from '../../api/settings';
import { tasksApi } from '../../api/tasks';
import { CreateTaskDrawer } from './create-task-drawer';
vi.mock('../../api/settings', () => ({ settingsApi: { get: vi.fn() } }));
vi.mock('../../api/tasks', () => ({ tasksApi: { create: vi.fn() } }));
let root: Root; let container: HTMLDivElement; let client: QueryClient; let defaults: SettingsResponse;
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); }
async function render(open = true) { await act(async () => root.render(<QueryClientProvider client={client}><CreateTaskDrawer open={open} onClose={() => {}} /></QueryClientProvider>)); await flush(); }
function button(text: string) { return Array.from(document.querySelectorAll('button')).find((element) => element.textContent?.trim() === text)!; }
async function fill(selector: string, value: string) {
  await act(async () => { const field = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement; const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function next() { await act(async () => button('下一步').click()); await flush(); }
async function enterBudget() { await fill('input[placeholder="例如 VulnHub DC-1 信息收集"]', '配置读取测试'); await fill('textarea[placeholder="192.168.56.101"]', '192.0.2.10'); await next(); }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  defaults = { model: { provider: 'fixture-provider', baseUrl: 'http://unused.invalid', modelName: 'lab-model-v9', apiKeyMasked: '', apiKeyConfigured: true, temperature: 0.2, maxTokens: 2000 }, runtime: { piRuntimeEnabled: false, workerMaxConcurrency: 1, modelMaxConcurrency: 2, defaultTokenBudget: 17000, defaultTimeBudgetMinutes: 23, defaultWorkerCount: 3, logLevel: 'info', logToFile: false }, updatedAt: null, encryptionKeyEphemeral: false };
  vi.mocked(settingsApi.get).mockImplementation(async () => defaults); vi.mocked(tasksApi.create).mockRejectedValue(new Error('固定返回：仅检查请求内容'));
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.resetAllMocks(); });
describe('新任务配置', () => {
  it('使用真实保存模型和默认预算/数量，关闭的引擎默认不自动启动，不发送 custom 占位名', async () => {
    await render(); await enterBudget();
    expect((document.querySelector('[aria-label="任务模型"]') as HTMLSelectElement).value).toBe('lab-model-v9');
    expect((document.querySelector('[aria-label="任务 Token 预算"]') as HTMLInputElement).value).toBe('17000');
    expect((document.querySelector('[aria-label="任务时间预算"]') as HTMLInputElement).value).toBe('23'); await next();
    expect((document.querySelector('[aria-label="任务 Worker 数量"]') as HTMLInputElement).value).toBe('3');
    expect(document.querySelector('[aria-label="创建后立即开始"]')?.getAttribute('aria-checked')).toBe('false');
    await act(async () => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click()); await act(async () => button('创建任务').click()); await flush();
    expect(tasksApi.create).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'lab-model-v9', modelProvider: 'fixture-provider', tokenBudget: 17000, timeBudgetMinutes: 23, workerCount: 3, autoStart: false }));
  });
  it('后台刷新不覆盖草稿，关闭后重新打开等待新配置，而非先使用缓存旧值', async () => {
    await render(); await enterBudget(); await fill('[aria-label="任务 Token 预算"]', '25000');
    defaults = { ...defaults, model: { ...defaults.model, modelName: 'new-saved-model' }, runtime: { ...defaults.runtime, defaultTokenBudget: 44000 } };
    await act(async () => { client.setQueryData(['settings', 'task-defaults'], defaults); });
    expect((document.querySelector('[aria-label="任务 Token 预算"]') as HTMLInputElement).value).toBe('25000');
    expect((document.querySelector('[aria-label="任务模型"]') as HTMLSelectElement).value).toBe('lab-model-v9');
    await render(false);
    defaults = { ...defaults, model: { ...defaults.model, modelName: 'fresh-on-open' }, runtime: { ...defaults.runtime, defaultTokenBudget: 55000 } };
    await render(true); await enterBudget();
    expect((document.querySelector('[aria-label="任务 Token 预算"]') as HTMLInputElement).value).toBe('55000');
    expect((document.querySelector('[aria-label="任务模型"]') as HTMLSelectElement).value).toBe('fresh-on-open');
  });
  it('读取配置失败明确阻止填写与创建，重试成功后使用保存值', async () => {
    client.setQueryData(['settings', 'task-defaults'], defaults);
    vi.mocked(settingsApi.get).mockRejectedValueOnce(new Error('配置读取失败'));
    await render(); expect(document.body.textContent).toContain('配置读取失败'); expect(button('下一步')).toBeUndefined(); expect(tasksApi.create).not.toHaveBeenCalled();
    await act(async () => button('重试').click()); await flush(); await enterBudget();
    expect((document.querySelector('[aria-label="任务模型"]') as HTMLSelectElement).value).toBe('lab-model-v9');
  });
});
