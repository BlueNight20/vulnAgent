import type { EngineSnapshot, OrchestratorStatus, StopReason } from '@vulnagent/shared';

/** 进程内运行的编排上下文 */
export interface OrchestratorContext {
  taskId: string;
  runId: string;
  /** Invalidates asynchronous decisions made before a pause/resume/stop. */
  controlRevision?: number;
  capacityDeferred?: boolean;
  planRevision?: number;
  reviewedRevision?: number;
  lastPlanningCycle?: number;
  planningCount?: number;
  status: OrchestratorStatus;
  cycle: number;
  noProgressRounds: number;
  stopReason: StopReason | null;
  plannerSessionId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastError: string | null;
  /** 正在执行的 Worker：workerTaskId -> { sessionId, startedAt } */
  activeWorkers: Map<string, { sessionId: string; startedAt: number }>;
  /** Planner 调度中标记，防止并发触发 */
  plannerBusy: boolean;
  /** 已有循环在途（同一上下文只跑一个循环） */
  cycleScheduled?: boolean;
  /** 在途循环结束后是否还需要再跑一轮 */
  cyclePending?: boolean;
  /** 最近 Worker 收尾是否发现新的证据支撑知识（含反证） */
  cycleGainedEvidence: boolean;
  /** 本次运行已观察到的去重知识标识总数 */
  evidenceBaseline: number;
  /** Evidence-backed knowledge already observed during this run, including negative results. */
  knowledgeSeen?: Set<string>;
  /** Planner 可恢复错误的重试计数 */
  plannerRetries: number;
  /** 最近一次规划的 assistant 文本，用于结果卡 */
  lastPlannerText: string;
}

export type SnapshotBuilder = (ctx: OrchestratorContext) => Promise<EngineSnapshot>;
