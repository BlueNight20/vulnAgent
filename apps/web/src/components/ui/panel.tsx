import * as React from 'react';
import { cn } from '../../lib/utils';

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  dense,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  dense?: boolean;
}) {
  return (
    <section
      className={cn(
        'flex min-h-0 flex-col rounded-lg border border-ink-200 bg-white shadow-panel',
        className,
      )}
    >
      {title ? (
        <header className="flex items-center justify-between gap-3 border-b border-ink-200/80 px-4 py-2.5">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-ink-900">{title}</h2>
            {description ? <p className="mt-0.5 text-[11px] text-ink-400">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn('min-h-0 flex-1', dense ? '' : 'p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function TableShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  );
}

export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'whitespace-nowrap border-b border-ink-200 bg-slate-50/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-400',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn('border-b border-ink-200/60 px-3 py-2 align-middle text-ink-900', className)}
    >
      {children}
    </td>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon ? <div className="text-ink-400">{icon}</div> : null}
      <p className="text-sm font-medium text-ink-600">{title}</p>
      {description ? <p className="max-w-md text-xs text-ink-400">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function LoadingBlock({ label = '加载中' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-8 text-xs text-ink-400">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-ink-200 border-t-brand-500" />
      {label}…
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-1.5 rounded-md border border-red-200 bg-red-50/60 px-3 py-2.5">
      <p className="text-xs font-medium text-red-700">数据加载失败</p>
      <p className="text-[11px] text-red-600">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded border border-red-300 bg-white px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-100"
        >
          重试
        </button>
      ) : null}
    </div>
  );
}
