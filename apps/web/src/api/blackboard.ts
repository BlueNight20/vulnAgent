import type {
  FactDto,
  IntentDto,
  ToolCallDetailDto,
} from '@vulnagent/shared';
import { api } from './client';

export interface FactListResponse {
  items: FactDto[];
  total: number;
  counts: Record<string, number>;
  kindCounts: Record<string, number>;
}

export const factApi = {
  list: (taskId: string, filters: { status?: string; category?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.category) params.set('category', filters.category);
    const qs = params.toString();
    return api.get<FactListResponse>(`/tasks/${taskId}/facts${qs ? `?${qs}` : ''}`);
  },
};

export const intentApi = {
  list: (taskId: string) =>
    api.get<{ items: IntentDto[]; total: number; counts: Record<string, number> }>(
      `/tasks/${taskId}/intents`,
    ),
  reject: (taskId: string, intentId: string) =>
    api.post<IntentDto>(`/tasks/${taskId}/intents/${intentId}/reject`, { reason: 'manual' }),
};

export interface ToolCallPage {
  items: ToolCallDetailDto[];
  total: number;
}

export const toolCallApi = {
  list: (taskId: string, pageSize = 50) =>
    api.get<ToolCallPage>(`/mcp/calls?taskId=${taskId}&pageSize=${pageSize}`),
};
