/** 任务状态（用户可见） */
export const TaskStatus = {
    Pending: 'pending',
    Running: 'running',
    Paused: 'paused',
    Stopped: 'stopped',
    Completed: 'completed',
    Failed: 'failed',
};
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
};
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
};
export const StopReason = {
    GoalReached: 'goal_reached',
    NoProgress: 'no_progress',
    BudgetTokens: 'budget_tokens',
    BudgetTime: 'budget_time',
    MaxCycles: 'max_cycles',
    NeedsInput: 'needs_input',
    UserStopped: 'user_stopped',
    Error: 'error',
};
/** Session 生命周期状态 */
export const SessionState = {
    Created: 'created',
    Running: 'running',
    Paused: 'paused',
    Completed: 'completed',
    Failed: 'failed',
    Terminated: 'terminated',
};
/** Fact 四态：inferred < observed < verified，refuted 为推翻 */
export const FactStatus = {
    Inferred: 'inferred',
    Observed: 'observed',
    Verified: 'verified',
    Refuted: 'refuted',
};
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
};
export const FactCategory = {
    Asset: 'asset',
    Service: 'service',
    Technology: 'technology',
    Credential: 'credential',
    Vulnerability: 'vulnerability',
    Privilege: 'privilege',
    Network: 'network',
};
export const IntentStatus = {
    Proposed: 'proposed',
    Dispatched: 'dispatched',
    Done: 'done',
    Rejected: 'rejected',
};
export const IntentRejectReason = {
    Duplicate: 'duplicate',
    OutOfScope: 'out_of_scope',
    ToolNotAllowed: 'tool_not_allowed',
    Prerequisite: 'prerequisite',
    Budget: 'budget',
    Manual: 'manual',
};
export const HypothesisStatus = {
    Proposed: 'proposed',
    Supported: 'supported',
    Refuted: 'refuted',
};
export const HypothesisLinkType = {
    Supports: 'supports',
    Contradicts: 'contradicts',
    DependsOn: 'depends_on',
    Refines: 'refines',
};
export const HintStatus = {
    Pending: 'pending',
    Consumed: 'consumed',
    Dismissed: 'dismissed',
};
export const WorkerTaskStatus = {
    Queued: 'queued',
    Running: 'running',
    Succeeded: 'succeeded',
    Failed: 'failed',
    Timeout: 'timeout',
    Cancelled: 'cancelled',
    Deduplicated: 'deduplicated',
};
/** Worker 专业能力档案（动态加载，不是固定 Agent） */
export const WorkerProfileId = {
    Recon: 'recon',
    Web: 'web',
    Service: 'service',
    LinuxAudit: 'linux-audit',
    VulnAnalysis: 'vuln-analysis',
    Verification: 'verification',
};
/** 漏洞候选状态 */
export const FindingStatus = {
    Candidate: 'candidate',
    Verifying: 'verifying',
    Confirmed: 'confirmed',
    Unconfirmed: 'unconfirmed',
};
export const Severity = {
    Critical: 'critical',
    High: 'high',
    Medium: 'medium',
    Low: 'low',
    Info: 'info',
};
export const AgentRole = {
    Orchestrator: 'orchestrator',
    Planner: 'planner',
    Bootstrap: 'bootstrap',
    Explore: 'explore',
    Analysis: 'analysis',
    Verifier: 'verifier',
    Reporter: 'reporter',
};
export const WorkerTaskKind = {
    Bootstrap: 'bootstrap',
    Explore: 'explore',
    Analysis: 'analysis',
    Verify: 'verify',
    Report: 'report',
};
export const AgentSessionStatus = SessionState;
export const McpServerStatus = {
    Unknown: 'unknown',
    Online: 'online',
    Unreachable: 'unreachable',
    Error: 'error',
};
export const McpTransport = {
    StreamableHttp: 'streamable-http',
    Sse: 'sse',
};
export const ToolRiskLevel = {
    Safe: 'safe',
    Intrusive: 'intrusive',
    Destructive: 'destructive',
};
export const ToolCallDecision = {
    Allow: 'allow',
    Deny: 'deny',
    PendingApproval: 'pending_approval',
};
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
};
/** 审批状态机（纯数据，供最终判定使用） */
export const ApprovalOutcome = {
    Approved: 'approved',
    Rejected: 'rejected',
    Expired: 'expired',
};
export const EvidenceKind = {
    CommandOutput: 'command_output',
    HttpResponse: 'http_response',
    Screenshot: 'screenshot',
    Pcap: 'pcap',
    File: 'file',
    Note: 'note',
};
export const ReportFormat = {
    Markdown: 'markdown',
    Pdf: 'pdf',
};
export const ReportStatus = {
    Draft: 'draft',
    Generating: 'generating',
    Ready: 'ready',
    Failed: 'failed',
};
export const ServiceHealthKind = {
    Mcp: 'mcp',
    Api: 'api',
    Database: 'database',
};
export const ServiceStatus = {
    Online: 'online',
    Offline: 'offline',
    Unknown: 'unknown',
};
