import type { TaskAction, TaskStatus } from '@vulnagent/shared';
import { TASK_ACTION_LABEL, TASK_ACTION_TARGET, TASK_TRANSITIONS } from '@vulnagent/shared';
import { ConflictException } from '@nestjs/common';

/**
 * 纯函数式任务状态机，便于单元测试。
 */
export function canApplyAction(current: TaskStatus, action: TaskAction): boolean {
  return TASK_TRANSITIONS[action]?.includes(current) ?? false;
}

export function nextStatus(current: TaskStatus, action: TaskAction): TaskStatus {
  if (!canApplyAction(current, action)) {
    throw new ConflictException(
      `当前状态「${current}」不支持「${TASK_ACTION_LABEL[action]}」操作`,
    );
  }
  return TASK_ACTION_TARGET[action];
}

export function availableActions(current: TaskStatus): TaskAction[] {
  return (Object.keys(TASK_TRANSITIONS) as TaskAction[]).filter((a) => canApplyAction(current, a));
}

/** 是否为终态 */
export function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}
