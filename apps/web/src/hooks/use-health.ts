import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { HealthResponse } from '../api/types';

/** 顶栏显示的后端连通状态，来自真实 /api/health 探测 */
export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<HealthResponse>('/health'),
    refetchInterval: 15000,
    retry: 0,
    staleTime: 5000,
  });
}
