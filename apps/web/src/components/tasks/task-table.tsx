import type { TaskAction, TaskSummary, TaskStatus } from '@vulnagent/shared';
import { TASK_ACTIONS, TASK_ACTION_LABEL, TASK_TRANSITIONS } from '@vulnagent/shared';
import { Trash2 } from 'lucide-react';
import { TableShell, Td, Th } from '../ui/panel';
import { TaskStatusBadge } from '../common/status-badge';
import { formatRelative } from '../../lib/utils';

interface Props {
  tasks: TaskSummary[];
  onAction: (task: TaskSummary, action: TaskAction) => void;
  onInspect: (task: TaskSummary) => void;
  onDelete: (task: TaskSummary) => void;
  pendingId: string | null;
  allowedActions?: (action: TaskAction, status: TaskStatus) => boolean;
}

export function TaskTable({ tasks, onAction, onInspect, onDelete, pendingId, allowedActions }: Props) {
  const can = (action: TaskAction, status: TaskStatus) =>
    allowedActions ? allowedActions(action, status) : TASK_TRANSITIONS[action].includes(status);

  return (
    <TableShell>
      <thead>
        <tr>
          <Th>任务名称</Th>
          <Th>目标 IP</Th>
          <Th>授权范围</Th>
          <Th>模型</Th>
          <Th className="text-center">Worker</Th>
          <Th className="text-right">Token 预算</Th>
          <Th>状态</Th>
          <Th>更新</Th>
          <Th className="w-[190px]">操作</Th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => {
          const busy = pendingId === task.id;
          return (
            <tr key={task.id} className="group transition-colors hover:bg-slate-50/70">
              <Td>
                <button
                  type="button"
                  onClick={() => onInspect(task)}
                  className="text-left font-medium text-ink-900 hover:text-brand-600"
                >
                  {task.name}
                </button>
                <p className="mt-0.5 font-mono text-[10px] text-ink-400">{task.id.slice(0, 8)}</p>
              </Td>
              <Td className="font-mono text-[12px] text-ink-600">
                {task.targetIps.join(', ') || '—'}
              </Td>
              <Td className="font-mono text-[12px] text-ink-600">
                {task.scope.cidrs.length ? task.scope.cidrs.join(', ') : '未限定'}
                {task.scope.ports ? ` · ${task.scope.ports}` : ''}
              </Td>
              <Td className="text-[12px] text-ink-600">{task.modelName}</Td>
              <Td className="text-center font-mono text-[12px] tabular">{task.workerCount}</Td>
              <Td className="text-right font-mono text-[12px] tabular text-ink-600">
                {task.tokenBudget.toLocaleString()}
              </Td>
              <Td>
                <TaskStatusBadge status={task.status} />
              </Td>
              <Td className="whitespace-nowrap text-[12px] text-ink-600">{formatRelative(task.updatedAt)}</Td>
              <Td>
                <div className="flex items-center gap-1 opacity-80 transition-opacity group-hover:opacity-100">
                  {TASK_ACTIONS.map((action) => (
                    <button
                      key={action}
                      type="button"
                      disabled={!can(action, task.status) || busy}
                      onClick={() => onAction(task, action)}
                      className="rounded border border-ink-200 bg-white px-1.5 py-0.5 text-[11px] text-ink-600 transition-colors hover:border-brand-300 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-ink-200 disabled:hover:text-ink-600"
                    >
                      {TASK_ACTION_LABEL[action]}
                    </button>
                  ))}
                  <button
                    type="button"
                    title={task.status === 'running' ? '请先停止任务再删除' : '删除任务及关联数据'}
                    aria-label={`删除任务 ${task.name}`}
                    disabled={task.status === 'running' || busy}
                    onClick={() => onDelete(task)}
                    className="ml-1 rounded border border-red-200 bg-white p-0.5 text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-red-200 disabled:hover:bg-white"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </TableShell>
  );
}
