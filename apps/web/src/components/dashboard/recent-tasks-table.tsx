import { Link } from 'react-router-dom';
import type { TaskSummary } from '@vulnagent/shared';
import { TableShell, Td, Th } from '../ui/panel';
import { TaskStatusBadge } from '../common/status-badge';
import { formatRelative } from '../../lib/utils';

export function RecentTasksTable({ tasks }: { tasks: TaskSummary[] }) {
  if (tasks.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-[12px] text-ink-400">
        还没有测试任务，前往{' '}
        <Link to="/tasks" className="text-brand-500 hover:underline">
          任务中心
        </Link>{' '}
        创建第一个任务。
      </div>
    );
  }

  return (
    <TableShell>
      <thead>
        <tr>
          <Th>任务名称</Th>
          <Th>目标</Th>
          <Th>状态</Th>
          <Th className="w-[180px]">进度</Th>
          <Th>模型</Th>
          <Th>更新时间</Th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((t) => (
          <tr key={t.id} className="transition-colors hover:bg-slate-50/70">
            <Td>
              <Link to={`/workflow?task=${t.id}`} className="font-medium text-ink-900 hover:text-brand-600">
                {t.name}
              </Link>
              <p className="text-[11px] text-ink-400">
                Worker {t.workerCount} · 预算 {t.tokenBudget.toLocaleString()} token
              </p>
            </Td>
            <Td className="font-mono text-[12px] text-ink-600">
              {t.targetIps.slice(0, 2).join(', ') || '—'}
              {t.targetIps.length > 2 ? ` +${t.targetIps.length - 2}` : ''}
            </Td>
            <Td>
              <TaskStatusBadge status={t.status} />
            </Td>
            <Td>
              <div className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-brand-500 transition-[width] duration-300"
                    style={{ width: `${Math.max(0, Math.min(100, t.progress))}%` }}
                  />
                </div>
                <span className="w-8 text-right font-mono text-[11px] tabular text-ink-600">
                  {t.progress}%
                </span>
              </div>
            </Td>
            <Td className="text-[12px] text-ink-600">{t.modelName}</Td>
            <Td className="whitespace-nowrap text-[12px] text-ink-600">{formatRelative(t.updatedAt)}</Td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}
