import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Terminal, Wrench } from 'lucide-react';
import type { ToolCallDetailDto } from '@vulnagent/shared';
import { toolCallApi } from '../../api/blackboard';
import { formatDuration } from '../../lib/utils';
import { cn } from '../../lib/utils';

/**
 * 会话内工具调用可视化（对齐 artex 的折叠行形态）。
 *
 * 折叠态一行：箭头 + 图标 + 工具名 + 参数摘要 + 状态字。
 * 展开态：输入 JSON 与失败/成功原因。状态色：执行中/成功/失败三档。
 * 与 artex 的差异：本项目的调用记录在落库后才可见，因此不存在"参数流式到达"的中间态。
 */

type Tone = 'running' | 'ok' | 'fail';

function toneOf(status: string): Tone {
  if (status === 'pending_approval') return 'running';
  if (status === 'success') return 'ok';
  return 'fail';
}

const TONE_TEXT: Record<Tone, string> = {
  running: 'text-sky-600',
  ok: 'text-emerald-600',
  fail: 'text-red-600',
};

const TONE_LABEL: Record<Tone, string> = {
  running: '等待审批…',
  ok: '✓ 成功',
  fail: '✕ 失败',
};

const STATUS_LABEL: Record<string, string> = {
  success: '成功',
  error: '错误',
  denied: '被拦截',
  timeout: '超时',
  cancelled: '已取消',
  pending_approval: '待审批',
  rejected: '已拒绝',
  expired: '已过期',
};

/** 参数单行摘要：优先展示命令/目标，避免把整段 JSON 铺开。 */
function summaryOf(call: ToolCallDetailDto): string {
  const args = call.arguments ?? {};
  const preferred = ['command', 'cmd', 'target', 'url', 'host', 'path', 'query'];
  for (const key of preferred) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  }
  const text = JSON.stringify(args);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export function ToolCallPanel({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const calls = useQuery({
    queryKey: ['toolCalls', taskId],
    queryFn: () => toolCallApi.list(taskId, 80),
    enabled: Boolean(taskId),
    refetchInterval: 5000,
  });

  const items: ToolCallDetailDto[] = calls.data?.items ?? [];
  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section>
      <p className="mb-1.5 text-[12px] font-semibold text-ink-900">
        工具调用（{calls.data?.total ?? 0}）
      </p>
      {items.length === 0 ? (
        <p className="rounded bg-slate-50 px-3 py-3 text-[11px] text-ink-400">
          暂无工具调用。Worker 执行真实工具后会记录在这里，包含输入参数、耗时与失败原因。
        </p>
      ) : (
        <div className="max-h-[420px] divide-y divide-ink-200/60 overflow-auto rounded border border-ink-200">
          {items.map((call) => {
            const tone = toneOf(call.status);
            const expanded = open.has(call.id);
            return (
              <div key={call.id}>
                <button
                  type="button"
                  onClick={() => toggle(call.id)}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-slate-50"
                >
                  <ChevronRight className={cn('h-3 w-3 shrink-0 text-ink-400 transition-transform', expanded && 'rotate-90')} />
                  {/^(?:bash|shell|exec)/i.test(call.toolName)
                    ? <Terminal className={cn('h-3.5 w-3.5 shrink-0', TONE_TEXT[tone])} />
                    : <Wrench className={cn('h-3.5 w-3.5 shrink-0', TONE_TEXT[tone])} />}
                  <span className="shrink-0 font-mono text-[11px] text-sky-600">{call.toolName}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-400">{summaryOf(call)}</span>
                  <span className={cn('shrink-0 text-[10px]', TONE_TEXT[tone])}>{TONE_LABEL[tone]}</span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-400">
                    {call.latencyMs > 0 ? formatDuration(call.latencyMs) : ''}
                  </span>
                </button>
                {expanded ? (
                  <div className="space-y-1.5 px-7 pb-2">
                    <p className="text-[10px] uppercase tracking-wide text-ink-400">命令 / 参数</p>
                    <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 px-2.5 py-1.5 font-mono text-[11px] text-ink-900">
                      {JSON.stringify(call.arguments ?? {}, null, 2)}
                    </pre>
                    <p className="text-[10px] uppercase tracking-wide text-ink-400">
                      输出 {tone === 'ok' ? '✓' : '✕'} · {STATUS_LABEL[call.status] ?? call.status}
                    </p>
                    <pre className={cn(
                      'max-h-[200px] overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 px-2.5 py-1.5 font-mono text-[11px]',
                      tone === 'fail' ? 'text-red-700' : 'text-ink-900',
                    )}>
                      {call.errorMessage ?? (call.rawOutputRef ? `证据 ${call.rawOutputRef}` : '（无输出）')}
                    </pre>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
