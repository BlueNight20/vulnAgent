import * as React from 'react';
import { cn } from '../../lib/utils';

export interface TabItem {
  key: string;
  label: string;
  count?: number;
}

export function Tabs({
  items,
  value,
  onChange,
  className,
}: {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-1 border-b border-ink-200', className)} role="tablist">
      {items.map((item) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.key)}
            className={cn(
              'relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
              active
                ? 'border-brand-500 text-brand-600'
                : 'border-transparent text-ink-600 hover:text-ink-900',
            )}
          >
            {item.label}
            {typeof item.count === 'number' ? (
              <span className="rounded bg-slate-100 px-1 text-[10px] tabular text-ink-600">
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
