import { Search } from 'lucide-react';
import { TASK_STATUS_LABEL } from '@vulnagent/shared';
import type { TaskStatus } from '@vulnagent/shared';
import { Input, Select } from '../ui/input';
import { cn } from '../../lib/utils';

interface Props {
  keyword: string;
  onKeywordChange: (v: string) => void;
  status: string;
  onStatusChange: (v: string) => void;
  stats: Record<string, number>;
  total: number;
}

const STATUS_ORDER: TaskStatus[] = ['running', 'pending', 'paused', 'stopped', 'completed', 'failed'];

export function TaskFilterBar({
  keyword,
  onKeywordChange,
  status,
  onStatusChange,
  stats,
  total,
}: Props) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
          <Input
            value={keyword}
            onChange={(e) => onKeywordChange(e.target.value)}
            placeholder="搜索任务名称或描述"
            className="w-[240px] pl-7"
          />
        </div>
        <Select value={status} onChange={(e) => onStatusChange(e.target.value)} className="w-[140px]">
          <option value="">全部状态</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onStatusChange('')}
            className={cn(
              'rounded border px-2 py-1 text-[11px] transition-colors',
              status === ''
                ? 'border-brand-300 bg-brand-50 text-brand-700'
                : 'border-ink-200 bg-white text-ink-600 hover:border-ink-400/60',
            )}
          >
            全部 {total}
          </button>
          {STATUS_ORDER.filter((s) => (stats[s] ?? 0) > 0).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onStatusChange(s)}
              className={cn(
                'rounded border px-2 py-1 text-[11px] transition-colors',
                status === s
                  ? 'border-brand-300 bg-brand-50 text-brand-700'
                  : 'border-ink-200 bg-white text-ink-600 hover:border-ink-400/60',
              )}
            >
              {TASK_STATUS_LABEL[s]} {stats[s]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
