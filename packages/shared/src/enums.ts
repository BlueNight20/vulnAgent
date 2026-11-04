/** 任务状态（用户可见） */
export const TaskStatus = {
  Pending: 'pending',
  Running: 'running',
  Paused: 'paused',
  Stopped: 'stopped',
  Completed: 'completed',
  Failed: 'failed',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/** 执行引擎状态（与用户可见状态解耦） */
export const EngineStatus = {
  Idle: 'idle',
  Running: 'running',
  Paused: 'paused',
  Stalled: 'stalled',
  NeedsInput: 'needs_input',
  Stopped: 'stopped',
  Completed: 'completed',
  Failed: 'failed',
} as const;
export type EngineStatus = (typeof EngineStatus)[keyof typeof EngineStatus];

/** Orchestrator 内部状态机 */
export const OrchestratorStatus = {
  Idle: 'idle',
  Planning: 'planning',
  Executing: 'executing',
  Paused: 'paused',
  Stopping: 'stopping',
  Stopped: 'stopped',
  Stalled: 'stalled',
  NeedsInput: 'needs_input',
  Completed: 'completed',
  Failed: 'failed',
} as const;
export type OrchestratorStatus = (typeof OrchestratorStatus)[keyof typeof OrchestratorStatus];

export const StopReason = {
  GoalReached: 'goal_reached',
  NoProgress: 'no_progress',
  BudgetTokens: 'budget_tokens',
  BudgetTime: 'budget_time',
  MaxCycles: 'max_cycles',
  NeedsInput: 'needs_input',
  UserStopped: 'user_stopped',
  Error: 'error',
} as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

/** Session 生命周期状态 */
export const SessionState = {
  Created: 'created',
  Running: 'running',
  Paused: 'paused',
  Completed: 'completed',
  Failed: 'failed',
  Terminated: 'terminated',
} as const;
export type SessionState = (typeof SessionState)[keyof typeof SessionState];

/** Fact 四态：inferred < observed < verified，refuted 为推翻 */
export const FactStatus = {
  Inferred: 'inferred',
  Observed: 'observed',
  Verified: 'verified',
  Refuted: 'refuted',
} as const;
export type FactStatus = (typeof FactStatus)[keyof typeof FactStatus];

/**
 * 事实的观测类别，用于区分「目标的安全状态」与「探测过程失败」。
 * 这是防止把工具报错当成目标结论的关键字段。
 */
export const FactObservationKind = {
  /** 目标真实状态（端口开放、服务版本、目录存在等） */
  TargetState: 'target_state',
  /** 目标明确否定（连接被拒绝、端口关闭、文件不存在） */
  TargetNegative: 'target_negative',
  /** 探测过程失败（超时、工具报错、权限不足），不可推断目标状态 */
  ProbeError: 'probe_error',
  /** 模型推理，未经工具验证 */
  Inference: 'inference',
} as const;
export type FactObservationKind = (typeof FactObservationKind)[keyof typeof FactObservationKind];

export const FactCategory = {
  Asset: 'asset',
  Service: 'service',
  Technology: 'technology',
  Credential: 'credential',
  Vulnerability: 'vulnerability',
  Privilege: 'privilege',
  Network: 'network',
} as const;
export type FactCategory = (typeof FactCategory)[keyof typeof FactCategory];

export const IntentStatus = {
  Proposed: 'proposed',
  Dispatched: 'dispatched',
  Done: 'done',
  Rejected: 'rejected',
} as const;
export type IntentStatus = (typeof IntentStatus)[keyof typeof IntentStatus];

export const IntentRejectReason = {
  PlatformMaintenance: 'platform_maintenance',
  Superseded: 'superseded',
  QueueCapacity: 'queue_capacity',
  Duplicate: 'duplicate',
  OutOfScope: 'out_of_scope',
  ToolNotAllowed: 'tool_not_allowed',
  Prerequisite: 'prerequisite',
  Budget: 'budget',
  Manual: 'manual',
} as const;
export type IntentRejectReason = (typeof IntentRejectReason)[keyof typeof IntentRejectReason];

export const HypothesisStatus = {
  Proposed: 'proposed',
  Supported: 'supported',
  Refuted: 'refuted',
} as const;
export type HypothesisStatus = (typeof HypothesisStatus)[keyof typeof HypothesisStatus];

export const HypothesisLinkType = {
  Supports: 'supports',
  Contradicts: 'contradicts',
  DependsOn: 'depends_on',
  Refines: 'refines',
} as const;
export type HypothesisLinkType = (typeof HypothesisLinkType)[keyof typeof HypothesisLinkType];

export const HintStatus = {
  Pending: 'pending',
  Consumed: 'consumed',
  Dismissed: 'dismissed',
} as const;
export type HintStatus = (typeof HintStatus)[keyof typeof HintStatus];

export const WorkerTaskStatus = {
  Queued: 'queued',
  Running: 'running',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Timeout: 'timeout',
  Cancelled: 'cancelled',
  Deduplicated: 'deduplicated',
} as const;
export type WorkerTaskStatus = (typeof WorkerTaskStatus)[keyof typeof WorkerTaskStatus];

/** Worker 专业能力档案（动态加载，不是固定 Agent） */
export const WorkerProfileId = {
  Recon: 'recon',
  Web: 'web',
  Service: 'service',
  LinuxAudit: 'linux-audit',
  VulnAnalysis: 'vuln-analysis',
  Verification: 'verification',
} as const;
export type WorkerProfileId = (typeof WorkerProfileId)[keyof typeof WorkerProfileId];

/** 漏洞候选状态 */
export const FindingStatus = {
  Refuted: 'refuted',
  Candidate: 'candidate',
  Verifying: 'verifying',
  Confirmed: 'confirmed',
  Unconfirmed: 'unconfirmed',
} as const;
export type FindingStatus = (typeof FindingStatus)[keyof typeof FindingStatus];

export const Severity = {
  Critical: 'critical',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
  Info: 'info',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export const AgentRole = {
  Orchestrator: 'orchestrator',
  Planner: 'planner',
  Bootstrap: 'bootstrap',
  Explore: 'explore',
  Analysis: 'analysis',
  Verifier: 'verifier',
  Reporter: 'reporter',
} as const;
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

export const WorkerTaskKind = {
  Bootstrap: 'bootstrap',
  Explore: 'explore',
  Analysis: 'analysis',
  Verify: 'verify',
  Report: 'report',
} as const;
export type WorkerTaskKind = (typeof WorkerTaskKind)[keyof typeof WorkerTaskKind];

export const AgentSessionStatus = SessionState;
export type AgentSessionStatus = SessionState;

export const McpServerStatus = {
  Unknown: 'unknown',
  Online: 'online',
  Unreachable: 'unreachable',
  Error: 'error',
} as const;
export type McpServerStatus = (typeof McpServerStatus)[keyof typeof McpServerStatus];

export const McpTransport = {
  StreamableHttp: 'streamable-http',
  Sse: 'sse',
  Stdio: 'stdio',
} as const;
export type McpTransport = (typeof McpTransport)[keyof typeof McpTransport];

export const ToolRiskLevel = {
  Safe: 'safe',
  Intrusive: 'intrusive',
  Destructive: 'destructive',
} as const;
export type ToolRiskLevel = (typeof ToolRiskLevel)[keyof typeof ToolRiskLevel];

export const ToolCallDecision = {
  Allow: 'allow',
  Deny: 'deny',
  PendingApproval: 'pending_approval',
} as const;
export type ToolCallDecision = (typeof ToolCallDecision)[keyof typeof ToolCallDecision];

/**
 * 工具调用失败原因分类。
 * 与 ToolCallStatus 互补：status 表示结果，failureKind 表示**为什么失败**。
 * 关键用途：probe 类失败不得被当作目标状态事实。
 */
export const ToolFailureKind = {
  BudgetExceeded: 'budget_exceeded',
  InvalidInput: 'invalid_input',
  WorkloadLimit: 'workload_limit',
  RetryLimit: 'retry_limit',
  Cancelled: 'cancelled',
  /** MCP 握手未完成（服务未就绪/协议不兼容） */
  HandshakeFailed: 'handshake_failed',
  /** 连接被拒绝或网络不可达 */
  ConnectionFailed: 'connection_failed',
  /** 工具开始执行但超时 */
  ExecTimeout: 'exec_timeout',
  /** 服务端返回错误 */
  ServerError: 'server_error',
  /** 被权限策略拒绝 */
  PermissionDenied: 'permission_denied',
  /** 目标不在授权范围 */
  UnauthorisedTarget: 'unauthorised_target',
  /** 执行成功但无有效输出 */
  EmptyResult: 'empty_result',
  /** 未分类 */
  Unknown: 'unknown',
} as const;
export type ToolFailureKind = (typeof ToolFailureKind)[keyof typeof ToolFailureKind];

export const ToolCallStatus = {
  Success: 'success',
  Error: 'error',
  Denied: 'denied',
  Timeout: 'timeout',
  /** 等待人工审批，尚未执行 */
  PendingApproval: 'pending_approval',
  /** 审批被拒绝 */
  Rejected: 'rejected',
  /** 审批超时未处理 */
  Expired: 'expired',
  /** 已取消（引擎停止） */
  Cancelled: 'cancelled',
} as const;
export type ToolCallStatus = (typeof ToolCallStatus)[keyof typeof ToolCallStatus];

/** 审批状态机（纯数据，供最终判定使用） */
export const ApprovalOutcome = {
  Approved: 'approved',
  Rejected: 'rejected',
  Expired: 'expired',
} as const;
export type ApprovalOutcome = (typeof ApprovalOutcome)[keyof typeof ApprovalOutcome];

export const EvidenceKind = {
  CommandOutput: 'command_output',
  HttpResponse: 'http_response',
  Screenshot: 'screenshot',
  Pcap: 'pcap',
  File: 'file',
  Note: 'note',
} as const;
export type EvidenceKind = (typeof EvidenceKind)[keyof typeof EvidenceKind];

export const ReportFormat = {
  Markdown: 'markdown',
  Pdf: 'pdf',
} as const;
export type ReportFormat = (typeof ReportFormat)[keyof typeof ReportFormat];

export const ReportStatus = {
  Draft: 'draft',
  Generating: 'generating',
  Ready: 'ready',
  Failed: 'failed',
} as const;
export type ReportStatus = (typeof ReportStatus)[keyof typeof ReportStatus];

export const ServiceHealthKind = {
  Mcp: 'mcp',
  Api: 'api',
  Database: 'database',
} as const;
export type ServiceHealthKind = (typeof ServiceHealthKind)[keyof typeof ServiceHealthKind];

export const ServiceStatus = {
  Online: 'online',
  Offline: 'offline',
  Unknown: 'unknown',
} as const;
export type ServiceStatus = (typeof ServiceStatus)[keyof typeof ServiceStatus];
