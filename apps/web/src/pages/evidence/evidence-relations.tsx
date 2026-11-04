import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { EvidenceRelationsDto } from '@vulnagent/shared';
import { api } from '../../api/client';
import { HypothesisLinks } from '../../components/blackboard/hypothesis-panel';

export function EvidenceRelations({ taskId, evidenceId }: { taskId: string; evidenceId: string }) {
  const relations = useQuery({ queryKey: ['evidence-relations', taskId, evidenceId], queryFn: () => api.get<EvidenceRelationsDto>(`/tasks/${encodeURIComponent(taskId)}/evidence/${encodeURIComponent(evidenceId)}/relations`), enabled: Boolean(taskId && evidenceId), refetchInterval: 10000 });
  const data = relations.data;
  return <section className="mt-4 space-y-2 border-t border-ink-200 pt-3 text-xs">
    <p className="font-semibold">证据反向关联</p>
    <p className="text-ink-500">列出明确使用此证据的记录；关联本身不代表漏洞已确认，失效关系仍保留供核查。</p>
    {relations.isPending && <p>正在查找关联…</p>}
    {relations.error && <p role="alert" className="text-red-700">{relations.error.message}</p>}
    {data && <>
      <p>关联事实（{data.facts?.length ?? 0}）</p>
      <ul className="space-y-1">{data.facts?.map((f) => <li key={f.id} className="break-words rounded bg-slate-50 p-2">[{f.status}] {f.subject} {f.predicate} {f.object}<span className="mt-1 block break-all text-ink-500">{f.targetIp ?? '目标未知'} · {f.id}</span></li>)}</ul>
      <p>关联假设（{data.hypotheses?.length ?? 0}）</p>
      {data.hypotheses?.map((view) => <div key={view.hypothesis.id} className="space-y-2 rounded border border-ink-200 p-2">
        <Link className="text-brand-600 underline" to={`/workflow?task=${encodeURIComponent(taskId)}&hypothesis=${encodeURIComponent(view.hypothesis.id)}`}>{view.hypothesis.title}</Link>
        {view.hypothesis.conflicted && <p className="text-amber-700">支持与反驳依据冲突，需要复核。</p>}
        <HypothesisLinks taskId={taskId} links={view.links} />
      </div>)}
      <p>关联漏洞记录（{data.findings?.length ?? 0}）</p>
      <ul>{data.findings?.map((f) => <li key={f.id} className="mt-1 rounded bg-slate-50 p-2"><Link className="text-brand-600 underline" to={`/findings?task=${encodeURIComponent(taskId)}&id=${encodeURIComponent(f.id)}`}>{f.title}</Link> · {f.status}<span className="block text-ink-500">验证引用：{f.verificationIds.join(', ') || '候选来源'}</span></li>)}</ul>
    </>}
  </section>;
}
