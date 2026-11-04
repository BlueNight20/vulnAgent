import type { ServiceHealthItem } from '@vulnagent/shared';
import { Badge } from '../ui/badge';
import { TableShell, Td, Th } from '../ui/panel';
import { formatDuration, formatRelative } from '../../lib/utils';

const KIND_LABEL: Record<string, string> = {
  mcp: 'MCP 网关',
  api: '后端服务',
  database: '数据库',
};

export function ServiceHealthTable({ items }: { items: ServiceHealthItem[] }) {
  return (
    <TableShell>
      <thead>
        <tr>
          <Th>服务</Th>
          <Th>类型</Th>
          <Th>状态</Th>
          <Th className="text-right">延迟</Th>
          <Th>检测时间</Th>
          <Th>说明</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.name} className="transition-colors hover:bg-slate-50/70">
            <Td className="font-medium">{item.name}</Td>
            <Td className="text-ink-600">{KIND_LABEL[item.kind] ?? item.kind}</Td>
            <Td>
              {item.status === 'online' ? (
                <Badge tone="success">在线</Badge>
              ) : item.status === 'offline' ? (
                <Badge tone="danger">离线</Badge>
              ) : (
                <Badge tone="neutral">未检测</Badge>
              )}
            </Td>
            <Td className="text-right font-mono text-[12px] tabular text-ink-600">
              {item.kind === 'api' ? '—' : formatDuration(item.latencyMs)}
            </Td>
            <Td className="whitespace-nowrap text-[12px] text-ink-600">
              {formatRelative(item.checkedAt)}
            </Td>
            <Td className="max-w-[420px] truncate text-[12px] text-ink-600" >
              <span title={item.detail}>{item.detail}</span>
            </Td>
          </tr>
        ))}
        {items.length === 0 ? (
          <tr>
            <Td className="py-6 text-center text-ink-400" >暂无服务记录</Td>
            <Td /><Td /><Td /><Td /><Td />
          </tr>
        ) : null}
      </tbody>
    </TableShell>
  );
}
