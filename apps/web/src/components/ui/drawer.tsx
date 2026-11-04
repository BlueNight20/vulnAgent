import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

export function Drawer({
  open,
  onClose,
  title,
  description,
  width = 'w-[560px]',
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  width?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="关闭抽屉"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-navy-900/35 backdrop-blur-[1px]"
      />
      <aside
        className={cn(
          'relative flex h-full flex-col bg-white shadow-drawer animate-slide-in-right',
          width,
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-ink-200 px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-ink-900">{title}</h2>
            {description ? (
              <div className="mt-0.5 text-[11px] text-ink-400">{description}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-400 transition-colors hover:bg-slate-100 hover:text-ink-900"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-ink-200 bg-slate-50/60 px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </aside>
    </div>,
    document.body,
  );
}
