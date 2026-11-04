import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DataMaintenanceApply, DataMaintenancePlan, DataMaintenanceResult, DataRetentionPolicy, MaintenanceCandidate } from '@vulnagent/shared';
import { api } from '../../api/client';
import { Panel } from '../ui/panel';
import { Field, Input } from '../ui/input';
import { Button } from '../ui/button';

export function DataMaintenancePanel() {
  const client = useQueryClient();
  const [before, setBefore] = useState(() => new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 16));
  const [keep, setKeep] = useState('10'); const [includeOrphans, setOrphans] = useState(false); const [page, setPage] = useState(1);
  const [confirmation, setConfirmation] = useState('');
  const preview = useMutation({ mutationFn: (policy: DataRetentionPolicy) => api.post<DataMaintenancePlan>('/maintenance/preview', policy) });
  const apply = useMutation({ mutationFn: () => {
    const plan = preview.data;
    if (!plan || confirmation !== '清理这些数据') throw new Error('请先预览并输入确认文字');
    return api.post<DataMaintenanceResult>('/maintenance/apply', { ...plan.policy, expiresAt: plan.expiresAt, digest: plan.digest, confirmation } satisfies DataMaintenanceApply);
  }, onSuccess: () => {
    preview.reset(); setConfirmation(''); setPage(1);
    for (const key of ['tasks', 'task-detail', 'dashboard', 'findings', 'finding-detail', 'reports', 'evidence', 'agents', 'workflow']) void client.invalidateQueries({ queryKey: [key] });
  }, onError: () => { preview.reset(); setConfirmation(''); } });
  const pending = preview.isPending || apply.isPending;
  const clear = () => { preview.reset(); apply.reset(); setConfirmation(''); setPage(1); };
  const policy = (targetPage: number): DataRetentionPolicy => ({ before: new Date(`${before}Z`).toISOString(), keepLatest: Number(keep), includeOrphans, page: targetPage });
  const load = (targetPage: number) => { setPage(targetPage); setConfirmation(''); apply.reset(); preview.mutate(policy(targetPage)); };
  const plan = preview.data; const eligible = plan ? [...plan.tasks, ...plan.orphans].filter((row) => !row.blockedReason).length : 0;
  const candidates = (rows: MaintenanceCandidate[], orphan: boolean) => rows.map((row) => <li key={row.taskId} className="space-y-1 rounded border border-ink-200 p-2 text-xs">
    <p className="break-words font-medium">{row.name ?? '父任务缺失'} · {row.taskId}</p>
    <p>{row.blockedReason ? `保留，暂不可清理：${row.blockedReason}` : orphan ? '将清理孤立记录并保存防重建 ID' : `将删除整项任务 · 结束于 ${row.finishedAt ?? '未知'}`}</p>
    <p className="break-words text-ink-500">{Object.entries(row.rows).filter(([, count]) => count > 0).map(([table, count]) => `${table}: ${count}`).join('；') || '没有所属记录'}</p>
  </li>);
  return <div className="mt-4"><Panel title="数据保留与孤立记录维护">
    <p className="mb-3 text-xs text-ink-500">只清理已停止、完成或失败且达到截止条件的任务，始终保护最近 N 项终态任务；结束时间缺失、活动任务和阻塞记录保留。执行前生成完整数据库备份，清理与审计同事务。此操作不安装定时任务。</p>
    <form onSubmit={(event) => { event.preventDefault(); if (before && keep.trim()) load(1); }}><fieldset disabled={pending} className="flex flex-wrap items-end gap-3">
      <Field label="清理截止时间（UTC，早于此时结束）"><Input aria-label="清理截止时间 UTC" type="datetime-local" required value={before} onChange={(event) => { clear(); setBefore(event.target.value); }} /></Field>
      <Field label="至少保留最近 N 项终态任务"><Input aria-label="保留终态任务数量" type="number" min={0} max={1000} step={1} required value={keep} onChange={(event) => { clear(); setKeep(event.target.value); }} /></Field>
      <label className="flex items-center gap-2 text-xs"><input aria-label="包含父任务缺失记录" type="checkbox" checked={includeOrphans} onChange={(event) => { clear(); setOrphans(event.target.checked); }} />同时检查父任务缺失的孤立记录</label>
      <Button type="submit" disabled={!before || !keep.trim()} loading={preview.isPending}>预览清理范围</Button>
    </fieldset></form>
    {(preview.error || apply.error) && <p role="alert" className="mt-3 text-xs text-red-700">{(apply.error ?? preview.error)!.message}。请核对后重新预览；若已生成备份，失败不会自动删除该备份。</p>}
    {apply.data && <div role="status" className="mt-3 space-y-1 break-all text-xs"><p>清理已提交：任务 {apply.data.deletedTasks.length} 项，孤立任务记录 {apply.data.cleanedOrphanTasks.length} 组。</p><p>备份：{apply.data.backup.path}</p><p>SHA-256：{apply.data.backup.sha256}</p><p>审计：{apply.data.auditId}</p></div>}
    {plan && <div className="mt-4 space-y-3 text-xs"><p>候选任务 {plan.taskCandidates} 项；孤立任务记录 {plan.orphanCandidates} 组。本页 {eligible} 项可清理，阻塞项将保留。</p>
      <p>预览有效至 {new Date(plan.expiresAt).toLocaleString('zh-CN')}。数据库写入、条件变化或服务重启后须重新预览。</p>
      {!plan.backupAvailable && <p role="alert">当前不是 SQLite 文件库，不能执行清理。</p>}
      <ul className="space-y-1 text-ink-500">{plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      <h4 className="font-medium">本页任务</h4><ul className="max-h-64 space-y-2 overflow-auto">{candidates(plan.tasks, false)}</ul>{!plan.tasks.length && <p>没有符合截止与保留条件的任务。</p>}
      {plan.policy.includeOrphans && <><h4 className="font-medium">本页父任务缺失记录</h4><ul className="max-h-64 space-y-2 overflow-auto">{candidates(plan.orphans, true)}</ul>{!plan.orphans.length && <p>没有父任务缺失的记录。</p>}</>}
      <div className="flex items-center gap-2"><Button disabled={pending || page <= 1} onClick={() => load(page - 1)}>清理上一页</Button><span>第 {plan.policy.page} 页</span><Button disabled={pending || page * plan.pageSize >= Math.max(plan.taskCandidates, plan.orphanCandidates)} onClick={() => load(page + 1)}>清理下一页</Button></div>
      <div className="flex flex-wrap items-end gap-2"><Field label="确认删除本页可清理项（任务的证据、附件和报告一起删除）"><Input aria-label="清理确认文字" placeholder="输入：清理这些数据" value={confirmation} disabled={pending} onChange={(event) => setConfirmation(event.target.value)} /></Field>
        <Button variant="danger" disabled={pending || !plan.backupAvailable || !eligible || confirmation !== '清理这些数据' || Date.parse(plan.expiresAt) < Date.now()} loading={apply.isPending} onClick={() => apply.mutate()}>备份并清理本页</Button></div>
    </div>}
  </Panel></div>;
}
