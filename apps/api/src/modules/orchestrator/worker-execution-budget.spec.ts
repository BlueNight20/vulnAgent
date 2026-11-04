import { describe, expect, it } from 'vitest';
import { WorkerExecutionBudget, WORKER_MAX_TOOL_CALLS } from './worker-execution-budget';

describe('Worker 确定性停止条件', () => {
  it('累计调用上限跨工具生效，不允许第 25 次执行', () => {
    const budget = new WorkerExecutionBudget();
    for (let i = 0; i < WORKER_MAX_TOOL_CALLS; i++) { expect(budget.begin()).toBeNull(); budget.record({ ok: true }); }
    expect(budget.begin()).toContain('24'); expect(budget.calls).toBe(24);
  });
  it('三个连续失败结束 Worker；成功重置失败计数，审批等待不算失败', () => {
    const budget = new WorkerExecutionBudget();
    for (let i = 0; i < 2; i++) { budget.begin(); budget.record({ ok: false }); }
    budget.begin(); budget.record({ ok: false, pendingApproval: true }); expect(budget.stopReason).toBeNull();
    budget.begin(); budget.record({ ok: true }); expect(budget.consecutiveFailures).toBe(0);
    for (let i = 0; i < 3; i++) { budget.begin(); budget.record({ ok: false }); }
    expect(budget.begin()).toContain('连续 3 次');
  });
});
