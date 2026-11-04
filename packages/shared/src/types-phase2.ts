import type {
  EngineStatus,
  FactCategory,
  FactStatus,
  HypothesisLinkType,
  HypothesisStatus,
  IntentRejectReason,
  OrchestratorStatus,
  SessionState,
  StopReason,
  WorkerProfileId,
} from './enums-phase2';
import type { AgentRole, Severity, TaskStatus, WorkerTaskStatus } from './enums';

/* ============ Session ============ */

export interface SessionDto {
  id: string;
  taskId: string;
  role: AgentRole;
  profileId: WorkerProfileId | null;
  parentSessionId: string | null;
  sessionKey: string;
  modelName: string;
  state: SessionState;
  tokenInput: number;
  tokenOutput: number;
  costUsd: number;
  stateCard: StateCard | null;
  errorMessage: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  messageCount: number;
}

export interface StateCard {
  /** 当前正在处理的 Intent */
  currentIntentId?: string | null;
  currentIntentTitle?: string | null;
  /** 当前阶段（如「分析端口结果」） */
  phase?: string | null;
  /** 阻塞点 */
  blockedBy?: string | null;
  /** 已调用工具次数 */
  toolCallCount?: number;
  /** 最近一次工具名 */
  lastTool?: string | null;
  /** 计划步骤 */
  plan?: string[];
  updatedAt?: string;
}

export interface SessionMessageDto {
  id: string;
  sessionId: string;
  seq: number;
  role: 'system' | 'user' | 'assistant' | 'toolResult';
  /** 纯文本摘要，便于列表显示 */
  content: string;
  /** 完整结构化消息（恢复与详情用） */
  messageJson: Record<string, unknown> | null;
  toolCallId: string | null;
  toolName: string | null;
  usage: { input: number; output: number; cost: number } | null;
  createdAt: string;
}

export interface SessionEventDto {
  id: string;
  sessionId: string;
  taskId: string;
  type: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

/* ============ Worker Task ============ */

export interface WorkerTaskDto {
  id: string;
  taskId: string;
  sessionId: string | null;
  intentId: string | null;
  parentWorkerTaskId: string | null;
  title: string;
  profileId: WorkerProfileId | null;
  status: WorkerTaskStatus;
  attempt: number;
  maxAttempts: number;
  dedupeKey: string | null;
  timeoutSeconds: number;
  leaseExpiresAt: string | null;
  tokensSpent: number;
  evidenceIds: string[];
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  resultCardId: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

/* ============ Fact ============ */

export interface FactDto {
  id: string;
  taskId: string;
  agentSessionId: string | null;
  category: FactCategory;
  subject: string;
  predicate: string;
  object: string;
  status: FactStatus;
  confidence: number;
  sourceEvidenceIds: string[];
  createdBy: 'tool' | 'agent' | 'user';
  hypothesisIds: string[];
  createdAt: string;
}

/* ============ Intent ============ */

export interface IntentDto {
  id: string;
  taskId: string;
  agentSessionId: string | null;
  title: string;
  hypothesis: string;
  objective: string;
  rationale: string;
  prerequisites: string[];
  workerProfileId: WorkerProfileId;
  suggestedTools: string[];
  expectedEvidence: string[];
  targetIp: string | null;
  priority: number;
  score: number | null;
  scoreBreakdown: Record<string, number> | null;
  status: 'proposed' | 'dispatched' | 'done' | 'rejected';
  rejectedReason: IntentRejectReason | null;
  dedupeKey: string;
  dependencies: string[];
  factIds: string[];
  maxAttempts: number;
  attemptCount: number;
  dispatchCount: number;
  cycle: number;
  createdAt: string;
  updatedAt: string;
}

/* ============ Hint ============ */

export interface HintDto {
  id: string;
  taskId: string;
  agentSessionId: string | null;
  appliedToSessionId: string | null;
  content: string;
  status: 'pending' | 'consumed' | 'dismissed';
  consumedAt: string | null;
  createdAt: string;
}

/* ============ Hypothesis ============ */

export interface HypothesisDto {
  id: string;
  taskId: string;
  title: string;
  description: string;
  status: HypothesisStatus;
  severity: Severity | null;
  targetIp: string | null;
  factIds: string[];
  evidenceIds: string[];
  intentIds: string[];
  supportCount: number;
  contradictCount: number;
  confidence: number;
  createdBy: 'agent' | 'user' | 'planner';
  createdAt: string;
  updatedAt: string;
}

export interface HypothesisLinkDto {
  id: string;
  hypothesisId: string;
  linkType: HypothesisLinkType;
  targetType: 'fact' | 'evidence' | 'intent';
  targetId: string;
  note: string | null;
  createdAt: string;
}

/* ============ Worker Result Card ============ */

export interface WorkerResultCardDto {
  id: string;
  taskId: string;
  workerTaskId: string;
  sessionId: string;
  objective: string;
  summary: string;
  newFactIds: string[];
  supportedHypothesisIds: string[];
  refutedHypothesisIds: string[];
  evidenceIds: string[];
  openQuestions: string[];
  nextSteps: string[];
  tokensUsed: number;
  durationMs: number;
  synthetic: boolean;
  createdAt: string;
}

/* ============ Orchestrator ============ */

export interface EngineSnapshot {
  taskId: string;
  engineStatus: EngineStatus;
  orchestratorStatus: OrchestratorStatus;
  stopReason: StopReason | null;
  cycle: number;
  activeWorkers: number;
  totalWorkers: number;
  maxConcurrency: number;
  tokensUsed: number;
  tokenBudget: number;
  elapsedSeconds: number;
  timeBudgetSeconds: number;
  factCounts: Record<FactStatus, number>;
  intentCounts: Record<string, number>;
  plannerSessionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

/* ============ Workflow 真实图 ============ */

export interface WorkflowNodeDto {
  id: string;
  kind: 'orchestrator' | 'planner' | 'worker';
  label: string;
  role: AgentRole;
  profileId: WorkerProfileId | null;
  status: string;
  title: string;
  tokens: number;
  durationMs: number | null;
  evidenceCount: number;
  detail: Record<string, unknown>;
}

export interface WorkflowEdgeDto {
  id: string;
  source: string;
  target: string;
  kind: 'dependency' | 'evidence' | 'intent';
  label: string | null;
}

export interface WorkflowGraphDto {
  source: 'live';
  taskId: string;
  taskName: string;
  taskStatus: TaskStatus;
  engine: EngineSnapshot | null;
  nodes: WorkflowNodeDto[];
  edges: WorkflowEdgeDto[];
  generatedAt: string;
}

/* ============ 评分（可解释） ============ */

export interface ScoreBreakdown {
  /** 证据支持度 0..1 */
  evidenceSupport: number;
  /** 未知程度 0..1 */
  novelty: number;
  /** 潜在风险/价值 0..1 */
  impact: number;
  /** 依赖解锁价值 0..1 */
  unlockValue: number;
  /** 执行成本 0..1（越高越贵） */
  cost: number;
}

export interface ScoredIntent {
  intentId: string;
  score: number;
  breakdown: ScoreBreakdown;
  explanation: string;
}
