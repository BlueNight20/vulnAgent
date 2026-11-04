import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemSettingsDto } from '@vulnagent/shared';
import { SettingsPage } from './settings-page';
import { settingsApi } from '../../api/settings';
vi.mock('../../api/settings', () => ({ settingsApi: { get: vi.fn(), models: vi.fn(), update: vi.fn(), testModel: vi.fn() } }));
let root: Root; let container: HTMLDivElement; let client: QueryClient; let data: SystemSettingsDto;
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); }
async function mount() { await act(async () => root.render(<QueryClientProvider client={client}><SettingsPage /></QueryClientProvider>)); await flush(); }
async function clickSave() { await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('保存配置'))!.click()); await flush(); }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  data = { model: { provider: 'fixture', baseUrl: 'http://unused.invalid/v1', modelName: 'fixture', apiKeyMasked: '', apiKeyConfigured: false, temperature: 0.2, maxTokens: 2000 }, runtime: { piRuntimeEnabled: false, workerMaxConcurrency: 2, modelMaxConcurrency: 2, defaultTokenBudget: 10000, defaultTimeBudgetMinutes: 60, defaultWorkerCount: 2, logLevel: 'info', logToFile: false }, updatedAt: null };
  vi.mocked(settingsApi.get).mockImplementation(async () => ({ ...data, encryptionKeyEphemeral: false })); vi.mocked(settingsApi.models).mockResolvedValue({ items: [] });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.resetAllMocks(); });
describe('执行引擎设置', () => {
  it('日志文件开关仅改草稿，保存同时提交级别并显示实际输出状态', async () => {
    data.loggingStatus = { level: 'info', fileEnabled: false, directory: 'fixture-logs', activeFile: null, lastError: null };
    vi.mocked(settingsApi.update).mockImplementation(async (input) => {
      data = { ...data, runtime: { ...data.runtime, ...input.runtime }, loggingStatus: { level: input.runtime!.logLevel!, fileEnabled: input.runtime!.logToFile!, directory: 'fixture-logs', activeFile: 'fixture-logs/vulnagent.jsonl', lastError: null } };
      return data;
    });
    await mount();
    const fileSwitch = container.querySelector('[aria-label="保存运行日志到文件"]') as HTMLButtonElement;
    await act(async () => { fileSwitch.click(); const level = Array.from(container.querySelectorAll('select')).find((select) => Array.from(select.options).some((option) => option.value === 'warn'))!; level.value = 'warn'; level.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(settingsApi.update).not.toHaveBeenCalled(); expect(container.textContent).toContain('当前级别：info');
    await clickSave(); await flush();
    expect(settingsApi.update).toHaveBeenCalledWith(expect.objectContaining({ runtime: expect.objectContaining({ logLevel: 'warn', logToFile: true }) }));
    expect(container.textContent).toContain('当前级别：warn'); expect(container.textContent).toContain('fixture-logs/vulnagent.jsonl');
  });
  it('按实际设置显示关闭，切换只改草稿，保存才提交并重新读取', async () => {
    vi.mocked(settingsApi.update).mockImplementation(async (input) => { data = { ...data, runtime: { ...data.runtime, ...input.runtime } }; return data; });
    await mount(); const control = container.querySelector('[aria-label="启用执行引擎"]') as HTMLButtonElement;
    expect(control.getAttribute('aria-checked')).toBe('false'); expect(container.textContent).toContain('执行引擎已选择关闭'); expect(container.textContent).toContain('重新开启后须手动恢复');
    await act(async () => control.click()); expect(settingsApi.update).not.toHaveBeenCalled();
    await clickSave(); expect(settingsApi.update).toHaveBeenCalledWith(expect.objectContaining({ runtime: expect.objectContaining({ piRuntimeEnabled: true }) }));
    await flush(); expect(control.getAttribute('aria-checked')).toBe('true'); expect(container.textContent).not.toContain('第二阶段执行引擎默认开启');
  });
  it('保存失败明确提示，不能把草稿当作已生效配置', async () => {
    vi.mocked(settingsApi.update).mockRejectedValue(new Error('审计写入失败，设置未提交'));
    await mount(); await act(async () => (container.querySelector('[aria-label="启用执行引擎"]') as HTMLButtonElement).click()); await clickSave();
    expect(container.textContent).toContain('设置未提交'); expect(container.textContent).toContain('点击保存后生效'); expect(data.runtime.piRuntimeEnabled).toBe(false);
  });
});
