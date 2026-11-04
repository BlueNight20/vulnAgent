import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataMaintenancePlan, DataMaintenanceResult, DataRetentionPolicy } from '@vulnagent/shared';
import { DataMaintenancePanel } from './data-maintenance-panel';
import { api } from '../../api/client';
vi.mock('../../api/client', () => ({ api: { post: vi.fn() } }));
let container: HTMLDivElement; let root: Root; let client: QueryClient;
const plan: DataMaintenancePlan = { policy: { before: '2025-01-01T00:00:00.000Z', keepLatest: 2, includeOrphans: true, page: 1 }, expiresAt: '2030-01-01T00:00:00Z', digest: 'a'.repeat(64), backupAvailable: true,
  tasks: [{ taskId: 'old', name: '<img src="https://unfetched.invalid/pixel">旧任务', finishedAt: '2020-01-01T00:00:00Z', rows: { evidence: 1, evidence_attachments: 1 }, blockedReason: null }, { taskId: 'blocked', name: '阻塞任务', finishedAt: '2020-02-01T00:00:00Z', rows: { tool_calls: 1 }, blockedReason: '审批结果待核实' }],
  orphans: [{ taskId: 'missing', name: null, finishedAt: null, rows: { facts: 2 }, blockedReason: null }], taskCandidates: 101, orphanCandidates: 1, pageSize: 100, warnings: ['会删除整项任务及证据；执行前备份，保留审计。'] };
const result: DataMaintenanceResult = { deletedTasks: ['old'], cleanedOrphanTasks: ['missing'], backup: { path: 'D:/fixture/backups/verified', sha256: 'b'.repeat(64), bytes: 100 }, auditId: 'audit-id' };
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); }
async function mount() { await act(async () => root.render(<QueryClientProvider client={client}><DataMaintenancePanel /></QueryClientProvider>)); await flush(); }
async function input(label: string, value: string) { const node = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function click(text: string) { await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === text)!.click()); await flush(); }
async function preview() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await flush(); }
function applyButton() { return Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '备份并清理本页'); }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  vi.mocked(api.post).mockImplementation(async (url, body) => url.endsWith('/preview') ? { ...plan, policy: body as DataRetentionPolicy } : result);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.resetAllMocks(); });
describe('数据保留维护', () => {
  it('挂载不发请求，预览列明阻塞和数据范围，明确确认后才提交完整凭据并展示备份', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries'); await mount(); expect(api.post).not.toHaveBeenCalled();
    await input('清理截止时间 UTC', '2025-01-01T00:00'); await input('保留终态任务数量', '2');
    await act(async () => (container.querySelector('[aria-label="包含父任务缺失记录"]') as HTMLInputElement).click()); await preview();
    expect(api.post).toHaveBeenCalledWith('/maintenance/preview', plan.policy);
    expect(container.textContent).toContain('审批结果待核实'); expect(container.textContent).toContain('evidence_attachments: 1'); expect(container.querySelector('img')).toBeNull(); expect(applyButton()?.disabled).toBe(true);
    await input('清理确认文字', '清理这些数据'); expect(applyButton()?.disabled).toBe(false);
    await click('备份并清理本页');
    expect(api.post).toHaveBeenLastCalledWith('/maintenance/apply', { ...plan.policy, digest: plan.digest, expiresAt: plan.expiresAt, confirmation: '清理这些数据' });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('清理已提交'); expect(container.textContent).toContain(result.backup.path); expect(container.textContent).toContain(result.backup.sha256); expect(container.textContent).toContain('audit-id');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks'] }); expect(applyButton()).toBeUndefined();
  });
  it('修改策略会丢弃旧预览和确认，不能沿用旧凭据执行', async () => {
    await mount(); await preview(); await input('清理确认文字', '清理这些数据');
    await input('保留终态任务数量', '3'); expect(applyButton()).toBeUndefined(); expect(container.querySelector('[aria-label="清理确认文字"]')).toBeNull();
    await preview(); expect(api.post).toHaveBeenLastCalledWith('/maintenance/preview', expect.objectContaining({ keepLatest: 3, page: 1 }));
    expect((container.querySelector('[aria-label="清理确认文字"]') as HTMLInputElement).value).toBe(''); expect(applyButton()?.disabled).toBe(true);
    expect(vi.mocked(api.post).mock.calls.every(([url]) => url.endsWith('/preview'))).toBe(true);
  });
  it('数据库变化等执行错误可见，清掉凭据和确认，不自动重试或显示成功', async () => {
    vi.mocked(api.post).mockImplementation(async (url, body) => { if (url.endsWith('/apply')) throw new Error('数据库已变化，请重新预览'); return { ...plan, policy: body as DataRetentionPolicy }; });
    await mount(); await preview(); await input('清理确认文字', '清理这些数据'); await click('备份并清理本页'); await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('数据库已变化'); expect(container.querySelector('[role="status"]')).toBeNull(); expect(applyButton()).toBeUndefined();
    expect(api.post).toHaveBeenCalledTimes(2); expect(container.textContent).not.toContain(result.backup.path);
  });
  it('翻页重置确认，内存库或没有可清理项时不允许执行', async () => {
    vi.mocked(api.post).mockImplementation(async (_url, body) => {
      const policy = body as DataRetentionPolicy;
      return policy.page === 1 ? { ...plan, policy } : { ...plan, policy, backupAvailable: false, tasks: [plan.tasks[1]], orphans: [] };
    });
    await mount(); await preview(); await input('清理确认文字', '清理这些数据'); await click('清理下一页');
    expect(api.post).toHaveBeenLastCalledWith('/maintenance/preview', expect.objectContaining({ page: 2 }));
    expect((container.querySelector('[aria-label="清理确认文字"]') as HTMLInputElement).value).toBe(''); expect(container.textContent).toContain('不能执行清理');
    await input('清理确认文字', '清理这些数据'); expect(applyButton()?.disabled).toBe(true); expect(vi.mocked(api.post).mock.calls.some(([url]) => url.endsWith('/apply'))).toBe(false);
  });
});
