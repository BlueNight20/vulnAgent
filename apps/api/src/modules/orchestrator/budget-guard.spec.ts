import { describe, expect, it } from 'vitest';
import { canAffordWorker, checkBudget, workerTokenAllowance } from './budget-guard';

describe('预算守卫', () => {
  it('在途和未知额度参与预算，余额不足 1000 时不能凭空分配 Worker 额度', () => {
    const budget = checkBudget({ tokenBudget: 10000, tokensUsed: 8000, tokensCommitted: 800, startedAt: null, timeBudgetMinutes: 10 });
    expect(budget.tokensLeft).toBe(200);
    expect(workerTokenAllowance(budget, 0.2, 10000)).toBe(200);
    expect(checkBudget({ tokenBudget: 10000, tokensUsed: 8000, tokensCommitted: 1000, startedAt: null, timeBudgetMinutes: 10 }).exhausted).toBe(true);
  });
  const base = {
    tokensUsed: 0,
    tokenBudget: 100_000,
    startedAt: new Date('2026-11-01T00:00:00Z'),
    timeBudgetMinutes: 60,
    reserveRatio: 0.1,
  };

  it('初始状态未耗尽', () => {
    const result = checkBudget(base, new Date('2026-11-01T00:10:00Z'));
    expect(result.exhausted).toBe(false);
    expect(result.tokensLeft).toBe(90_000);
  });

  it('Token 达到可用上限时耗尽（保留 10% 给总结）', () => {
    const result = checkBudget(
      { ...base, tokensUsed: 90_000 },
      new Date('2026-11-01T00:05:00Z'),
    );
    expect(result.exhausted).toBe(true);
    expect(result.reason).toBe('budget_tokens');
  });

  it('时间超预算时耗尽', () => {
    const result = checkBudget(base, new Date('2026-11-01T01:30:00Z'));
    expect(result.exhausted).toBe(true);
    expect(result.reason).toBe('budget_time');
  });

  it('Token 与时间同时耗尽时优先报告 Token', () => {
    const result = checkBudget(
      { ...base, tokensUsed: 95_000 },
      new Date('2026-11-01T02:00:00Z'),
    );
    expect(result.reason).toBe('budget_tokens');
  });

  it('Worker 预算份额不超过剩余预算', () => {
    const check = checkBudget(base, new Date('2026-11-01T00:00:00Z'));
    expect(workerTokenAllowance(check, 0.25, 100_000)).toBe(25_000);

    const tight = checkBudget({ ...base, tokensUsed: 88_000 }, new Date('2026-11-01T00:00:00Z'));
    expect(workerTokenAllowance(tight, 0.25, 100_000)).toBe(2_000);
  });

  it('余额不足时不再派发 Worker', () => {
    const check = checkBudget({ ...base, tokensUsed: 85_000 }, new Date('2026-11-01T00:00:00Z'));
    expect(canAffordWorker(check, 10_000)).toBe(false);
    expect(canAffordWorker(check, 3_000)).toBe(true);
  });
});
