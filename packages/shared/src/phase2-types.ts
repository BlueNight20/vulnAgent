import type {
  AgentRole,
  EvidenceKind,
  FactCategory,
  FactObservationKind,
  FactStatus,
  HintStatus,
  HypothesisLinkType,
  HypothesisStatus,
  IntentRejectReason,
  IntentStatus,
  OrchestratorStatus,
  Severity,
  SessionState,
  Severity as SeverityType,
  StopReason,
  ToolFailureKind,
  ToolRiskLevel,
  WorkerProfileId,
  WorkerTaskStatus,
} from './enums';

/** ===== Session ===== */

export interface StateCard {
  phase?: string;
  plan?: string[];
  currentIntentId?: string;
  currentIntentTitle?: string;
  toolCallCount?: number;
  blockers?: string[];
  updatedAt?: string;
}

export interface SessionDto {
  tokenAllowance?: number | null;
  tokensCommitted?: number;
  budgetManaged?: boolean;
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

export interface SessionMessageDto {
  id: string;
  sessionId: string;
  seq: number;
  role: string;
  content: string;
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

/** ===== Blackboard ===== */

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
  /** 溯源：产出该事实的工具 */
  sourceTool: string | null;
  /** 溯源：观测目标 */
  targetIp: string | null;
  /** 溯源：观测时间 */
  observedAt: string | null;
  /** 观测类别：区分目标状态与探测失败 */
  observationKind: FactObservationKind;
  /** 所属冲突组（同 subject+predicate 的不同取值共享） */
  conflictGroupId: string | null;
  conflictResolved: boolean;
  createdAt: string;
}

export interface ScoreBreakdown {
  evidenceSupport: number;
  novelty: number;
  impact: number;
  unlockValue: number;
  cost: number;
}

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
  score: number;
  scoreBreakdown: ScoreBreakdown | null;
  status: IntentStatus;
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
  /** 同时存在有效支持与反驳，不能由多数票消解。 */
  conflicted?: boolean;
  invalidLinkCount?: number;
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
  evidenceQuotes?: { evidenceId: string; quote: string }[];
  assessmentSource?: 'legacy' | 'agent' | 'user';
  agentSessionId?: string | null;
  validation?: 'valid' | 'invalid' | 'legacy' | 'stale';
  invalidReason?: string | null;
  counted?: boolean;
  createdAt: string;
}

export interface HintDto {
  id: string;
  taskId: string;
  agentSessionId: string | null;
  appliedToSessionId: string | null;
  content: string;
  status: HintStatus;
  consumedAt: string | null;
  createdAt: string;
}

export interface EvidenceRelationsDto {
  facts: Pick<FactDto, 'id' | 'subject' | 'predicate' | 'object' | 'status' | 'targetIp'>[];
  hypotheses: { hypothesis: HypothesisDto; links: HypothesisLinkDto[] }[];
  findings: { id: string; title: string; status: string; targetIp: string | null; verificationIds: string[] }[];
}

export interface WorkerTaskDto {
  id: string;
  taskId: string;
  sessionId: string | null;
  intentId: string | null;
  parentWorkerTaskId: string | null;
  title: string;
  profileId: WorkerProfileId;
  status: WorkerTaskStatus;
  attempt: number;
  maxAttempts: number;
  dedupeKey: string;
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

export interface EvidenceDto {
  id: string;
  taskId: string | null;
  agentSessionId: string | null;
  kind: EvidenceKind;
  title: string;
  mimeType: string | null;
  content: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

/** ===== Engine ===== */

export interface EngineSnapshot {
  globalWorkerLimit?: number;
  globalWorkersActive?: number;
  waitingForWorkerCapacity?: boolean;
  taskId: string;
  engineStatus: string;
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

/** ===== Workflow ===== */

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
  kind: 'dependency' | 'intent' | 'evidence';
  label: string | null;
}

export interface WorkflowGraphDto {
  source: 'live';
  taskId: string;
  taskName: string;
  taskStatus: string;
  engine: EngineSnapshot | null;
  nodes: WorkflowNodeDto[];
  edges: WorkflowEdgeDto[];
  generatedAt: string;
}

/** ===== 复用现有类型别名 ===== */
export type SeverityAlias = SeverityType;
export type ToolRiskLevelValue = ToolRiskLevel;

/** ===== 模型测试 ===== */

export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  httpStatus: number | null;
  outputPreview: string | null;
  modelName: string;
  tokensUsed: number;
  checkedAt: string;
}

/** ===== 工具审批 ===== */

export interface ApprovalRequestDto {
  id: string;
  taskId: string | null;
  sessionId: string | null;
  toolName: string;
  arguments: Record<string, unknown>;
  targetIp: string | null;
  riskLevel: ToolRiskLevel;
  reason: string | null;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  /** 当前 API 进程中的执行状态；重启后已批准的未收尾调用需要人工核实。 */
  executionState?: 'pending' | 'running' | 'needs_review' | 'resolved';
  replayOfId?: string | null;
}

export interface ToolCallDetailDto {
  id: string;
  taskId: string | null;
  sessionId: string | null;
  toolName: string;
  arguments: Record<string, unknown>;
  argumentsHash: string | null;
  targetIp: string | null;
  decision: string;
  decisionReason: string | null;
  status: string;
  latencyMs: number;
  errorMessage: string | null;
  /** 失败原因分类；成功时为 null */
  failureKind: ToolFailureKind | null;
  rawOutputRef: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  replayOfId: string | null;
  createdAt: string;
}

/** ===== 事实冲突 ===== */

export interface FactConflictDto {
  taskId: string;
  subject: string;
  predicate: string;
  /** 同一个 subject+predicate 下并存的不同 object */
  objects: Array<{
    factId: string;
    object: string;
    status: FactStatus;
    sourceTool: string | null;
    observedAt: string | null;
    evidenceIds: string[];
    confidence: number;
  }>;
  /** 是否已被人工/复核确认为某个取值 */
  resolved: boolean;
}
