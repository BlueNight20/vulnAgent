import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Play, Square } from 'lucide-react';
import type { WorkflowNode } from '../../api/agents';
import {
  ORCHESTRATOR_STATUS_LABEL,
  STOP_REASON_LABEL,
  WORKER_PROFILE_LABEL,
} from '@vulnagent/shared';
import { PageHeader } from '../../components/layout/page-header';
import { Panel, LoadingBlock, EmptyState, ErrorBlock } from '../../components/ui/panel';
import { Select } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { LiveCanvas } from '../../features/workflow/live-canvas';
import { FactPanel } from '../../components/blackboard/fact-panel';
import { ToolCallPanel } from '../../components/blackboard/tool-call-panel';
import { HypothesisPanel } from '../../components/blackboard/hypothesis-panel';
import { WorkflowNodeDrawer } from './workflow-node-drawer';
import { ROLE_COLOR, statusLabel } from '../../features/workflow/graph-mapper';
import { isEngineActive, launchLabel as launchActionLabel, resolveLaunchAction, type LaunchAction } from '../../features/workflow/launch-action';
import { workflowApi } from '../../api/agents';
import { useEngineControl } from '../../hooks/use-engine-control';
import { tasksApi } from '../../api/tasks';
import { formatNumber } from '../../lib/utils';

export function WorkflowPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<WorkflowNode | null>(null);
  const taskId = searchParams.get('task') ?? '';

  const tasks = useQuery({ queryKey: ['tasks', 'list', '', ''], queryFn: () => tasksApi.list({ pageSize: 50 }) });

  useEffect(() => {
    if (!taskId && tasks.data?.items.length) {
      setSearchParams({ task: tasks.data.items[0].id }, { replace: true });
    }
  }, [taskId, tasks.data, setSearchParams]);

  const graph = useQuery({
    queryKey: ['workflow', taskId],
    queryFn: () => workflowApi.graph(taskId),
    enabled: Boolean(taskId),
    refetchInterval: 3000,
  });

  const engine = graph.data?.engine ?? null;
  const status = engine?.orchestratorStatus ?? 'idle';
  const running = isEngineActive(engine);
  const currentTask = tasks.data?.items.find((t) => t.id === taskId) ?? null;

  const control = useEngineControl(taskId);
  const launch = resolveLaunchAction(engine, currentTask);

  return (
    <>
      <PageHeader
        title="工作流"
        description="节点与连线全部来自真实运行记录：Orchestrator 状态、Planner 会话、每个 Worker 与其任务依赖。"
        meta={<Badge tone={running ? 'brand' : status === 'failed' ? 'danger' : 'neutral'} pulse={running}>{ORCHESTRATOR_STATUS_LABEL[status]}</Badge>}
        actions={
          <>
            <Select
              value={taskId}
              onChange={(e) => {
                setSelected(null);
                setSearchParams({ task: e.target.value });
              }}
              className="w-[280px]"
            >
              {tasks.data?.items.length ? null : <option value="">暂无任务</option>}
              {tasks.data?.items.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              )              )}
            </Select>
            {running ? (
              <Button variant="danger" disabled={control.pending} loading={control.action === 'stop'} onClick={() => void control.act('stop')}>
                <Square className="h-3.5 w-3.5" />
                停止引擎
              </Button>
            ) : (
              <LaunchButton taskId={taskId} launch={launch} control={control} />
            )}
          </>
        }
      />

      {control.error ? <p role="alert" className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">引擎操作失败：{control.error}</p> : null}
      {tasks.isError ? <ErrorBlock message={(tasks.error as Error).message} onRetry={() => void tasks.refetch()} /> : null}

      {engine ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-ink-200 bg-white px-4 py-2.5 text-[12px] shadow-panel">
          <span className="text-ink-400">
            轮次 <span className="font-mono text-ink-900">{engine.cycle}</span>
          </span>
          <span className="text-ink-400">
            活跃 Worker{' '}
            <span className="font-mono text-ink-900">
              {engine.activeWorkers}/{engine.maxConcurrency}
            </span>
          </span>
          <span className="text-ink-400">
            Token{' '}
            <span className="font-mono text-ink-900">
              {formatNumber(engine.tokensUsed)}/{formatNumber(engine.tokenBudget)}
            </span>
          </span>
          {engine.globalWorkerLimit ? <span className="text-ink-400">全局 Worker（含排队） <span className="font-mono text-ink-900">{engine.globalWorkersActive}/{engine.globalWorkerLimit}</span>{engine.waitingForWorkerCapacity ? ' · 等待执行名额' : ''}</span> : null}
          <span className="text-ink-400">
            事实 观察 <span className="font-mono text-ink-900">{engine.factCounts.observed}</span> · 验证{' '}
            <span className="font-mono text-ink-900">{engine.factCounts.verified}</span> · 推断{' '}
            <span className="font-mono text-ink-900">{engine.factCounts.inferred}</span>
          </span>
          {engine.stopReason ? (
            <span className="text-ink-400">
              停止原因 <span className="text-amber-700">{STOP_REASON_LABEL[engine.stopReason]}</span>
            </span>
          ) : null}
          <Link to={`/agents?task=${taskId}`} className="ml-auto text-brand-600 hover:underline">
            打开智能体工作台 →
          </Link>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_260px]">
        <Panel dense bodyClassName="h-[620px] overflow-hidden rounded-b-lg">
          {graph.isLoading ? (
            <LoadingBlock />
          ) : graph.isError ? (
            <div className="p-4">
              <ErrorBlock message={(graph.error as Error).message} onRetry={() => void graph.refetch()} />
            </div>
          ) : !taskId ? (
            <EmptyState
              title="请选择任务"
              description="工作流与任务一一对应，先在任务中心创建任务后即可查看真实执行拓扑。"
            />
          ) : (graph.data?.nodes.length ?? 0) <= 1 ? (
            <EmptyState
              title="还没有执行记录"
              description="启动或恢复后，执行记录会在这里显示；若操作失败，请查看页面错误提示。"
              action={<LaunchButton taskId={taskId} launch={launch} control={control} />}
            />
          ) : (
            <LiveCanvas
              nodes={graph.data!.nodes}
              edges={graph.data!.edges}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
          )}
        </Panel>

        <div className="space-y-3">
          <Panel title="图例" dense>
            <ul className="space-y-1.5 px-3 py-2.5 text-[12px] text-ink-600">
              {Object.entries(WORKER_PROFILE_LABEL).map(([key, label]) => (
                <li key={key} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: ROLE_COLOR[key] }} />
                  {label}
                </li>
              ))}
              <li className="flex items-center gap-2 border-t border-ink-200 pt-1.5">
                <span className="h-0 w-6 border-t-2 border-solid border-slate-400" />
                派发 / 依赖
              </li>
              <li className="flex items-center gap-2">
                <span className="h-0 w-6 border-t-2 border-dashed border-amber-500" />
                证据回传
              </li>
            </ul>
          </Panel>

          <Panel title="节点（实时）" dense bodyClassName="max-h-[420px] overflow-y-auto">
            <ul className="divide-y divide-ink-200/60">
              {(graph.data?.nodes ?? []).map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(n)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition-colors hover:bg-slate-50"
                  >
                    <span className="truncate text-[11px] text-ink-900">{n.label}</span>
                    <span className="shrink-0 text-[10px] text-ink-400">{statusLabel(n.status)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>

      {taskId ? (
        <div className="mt-3 space-y-3">
          <Panel title="执行明细" description="以下数据全部来自数据库，无任何模拟内容" dense>
            <div className="space-y-4 px-4 py-3">
              <ToolCallPanel taskId={taskId} />
            </div>
          </Panel>

          <Panel title="事实黑板" description="区分目标状态、目标否定、探测失败与模型推断" dense>
            <div className="px-4 py-3">
              <FactPanel taskId={taskId} />
            </div>
          </Panel>
            <Panel title="假设与依据" description="逐条查看明确引用、关系解释与当前有效性" dense>
              <div className="px-4 py-3"><HypothesisPanel key={taskId} taskId={taskId} /></div>
            </Panel>
        </div>
      ) : null}

      <WorkflowNodeDrawer node={selected} onClose={() => setSelected(null)} />
    </>
  );
}

/** 一个任务只显示一个启动动作，避免同时触发 start 与 resume 互相 409。 */
function LaunchButton({
  taskId,
  launch,
  control,
}: {
  taskId: string;
  launch: LaunchAction | null;
  control: ReturnType<typeof useEngineControl>;
}) {
  if (launch === 'rerun') {
    return (
      <Link
        to={`/tasks?task=${taskId}`}
        className="inline-flex items-center gap-1.5 rounded border border-ink-200 bg-white px-2.5 py-1 text-[12px] text-ink-600 hover:border-brand-300 hover:text-brand-600"
      >
        <Play className="h-3.5 w-3.5" />
        先重新运行任务
      </Link>
    );
  }
  const engineAction = launch === 'resume' ? 'resume' : 'start';
  return (
    <Button
      variant="primary"
      disabled={!taskId || control.pending}
      loading={control.action === engineAction}
      onClick={() => void control.act(engineAction)}
    >
      <Play className="h-3.5 w-3.5" />
      {launch ? launchActionLabel(launch) : '启动引擎'}
    </Button>
  );
}
