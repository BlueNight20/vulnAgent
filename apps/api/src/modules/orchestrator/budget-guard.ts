import type { StopReason } from '@vulnagent/shared';

export interface BudgetState {
  tokensCommitted?: number;
  tokensUsed: number;
  tokenBudget: number;
  startedAt: Date | null;
  timeBudgetMinutes: number;
  /** 预留：为最终报告生成保留的 Token 比例 */
  reserveRatio?: number;
}

export interface BudgetCheck {
  exhausted: boolean;
  reason: StopReason | null;
  tokensLeft: number;
  minutesLeft: number;
  detail: string;
}

/**
 * 预算守卫：Token 与时间双阈值，覆盖 Planner 与全部 Worker。
 * reserveRatio 保证不会因为 Worker 耗尽预算而无法产出最终结论。
 */
export function checkBudget(state: BudgetState, now = new Date()): BudgetCheck {
  const reserveRatio = state.reserveRatio ?? 0.1;
  const usable = state.tokenBudget * (1 - reserveRatio);
  const charged = state.tokensUsed + (state.tokensCommitted ?? 0);
  const tokensLeft = Math.max(0, Math.floor(usable - charged));

  const elapsedMs = state.startedAt ? now.getTime() - state.startedAt.getTime() : 0;
  const elapsedMinutes = elapsedMs / 60_000;
  const minutesLeft = Math.max(0, state.timeBudgetMinutes - elapsedMinutes);

  if (charged >= usable) {
    return {
      exhausted: true,
      reason: 'budget_tokens',
      tokensLeft: 0,
      minutesLeft,
      detail: `已使用 ${state.tokensUsed}，在途/未确认占用 ${state.tokensCommitted ?? 0} / 可用 ${Math.floor(usable)} tokens（预留 ${Math.round(
        state.tokenBudget * reserveRatio,
      )} 用于总结）`,
    };
  }

  if (elevatedTime(state, elapsedMinutes)) {
    return {
      exhausted: true,
      reason: 'budget_time',
      tokensLeft,
      minutesLeft: 0,
      detail: `已用 ${elapsedMinutes.toFixed(1)} 分钟，超过时间预算 ${state.timeBudgetMinutes} 分钟`,
    };
  }

  return {
    exhausted: false,
    reason: null,
    tokensLeft,
    minutesLeft,
    detail: `剩余 ${tokensLeft} tokens / ${minutesLeft.toFixed(1)} 分钟`,
  };
}

function elevatedTime(state: BudgetState, elapsedMinutes: number): boolean {
  return elapsedMinutes >= state.timeBudgetMinutes;
}

/** 是否为单个 Worker 分配足够的预算余量 */
export function canAffordWorker(
  budget: BudgetCheck,
  estimatedWorkerTokens: number,
  reserveForOthers = 0,
): boolean {
  return budget.tokensLeft - reserveForOthers >= estimatedWorkerTokens;
}

/** 估算一个 Worker 任务允许的 Token 上限（任务预算份额 vs 剩余预算取小） */
export function workerTokenAllowance(
  budget: BudgetCheck,
  shareRatio: number,
  tokenBudget: number,
): number {
  const share = Math.floor(tokenBudget * shareRatio);
  return Math.max(0, Math.min(share, budget.tokensLeft));
}
