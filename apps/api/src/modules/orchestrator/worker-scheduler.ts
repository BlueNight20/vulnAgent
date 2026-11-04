import type { ScoreBreakdown } from '@vulnagent/shared';

export interface SchedulableIntent {
  id: string;
  title: string;
  targetIp: string | null;
  suggestedTools: string[];
  score: number;
  breakdown: ScoreBreakdown;
  priority: number;
  createdAt: string;
  workerProfileId: string;
  dedupeKey: string;
}

export interface ScheduleContext {
  maxConcurrency: number;
  runningWorkers: number;
  /** Worker 预计消耗的 Token */
  estimatedTokensPerWorker: number;
  tokensLeft: number;
}

export interface ScheduleDecision {
  dispatch: SchedulableIntent[];
  /** 因并发已满而等待的意图 */
  deferred: SchedulableIntent[];
  /** 因预算不足而等待的意图 */
  budgetBlocked: SchedulableIntent[];
  slots: number;
}

/**
 * Worker 调度（纯函数）：
 * 1. 按综合评分降序（分数相同按 priority 降序，再按创建时间升序）
 * 2. 受并发上限与剩余预算双重约束
 */
export function planDispatch(
  intents: SchedulableIntent[],
  ctx: ScheduleContext,
): ScheduleDecision {
  const sorted = [...intents].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.createdAt.localeCompare(b.createdAt);
  });

  const slots = Math.max(0, ctx.maxConcurrency - ctx.runningWorkers);
  const dispatch: SchedulableIntent[] = [];
  const deferred: SchedulableIntent[] = [];
  const budgetBlocked: SchedulableIntent[] = [];
  let budget = ctx.tokensLeft;

  for (const intent of sorted) {
    if (dispatch.length >= slots) {
      deferred.push(intent);
      continue;
    }
    if (ctx.estimatedTokensPerWorker > budget) {
      budgetBlocked.push(intent);
      continue;
    }
    budget -= ctx.estimatedTokensPerWorker;
    dispatch.push(intent);
  }

  return { dispatch, deferred, budgetBlocked, slots };
}

/** 超时回收判定 */
export function isLeaseExpired(leaseExpiresAt: Date | null, now = new Date()): boolean {
  if (!leaseExpiresAt) return false;
  return leaseExpiresAt.getTime() < now.getTime();
}

export type RetryDecision = 'retry' | 'fail';

/** 重试判定：使用 attempt 与 maxAttempts，不修改 dedupeKey */
export function decideRetry(attempt: number, maxAttempts: number): RetryDecision {
  return attempt < maxAttempts ? 'retry' : 'fail';
}
