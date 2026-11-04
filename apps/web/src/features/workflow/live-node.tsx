import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { cn, formatDuration, formatNumber } from '../../lib/utils';
import { statusLabel, type FlowNodeData } from './graph-mapper';

export type LiveNodeType = Node<FlowNodeData, 'liveNode'>;

const STATUS_STYLE: Record<string, string> = {
  running: 'text-brand-600 bg-brand-50 ring-brand-200',
  executing: 'text-brand-600 bg-brand-50 ring-brand-200',
  planning: 'text-brand-600 bg-brand-50 ring-brand-200',
  succeeded: 'text-emerald-700 bg-emerald-50 ring-emerald-200',
  completed: 'text-emerald-700 bg-emerald-50 ring-emerald-200',
  queued: 'text-ink-600 bg-slate-100 ring-slate-200',
  idle: 'text-ink-600 bg-slate-100 ring-slate-200',
  failed: 'text-red-700 bg-red-50 ring-red-200',
  timeout: 'text-red-700 bg-red-50 ring-red-200',
  stalled: 'text-amber-700 bg-amber-50 ring-amber-200',
};

const KIND_LABEL: Record<string, string> = {
  orchestrator: '编排核心',
  planner: '规划器',
  worker: '执行单元',
};

function LiveNodeComponent({ data, selected }: NodeProps<LiveNodeType>) {
  const tone = STATUS_STYLE[data.status] ?? STATUS_STYLE.idle;
  const active = data.status === 'running' || data.status === 'executing' || data.status === 'planning';

  return (
    <div
      className={cn(
        'w-[224px] overflow-hidden rounded-md border bg-white shadow-panel transition-shadow',
        selected ? 'border-brand-500 ring-2 ring-brand-500/20' : 'border-ink-200',
      )}
    >
      <div className="h-1 w-full" style={{ background: data.color }} />
      <div className="px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-[12px] font-semibold text-ink-900">{data.label}</p>
          <span
            className={cn(
              'flex shrink-0 items-center gap-1 rounded px-1 py-px text-[10px] font-medium ring-1 ring-inset',
              tone,
            )}
          >
            {active ? <span className="h-1 w-1 animate-pulse-dot rounded-full bg-current" /> : null}
            {statusLabel(data.status)}
          </span>
        </div>
        <p className="mt-0.5 text-[10px] uppercase tracking-wide text-ink-400">{KIND_LABEL[data.kind] ?? data.kind}</p>
        <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-ink-600">{data.title || '—'}</p>
        <div className="mt-2 flex items-center justify-between border-t border-ink-200/70 pt-1.5 text-[10px] text-ink-400">
          <span>{formatDuration(data.durationMs)}</span>
          <span className="font-mono tabular">{formatNumber(data.tokens)} tok</span>
          <span>{data.evidenceCount} 证据</span>
        </div>
      </div>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-ink-400" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-ink-400" />
    </div>
  );
}

export const LiveNode = memo(LiveNodeComponent);
export const nodeTypes = { liveNode: LiveNode };
