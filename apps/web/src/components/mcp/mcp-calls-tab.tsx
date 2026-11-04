import type { McpCallDto } from '@vulnagent/shared';
import { EmptyState, TableShell, Td, Th } from '../ui/panel';
import { Badge, type BadgeTone } from '../ui/badge';
import { formatDateTime, formatDuration } from '../../lib/utils';

const DECISION: Record<string, { tone: BadgeTone; label: string }> = {
  allow: { tone: 'success', label: '允许' },
  deny: { tone: 'danger', label: '拒绝' },
  pending_approval: { tone: 'warning', label: '待审批' },
};

const STATUS: Record<string, { tone: BadgeTone; label: string }> = {
  success: { tone: 'success', label: '成功' },
  error: { tone: 'danger', label: '失败' },
  denied: { tone: 'danger', label: '已拒绝' },
  timeout: { tone: 'warning', label: '超时' },
};

export function McpCallsTab({ calls, total, loading }: { calls: McpCallDto[]; total: number; loading: boolean }) {
  if (loading) return <p className="px-4 py-6 text-[12px] text-ink-400">加载中…</p>;
  if (calls.length === 0) {
    return (
      <EmptyState
        title="暂无 MCP 工具调用记录"
        description="tool_calls 表当前为空。执行引擎与 MCP Policy Proxy 接入后，每一次工具调用都会在此留痕（参数、目标、决策、耗时）。"
      />
    );
  }

  return (
    <TableShell>
      <thead>
        <tr>
          <Th>时间</Th>
          <Th>工具</Th>
          <Th>目标 IP</Th>
          <Th>决策</Th>
          <Th>执行结果</Th>
          <Th className="text-right">耗时</Th>
          <Th>错误</Th>
        </tr>
      </thead>
      <tbody>
        {calls.map((call) => (
          <tr key={call.id} className="transition-colors hover:bg-slate-50/70">
            <Td className="whitespace-nowrap text-[11px] text-ink-600">{formatDateTime(call.createdAt)}</Td>
            <Td className="font-mono text-[12px]">{call.toolName}</Td>
            <Td className="font-mono text-[12px] text-ink-600">{call.targetIp ?? '—'}</Td>
            <Td>
              <Badge tone={(DECISION[call.decision] ?? DECISION.allow).tone}>
                {(DECISION[call.decision] ?? DECISION.allow).label}
              </Badge>
            </Td>
            <Td>
              <Badge tone={(STATUS[call.status] ?? STATUS.success).tone}>
                {(STATUS[call.status] ?? STATUS.success).label}
              </Badge>
            </Td>
            <Td className="text-right font-mono text-[12px] tabular">{formatDuration(call.latencyMs)}</Td>
            <Td className="max-w-[280px] truncate text-[11px] text-ink-600">{call.errorMessage ?? '—'}</Td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <Td className="text-[11px] text-ink-400">共 {total} 条</Td>
          <Td /><Td /><Td /><Td /><Td /><Td />
        </tr>
      </tfoot>
    </TableShell>
  );
}
