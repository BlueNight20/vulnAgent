import type { DashboardSummary, UsageTrend } from '@vulnagent/shared';
import { api } from './client';

export const dashboardApi = {
  summary: () => api.get<DashboardSummary>('/dashboard/summary'),
  usageTrend: (days = 7) => api.get<UsageTrend>(`/dashboard/usage-trend?days=${days}`),
};
