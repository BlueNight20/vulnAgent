import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { PageHeader } from '../../components/layout/page-header';
import { MetricStrip } from '../../components/dashboard/metric-strip';
import { ServiceHealthTable } from '../../components/dashboard/service-health-table';
import { UsageTrendChart } from '../../components/dashboard/usage-trend-chart';
import { RecentTasksTable } from '../../components/dashboard/recent-tasks-table';
import { Panel, ErrorBlock, LoadingBlock } from '../../components/ui/panel';
import { Button } from '../../components/ui/button';
import { dashboardApi } from '../../api/dashboard';
import { formatDateTime } from '../../lib/utils';

export function DashboardPage() {
  const queryClient = useQueryClient();
  const summary = useQuery({ queryKey: ['dashboard', 'summary'], queryFn: dashboardApi.summary });
  const trend = useQuery({ queryKey: ['dashboard', 'trend', 7], queryFn: () => dashboardApi.usageTrend(7) });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['health'] });
  };

  return (
    <>
      <PageHeader
        title="仪表盘"
        description="所有指标由后端实时聚合（tasks / findings / model_usage 表），服务状态来自真实连通性探测。"
        actions={
          <>
            <span className="text-[11px] text-ink-400">
              更新于 {summary.dataUpdatedAt ? formatDateTime(new Date(summary.dataUpdatedAt).toISOString()) : '—'}
            </span>
            <Button onClick={refresh} loading={summary.isFetching}>
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </Button>
            <Link
              to="/tasks"
              className="inline-flex h-8 items-center gap-1 rounded-md bg-brand-500 px-3 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-brand-600"
            >
              新建任务
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </>
        }
      />

      {summary.isError ? (
        <ErrorBlock message={(summary.error as Error).message} onRetry={() => void summary.refetch()} />
      ) : null}

      <MetricStrip summary={summary.data} loading={summary.isLoading} />

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Panel
          title="服务运行状态"
          description="MCP 状态取自最近一次真实检测结果，不会被前端伪造"
          dense
          bodyClassName="min-h-[248px]"
        >
          {summary.isLoading ? (
            <LoadingBlock />
          ) : (
            <ServiceHealthTable items={summary.data?.services ?? []} />
          )}
        </Panel>

        <Panel
          title="Token 消耗趋势（近 7 天）"
          description="来源：model_usage 表按日聚合"
          bodyClassName="pt-2"
        >
          {trend.isLoading ? (
            <LoadingBlock />
          ) : trend.isError ? (
            <ErrorBlock message={(trend.error as Error).message} onRetry={() => void trend.refetch()} />
          ) : (
            <UsageTrendChart points={trend.data?.points ?? []} />
          )}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel
          title="最近测试任务"
          description="按更新时间排序，最多展示 6 条"
          dense
          actions={
            <Link to="/tasks" className="text-[12px] text-brand-500 hover:underline">
              查看全部
            </Link>
          }
        >
          {summary.isLoading ? <LoadingBlock /> : <RecentTasksTable tasks={summary.data?.recentTasks ?? []} />}
        </Panel>
      </div>
    </>
  );
}
