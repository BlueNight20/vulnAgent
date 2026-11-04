import * as React from 'react';

export function PageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-6">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-ink-900">
            {title}
          </h1>
          {meta}
        </div>
        {description ? <p className="mt-1 text-[12px] text-ink-600">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
