import type {
  AgentRole,
  FactStatus,
  IntentRejectReason,
  OrchestratorStatus,
  SessionState,
  StopReason,
  WorkerProfileId,
  WorkerTaskStatus,
} from './enums';

/** 模型推断事实的置信度上限：超过此值必须由工具证据支撑 */
export const INFERRED_MAX_CONFIDENCE = 0.5;

/** 连续无进展轮数阈值，达到后进入 stalled 而不是 completed */
export const DEFAULT_NO_PROGRESS_ROUNDS = 3;

/** 单任务最大编排轮次，防止无限循环 */
export const DEFAULT_MAX_CYCLES = 40;

/** Worker 默认超时与重试 */
export const DEFAULT_WORKER_TIMEOUT_SECONDS = 420;
export const DEFAULT_WORKER_MAX_ATTEMPTS = 2;

/** 租约扫描间隔（超时回收） */
export const WORKER_LEASE_SCAN_INTERVAL_MS = 5000;

/** Planner 单实例锁的续租时间 */
export const PLANNER_LOCK_TTL_MS = 60_000;

export const MCP_STATUS_LABEL: Record<'unknown' | 'online' | 'unreachable' | 'error', string> = {
  unknown: '未检测',
  online: '在线',
  unreachable: '未连接',
  error: '异常',
};

export const FACT_STATUS_LABEL: Record<FactStatus, string> = {
  inferred: '推断',
  observed: '已观察',
  verified: '已验证',
  refuted: '已推翻',
};

export const FACT_CATEGORY_LABEL: Record<string, string> = {
  asset: '资产',
  service: '服务',
  technology: '技术栈',
  credential: '凭据',
  vulnerability: '漏洞',
  privilege: '权限',
  network: '网络',
};

export const SESSION_STATE_LABEL: Record<SessionState, string> = {
  created: '已创建',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  terminated: '已终止',
};

export const ORCHESTRATOR_STATUS_LABEL: Record<OrchestratorStatus, string> = {
  idle: '未启动',
  planning: '规划中',
  executing: '执行中',
  paused: '已暂停',
  stopping: '停止中',
  stopped: '已停止',
  stalled: '已停滞',
  needs_input: '需要介入',
  completed: '已完成',
  failed: '失败',
};

export const STOP_REASON_LABEL: Record<StopReason, string> = {
  goal_reached: '目标达成',
  no_progress: '无进展',
  budget_tokens: 'Token 预算耗尽',
  budget_time: '时间预算耗尽',
  max_cycles: '达到最大轮次',
  needs_input: '需要人工介入',
  user_stopped: '用户停止',
  error: '执行出错',
};

export const WORKER_STATUS_LABEL: Record<WorkerTaskStatus, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  timeout: '超时',
  cancelled: '已取消',
  deduplicated: '已去重',
};

export const WORKER_PROFILE_LABEL: Record<WorkerProfileId, string> = {
  recon: '侦察 Worker',
  web: 'Web 探测 Worker',
  service: '服务分析 Worker',
  'linux-audit': 'Linux 审计 Worker',
  'vuln-analysis': '漏洞分析 Worker',
  verification: '漏洞验证 Worker',
};

export const INTENT_REJECT_LABEL: Record<IntentRejectReason, string> = {
  platform_maintenance: '平台维护偏离测试目标',
  superseded: '新计划已替代',
  queue_capacity: '队列容量暂缓，待重新规划',
  duplicate: '重复意图',
  out_of_scope: '超出授权范围',
  tool_not_allowed: '工具未授权',
  prerequisite: '前置依赖未完成',
  budget: '预算不足',
  manual: '人工拒绝',
};

export const AGENT_ROLE_LABEL: Record<AgentRole, string> = {
  orchestrator: '主编排器',
  planner: '规划器',
  bootstrap: '初始化 Worker',
  explore: '探索 Worker',
  analysis: '分析 Worker',
  verifier: '验证 Worker',
  reporter: '报告 Worker',
};

export const ENGINE_PHASE_NOTICE = '执行引擎已接入：任务启动后将真实调用云端模型并协调 Planner 与 Worker。';

export const MCP_PERMISSION_NOTICE =
  '工具权限在每次调用及审批重放前校验；匹配的显式拒绝优先于授权，无匹配默认拒绝。高风险工具默认需人工审批；批准不豁免范围和最新权限。';

/** 每批只接纳短期可执行计划，剩余方向由后续规划重新评估。 */
export const MAX_PLANNER_INTENTS = 3;
