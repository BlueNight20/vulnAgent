import { BadRequestException } from '@nestjs/common';
import type { OrchestratorStatus, StopReason } from '@vulnagent/shared';

/**
 * Orchestrator 状态机（纯函数）。
 *
 * 关键设计：
 * - stalled 表示「连续多轮无进展」，与 completed（目标达成）严格区分
 * - needs_input 表示「需要人工介入」，仅由 Planner 显式声明或准入全部失败时进入
 */
export const ALLOWED_TRANSITIONS: Record<OrchestratorStatus, OrchestratorStatus[]> = {
  idle: ['planning', 'stopped', 'failed'],
  planning: ['executing', 'completed', 'stalled', 'needs_input', 'paused', 'stopping', 'failed'],
  executing: ['planning', 'paused', 'stopping', 'stalled', 'needs_input', 'failed'],
  paused: ['planning', 'executing', 'stopping', 'stopped'],
  stopping: ['stopped'],
  stalled: ['planning', 'completed', 'stopped', 'needs_input'],
  needs_input: ['planning', 'stopped', 'completed'],
  completed: [],
  stopped: [],
  failed: ['planning'],
};

/** 引擎终态：不再接受推进 */
export const TERMINAL_STATUSES: OrchestratorStatus[] = ['completed', 'stopped', 'failed'];

export function canTransition(from: OrchestratorStatus, to: OrchestratorStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: OrchestratorStatus, to: OrchestratorStatus): void {
  if (!canTransition(from, to)) {
    throw new BadRequestException(`编排状态不允许从 ${from} 变更为 ${to}`);
  }
}

export function isTerminal(status: OrchestratorStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Planner 声明的目标状态映射到编排状态 */
export function goalStatusToOrchestrator(
  goalStatus: 'in_progress' | 'goal_reached' | 'needs_input' | 'blocked',
): { status: OrchestratorStatus | null; reason: StopReason | null } {
  switch (goalStatus) {
    case 'goal_reached':
      return { status: 'completed', reason: 'goal_reached' };
    case 'needs_input':
      return { status: 'needs_input', reason: 'needs_input' };
    case 'blocked':
      return { status: 'stalled', reason: 'no_progress' };
    default:
      return { status: null, reason: null };
  }
}

/** 无进展判定：连续 N 轮没有新证据事实 */
export function shouldMarkStalled(noProgressRounds: number, threshold: number): boolean {
  return noProgressRounds >= threshold;
}
