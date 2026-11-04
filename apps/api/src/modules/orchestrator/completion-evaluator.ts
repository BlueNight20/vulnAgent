import type { TaskAcceptance, OrchestratorStatus, StopReason } from '@vulnagent/shared';

/**
 * 任务完成与停止条件判定（纯函数）。
 *
 * 设计原则：**不依赖模型自称完成**。
 * Planner 说 goal_reached 只是「候选」，必须由证据校验后才真正结束。
 */

export interface CompletionSignal {
  /** Planner 声明的目标状态 */
  plannerGoal: 'in_progress' | 'goal_reached' | 'needs_input' | 'blocked';
  /** 由后端按任务目标、工具原文和复核记录计算；不是 Planner 提供。 */
  acceptance: TaskAcceptance;
  /** 是否仍有未完成意图 */
  hasPendingIntents: boolean;
  /** 是否仍有活跃 Worker */
  hasActiveWorkers: boolean;
  /** 连续无进展轮数 */
  noProgressRounds: number;
  noProgressThreshold: number;
  /** 预算是否耗尽 */
  budgetExhausted: boolean;
  budgetReason?: 'budget_tokens' | 'budget_time';
}

export interface CompletionVerdict {
  /** 是否应该结束任务 */
  finish: boolean;
  /** 目标状态（finish=true 时有效） */
  status: OrchestratorStatus | null;
  reason: StopReason | null;
  /** 人类可读依据 */
  detail: string;
}

/**
 * 评估是否应当结束任务。
 * 优先级：预算 → 在途工作 → 验收目标 → Planner 声明与无进展 → 默认继续
 */
export function evaluateCompletion(signal: CompletionSignal): CompletionVerdict {
  if (signal.budgetExhausted) {
    return {
      finish: true,
      status: 'stopped',
      reason: signal.budgetReason ?? 'budget_tokens',
      detail: '预算已耗尽，任务停止',
    };
  }

  // 完成或阻塞声明都不能丢弃尚在执行的工作。
  if (signal.hasActiveWorkers || signal.hasPendingIntents) {
    return { finish: false, status: null, reason: null, detail: '仍有执行中或待执行的意图' };
  }

  if (!signal.acceptance.configured) return { finish: true, status: 'needs_input', reason: 'needs_input', detail: '任务尚未配置验收目标，请先明确范围与期望结果' };
  if (signal.acceptance.complete) return { finish: true, status: 'completed', reason: 'goal_reached', detail: '任务验收目标已逐项由实际证据满足' };
  if (signal.plannerGoal === 'goal_reached') return { finish: true, status: 'stalled', reason: 'no_progress', detail: `Planner 声称完成，但以下验收项未满足：${signal.acceptance.checks.filter((c) => !c.passed).map((c) => c.label).join('；')}` };

  // Planner 明确 blocked：不再静默忽略，转为 stalled 并保留原因
  if (signal.plannerGoal === 'blocked') {
    return {
      finish: true,
      status: 'stalled',
      reason: 'no_progress',
      detail: 'Planner 报告阻塞：无可行探索路径',
    };
  }

  // Planner 请求人工介入
  if (signal.plannerGoal === 'needs_input') {
    return {
      finish: true,
      status: 'needs_input',
      reason: 'needs_input',
      detail: 'Planner 请求人工介入',
    };
  }

  // 连续无进展
  if (
    signal.noProgressRounds >= signal.noProgressThreshold &&
    !signal.hasActiveWorkers &&
    !signal.hasPendingIntents
  ) {
    return {
      finish: true,
      status: 'stalled',
      reason: 'no_progress',
      detail: `连续 ${signal.noProgressRounds} 轮无新增证据支撑的知识变化（含有效反证）`,
    };
  }

  return { finish: false, status: null, reason: null, detail: '继续探索' };
}

/** 是否允许在 stalled 状态下由用户恢复继续探索 */
export function canResumeFrom(status: OrchestratorStatus): boolean {
  return status === 'stalled' || status === 'needs_input' || status === 'paused';
}
