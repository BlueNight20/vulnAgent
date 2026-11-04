import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Play, Square, PauseCircle } from 'lucide-react';
import type { SessionDto } from '@vulnagent/shared';
import { ORCHESTRATOR_STATUS_LABEL, STOP_REASON_LABEL } from '@vulnagent/shared';
import { PageHeader } from '../../components/layout/page-header';
import { Panel, EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui/panel';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { SessionList } from '../../components/agents/session-list';
import { MessageStream } from '../../components/agents/message-stream';
import { SessionPanel } from '../../components/agents/session-panel';
import { agentsApi, blackboardApi, engineApi } from '../../api/agents';
import { tasksApi } from '../../api/tasks';
import { cn, formatNumber } from '../../lib/utils';
import { useEngineControl } from '../../hooks/use-engine-control';
import { isEngineActive, launchLabel, resolveLaunchAction } from '../../features/workflow/launch-action';

export function AgentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const taskId = searchParams.get('task') ?? '';
  const [activeId, setActiveId] = useState<string | null>(null);

  const tasks = useQuery({ queryKey: ['tasks', 'list', '', ''], queryFn: () => tasksApi.list({ pageSize: 50 }) });

  useEffect(() => {
    if (!taskId && tasks.data?.items.length) {
      setSearchParams({ task: tasks.data.items[0].id }, { replace: true });
    }
  }, [taskId, tasks.data, setSearchParams]);

  const engine = useQuery({
    queryKey: ['engine', taskId],
    queryFn: () => engineApi.snapshot(taskId),
    enabled: Boolean(taskId),
    refetchInterval: 4000,
  });

  const sessions = useQuery({
    queryKey: ['agents', 'sessions', taskId],
    queryFn: () => agentsApi.sessions(taskId),
    enabled: Boolean(taskId),
    refetchInterval: 4000,
  });

  const sessionItems = sessions.data?.items ?? [];
  const active: SessionDto | null = useMemo(
    () => sessionItems.find((s) => s.id === activeId) ?? sessionItems[sessionItems.length - 1] ?? null,
    [sessionItems, activeId],
  );

  const messages = useInfiniteQuery({
    queryKey: ['agents', 'messages', active?.id],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => agentsApi.messages(active!.id, pageParam),
    getNextPageParam: (last) => last.nextAfterSeq ?? undefined,
    enabled: Boolean(active?.id),
    refetchInterval: active?.state === 'running' ? 3000 : false,
  });

  const workers = useQuery({
    queryKey: ['blackboard', 'workers', taskId],
    queryFn: () => blackboardApi.workers(taskId),
    enabled: Boolean(taskId),
    refetchInterval: 5000,
  });

  const control = useEngineControl(taskId);

  const status = engine.data?.orchestratorStatus ?? 'idle';
  const running = isEngineActive(engine.data);
  const currentTask = tasks.data?.items.find((t) => t.id === taskId) ?? null;
  const launch = running ? null : resolveLaunchAction(engine.data, currentTask);

  return (
    <>
      <PageHeader
        title="智能体工作台"
        description="查看真实运行的 Pi Session：Planner 与各 Worker 的模型输出、工具调用、状态卡与 Token 消耗。"
        meta={
          <Badge tone={running ? 'brand' : status === 'failed' ? 'danger' : 'neutral'} pulse={running}>
            {ORCHESTRATOR_STATUS_LABEL[status]}
          </Badge>
        }
        actions={
          <>
            <Select
              value={taskId}
              onChange={(e) => {
                setActiveId(null);
                setSearchParams({ task: e.target.value });
              }}
              className="w-[280px]"
            >
              {tasks.data?.items.length ? null : <option value="">暂无任务</option>}
              {tasks.data?.items.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            {running ? (
              <>
                <Button disabled={control.pending} onClick={() => void control.act('pause')} loading={control.action === 'pause'}>
                  <PauseCircle className="h-3.5 w-3.5" />
                  暂停引擎
                </Button>
                <Button variant="danger" disabled={control.pending} onClick={() => void control.act('stop')} loading={control.action === 'stop'}>
                  <Square className="h-3.5 w-3.5" />
                  停止
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                disabled={!taskId || control.pending}
                onClick={() => void control.act(launch === 'rerun' ? 'start' : launch ?? 'start')}
                loading={control.action === (launch === 'rerun' ? 'start' : launch)}
              >
                <Play className="h-3.5 w-3.5" />
                {launch ? launchLabel(launch) : '启动引擎'}
              </Button>
            )}
          </>
        }
      />

      {control.error ? <p role="alert" className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">引擎操作失败：{control.error}</p> : null}
      {tasks.isError ? <ErrorBlock message={(tasks.error as Error).message} onRetry={() => void tasks.refetch()} /> : null}
      {engine.isError ? <ErrorBlock message={(engine.error as Error).message} onRetry={() => void engine.refetch()} /> : null}

      {engine.data ? (
        <div className="mb-3 grid grid-cols-2 divide-x divide-ink-200 overflow-hidden rounded-lg border border-ink-200 bg-white shadow-panel md:grid-cols-6">
          {[
            { label: '编排轮次', value: String(engine.data.cycle) },
            { label: '活跃 Worker', value: `${engine.data.activeWorkers}/${engine.data.maxConcurrency}` },
            { label: '全局 Worker（含排队）', value: engine.data.globalWorkerLimit ? `${engine.data.globalWorkersActive}/${engine.data.globalWorkerLimit}` : '—' },
            { label: '累计 Worker', value: String(engine.data.totalWorkers) },
            { label: 'Token 已用', value: `${formatNumber(engine.data.tokensUsed)}/${formatNumber(engine.data.tokenBudget)}` },
            {
              label: '事实（观察/验证）',
              value: `${engine.data.factCounts.observed}/${engine.data.factCounts.verified}`,
            },
            {
              label: '停止原因',
              value: engine.data.stopReason ? STOP_REASON_LABEL[engine.data.stopReason] : '—',
            },
          ].map((m) => (
            <div key={m.label} className="px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-ink-400">{m.label}</p>
              <p className="mt-0.5 truncate font-mono text-[15px] font-semibold tabular text-ink-900">{m.value}</p>
            </div>
          ))}
        </div>
      ) : null}

      {engine.data?.lastError ? (
        <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          {engine.data.lastError}
        </div>
      ) : null}
      {engine.data?.waitingForWorkerCapacity ? <p className="mb-3 text-[12px] text-amber-700">等待全局或任务 Worker 执行名额，系统会自动继续；等待不会消耗重试次数。</p> : null}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[240px_1fr_300px]">
        <Panel dense bodyClassName="h-[620px] overflow-y-auto" className="min-w-0">
          {sessions.isLoading ? (
            <LoadingBlock />
          ) : (
            <SessionList sessions={sessionItems} activeId={active?.id ?? null} onSelect={(s) => setActiveId(s.id)} />
          )}
        </Panel>

        <Panel
          dense
          bodyClassName="h-[620px] overflow-y-auto"
          className="min-w-0"
          title={active ? '会话消息' : undefined}
          description={active ? `${active.messageCount} 条消息 · 模型 ${active.modelName || '默认'}` : undefined}
        >
          {sessions.isError ? (
            <div className="p-3">
              <ErrorBlock message={(sessions.error as Error).message} onRetry={() => void sessions.refetch()} />
            </div>
          ) : !active ? (
            <EmptyState
              title="还没有 Agent 会话"
              description="启动引擎后，Planner 会被首先创建，随后按需派发 Worker。所有内容均为真实模型输出。"
            />
          ) : messages.isError ? (
            <div className="p-3"><ErrorBlock message={(messages.error as Error).message} onRetry={() => void messages.refetch()} /></div>
          ) : (
            <>
              <MessageStream messages={messages.data?.pages.flatMap((page) => page.items) ?? []} loading={messages.isLoading} />
              {messages.hasNextPage ? <div className="px-4 pb-3"><Button loading={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>加载后续消息</Button><span className="ml-2 text-[11px] text-ink-400">已加载 {messages.data?.pages.reduce((count, page) => count + page.items.length, 0)} / {messages.data?.pages[0].total}</span></div> : null}
            </>
          )}
        </Panel>

        <Panel dense bodyClassName="h-[620px] overflow-hidden" className="min-w-0">
          {active ? (
            <SessionPanel key={active.id} session={active} taskId={taskId} />
          ) : (
            <div className="px-3 py-6 text-[11px] text-ink-400">选择一个会话查看详情</div>
          )}
        </Panel>
      </div>

      <div className="mt-3">
        <Panel title="Worker 任务" description="来自 worker_tasks 表的真实执行记录" dense>
          {workers.isError ? <ErrorBlock message={(workers.error as Error).message} onRetry={() => void workers.refetch()} /> : (workers.data?.items ?? []).length === 0 ? (
            <p className="px-4 py-4 text-[12px] text-ink-400">还没有派发 Worker。</p>
          ) : (
            <ul className="divide-y divide-ink-200/60">
              {(workers.data?.items ?? []).map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-[12px] font-medium text-ink-900">{w.title}</p>
                    <p className="text-[10px] text-ink-400">
                      {w.profileId} · attempt {w.attempt}/{w.maxAttempts} ·{' '}
                      {w.errorMessage ? <span className="text-danger">{w.errorMessage}</span> : 'dedupeKey ' + w.dedupeKey}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[11px] tabular text-ink-600">{formatNumber(w.tokensSpent)} tok</span>
                    <Badge
                      tone={
                        w.status === 'succeeded'
                          ? 'success'
                          : w.status === 'running'
                            ? 'brand'
                            : w.status === 'failed' || w.status === 'timeout'
                              ? 'danger'
                              : 'neutral'
                      }
                      pulse={w.status === 'running'}
                    >
                      {w.status}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

export const AGENTS_PAGE_CLASS = cn('');
