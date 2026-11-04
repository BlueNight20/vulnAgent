import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TaskSummary } from '@vulnagent/shared';
import { tasksApi } from '../../api/tasks';
import { Button } from '../ui/button';

export function TaskDeletePanel({ task, onDeleted }: { task: TaskSummary; onDeleted: () => void }) {
  const client = useQueryClient();
  const [confirmName, setConfirmName] = useState('');
  const deletion = useMutation({
    mutationFn: () => tasksApi.remove(task.id),
    onSuccess: () => { onDeleted(); void client.invalidateQueries(); },
  });
  return <section className="space-y-2 rounded border border-red-200 p-3 text-xs">
    <p className="font-semibold text-red-800">删除任务及关联数据</p>
    <p className="text-ink-600">将永久删除此任务的会话、调用、证据、漏洞、模型请求/用量和报告，包括二进制附件。审计记录保留。需要保留的报告请先导出。</p>
    {task.status === 'running' ? <p className="text-red-700">请先停止任务并等待执行收尾，再删除。</p> : <>
      <label className="block">输入任务名称“{task.name}”确认删除
        <input className="mt-1 block w-full rounded border border-ink-200 px-2 py-1.5" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
      </label>
      <Button variant="danger" size="sm" disabled={confirmName !== task.name} loading={deletion.isPending} onClick={() => deletion.mutate()}>永久删除此任务</Button>
    </>}
    {deletion.error && <p role="alert" className="text-red-700">{deletion.error.message}</p>}
  </section>;
}
