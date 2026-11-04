/**
 * 第二阶段新增枚举：引擎状态、编排状态、会话状态、事实四态、假设图、Worker 档案。
 */

/** 执行引擎状态（与用户可见的 TaskStatus 解耦） */
export const EngineStatus = {
  Idle: 'idle',
  Starting: 'starting',
  Running: 'running',
  Paused: 'paused',
  Stopping: 'stopping',
  Stopped: 'stopped',
  Completed: 'completed',
  Stalled: 'stalled',
  NeedsInput: 'needs_input',
  Failed: 'failed',
} as const;
export type EngineStatus = (typeof EngineStatus)[keyof typeof EngineStatus];

/** Orchestrator 运行状态 */
export const OrchestratorStatus = {
  Idle: 'idle',
  Planning: 'planning',
  Executing: 'executing',
  Paused: 'paused',
  Stopping: 'stopping',
  Stopped: 'stopped',
  Completed: 'completed',
  Stalled: 'stalled',
  NeedsInput: 'needs_input',
  Failed: 'failed',
} as const;
export type OrchestratorStatus = (typeof OrchestratorStatus)[keyof typeof OrchestratorStatus];

/** 停止原因 */
export const StopReason = {
  UserStopped: 'user_stopped',
  BudgetTokens: 'budget_tokens',
  BudgetTime: 'budget_time',
  NoProgress: 'no_progress',
  GoalReached: 'goal_reached',
  NeedsInput: 'needs_input',
  Error: 'error',
  MaxCycles: 'max_cycles',
} as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

/** 事实四态：模型推断不得直接成为 observed / verified */
export const FactStatus = {
  /** 模型推断，未经验证，不得作为漏洞证据 */
  Inferred: 'inferred',
  /** 有工具真实输出作为证据 */
  Observed: 'observed',
  /** 经过复核确认 */
  Verified: 'verified',
  /** 已被推翻 */
  Refuted: 'refuted',
} as const;
export type FactStatus = (typeof FactStatus)[keyof typeof FactStatus];

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

/** 攻击假设状态 */
export const HypothesisStatus = {
  Proposed: 'proposed',
  Supported: 'supported',
  Refuted: 'refuted',
  Confirmed: 'confirmed',
  Abandoned: 'abandoned',
} as const;
export type HypothesisStatus = (typeof HypothesisStatus)[keyof typeof HypothesisStatus];

/** 假设与事实/意图/证据的关联类型 */
export const HypothesisLinkType = {
  Supports: 'supports',
  Contradicts: 'contradicts',
  DependsOn: 'depends_on',
  Refines: 'refines',
  EvidencedBy: 'evidenced_by',
} as const;
export type HypothesisLinkType = (typeof HypothesisLinkType)[keyof typeof HypothesisLinkType];

/** Worker 专业能力档案 */
export const WorkerProfileId = {
  Recon: 'recon',
  Web: 'web',
  Service: 'service',
  LinuxAudit: 'linux-audit',
  VulnAnalysis: 'vuln-analysis',
  Verification: 'verification',
} as const;
export type WorkerProfileId = (typeof WorkerProfileId)[keyof typeof WorkerProfileId];

/** Session 运行状态 */
export const SessionState = {
  Created: 'created',
  Running: 'running',
  Paused: 'paused',
  Completed: 'completed',
  Failed: 'failed',
  Terminated: 'terminated',
} as const;
export type SessionState = (typeof SessionState)[keyof typeof SessionState];

/** Intent 状态（补充 rejected 原因枚举） */
export const IntentRejectReason = {
  Duplicate: 'duplicate',
  OutOfScope: 'out_of_scope',
  ToolNotAllowed: 'tool_not_allowed',
  Budget: 'budget',
  Prerequisite: 'prerequisite',
  Manual: 'manual',
  MaxAttempts: 'max_attempts',
} as const;
export type IntentRejectReason = (typeof IntentRejectReason)[keyof typeof IntentRejectReason];

/** 会话事件类型（用于 agent_session_events.type） */
export const SessionEventType = {
  AgentStart: 'agent_start',
  AgentEnd: 'agent_end',
  TurnStart: 'turn_start',
  TurnEnd: 'turn_end',
  MessageStart: 'message_start',
  MessageUpdate: 'message_update',
  MessageEnd: 'message_end',
  ToolExecutionStart: 'tool_execution_start',
  ToolExecutionUpdate: 'tool_execution_update',
  ToolExecutionEnd: 'tool_execution_end',
  /** 生命周期：创建/暂停/恢复/终止 */
  Lifecycle: 'lifecycle',
  /** 编排层事件：Intent 认领、结果卡写入等 */
  Orchestration: 'orchestration',
} as const;
export type SessionEventType = (typeof SessionEventType)[keyof typeof SessionEventType];
