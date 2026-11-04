import type {
  AgentRole,
  McpCallDto,
  McpHealthCheckResult,
  McpPermissionDto,
  McpPermissionMatrix,
  McpServerDto,
  McpToolDto,
} from '@vulnagent/shared';
import { api } from './client';

export interface McpServerInput { preserveCredentials?: boolean; name: string; endpoint: string; transport: 'streamable-http' | 'sse' | 'stdio'; command?: string; args?: string[]; env?: Record<string, string>; token?: string; headers?: Record<string, string> }
export const mcpApi = {
  update: (id: string, input: McpServerInput) => api.put<McpServerDto>(`/mcp/servers/${id}`, input),
  testUpdate: (id: string, input: McpServerInput) => api.post<{ ok: boolean; toolCount?: number; latencyMs: number; error?: string }>(`/mcp/servers/${id}/test`, input),
  setEnabled: (id: string, enabled: boolean) => api.put<McpServerDto>(`/mcp/servers/${id}/enabled`, { enabled }),
  diagnostics: (id: string) => api.get<{ items: Array<{ id: string; action: string; result: string; createdAt: string }> }>(`/mcp/servers/${id}/diagnostics`),
  capabilities: (id: string) => api.get<{ resources: Array<{ name: string; uri: string; description?: string }>; prompts: Array<{ name: string; description?: string }> }>(`/mcp/servers/${id}/capabilities`),
  create: (input: McpServerInput) => api.post<McpServerDto>('/mcp/servers', input),
  test: (input: McpServerInput) => api.post<{ ok: boolean; toolCount?: number; latencyMs: number; error?: string }>('/mcp/servers/test', input),
  servers: () => api.get<{ items: McpServerDto[] }>('/mcp/servers'),
  server: (id: string) => api.get<McpServerDto>(`/mcp/servers/${id}`),
  check: (id: string) => api.post<McpHealthCheckResult>(`/mcp/servers/${id}/check`),
  sync: (id: string) => api.post<McpHealthCheckResult & { message: string }>(`/mcp/servers/${id}/sync`),
  tools: (serverId?: string, keyword?: string) => {
    const params = new URLSearchParams();
    if (keyword) params.set('keyword', keyword);
    const base = serverId ? `/mcp/servers/${serverId}/tools` : '/mcp/tools';
    return api.get<{ items: McpToolDto[] }>(`${base}${params.toString() ? `?${params}` : ''}`);
  },
  permissions: (taskId?: string) =>
    api.get<McpPermissionMatrix>(`/mcp/permissions${taskId ? `?taskId=${taskId}` : ''}`),
  updatePermission: (input: {
    agentRole: AgentRole;
    toolPattern: string;
    allowed: boolean;
    requireApproval?: boolean;
    taskId?: string | null;
  }) => api.put<McpPermissionDto>('/mcp/permissions', input),
  calls: (page = 1, pageSize = 20) =>
    api.get<{ items: McpCallDto[]; total: number }>(`/mcp/calls?page=${page}&pageSize=${pageSize}`),
};
