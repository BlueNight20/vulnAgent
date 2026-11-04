import type { McpServerDto } from '@vulnagent/shared';
import { TableShell, Td, Th } from '../ui/panel';
import { NoticeBanner } from '../common/notice-banner';
import { McpStatusBadge } from '../common/status-badge';
import { formatDateTime } from '../../lib/utils';

/**
 * 连接配置（只读）。
 * 第一阶段中连接参数由后端环境变量提供并被持久化到 mcp_servers 表，
 * 前端不提供直接改动端点的写接口，避免浏览器侧绕过审计修改连接目标。
 */
export function McpConfigTab({ servers }: { servers: McpServerDto[] }) {
  return (
    <div className="space-y-3 p-4">
      <NoticeBanner
        text="连接地址来自后端环境变量（MCP_GATEWAY_URL 等），启动时写入 mcp_servers 表；前端只读展示，避免在浏览器侧绕过审计修改连接目标。"
      />

      <TableShell>
        <thead>
          <tr>
            <Th>配置项</Th>
            <Th>当前值</Th>
            <Th>来源</Th>
            <Th>状态</Th>
            <Th>更新时间</Th>
          </tr>
        </thead>
        <tbody>
          {servers.map((s) => (
            <>
              <tr key={`${s.id}-name`} className="hover:bg-slate-50/70">
                <Td className="font-mono text-[12px]">MCP_GATEWAY_NAME</Td>
                <Td className="text-[12px]">{s.name}</Td>
                <Td className="text-[12px] text-ink-600">{s.source === 'env' ? '环境变量' : '手动写入'}</Td>
                <Td>
                  <McpStatusBadge status={s.status} />
                </Td>
                <Td className="text-[11px] text-ink-400">{formatDateTime(s.lastCheckedAt)}</Td>
              </tr>
              <tr key={`${s.id}-url`} className="hover:bg-slate-50/70">
                <Td className="font-mono text-[12px]">MCP_GATEWAY_URL</Td>
                <Td className="font-mono text-[12px]">{s.endpoint}</Td>
                <Td className="text-[12px] text-ink-600">环境变量</Td>
                <Td colSpan={2} className="text-[11px] text-ink-400">
                  传输：{s.transport === 'streamable-http' ? 'Streamable HTTP' : 'SSE'} · 启用：
                  {s.enabled ? '是' : '否'} · 认证头：{s.headersMasked ?? '未配置'}
                </Td>
              </tr>
            </>
          ))}
        </tbody>
      </TableShell>

      <div className="rounded-md border border-ink-200 bg-slate-50/70 p-3">
        <p className="mb-1.5 text-[12px] font-semibold text-ink-900">环境变量参考（在项目根目录 .env 中配置）</p>
        <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-ink-600">
{`MCP_GATEWAY_NAME=blhackbox-gateway
MCP_GATEWAY_URL=http://localhost:8080/mcp
MCP_GATEWAY_ENABLED=true
MCP_TRANSPORT=streamable-http
MCP_HEALTH_TIMEOUT_MS=5000
MCP_HEALTH_CACHE_TTL_MS=30000
MCP_GATEWAY_HEADERS={"Authorization":"Bearer <token>"}`}
        </pre>
      </div>
    </div>
  );
}
