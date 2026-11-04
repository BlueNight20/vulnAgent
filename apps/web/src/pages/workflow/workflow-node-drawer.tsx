import { WORKER_PROFILE_LABEL } from '@vulnagent/shared';
import type { WorkflowNode } from '../../api/agents';
import { Drawer } from '../../components/ui/drawer';
import { Badge } from '../../components/ui/badge';
import { statusLabel } from '../../features/workflow/graph-mapper';
import { formatDuration, formatNumber } from '../../lib/utils';

function JsonBlock({ value, empty }: { value: unknown; empty: string }) {
  if (value === null || value === undefined || (typeof value === 'object' && Object.keys(value as object).length === 0)) {
    return <p className="rounded bg-slate-50 px-2.5 py-2 text-[11px] text-ink-400">{empty}</p>;
  }
  return (
    <pre className="max-h-[240px] overflow-auto rounded border border-ink-200 bg-navy-900 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-200">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function WorkflowNodeDrawer({ node, onClose }: { node: WorkflowNode | null; onClose: () => void }) {
  const detail = (node?.detail ?? {}) as Record<string, unknown>;

  return (
    <Drawer
      open={Boolean(node)}
      onClose={onClose}
      title={
        node
          ? node.kind === 'orchestrator'
            ? 'Orchestrator Core'
            : node.kind === 'planner'
              ? node.label || 'Planner'
              : (node.profileId ? (WORKER_PROFILE_LABEL as Record<string, string>)[node.profileId] : null) ?? node.label
          : '节点详情'
      }
      description={
        node ? (
          <span className="flex items-center gap-2">
            <span>{statusLabel(node.status)}</span>
            <span>·</span>
            <span>{node.title}</span>
          </span>
        ) : undefined
      }
      width="w-[540px]"
    >
      {node ? (
        <div className="space-y-4">
          <section>
            <p className="mb-1.5 text-[12px] font-semibold text-ink-900">运行概况</p>
            <dl className="grid grid-cols-[96px_1fr] gap-y-1 rounded border border-ink-200 px-3 py-2 text-[12px]">
              <dt className="text-ink-400">类型</dt>
              <dd>{node.kind === 'orchestrator' ? '编排核心' : node.kind === 'planner' ? '规划器会话' : 'Worker 任务'}</dd>
              <dt className="text-ink-400">状态</dt>
              <dd>
                <Badge tone={node.status === 'failed' || node.status === 'timeout' ? 'danger' : node.status === 'succeeded' ? 'success' : 'brand'}>
                  {statusLabel(node.status)}
                </Badge>
              </dd>
              <dt className="text-ink-400">Token</dt>
              <dd className="font-mono">{formatNumber(node.tokens)}</dd>
              <dt className="text-ink-400">耗时</dt>
              <dd>{formatDuration(node.durationMs)}</dd>
              <dt className="text-ink-400">证据条数</dt>
              <dd className="font-mono">{node.evidenceCount}</dd>
              {typeof detail.error === 'string' && detail.error ? (
                <>
                  <dt className="text-ink-400">错误</dt>
                  <dd className="text-danger">{detail.error}</dd>
                </>
              ) : null}
            </dl>
          </section>

          {detail.objective ? (
            <section>
              <p className="mb-1.5 text-[12px] font-semibold text-ink-900">任务目标与假设</p>
              <p className="text-[12px] text-ink-600">目标：{String(detail.objective)}</p>
              <p className="mt-1 text-[12px] text-ink-600">假设：{String(detail.hypothesis || '—')}</p>
              {detail.score !== null && detail.score !== undefined ? (
                <p className="mt-1 text-[12px] text-ink-600">
                  探索评分：<span className="font-mono">{Number(detail.score).toFixed(3)}</span>
                </p>
              ) : null}
            </section>
          ) : null}

          {detail.scoreBreakdown ? (
            <section>
              <p className="mb-1.5 text-[12px] font-semibold text-ink-900">评分构成（可解释）</p>
              <ul className="grid grid-cols-2 gap-1 text-[11px] text-ink-600">
                {Object.entries(detail.scoreBreakdown as Record<string, number>).map(([key, value]) => (
                  <li key={key} className="flex justify-between rounded bg-slate-50 px-2 py-1">
                    <span>{key}</span>
                    <span className="font-mono">{value.toFixed(3)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section>
            <p className="mb-1.5 text-[12px] font-semibold text-ink-900">节点输入</p>
            <JsonBlock value={detail.input} empty="无输入记录" />
          </section>

          <section>
            <p className="mb-1.5 text-[12px] font-semibold text-ink-900">节点输出</p>
            <JsonBlock value={detail.output} empty="尚未产生输出" />
          </section>

          {detail.stateCard ? (
            <section>
              <p className="mb-1.5 text-[12px] font-semibold text-ink-900">状态卡</p>
              <JsonBlock value={detail.stateCard} empty="暂无状态卡" />
            </section>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
