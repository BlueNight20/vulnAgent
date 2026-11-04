export const WORKER_MAX_TOOL_CALLS = 24;
export const WORKER_MAX_CONSECUTIVE_FAILURES = 3;

/** Shared by all tool definitions in one Worker; a model cannot reset it by switching tools. */
export class WorkerExecutionBudget {
  calls = 0;
  consecutiveFailures = 0;
  stopReason: string | null = null;
  begin(): string | null {
    if (this.stopReason) return this.stopReason;
    if (this.calls >= WORKER_MAX_TOOL_CALLS) return this.stopReason = `Worker 达到 ${WORKER_MAX_TOOL_CALLS} 次工具调用上限，请重新规划剩余缺口`;
    this.calls++;
    return null;
  }
  record(result: { ok: boolean; pendingApproval?: boolean }): void {
    if (!result.pendingApproval) this.consecutiveFailures = result.ok ? 0 : this.consecutiveFailures + 1;
    if (this.consecutiveFailures >= WORKER_MAX_CONSECUTIVE_FAILURES) this.stopReason = `Worker 连续 ${this.consecutiveFailures} 次工具失败，停止本轮尝试并保留已获得证据`;
    else if (this.calls >= WORKER_MAX_TOOL_CALLS) this.stopReason = `Worker 达到 ${WORKER_MAX_TOOL_CALLS} 次工具调用上限，请重新规划剩余缺口`;
  }
}
