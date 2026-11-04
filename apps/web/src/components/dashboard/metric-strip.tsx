import type { DashboardSummary } from '@vulnagent/shared';
import { cn, formatCost, formatNumber } from '../../lib/utils';

interface Metric {
  label: string;
  value: string;
  sub: string;
  tone?: 'default' | 'brand' | 'warn' | 'ok' | 'danger';
}

export function MetricStrip({ summary, loading }: { summary?: DashboardSummary; loading: boolean }) {
  const metrics: Metric[] = [
    {
      label: '测试任务总数',
      value: loading ? '—' : String(summary?.tasks.total ?? 0),
      sub: `已完成 ${summary?.tasks.completed ?? 0} · 失败 ${summary?.tasks.failed ?? 0}`,
    },
    {
      label: '正在运行',
      value: loading ? '—' : String(summary?.tasks.running ?? 0),
      sub: `待启动 ${summary?.tasks.pending ?? 0} · 暂停 ${summary?.tasks.paused ?? 0}`,
      tone: (summary?.tasks.running ?? 0) > 0 ? 'brand' : 'default',
    },
    {
      label: '漏洞候选',
      value: loading ? '—' : String(summary?.findings.candidate ?? 0),
      sub: `验证中 ${summary?.findings.verifying ?? 0} · 无法确认 ${summary?.findings.unconfirmed ?? 0}`,
      tone: 'warn',
    },
    {
      label: '已验证漏洞',
      value: loading ? '—' : String(summary?.findings.confirmed ?? 0),
        sub: `记录总数 ${summary?.findings.total ?? 0} · 已排除 ${summary?.findings.refuted ?? 0}`,
      tone: 'ok',
    },
    {
      label: 'Token 消耗',
      value: loading ? '—' : formatNumber(summary?.usage.tokens ?? 0),
      sub: '来自 model_usage 表聚合',
    },
    {
      label: '预估成本',
      value: loading ? '—' : formatCost(summary?.usage.costUsd ?? 0),
      sub: '按模型单价累计',
    },
  ];

  const toneClass: Record<NonNullable<Metric['tone']>, string> = {
    default: 'text-ink-900',
    brand: 'text-brand-600',
    warn: 'text-amber-600',
    ok: 'text-emerald-600',
    danger: 'text-danger',
  };

  return (
    <div className="grid grid-cols-2 divide-x divide-ink-200 overflow-hidden rounded-lg border border-ink-200 bg-white shadow-panel md:grid-cols-3 xl:grid-cols-6">
      {metrics.map((m, idx) => (
        <div
          key={m.label}
          className={cn(
            'px-4 py-3',
            idx >= 3 && 'border-t border-ink-200 xl:border-t-0',
            idx === 2 && 'md:border-t xl:border-t-0',
          )}
        >
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{m.label}</p>
          <p
            className={cn(
              'mt-1 font-mono text-[28px] font-semibold leading-none tabular',
              toneClass[m.tone ?? 'default'],
            )}
          >
            {m.value}
          </p>
          <p className="mt-1.5 truncate text-[11px] text-ink-400">{m.sub}</p>
        </div>
      ))}
    </div>
  );
}
