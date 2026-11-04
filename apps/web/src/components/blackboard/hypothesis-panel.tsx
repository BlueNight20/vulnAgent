import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { HypothesisDto, HypothesisLinkDto } from '@vulnagent/shared';
import { api } from '../../api/client';

const relationLabels: Record<string, string> = { supports: '支持解释', contradicts: '反驳解释', depends_on: '研究计划', refines: '研究线索' };
export function HypothesisLinks({ taskId, links }: { taskId: string; links: HypothesisLinkDto[] }) {
  return <ul className="space-y-2">
    {links.map((l) => <li key={l.id} className="rounded border border-ink-200 bg-white p-2 text-xs">
      <p>{relationLabels[l.linkType] ?? l.linkType} · {l.targetType} · <span className="break-all font-mono">{l.targetId}</span></p>
      <p className="mt-1 text-ink-600">来源：{l.assessmentSource === 'agent' ? '模型解释' : l.assessmentSource === 'user' ? '人工解释' : '历史关联'} · {l.validation === 'valid' ? l.counted ? '来源校验通过' : '仅关联，不计入支持/反驳' : '未计入当前判断'}</p>
      {l.invalidReason && <p className="mt-1 text-red-700">{l.invalidReason}</p>}
      {l.note && <p className="mt-1 whitespace-pre-wrap break-words">{l.note}</p>}
      {(l.evidenceQuotes ?? []).map((q, i) => <div key={`${q.evidenceId}:${i}`} className="mt-2">
        <Link className="break-all text-brand-600 underline" to={`/evidence?task=${encodeURIComponent(taskId)}&id=${encodeURIComponent(q.evidenceId)}`}>查看原始证据 {q.evidenceId}</Link>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2">{q.quote}</pre>
      </div>)}
    </li>)}
  </ul>;
}

export function HypothesisPanel({ taskId }: { taskId: string }) {
  const [params] = useSearchParams();
  const [selectedId, setSelectedId] = useState(params.get('hypothesis') ?? '');
  const list = useQuery({ queryKey: ['hypotheses', taskId], queryFn: () => api.get<{ items: HypothesisDto[] }>(`/tasks/${encodeURIComponent(taskId)}/hypotheses`), enabled: Boolean(taskId), refetchInterval: 10000 });
  const detail = useQuery({ queryKey: ['hypothesis-detail', taskId, selectedId], queryFn: () => api.get<{ hypothesis: HypothesisDto; links: HypothesisLinkDto[] }>(`/tasks/${encodeURIComponent(taskId)}/hypotheses/${encodeURIComponent(selectedId)}`), enabled: Boolean(taskId && selectedId), refetchInterval: 10000 });
  return <section className="space-y-2 text-xs">
    <p className="text-ink-500">支持/反驳按完整原文来源去重；属于分析解释，漏洞确认仍需独立验证。</p>
    {list.isPending && <p>正在核对假设依据…</p>}
    {list.error && <p role="alert" className="text-red-700">{list.error.message}</p>}
    {!list.isPending && !list.error && !list.data?.items.length && <p>暂无攻击假设。</p>}
    <div className="max-h-64 space-y-2 overflow-auto">{list.data?.items.map((h) => <button key={h.id} aria-pressed={h.id === selectedId} onClick={() => setSelectedId(h.id === selectedId ? '' : h.id)} className="block w-full rounded border border-ink-200 p-2 text-left hover:bg-slate-50">
      <span className="font-medium">{h.title}</span>
      <span className="ml-2">{h.conflicted ? '依据冲突，待验证' : h.status === 'supported' ? '有支持解释' : h.status === 'refuted' ? '有反驳解释' : '待验证'}</span>
      <span className="mt-1 block text-ink-500">{h.targetIp ?? '未绑定目标'} · 支持/反驳 {h.supportCount}/{h.contradictCount} · 无效/旧关联 {h.invalidLinkCount ?? 0}</span>
    </button>)}</div>
    {selectedId && <div className="space-y-2">
      {detail.isPending && <p>正在加载引用…</p>}
      {detail.error && <p role="alert" className="text-red-700">{detail.error.message}</p>}
      {detail.data && <><p className="whitespace-pre-wrap break-words">{detail.data.hypothesis.description}</p><HypothesisLinks taskId={taskId} links={detail.data.links} />{!detail.data.links.length && <p>尚无明确关联依据。</p>}</>}
    </div>}
  </section>;
}
