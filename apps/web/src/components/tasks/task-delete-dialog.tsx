import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TaskSummary } from '@vulnagent/shared';
import { tasksApi } from '../../api/tasks';
import { Button } from '../ui/button';

/**
 * 任务删除确认。删除在后端真实执行：所属会话、调用、证据、漏洞、报告及二进制附件一并清理，
 * 审计记录保留。名称确认只用于避免误删。
 */
export function TaskDeleteDialog({ task, onCancel, onDeleted }: { task: TaskSummary; onCancel: () => void; onDeleted?: () => void }) {
  const client = useQueryClient();
  const [confirmName, setConfirmName] = useState('');
  const deletion = useMutation({
    mutationFn: () => tasksApi.remove(task.id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['tasks'] });
      void client.invalidateQueries({ queryKey: ['dashboard'] });
      void client.invalidateQueries({ queryKey: ['workflow'] });
      onDeleted?.();
      onCancel();
    },
  });

  const running = task.status === 'running';
  return (
    <div role="dialog" aria-modal="true" aria-label="删除任务" className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
      <div className="w-full max-w-[440px] space-y-3 rounded-lg border border-ink-200 bg-white p-4 shadow-panel">
        <p className="text-[13px] font-semibold text-red-800">删除任务「{task.name}」</p>
        <p className="text-[12px] text-ink-600">
          将永久删除此任务的会话、调用、证据、漏洞、模型请求/用量和报告，包括二进制附件。审计记录保留，需要保留的报告请先导出。
        </p>
        {running ? (
          <p className="text-[12px] text-red-700">请先停止任务并等待执行收尾，再删除。</p>
        ) : (
          <label className="block text-[12px] text-ink-600">
            输入任务名称确认删除
            <input
              className="mt-1 block w-full rounded border border-ink-200 px-2 py-1.5 text-[12px] text-ink-900"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              autoComplete="off"
              autoFocus
            />
          </label>
        )}
        {deletion.error ? <p role="alert" className="text-[12px] text-red-700">{deletion.error.message}</p> : null}
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onCancel} disabled={deletion.isPending}>取消</Button>
          <Button
            size="sm"
            variant="danger"
            disabled={confirmName !== task.name}
            loading={deletion.isPending}
            onClick={() => deletion.mutate()}
          >
            永久删除
          </Button>
        </div>
      </div>
    </div>
  );
}
