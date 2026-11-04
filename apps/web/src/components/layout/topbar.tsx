import { useHealth } from '../../hooks/use-health';
import { useWebSocket } from '../../hooks/use-websocket';
import { cn } from '../../lib/utils';

function StatusPill({
  label,
  ok,
  pending,
  detail,
}: {
  label: string;
  ok: boolean;
  pending?: boolean;
  detail?: string;
}) {
  const tone = pending ? 'text-warn' : ok ? 'text-ok' : 'text-danger';
  const dot = pending ? 'bg-warn' : ok ? 'bg-ok' : 'bg-danger';
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] text-ink-600"
      title={detail}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot, pending && 'animate-pulse-dot')} />
      <span>{label}</span>
      <span className={cn('font-medium', tone)}>{pending ? '检测中' : ok ? '正常' : '断开'}</span>
    </span>
  );
}

export function Topbar({ title, breadcrumb }: { title: string; breadcrumb: string }) {
  const health = useHealth();
  const ws = useWebSocket();

  const apiOk = health.isSuccess;
  const apiPending = health.isLoading;
  const wsOk = ws.status === 'open';
  const wsPending = ws.status === 'connecting';

  return (
    <header className="fixed left-0 right-0 top-0 z-20 flex h-14 items-center justify-between border-b border-ink-200 bg-white/95 px-6 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2.5 pl-[236px]">
        <span className="text-[12px] text-ink-400">{breadcrumb}</span>
        <span className="text-ink-200">/</span>
        <h1 className="truncate text-[15px] font-semibold text-ink-900">{title}</h1>
      </div>
      <div className="flex items-center gap-4">
        <StatusPill
          label="API"
          ok={apiOk}
          pending={apiPending}
          detail={health.data ? `版本 ${health.data.version} · 数据库 ${health.data.database}` : '无法访问 /api/health'}
        />
        <span className="h-3 w-px bg-ink-200" />
        <StatusPill
          label="WebSocket"
          ok={wsOk}
          pending={wsPending}
          detail={wsOk ? `客户端 ${ws.clientId ?? ''}` : 'ws://localhost:3001/ws'}
        />
        <span className="h-3 w-px bg-ink-200" />
        <span className="rounded border border-brand-100 bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">
          Pi Runtime · 多智能体调度已启用
        </span>
      </div>
    </header>
  );
}
