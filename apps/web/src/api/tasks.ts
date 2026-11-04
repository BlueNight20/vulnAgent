import type { CreateTaskInput, TaskDetail, TaskListResult, TaskSummary } from '@vulnagent/shared';
import { api } from './client';

export interface TaskQuery {
  status?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export const tasksApi = {
  list(query: TaskQuery = {}): Promise<TaskListResult> {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.keyword) params.set('keyword', query.keyword);
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    const qs = params.toString();
    return api.get<TaskListResult>(`/tasks${qs ? `?${qs}` : ''}`);
  },
  detail(id: string): Promise<TaskDetail> {
    return api.get<TaskDetail>(`/tasks/${id}`);
  },
  create(input: CreateTaskInput & { autoStart?: boolean }): Promise<TaskDetail> {
    return api.post<TaskDetail>('/tasks', input);
  },
  action(id: string, action: 'pause' | 'resume' | 'stop' | 'rerun'): Promise<TaskSummary> {
    return api.post<TaskSummary>(`/tasks/${id}/${action}`);
  },
  remove(id: string): Promise<{ deleted: boolean }> {
    return api.delete<{ deleted: boolean }>(`/tasks/${id}`);
  },
};
