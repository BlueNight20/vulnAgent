import { useEffect, useRef } from 'react';
import type { SessionMessageItem } from '../../api/agents';
import { cn } from '../../lib/utils';

const ROLE_META: Record<string, { label: string; tone: string }> = {
  user: { label: '任务指令', tone: 'border-brand-200 bg-brand-50/50' },
  assistant: { label: '模型输出', tone: 'border-ink-200 bg-white' },
  toolResult: { label: '工具结果', tone: 'border-amber-200 bg-amber-50/40' },
  system: { label: '系统提示', tone: 'border-slate-200 bg-slate-50' },
};

export function MessageStream({
  messages,
  loading,
}: {
  messages: SessionMessageItem[];
  loading: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  if (loading) {
    return <p className="px-4 py-6 text-[12px] text-ink-400">加载会话消息…</p>;
  }
  if (messages.length === 0) {
    return <p className="px-4 py-6 text-[12px] text-ink-400">该会话还没有消息。</p>;
  }

  return (
    <div className="space-y-2.5 px-4 py-3">
      {messages.map((message) => {
        const meta = ROLE_META[message.role] ?? ROLE_META.assistant;
        return (
          <article key={message.id} className={cn('rounded-md border px-3 py-2', meta.tone)}>
            <header className="mb-1 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                #{message.seq} {meta.label}
                {message.toolName ? (
                  <span className="rounded bg-white px-1 font-mono text-[10px] normal-case text-ink-600 ring-1 ring-inset ring-ink-200">
                    {message.toolName}
                  </span>
                ) : null}
              </span>
              {message.usage ? (
                <span className="font-mono text-[10px] tabular text-ink-400">
                  in {message.usage.input} / out {message.usage.output}
                  {message.usage.cost > 0 ? ` · $${message.usage.cost.toFixed(5)}` : ''}
                </span>
              ) : null}
            </header>
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-ink-900">
              {message.content || (message.messageJson ? '（无文本，工具调用等信息见下方完整消息）' : '（空）')}
            </pre>
            {message.messageJson ? <details className="mt-2 border-t border-ink-200 pt-2">
              <summary className="cursor-pointer text-[11px] text-brand-600">完整会话消息（含工具参数）</summary>
              {message.content.length >= 8000 ? <p className="mt-1 text-[10px] text-ink-400">上方为文本预览；下方为保存的完整会话结构，工具原始证据可在证据管理查看。</p> : null}
              <pre className="mt-1 max-h-[420px] overflow-auto whitespace-pre-wrap break-words text-[11px] text-ink-600">{JSON.stringify(message.messageJson, null, 2)}</pre>
            </details> : null}
          </article>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
