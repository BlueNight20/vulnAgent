import { AlertCircle, CheckCircle2, RefreshCw, WifiOff } from 'lucide-react';
import type { McpServerDto } from '@vulnagent/shared';
import { Button } from '../ui/button';
import { McpStatusBadge } from '../common/status-badge';
import { formatDateTime, formatDuration } from '../../lib/utils';

export function McpOverview({
  servers,
  checkingId,
  onCheck,
}: {
  servers: McpServerDto[];
  checkingId: string | null;
  onCheck: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      {servers.map((server) => {
        const online = server.status === 'online';
        const unchecked = server.status === 'unknown';
        return (
          <div
            key={server.id}
            className="rounded-lg border border-ink-200 bg-white p-4 shadow-panel"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <span
                  className={`mt-0.5 grid h-9 w-9 place-items-center rounded-md ${
                    online
                      ? 'bg-emerald-50 text-emerald-600'
                      : unchecked
                        ? 'bg-slate-100 text-ink-400'
                        : 'bg-slate-100 text-ink-600'
                  }`}
                >
                  {online ? (
                    <CheckCircle2 className="h-4.5 w-4.5" />
                  ) : unchecked ? (
                    <AlertCircle className="h-4.5 w-4.5" />
                  ) : (
                    <WifiOff className="h-4.5 w-4.5" />
                  )}
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-[14px] font-semibold text-ink-900">{server.name}</p>
                    <McpStatusBadge status={server.status} />
                    <span className="rounded border border-ink-200 px-1 text-[10px] text-ink-400">
                      {server.source === 'env' ? '环境变量' : '手动'}
                    </span>
                    {!server.enabled ? (
                      <span className="rounded bg-slate-100 px-1 text-[10px] text-ink-400">已禁用</span>
                    ) : null}
                  </div>
                  <p className="mt-1 font-mono text-[12px] text-ink-600">{server.endpoint}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-400">
                    <span>传输：{server.transport === 'streamable-http' ? 'Streamable HTTP' : 'SSE'}</span>
                    <span>工具数：{server.toolCount}</span>
                    <span>延迟：{formatDuration(server.latencyMs)}</span>
                    <span>最近检测：{formatDateTime(server.lastCheckedAt)}</span>
                  </div>
                </div>
              </div>
              <Button
                variant={online ? 'secondary' : 'primary'}
                loading={checkingId === server.id}
                onClick={() => onCheck(server.id)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                重新检测
              </Button>
            </div>

            {server.status !== 'online' ? (
              <div className="mt-3 rounded-md border border-ink-200 bg-slate-50 px-3 py-2">
                <p className="text-[11px] font-medium text-ink-600">
                  {unchecked ? '尚未执行连接检测' : '连接失败原因（真实检测结果）'}
                </p>
                <p className="mt-0.5 break-all font-mono text-[11px] text-ink-600">
                  {server.lastError ?? '点击「重新检测」调用 MCP 客户端执行 connect + tools/list'}
                </p>
                <p className="mt-2 text-[11px] text-ink-400">
                  排查建议：确认 blhackbox 已启动并加载 gateway profile
                  （<code className="rounded bg-white px-1 font-mono">docker compose --profile gateway up -d</code>），
                  并核对 MCP_GATEWAY_URL 指向 http://localhost:8080/mcp。
                </p>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
