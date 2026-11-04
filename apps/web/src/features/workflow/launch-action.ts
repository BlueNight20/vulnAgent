import type { EngineSnapshot, TaskSummary } from '@vulnagent/shared';

/** start：待启动任务；resume：暂停/等待输入/停滞；rerun：终态任务需先重新运行。 */
export type LaunchAction = 'start' | 'resume' | 'rerun';

const ENGINE_ACTIVE = ['planning', 'executing'];
const ENGINE_RESUMABLE = ['paused', 'needs_input', 'stalled'];
const TERMINAL_TASKS = ['stopped', 'completed', 'failed'];

/**
 * 一个任务只有一个启动动作，且只发一个请求：
 * start 与 pause/resume/stop 共用后端持久化控制队列，重复或不匹配的请求只会得到 409。
 * snapshot 必须来自实时引擎快照；任务列表里的 status 只在快照缺失时兜底。
 */
export function resolveLaunchAction(
  snapshot: EngineSnapshot | null | undefined,
  task: Pick<TaskSummary, 'status'> | null | undefined,
): LaunchAction | null {
  if (isEngineActive(snapshot)) return null;
  const orchestratorStatus = snapshot?.orchestratorStatus;
  if (orchestratorStatus && ENGINE_RESUMABLE.includes(orchestratorStatus)) return 'resume';
  const taskStatus = snapshot ? snapshotTaskStatus(snapshot) : task?.status;
  if (taskStatus && TERMINAL_TASKS.includes(taskStatus)) return 'rerun';
  return 'start';
}

/** 快照的 engineStatus 是权威来源；缺失时用 orchestratorStatus 兜底。 */
function snapshotTaskStatus(snapshot: EngineSnapshot): string {
  return snapshot.engineStatus || snapshot.orchestratorStatus;
}

export function launchLabel(action: LaunchAction): string {
  if (action === 'resume') return '恢复引擎';
  if (action === 'rerun') return '先重新运行任务';
  return '启动引擎';
}

export function isEngineActive(snapshot: EngineSnapshot | null | undefined): boolean {
  return ENGINE_ACTIVE.includes(snapshot?.orchestratorStatus ?? '');
}
