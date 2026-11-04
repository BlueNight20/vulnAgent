import * as React from 'react';
import { cn } from '../../lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-8 w-full rounded-md border border-ink-200 bg-white px-2.5 text-[13px] text-ink-900 placeholder:text-ink-400',
        'transition-colors focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500/40',
        'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-ink-400',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-[13px] text-ink-900 placeholder:text-ink-400',
      'transition-colors focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500/40',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'h-8 w-full cursor-pointer appearance-none rounded-md border border-ink-200 bg-white pl-2.5 pr-7 text-[13px] text-ink-900',
      'bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20viewBox%3D%270%200%2016%2016%27%20fill%3D%27%2394A3B8%27%3E%3Cpath%20d%3D%27M4%206l4%204%204-4z%27/%3E%3C/svg%3E")] bg-[length:14px] bg-[right_6px_center] bg-no-repeat',
      'transition-colors focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500/40',
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = 'Select';

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs font-medium text-ink-600">
        {label}
        {required ? <span className="ml-0.5 text-danger">*</span> : null}
      </span>
      {children}
      {error ? (
        <span className="text-[11px] text-danger">{error}</span>
      ) : hint ? (
        <span className="text-[11px] text-ink-400">{hint}</span>
      ) : null}
    </label>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  size = 'md',
  label,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  label?: string;
}) {
  const dims = size === 'sm' ? { w: 'w-7', h: 'h-4', knob: 'h-3 w-3', shift: 'translate-x-3' } : { w: 'w-9', h: 'h-5', knob: 'h-4 w-4', shift: 'translate-x-4' };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full transition-colors focus-ring',
        dims.w,
        dims.h,
        checked ? 'bg-brand-500' : 'bg-slate-300',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'inline-block translate-x-0.5 rounded-full bg-white shadow transition-transform',
          dims.knob,
          checked && dims.shift,
        )}
      />
    </button>
  );
}
