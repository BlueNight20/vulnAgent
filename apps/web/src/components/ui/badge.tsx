import * as React from 'react';
import { cn } from '../../lib/utils';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

const TONE: Record<BadgeTone, { wrap: string; dot: string }> = {
  neutral: { wrap: 'bg-slate-100 text-ink-600 ring-slate-200', dot: 'bg-ink-400' },
  success: { wrap: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dot: 'bg-ok' },
  warning: { wrap: 'bg-amber-50 text-amber-700 ring-amber-200', dot: 'bg-warn' },
  danger: { wrap: 'bg-red-50 text-red-700 ring-red-200', dot: 'bg-danger' },
  info: { wrap: 'bg-cyan-50 text-cyan-700 ring-cyan-200', dot: 'bg-info' },
  brand: { wrap: 'bg-brand-50 text-brand-700 ring-brand-100', dot: 'bg-brand-500' },
};

export interface BadgeProps {
  tone?: BadgeTone;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function Badge({ tone = 'neutral', dot = true, pulse, className, children }: BadgeProps) {
  const t = TONE[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
        t.wrap,
        className,
      )}
    >
      {dot ? (
        <span className={cn('h-1.5 w-1.5 rounded-full', t.dot, pulse && 'animate-pulse-dot')} />
      ) : null}
      {children}
    </span>
  );
}
