import type {
  AgentRole,
  FindingStatus,
  McpServerStatus,
  McpTransport,
  ServiceHealthKind,
  ServiceStatus,
  Severity,
  TaskStatus,
  ToolRiskLevel,
} from './enums';
import type {
  EngineSnapshot,
  FactDto,
  HypothesisDto,
  IntentDto,
  SessionDto,
  SessionEventDto,
  SessionMessageDto,
  WorkerTaskDto,
} from './types-phase2';

export interface TargetDto {
  id: string;
  taskId: string;
  ip: string;
  hostname: string | null;
  /** host：单主机/IP/域名/URL 目标；cidr：网段 */
  kind: 'host' | 'cidr';
  inScope: boolean;
  note: string | null;
}

export interface TaskScope {
  cidrs: string[];
  ports: string | null;
}

export interface TaskSummary {
  tokensCommitted?: number;
  goal: TaskGoal | null;
  id: string;
  name: string;
  status: TaskStatus;
  scope: TaskScope;
  modelProvider: string;
  modelName: string;
  tokenBudget: number;
  tokensUsed: number;
  costUsd: number;
  timeBudgetMinutes: number;
  workerCount: number;
  progress: number;
  currentPhase: string | null;
  targetIps: string[];
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends TaskSummary {
  description: string | null;
  authorizationRef: string | null;
  targets: TargetDto[];
}

export interface TaskListResult {
  items: TaskSummary[];
  total: number;
  stats: Record<string, number>;
}

export interface CreateTargetInput {
  ip: string;
  note?: string | null;
}

export interface CreateTaskInput {
  goal?: TaskGoalInput;
  name: string;
  description?: string | null;
  targets: CreateTargetInput[];
  scope: TaskScope;
  authorizationRef?: string | null;
  authorized: boolean;
  modelProvider: string;
  modelName: string;
  tokenBudget: number;
  timeBudgetMinutes: number;
  workerCount: number;
}

export interface ServiceHealthItem {
  name: string;
  kind: ServiceHealthKind;
  status: ServiceStatus;
  latencyMs: number | null;
  detail: string;
  checkedAt: string;
}

export interface DashboardSummary {
  tasks: {
    total: number;
    running: number;
    pending: number;
    paused: number;
    stopped: number;
    completed: number;
    failed: number;
  };
  findings: {
    total: number;
    candidate: number;
    verifying: number;
    confirmed: number;
    unconfirmed: number;
    refuted: number;
  };
  usage: {
    tokens: number;
    costUsd: number;
  };
  services: ServiceHealthItem[];
  recentTasks: TaskSummary[];
}

export interface UsageTrendPoint {
  date: string;
  tokens: number;
  costUsd: number;
}

export interface UsageTrend {
  points: UsageTrendPoint[];
}

export interface McpServerDto {
  id: string;
  name: string;
  endpoint: string;
  transport: McpTransport;
  enabled: boolean;
  headersMasked: string | null;
  status: McpServerStatus;
  lastCheckedAt: string | null;
  latencyMs: number | null;
  toolCount: number;
  lastError: string | null;
  source: 'env' | 'manual';
}

export interface McpToolDto {
  id: string;
  serverId: string;
  serverName: string;
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
  syncedAt: string;
  paramCount: number;
}

export interface McpHealthCheckResult {
  serverId: string;
  name: string;
  endpoint: string;
  status: McpServerStatus;
  latencyMs: number | null;
  toolCount: number;
  lastError: string | null;
  checkedAt: string;
  cached: boolean;
}

export interface McpPermissionDto {
  id: string;
  taskId: string | null;
  agentRole: AgentRole;
  toolPattern: string;
  allowed: boolean;
  requireApproval: boolean;
}

export interface McpCallDto {
  id: string;
  taskId: string | null;
  agentSessionId: string | null;
  toolName: string;
  targetIp: string | null;
  decision: string;
  decisionReason: string | null;
  status: string;
  latencyMs: number;
  /** 工具入参（原样，未截断）：执行记录页展开查看 */
  arguments: Record<string, unknown>;
  /** 成功调用的原始输出证据 ID */
  rawOutputRef: string | null;
  failureKind: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface McpPermissionMatrix {
  roles: AgentRole[];
  tools: { name: string; serverName: string; riskLevel: ToolRiskLevel }[];
  permissions: McpPermissionDto[];
  notice: string;
}

export interface ModelSettings {
  provider: string;
  baseUrl: string;
  modelName: string;
  apiKeyMasked: string | null;
  apiKeyConfigured: boolean;
  temperature: number;
  maxTokens: number;
}

export interface RuntimeSettings {
  piRuntimeEnabled: boolean;
  workerMaxConcurrency: number;
  modelMaxConcurrency: number;
  defaultTokenBudget: number;
  defaultTimeBudgetMinutes: number;
  defaultWorkerCount: number;
  logLevel: string;
  logToFile: boolean;
}

export interface SystemSettingsDto {
  model: ModelSettings;
  runtime: RuntimeSettings;
  updatedAt: string | null;
  loggingStatus?: LoggingStatus;
}

export interface LoggingStatus {
  level: string;
  fileEnabled: boolean;
  directory: string;
  activeFile: string | null;
  lastError: string | null;
}

export interface UpdateSystemSettingsInput {
  model?: Partial<{
    provider: string;
    baseUrl: string;
    modelName: string;
    apiKey: string;
    temperature: number;
    maxTokens: number;
  }>;
  runtime?: Partial<RuntimeSettings>;
}

// ModelTestResult 定义于 phase2-types.ts（包含真实调用输出摘要）

export interface AuditLogDto {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  taskId: string | null;
  result: 'success' | 'failure';
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export type WsEvent =
  | { type: 'hello'; payload: { clientId: string; serverTime: string } }
  | { type: 'pong'; payload: { serverTime: string } }
  | { type: 'task.updated'; payload: TaskSummary }
  | { type: 'task.deleted'; payload: { taskId: string } }
  | { type: 'mcp.health'; payload: McpHealthCheckResult }
  | { type: 'audit.appended'; payload: AuditLogDto }
  | { type: 'session.created'; payload: SessionDto }
  | { type: 'session.updated'; payload: SessionDto }
  | { type: 'session.ended'; payload: SessionDto }
  | { type: 'session.message'; payload: SessionMessageDto }
  | { type: 'session.event'; payload: SessionEventDto }
  | { type: 'worker.task'; payload: WorkerTaskDto }
  | { type: 'engine.status'; payload: EngineSnapshot }
  | { type: 'orchestrator.cycle'; payload: EngineSnapshot }
  | { type: 'blackboard.fact'; payload: FactDto }
  | { type: 'blackboard.intent'; payload: IntentDto }
  | { type: 'blackboard.hypothesis'; payload: HypothesisDto }
  | { type: 'tool.call'; payload: ToolCallEventPayload };

export interface ToolCallEventPayload {
  taskId: string | null;
  sessionId: string | null;
  toolCallId: string;
  toolName: string;
  targetIp: string | null;
  status: 'running' | 'success' | 'error' | 'denied';
  latencyMs: number | null;
  summary: string | null;
  evidenceId: string | null;
}

export type SeverityValue = Severity;
export type FindingStatusValue = FindingStatus;
/** 工具证据列表与详情的统一接口。列表不传输完整输出。 */
export interface EvidenceSummaryDto {
  id: string;
  taskId: string | null;
  kind: string;
  title: string;
  agentSessionId: string | null;
  toolCallId: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  createdAt: string;
  preview: string;
}

export interface EvidenceDetailDto extends EvidenceSummaryDto {
  content: string | null;
  mimeType: string | null;
  integrity: 'match' | 'mismatch' | 'unavailable';
  computedSha256: string | null;
  computedSizeBytes: number | null;
}

export type VerificationOutcome = 'pending' | 'confirmed' | 'refuted' | 'inconclusive';
export interface VerificationResult {
  outcome: 'confirmed' | 'refuted' | 'inconclusive';
  summary: string;
  evidenceQuotes: { evidenceId: string; quote: string }[];
}
export interface FindingDto {
  clueLevel?: 'actionable' | 'weakness';
  sourceFactIds?: string[];
  metadataRevision?: number;
  assessment?: import('./finding-assessments').FindingAssessmentDto | null;
  cvss?: number | null;
  id: string;
  taskId: string;
  title: string;
  description: string;
  severity: Severity;
  status: FindingStatus;
  targetIp: string | null;
  evidenceIds: string[];
  cve: string | null;
  cwe: string | null;
  remediation: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface FindingVerificationDto {
  id: string;
  taskId: string;
  findingId: string;
  intentId: string;
  agentSessionId: string | null;
  outcome: VerificationOutcome;
  summary: string;
  baselineEvidenceIds: string[];
  evidenceIds: string[];
  evidenceQuotes: { evidenceId: string; quote: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface SurfaceObservation {
  factId: string;
  subject: string;
  predicate: string;
  value: string;
  evidenceIds: string[];
  observedAt: string;
  conflicting: boolean;
}
export interface SurfacePort {
  port: number;
  protocol: 'tcp' | 'udp' | 'unknown';
  states: string[];
  services: string[];
  versionObserved: boolean;
  observations: SurfaceObservation[];
}
export interface SurfaceAsset {
  address: string;
  kind: 'host' | 'cidr';
  hostname: string | null;
  configured: boolean;
  inScope: boolean;
  aliveObserved: boolean;
  ports: SurfacePort[];
  technologies: SurfaceObservation[];
  endpoints: SurfaceObservation[];
  probeErrors: number;
  inferredFacts: number;
  findings: { id: string; title: string; status: FindingStatus }[];
  gaps: string[];
}
export interface AttackSurfaceDto {
  taskId: string;
  assets: SurfaceAsset[];
  excludedFacts: number;
  gaps: string[];
}

export interface TaskGoalInput {
  mode: 'recon' | 'assessment' | 'evidence';
  targets: string[];
  ports: string | null;
  protocol: 'tcp' | 'udp';
  evidenceText: string | null;
}
export interface TaskGoal extends TaskGoalInput { configuredAt: string }
export interface TaskAcceptance {
  goal: TaskGoal | null;
  configured: boolean;
  complete: boolean;
  checks: { id: string; label: string; passed: boolean; evidenceIds: string[] }[];
  notes: string[];
}
