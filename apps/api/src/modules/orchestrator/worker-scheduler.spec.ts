import { describe, expect, it } from 'vitest';
import {
  decideRetry,
  isLeaseExpired,
  planDispatch,
  type SchedulableIntent,
} from './worker-scheduler';

const makeIntent = (id: string, score: number, over: Partial<SchedulableIntent> = {}): SchedulableIntent => ({
  id,
  title: `intent-${id}`,
  targetIp: '192.168.56.101',
  suggestedTools: ['nmap_scan'],
  score,
  breakdown: { evidenceSupport: 0, novelty: 1, impact: 1, unlockValue: 0, cost: 0 },
  priority: 50,
  createdAt: '2026-11-01T00:00:00.000Z',
  workerProfileId: 'recon',
  dedupeKey: `key-${id}`,
  ...over,
});

describe('Worker 调度', () => {
  it('按评分降序派发', () => {
    const decision = planDispatch([makeIntent('a', 0.4), makeIntent('b', 0.9), makeIntent('c', 0.6)], {
      maxConcurrency: 2,
      runningWorkers: 0,
      estimatedTokensPerWorker: 1000,
      tokensLeft: 100_000,
    });
    expect(decision.dispatch.map((i) => i.id)).toEqual(['b', 'c']);
    expect(decision.deferred.map((i) => i.id)).toEqual(['a']);
  });

  it('遵守并发上限', () => {
    const decision = planDispatch([makeIntent('a', 0.9), makeIntent('b', 0.8), makeIntent('c', 0.7)], {
      maxConcurrency: 2,
      runningWorkers: 1,
      estimatedTokensPerWorker: 1000,
      tokensLeft: 100_000,
    });
    expect(decision.dispatch).toHaveLength(1);
    expect(decision.slots).toBe(1);
  });

  it('并发已满时不派发', () => {
    const decision = planDispatch([makeIntent('a', 0.9)], {
      maxConcurrency: 2,
      runningWorkers: 2,
      estimatedTokensPerWorker: 1000,
      tokensLeft: 100_000,
    });
    expect(decision.dispatch).toHaveLength(0);
    expect(decision.deferred).toHaveLength(1);
  });

  it('预算不足时阻塞而非派发', () => {
    const decision = planDispatch([makeIntent('a', 0.9), makeIntent('b', 0.8)], {
      maxConcurrency: 2,
      runningWorkers: 0,
      estimatedTokensPerWorker: 60_000,
      tokensLeft: 80_000,
    });
    expect(decision.dispatch.map((i) => i.id)).toEqual(['a']);
    expect(decision.budgetBlocked.map((i) => i.id)).toEqual(['b']);
  });

  it('租约过期判定', () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    expect(isLeaseExpired(past)).toBe(true);
    expect(isLeaseExpired(future)).toBe(false);
    expect(isLeaseExpired(null)).toBe(false);
  });

  it('重试判定使用 attempt/maxAttempts', () => {
    expect(decideRetry(0, 2)).toBe('retry');
    expect(decideRetry(1, 2)).toBe('retry');
    expect(decideRetry(2, 2)).toBe('fail');
  });
});
