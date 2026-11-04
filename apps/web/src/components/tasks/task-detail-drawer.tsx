import { useQuery } from '@tanstack/react-query';
import type { TaskSummary } from '@vulnagent/shared';
import { ENGINE_PHASE_NOTICE } from '@vulnagent/shared';
import { Link } from 'react-router-dom';
import { Drawer } from '../ui/drawer';
import { TaskStatusBadge } from '../common/status-badge';
import { ErrorBlock, LoadingBlock } from '../ui/panel';
import { tasksApi } from '../../api/tasks';
import { formatDateTime } from '../../lib/utils';
import { TaskGoalPanel } from './task-goal-panel';
import { TaskDeletePanel } from './task-delete-panel';
import { ModelBudgetPanel } from './model-budget-panel';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="py-1.5 text-[12px] text-ink-400">{label}</dt>
      <dd className="py-1.5 text-[12px] text-ink-900">{value}</dd>
    </>
  );
}

export function TaskDetailDrawer({
  task,
  onClose,
}: {
  task: TaskSummary | null;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ['tasks', 'detail', task?.id],
    queryFn: () => tasksApi.detail(task!.id),
    enabled: Boolean(task?.id),
  });

  return (
    <Drawer
      open={Boolean(task)}
      onClose={onClose}
      title={task?.name ?? '任务详情'}
      description={task ? `任务 ID ${task.id}` : undefined}
      width="w-[520px]"
    >
      {!task ? null : detail.isLoading ? (
        <LoadingBlock />
      ) : detail.isError ? (
        <ErrorBlock message={(detail.error as Error).message} onRetry={() => void detail.refetch()} />
      ) : detail.data ? (
        <div className="space-y-5">
          <TaskGoalPanel key={detail.data.id} task={detail.data} />
          <div className="flex items-center gap-2">
            <TaskStatusBadge status={detail.data.status} />
            <span className="text-[11px] text-ink-400">{detail.data.currentPhase ?? ''}</span>
          </div>

          <div>
            <p className="mb-1.5 text-[12px] font-semibold text-ink-900">任务信息</p>
            <dl className="divide-y divide-ink-200/60">
              <Row label="模型" value={detail.data.modelName} />
              <Row
                label="端口范围"
                value={<span className="font-mono">{detail.data.scope.ports || '未限定'}</span>}
              />
              <Row label="Worker 数量" value={`${detail.data.workerCount}（上限 2 个 Explore Worker）`} />
              <Row
                label="预算"
                value={
                  <span className="font-mono">
                    {detail.data.tokenBudget.toLocaleString()} token · {detail.data.timeBudgetMinutes} 分钟
                  </span>
                }
              />
              <Row label="已消耗" value={<span className="font-mono">{detail.data.tokensUsed.toLocaleString()}</span>} />
              <Row label="创建时间" value={formatDateTime(detail.data.createdAt)} />
              <Row label="开始时间" value={formatDateTime(detail.data.startedAt)} />
            </dl>
          </div>

          <div>
            <p className="mb-1.5 text-[12px] font-semibold text-ink-900">测试目标</p>
            <ul className="divide-y divide-ink-200/60 rounded border border-ink-200">
              {detail.data.targets.map((t) => (
                <li key={t.id} className="flex items-center justify-between px-2.5 py-1.5">
                  <span className="font-mono text-[12px]">{t.ip}</span>
                  <span className="text-[11px] text-ink-400">
                    {t.kind === 'cidr' ? '网段' : /^[a-z][a-z0-9+.-]*:\/\//i.test(t.ip) ? 'URL' : '主机'} · {t.inScope ? '在范围内' : '已排除'}
                    {t.note ? ` · ${t.note}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {detail.data.description ? (
            <div>
              <p className="mb-1.5 text-[12px] font-semibold text-ink-900">描述</p>
              <p className="whitespace-pre-wrap text-[12px] text-ink-600">{detail.data.description}</p>
            </div>
          ) : null}

          <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-[11px] text-amber-800">
            {ENGINE_PHASE_NOTICE}
          </div>

          <Link
            to={`/workflow?task=${detail.data.id}`}
            className="inline-flex text-[12px] font-medium text-brand-600 hover:underline"
          >
            在工作流中查看运行记录 →
          </Link>
          <TaskDeletePanel key={detail.data.id} task={detail.data} onDeleted={onClose} />
          <ModelBudgetPanel key={`budget:${detail.data.id}`} taskId={detail.data.id} />
        </div>
      ) : null}
    </Drawer>
  );
}
