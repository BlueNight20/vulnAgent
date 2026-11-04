import type {
  EngineSnapshot,
  FactDto,
  HintDto,
  HypothesisDto,
  IntentDto,
  WorkerResultCardDto,
  WorkerTaskDto,
  TaskSummary,
} from '@vulnagent/shared';
import { api } from './client';

export interface SessionMessageItem {
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

export interface SessionEventItem {
  id: string;
  sessionId: string;
  taskId: string;
  type: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface ToolCallItem {
  id: string;
  toolName: string;
  targetIp: string | null;
  decision: string;
  status: string;
  latencyMs: number;
  errorMessage: string | null;
  createdAt: string;
}

export interface EvidenceItem {
  id: string;
  kind: string;
  title: string;
  agentSessionId: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  createdAt: string;
  preview: string;
}

export const agentsApi = {
  sessions: (taskId: string) =>
    api.get<{ items: import('@vulnagent/shared').SessionDto[] }>(`/agents/sessions?taskId=${taskId}`),
  detail: (id: string) =>
    api.get<{ session: import('@vulnagent/shared').SessionDto; toolCalls: ToolCallItem[] }>(
      `/agents/sessions/${id}`,
    ),
  messages: (id: string, afterSeq = 0) =>
    api.get<{ items: SessionMessageItem[]; total: number; nextAfterSeq: number | null }>(
      `/agents/sessions/${id}/messages?afterSeq=${afterSeq}`,
    ),
  events: (id: string, limit = 100) =>
    api.get<{ items: SessionEventItem[] }>(`/agents/sessions/${id}/events?limit=${limit}`),
  pause: (id: string) => api.post<unknown>(`/agents/sessions/${id}/pause`),
  resume: (id: string) => api.post<unknown>(`/agents/sessions/${id}/resume`),
  terminate: (id: string) => api.post<unknown>(`/agents/sessions/${id}/terminate`),
  runtime: () =>
    api.get<{ activeSessions: number; modelConcurrency: number; modelConcurrencyLimit: number }>(
      '/agents/runtime',
    ),
};

export const engineApi = {
  snapshot: (taskId: string) => api.get<EngineSnapshot>(`/tasks/${taskId}/engine`),
  start: (taskId: string) => api.post<TaskSummary>(`/tasks/${taskId}/engine/start`),
  pause: (taskId: string) => api.post<TaskSummary>(`/tasks/${taskId}/engine/pause`),
  resume: (taskId: string) => api.post<TaskSummary>(`/tasks/${taskId}/engine/resume`),
  stop: (taskId: string) => api.post<TaskSummary>(`/tasks/${taskId}/engine/stop`),
};

export const blackboardApi = {
  facts: (taskId: string, status?: string) =>
    api.get<{ items: FactDto[]; total: number; counts: Record<string, number> }>(
      `/tasks/${taskId}/facts${status ? `?status=${status}` : ''}`,
    ),
  intents: (taskId: string) =>
    api.get<{ items: IntentDto[]; total: number; counts: Record<string, number> }>(
      `/tasks/${taskId}/intents`,
    ),
  hypotheses: (taskId: string) =>
    api.get<{ items: HypothesisDto[] }>(`/tasks/${taskId}/hypotheses`),
  hints: (taskId: string) => api.get<{ items: HintDto[] }>(`/tasks/${taskId}/hints`),
  createHint: (taskId: string, content: string, sessionId?: string) =>
    api.post<HintDto>(`/tasks/${taskId}/hints`, { content, sessionId: sessionId ?? null }),
  workers: (taskId: string) => api.get<{ items: WorkerTaskDto[] }>(`/tasks/${taskId}/workers`),
  resultCards: (taskId: string) =>
    api.get<{ items: WorkerResultCardDto[] }>(`/tasks/${taskId}/result-cards`),
  evidence: (taskId: string) => api.get<{ items: EvidenceItem[]; total: number }>(`/tasks/${taskId}/evidence`),
};

export interface WorkflowGraphResponse {
  source: 'live';
  taskId: string;
  taskName: string;
  taskStatus: string;
  engine: EngineSnapshot | null;
  generatedAt: string;
}

export const workflowApi = {
  graph: (taskId: string) =>
    api.get<WorkflowGraphResponse & { nodes: WorkflowNode[]; edges: WorkflowEdge[] }>(
      `/workflows/${taskId}/graph`,
    ),
};

export interface WorkflowNode {
  id: string;
  kind: 'orchestrator' | 'planner' | 'worker';
  label: string;
  role: string;
  profileId: string | null;
  status: string;
  title: string;
  tokens: number;
  durationMs: number | null;
  evidenceCount: number;
  detail: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  kind: 'dependency' | 'intent' | 'evidence';
  label: string | null;
}
