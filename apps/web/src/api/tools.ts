import { api } from './client';

/** 后端 /api/intercept/rules 的规则形状（与 intercept_rules 表一致）。 */
export interface InterceptRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  matchTarget: 'tool_name' | 'tool_input';
  matchType: 'string' | 'regex';
  pattern: string;
  action: 'allow' | 'deny' | 'ask';
  message: string | null;
  timeoutEnabled: boolean;
  timeoutSeconds: number | null;
  timeoutAction: 'deny' | 'allow' | null;
  createdAt: string;
  updatedAt: string;
}

export type InterceptRuleInput = Omit<InterceptRule, 'id' | 'createdAt' | 'updatedAt'>;

export interface RegistryTool {
  name: string;
  source: string;
  risk: string;
}

export const toolApi = {
  registry: () => api.get<{ tools: RegistryTool[] }>('/intercept/tools'),
  rules: () => api.get<{ rules: InterceptRule[] }>('/intercept/rules'),
  createRule: (input: InterceptRuleInput) => api.post<InterceptRule>('/intercept/rules', input),
  updateRule: (id: string, input: InterceptRuleInput) => api.put<InterceptRule>(`/intercept/rules/${id}`, input),
  toggleRule: (id: string, enabled: boolean) =>
    api.post<InterceptRule>(`/intercept/rules/${id}/toggle`, { enabled }),
  removeRule: (id: string) => api.delete<{ deleted: boolean }>(`/intercept/rules/${id}`),
};
