import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleDot, XCircle } from 'lucide-react';
import type { FactDto } from '@vulnagent/shared';
import { FACT_CATEGORY_LABEL, FACT_STATUS_LABEL } from '@vulnagent/shared';
import { factApi } from '../../api/blackboard';
import { Badge } from '../ui/badge';

const KIND_META: Record<string, { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' }> = {
  target_state: { label: '目标状态', tone: 'success' },
  target_negative: { label: '目标否定', tone: 'warning' },
  probe_error: { label: '探测失败', tone: 'danger' },
  inference: { label: '模型推断', tone: 'neutral' },
};

const STATUS_ICON: Record<string, React.ReactNode> = {
  verified: <CheckCircle2 className="h-3 w-3 text-emerald-600" />,
  observed: <CircleDot className="h-3 w-3 text-brand-600" />,
  inferred: <CircleDot className="h-3 w-3 text-ink-400" />,
  refuted: <XCircle className="h-3 w-3 text-red-600" />,
};

export function FactPanel({ taskId }: { taskId: string }) {
  const facts = useQuery({
    queryKey: ['facts', taskId],
    queryFn: () => factApi.list(taskId),
    enabled: Boolean(taskId),
    refetchInterval: 6000,
  });

  const items = facts.data?.items ?? [];
  const kindCounts = facts.data?.kindCounts ?? {};

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 divide-x divide-ink-200 overflow-hidden rounded border border-ink-200 bg-white">
        {[
          { key: 'target_state', label: '目标状态', value: kindCounts.target_state ?? 0 },
          { key: 'target_negative', label: '目标否定', value: kindCounts.target_negative ?? 0 },
          { key: 'probe_error', label: '探测失败', value: kindCounts.probe_error ?? 0 },
          { key: 'inference', label: '模型推断', value: kindCounts.inference ?? 0 },
        ].map((stat) => (
          <div key={stat.key} className="px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-ink-400">{stat.label}</p>
            <p className="font-mono text-[15px] font-semibold tabular text-ink-900">{stat.value}</p>
          </div>
        ))}
      </div>

      <section>
        <p className="mb-1.5 text-[12px] font-semibold text-ink-900">
          事实黑板（{facts.data?.total ?? 0}）
        </p>
        {facts.isLoading ? (
          <p className="text-[11px] text-ink-400">加载中…</p>
        ) : items.length === 0 ? (
          <p className="rounded bg-slate-50 px-3 py-4 text-center text-[11px] text-ink-400">
            暂无事实。启动引擎后，Worker 调用真实工具产生的结果会写入这里。
          </p>
        ) : (
          <ul className="max-h-[420px] space-y-1 overflow-y-auto">
            {items.map((fact) => (
              <FactRow key={fact.id} fact={fact} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FactRow({ fact }: { fact: FactDto }) {
  const kind = KIND_META[fact.observationKind] ?? KIND_META.inference;
  return (
    <li className="rounded border border-ink-200 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        {STATUS_ICON[fact.status]}
        <span className="truncate font-mono text-[11px] text-ink-900">{fact.subject}</span>
        <span className="shrink-0 text-[10px] text-ink-400">{fact.predicate}</span>
        <Badge tone={kind.tone}>{kind.label}</Badge>
        <span className="ml-auto shrink-0 text-[10px] text-ink-400">
          {FACT_CATEGORY_LABEL[fact.category] ?? fact.category}
        </span>
      </div>
      <p className="mt-0.5 break-words pl-[18px] text-[11px] text-ink-600">{fact.object}</p>
      <div className="mt-0.5 flex flex-wrap items-center gap-2 pl-[18px] text-[10px] text-ink-400">
        <span>状态 {FACT_STATUS_LABEL[fact.status]}</span>
        <span>置信度 {fact.confidence.toFixed(2)}</span>
        {fact.sourceTool ? <span className="font-mono">{fact.sourceTool}</span> : null}
        {fact.sourceEvidenceIds.map((id, index) => <Link key={id} className="text-brand-500 underline" to={`/evidence?task=${encodeURIComponent(fact.taskId)}&id=${encodeURIComponent(id)}`}>证据 {index + 1}</Link>)}
        {fact.conflictGroupId ? <span className="text-amber-700">冲突中</span> : null}
      </div>
    </li>
  );
}
