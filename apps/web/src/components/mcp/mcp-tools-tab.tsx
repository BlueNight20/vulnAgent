import { useState } from 'react';
import { Search } from 'lucide-react';
import type { McpToolDto } from '@vulnagent/shared';
import { Input } from '../ui/input';
import { EmptyState, TableShell, Td, Th } from '../ui/panel';
import { Badge, type BadgeTone } from '../ui/badge';
import { Drawer } from '../ui/drawer';
import { formatDateTime } from '../../lib/utils';

const RISK: Record<string, { tone: BadgeTone; label: string }> = {
  safe: { tone: 'success', label: '只读/安全' },
  intrusive: { tone: 'warning', label: '较强探测' },
  destructive: { tone: 'danger', label: '高风险' },
};

export function McpToolsTab({
  tools,
  keyword,
  onKeywordChange,
  loading,
}: {
  tools: McpToolDto[];
  keyword: string;
  onKeywordChange: (v: string) => void;
  loading: boolean;
}) {
  const [active, setActive] = useState<McpToolDto | null>(null);

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-ink-200 px-4 py-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
          <Input
            value={keyword}
            onChange={(e) => onKeywordChange(e.target.value)}
            placeholder="按工具名或描述搜索"
            className="w-[280px] pl-7"
          />
        </div>
        <span className="text-[11px] text-ink-400">共 {tools.length} 个工具</span>
      </div>

      {loading ? (
        <p className="px-4 py-6 text-[12px] text-ink-400">加载中…</p>
      ) : tools.length === 0 ? (
        <EmptyState
          title="工具目录为空"
          description="工具目录来自 MCP 服务的真实返回。请在「服务管理」点击「检测」，连接成功后会自动同步。" 
        />
      ) : (
        <TableShell>
          <thead>
            <tr>
              <Th>工具名</Th>
              <Th>来源服务</Th>
              <Th>描述</Th>
              <Th className="text-center">参数数</Th>
              <Th>风险推断</Th>
              <Th>同步时间</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {tools.map((tool) => (
              <tr key={tool.id} className="transition-colors hover:bg-slate-50/70">
                <Td className="font-mono text-[12px] font-medium">{tool.name}</Td>
                <Td className="text-[12px] text-ink-600">{tool.serverName}</Td>
                <Td className="max-w-[420px] truncate text-[12px] text-ink-600">
                  <span title={tool.description ?? ''}>{tool.description ?? '—'}</span>
                </Td>
                <Td className="text-center font-mono text-[12px] tabular">{tool.paramCount}</Td>
                <Td>
                  <Badge tone={(RISK[tool.riskLevel] ?? RISK.safe).tone}>
                    {(RISK[tool.riskLevel] ?? RISK.safe).label}
                  </Badge>
                </Td>
                <Td className="whitespace-nowrap text-[11px] text-ink-400">{formatDateTime(tool.syncedAt)}</Td>
                <Td>
                  <button
                    type="button"
                    onClick={() => setActive(tool)}
                    className="text-[11px] text-brand-600 hover:underline"
                  >
                    查看详情
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}

      <Drawer
        open={Boolean(active)}
        onClose={() => setActive(null)}
        title={active?.name ?? ''}
        description={active ? `来源：${active.serverName} · 风险推断：${(RISK[active.riskLevel] ?? RISK.safe).label}` : undefined}
      >
        {active ? (
          <div className="space-y-4">
            <div>
              <p className="mb-1 text-[12px] font-semibold text-ink-900">工具描述</p>
              <p className="text-[12px] leading-relaxed text-ink-600">{active.description ?? '该工具未提供描述'}</p>
            </div>
            <div>
              <p className="mb-1 text-[12px] font-semibold text-ink-900">输入参数 JSON Schema</p>
              <pre className="max-h-[520px] overflow-auto rounded border border-ink-200 bg-navy-900 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-200">
                {JSON.stringify(active.inputSchema, null, 2)}
              </pre>
            </div>
            <p className="text-[11px] text-ink-400">
              参数由 MCP 服务提供。自动化任务根据 Worker 的工具权限调用，执行结果记录在「调用日志」。
            </p>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
