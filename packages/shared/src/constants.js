/** 任务状态中文标签 */
export const TASK_STATUS_LABEL = {
    pending: '待启动',
    running: '运行中',
    paused: '已暂停',
    stopped: '已停止',
    completed: '已完成',
    failed: '失败',
};
/** 任务状态机：可执行的动作 */
export const TASK_ACTIONS = ['pause', 'resume', 'stop', 'rerun'];
export const TASK_ACTION_LABEL = {
    pause: '暂停',
    resume: '恢复',
    stop: '停止',
    rerun: '重新运行',
};
/** 允许的状态迁移表 */
export const TASK_TRANSITIONS = {
    pause: ['running'],
    resume: ['paused'],
    stop: ['running', 'paused', 'pending'],
    rerun: ['stopped', 'completed', 'failed', 'pending', 'paused'],
};
export const TASK_ACTION_TARGET = {
    pause: 'paused',
    resume: 'running',
    stop: 'stopped',
    rerun: 'pending',
};
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const TASK_WORKER_COUNT_MAX = 8;
export const TASK_WORKER_COUNT_MIN = 1;
export const DEFAULT_WORKER_COUNT = 2;
export const DEFAULT_TOKEN_BUDGET = 200_000;
export const DEFAULT_TIME_BUDGET_MINUTES = 60;
