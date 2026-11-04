import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskAcceptance, TaskDetail, TaskGoalInput } from '@vulnagent/shared';
import { api } from '../../api/client';
import { Button } from '../ui/button';
import { Field, Input, Select, Textarea } from '../ui/input';
import { ErrorBlock, LoadingBlock } from '../ui/panel';
import { Badge } from '../ui/badge';

export function TaskGoalPanel({ task }: { task: TaskDetail }) {
  const client = useQueryClient();
  const endpoint = `/tasks/${encodeURIComponent(task.id)}/goal`;
  const query = useQuery({ queryKey: ['task-goal', task.id], queryFn: () => api.get<TaskAcceptance>(endpoint), refetchInterval: task.status === 'running' ? 5000 : false });
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<TaskGoalInput['mode']>('assessment');
  const [targets, setTargets] = useState('');
  const [ports, setPorts] = useState('1-1000');
  const [protocol, setProtocol] = useState<'tcp' | 'udp'>('tcp');
  const [text, setText] = useState('');
  const save = useMutation({
    mutationFn: () => api.put<TaskAcceptance>(endpoint, { mode, targets: targets.split(/[\s,;]+/).filter(Boolean), ports: mode === 'evidence' ? null : ports, protocol, evidenceText: mode === 'evidence' ? text : null }),
    onSuccess: () => { setEditing(false); void client.invalidateQueries({ queryKey: ['task-goal', task.id] }); void client.invalidateQueries({ queryKey: ['tasks'] }); },
  });
  const edit = () => { const goal = query.data?.goal; setMode(goal?.mode ?? 'assessment'); setTargets((goal?.targets ?? task.targetIps).join(', ')); setPorts(goal?.ports ?? task.scope.ports ?? '1-1000'); setProtocol(goal?.protocol ?? 'tcp'); setText(goal?.evidenceText ?? ''); setEditing(true); save.reset(); };
  const blocked = ['completed', 'stopped'].includes(task.status) || (task.status === 'running' && query.data?.configured);
  return <section className="rounded border border-ink-200 p-3">
    <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">验收目标与进度</h3><Button size="sm" disabled={Boolean(blocked)} onClick={edit}>{query.data?.configured ? '修改目标' : '配置目标'}</Button></div>
    {query.isPending ? <LoadingBlock /> : query.error ? <ErrorBlock message={query.error.message} onRetry={() => void query.refetch()} /> : query.data && <>
      <Badge tone={query.data.complete ? 'success' : query.data.configured ? 'warning' : 'neutral'}>{query.data.complete ? '验收项已满足' : query.data.configured ? '仍有未满足项' : '需要配置目标'}</Badge>
      {query.data.goal && <p className="my-2 break-all text-xs">{query.data.goal.targets.join(', ')} · {query.data.goal.protocol} {query.data.goal.ports ?? '指定证据标记'}</p>}
      <ul className="mt-2 space-y-1 text-xs">{query.data.checks.map((check) => <li key={check.id} className={check.passed ? 'text-emerald-700' : 'text-amber-700'}>{check.passed ? '✓' : '○'} {check.label}</li>)}</ul>
      <ul className="mt-2 space-y-1 text-[11px] text-ink-400">{query.data.notes.map((note) => <li key={note}>{note}</li>)}</ul>
    </>}
    {blocked && <p className="mt-2 text-[11px] text-ink-400">运行中的任务请先暂停修改；已结束的任务请先重跑。</p>}
    {save.error && <ErrorBlock message={save.error.message} />}
    {editing && !blocked && <div className="mt-3 space-y-3 border-t border-ink-200 pt-3">
      <Field label="验收类型"><Select aria-label="验收类型" value={mode} onChange={(e) => setMode(e.target.value as TaskGoalInput['mode'])}><option value="assessment">范围观测、漏洞分析与候选复核</option><option value="recon">指定范围观测</option><option value="evidence">指定证据标记</option></Select></Field>
      <Field label="验收 IP / CIDR"><Input aria-label="验收目标" value={targets} onChange={(e) => setTargets(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-2"><Field label="协议"><Select aria-label="验收协议" value={protocol} onChange={(e) => setProtocol(e.target.value as 'tcp' | 'udp')}><option value="tcp">TCP</option><option value="udp">UDP</option></Select></Field><Field label="端口"><Input aria-label="验收端口" disabled={mode === 'evidence'} value={ports} onChange={(e) => setPorts(e.target.value)} /></Field></div>
      {mode === 'evidence' && <Field label="精确证据标记"><Textarea aria-label="精确证据标记" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} /></Field>}
      <p className="text-[11px] text-ink-400">修改后需重新获取符合目标的证据。保存后在智能体工作台启动或恢复任务。</p>
      <div className="flex gap-2"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>保存目标</Button><Button onClick={() => setEditing(false)}>取消</Button></div>
    </div>}
  </section>;
}
