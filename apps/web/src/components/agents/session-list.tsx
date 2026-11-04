import { AGENT_ROLE_LABEL, WORKER_PROFILE_LABEL } from '@vulnagent/shared';
import type { SessionDto } from '@vulnagent/shared';
import { cn, formatDuration, formatNumber } from '../../lib/utils';

const STATE_DOT: Record<string, string> = {
  running: 'bg-ok animate-pulse-dot',
  paused: 'bg-warn',
  completed: 'bg-brand-500',
  failed: 'bg-danger',
  terminated: 'bg-ink-400',
  created: 'bg-ink-400',
  idle: 'bg-ink-400',
};

const STATE_LABEL: Record<string, string> = {
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  terminated: '已终止',
  created: '已创建',
  idle: '空闲',
};

export function SessionList({
  sessions,
  activeId,
  onSelect,
}: {
  sessions: SessionDto[];
  activeId: string | null;
  onSelect: (session: SessionDto) => void;
}) {
  const planners = sessions.filter((s) => s.role === 'planner');
  const workers = sessions.filter((s) => s.role !== 'planner');

  const renderItem = (session: SessionDto) => {
    const active = session.id === activeId;
    const duration = session.startedAt
      ? (session.endedAt ? new Date(session.endedAt).getTime() : Date.now()) - new Date(session.startedAt).getTime()
      : null;
    return (
      <li key={session.id}>
        <button
          type="button"
          onClick={() => onSelect(session)}
          className={cn(
            'w-full border-l-2 px-3 py-2 text-left transition-colors',
            active
              ? 'border-brand-500 bg-brand-50/70'
              : 'border-transparent hover:bg-slate-50',
          )}
        >
          <div className="flex items-center gap-1.5">
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATE_DOT[session.state] ?? 'bg-ink-400')} />
            <span className="truncate text-[12px] font-medium text-ink-900">
              {session.profileId ? WORKER_PROFILE_LABEL[session.profileId] ?? session.profileId : AGENT_ROLE_LABEL[session.role]}
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2 pl-3 text-[10px] text-ink-400">
            <span>{STATE_LABEL[session.state] ?? session.state}</span>
            <span className="font-mono tabular">
              {formatNumber(session.tokenInput + session.tokenOutput)} tok
            </span>
          </div>
          <div className="pl-3 text-[10px] text-ink-400">
            {session.messageCount} 条消息 · {formatDuration(duration)}
          </div>
        </button>
      </li>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {planners.length > 0 ? (
        <>
          <p className="border-b border-ink-200 bg-slate-50/80 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
            规划器
          </p>
          <ul>{planners.map(renderItem)}</ul>
        </>
      ) : null}
      {workers.length > 0 ? (
        <>
          <p className="border-b border-t border-ink-200 bg-slate-50/80 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
            Worker（{workers.length}）
          </p>
          <ul className="min-h-0 flex-1 overflow-y-auto">{workers.map(renderItem)}</ul>
        </>
      ) : null}
      {sessions.length === 0 ? (
        <p className="px-3 py-6 text-center text-[11px] text-ink-400">暂无会话</p>
      ) : null}
    </div>
  );
}
