import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Terminal } from 'lucide-react';
import type { McpCallDto } from '@vulnagent/shared';
import { PageHeader } from '../../components/layout/page-header';
import { Panel, LoadingBlock, EmptyState, ErrorBlock, TableShell, Th, Td } from '../../components/ui/panel';
import { Button } from '../../components/ui/button';
import { Badge, type BadgeTone } from '../../components/ui/badge';
import { Input, Select } from '../../components/ui/input';
import { Drawer } from '../../components/ui/drawer';
import { mcpApi } from '../../api/mcp';
import { formatDateTime, formatDuration } from '../../lib/utils';

const STATUS: Record<string, { tone: BadgeTone; label: string }> = {
  success: { tone: 'success', label: '成功' },
  error: { tone: 'danger', label: '失败' },
  denied: { tone: 'danger', label: '已拦截' },
  timeout: { tone: 'warning', label: '超时' },
  cancelled: { tone: 'neutral', label: '已取消' },
  pending_approval: { tone: 'warning', label: '待审批' },
};

const DECISION: Record<string, { tone: BadgeTone; label: string }> = {
  allow: { tone: 'success', label: '允许' },
  deny: { tone: 'danger', label: '拒绝' },
  pending_approval: { tone: 'warning', label: '待审批' },
};

/**
 * 工具执行记录：所有真实调用（含被拦截、超时、取消）都留痕。
 *
 * 与 artex 的执行记录页同构：搜索 + 分页 + 行内展开查看完整输入输出。
 * 被拦截的调用不会产生证据，但仍必须可审计。
 */
export function CommandsPage() {
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<McpCallDto | null>(null);
  const pageSize = 20;

  const calls = useQuery({
    queryKey: ['commands', page, pageSize],
    queryFn: () => mcpApi.calls(page, pageSize),
    refetchInterval: 5000,
  });

  const items = useMemo(() => {
    const list = calls.data?.items ?? [];
    const text = keyword.trim().toLowerCase();
    return list
      .filter((call) => !status || call.status === status)
      .filter((call) => !text || call.toolName.toLowerCase().includes(text) || (call.targetIp ?? '').toLowerCase().includes(text));
  }, [calls.data, keyword, status]);

  const total = calls.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <PageHeader
        title="工具执行"
        description="每次工具调用（含被拦截、超时与取消）都在这里留痕。被拦截的调用不会产生证据，但必须可审计。"
        actions={
          <Button onClick={() => void calls.refetch()} loading={calls.isFetching}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        }
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索工具名或目标" className="w-[240px]" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-[140px]">
          <option value="">全部状态</option>
          <option value="success">成功</option>
          <option value="error">失败</option>
          <option value="denied">已拦截</option>
          <option value="timeout">超时</option>
          <option value="cancelled">已取消</option>
        </Select>
        <div className="ml-auto flex items-center gap-2 text-[12px] text-ink-400">
          <span className="tabular">共 {total} 条</span>
          <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
          <span className="tabular">{page}/{pages}</span>
          <Button size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
        </div>
      </div>

      <div className="mt-3">
        <Panel dense>
          {calls.isLoading ? (
            <LoadingBlock />
          ) : calls.isError ? (
            <ErrorBlock message={(calls.error as Error).message} onRetry={() => void calls.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              title="暂无执行记录"
              description="启动任务后，每次工具调用（包括被拦截与失败的调用）都会在这里留痕。"
            />
          ) : (
            <TableShell>
              <thead>
                <tr>
                  <Th className="w-[150px]">时间</Th>
                  <Th>工具</Th>
                  <Th className="w-[140px]">目标</Th>
                  <Th className="w-[80px]">决策</Th>
                  <Th className="w-[80px]">状态</Th>
                  <Th className="w-[80px] text-right">耗时</Th>
                  <Th>失败分类 / 错误</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((call) => (
                  <tr key={call.id} className="cursor-pointer transition-colors hover:bg-slate-50/70" onClick={() => setSelected(call)}>
                    <Td className="whitespace-nowrap text-[11px] text-ink-600">{formatDateTime(call.createdAt)}</Td>
                    <Td className="font-mono text-[12px]">{call.toolName}</Td>
                    <Td className="font-mono text-[12px] text-ink-600">{call.targetIp ?? '—'}</Td>
                    <Td><Badge tone={(DECISION[call.decision] ?? DECISION.allow).tone}>{(DECISION[call.decision] ?? DECISION.allow).label}</Badge></Td>
                    <Td><Badge tone={(STATUS[call.status] ?? STATUS.success).tone}>{(STATUS[call.status] ?? STATUS.success).label}</Badge></Td>
                    <Td className="text-right font-mono text-[12px] tabular">{formatDuration(call.latencyMs)}</Td>
                    <Td className="max-w-[320px] truncate text-[11px] text-ink-600">{call.errorMessage ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Panel>
      </div>

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.toolName ?? '调用详情'} description={selected?.createdAt ? formatDateTime(selected.createdAt) : undefined} width="w-[520px]">
        {selected ? (
          <div className="space-y-4 text-[12px]">
            <section>
              <p className="mb-1.5 font-semibold text-ink-900">输入</p>
              <pre className="max-h-[220px] overflow-auto rounded border border-ink-200 bg-slate-50 px-3 py-2 font-mono text-[11px]">{JSON.stringify(selected.arguments ?? {}, null, 2)}</pre>
            </section>
            <section>
              <p className="mb-1.5 font-semibold text-ink-900">结果</p>
              {selected.errorMessage ? (
                <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">{selected.errorMessage}</p>
              ) : (
                <p className="rounded bg-slate-50 px-3 py-2 text-ink-400">调用成功，原始输出见证据 <span className="font-mono">{selected.rawOutputRef ?? '—'}</span></p>
              )}
            </section>
            <section>
              <p className="mb-1.5 font-semibold text-ink-900">审计</p>
              <dl className="divide-y divide-ink-200/60 rounded border border-ink-200">
                <div className="flex justify-between px-3 py-1.5"><dt className="text-ink-400">决策</dt><dd>{(DECISION[selected.decision] ?? DECISION.allow).label}</dd></div>
                <div className="flex justify-between px-3 py-1.5"><dt className="text-ink-400">决策理由</dt><dd className="max-w-[300px] truncate text-right">{selected.decisionReason ?? '—'}</dd></div>
                <div className="flex justify-between px-3 py-1.5"><dt className="text-ink-400">耗时</dt><dd className="font-mono">{formatDuration(selected.latencyMs)}</dd></div>
                <div className="flex justify-between px-3 py-1.5"><dt className="text-ink-400">调用 ID</dt><dd className="font-mono text-[11px]">{selected.id.slice(0, 8)}</dd></div>
              </dl>
            </section>
            <p className="flex items-center gap-1.5 rounded border border-amber-200 bg-amber-50/70 px-3 py-2 text-[11px] text-amber-800">
              <Terminal className="h-3.5 w-3.5" />
              失败与拦截不代表目标状态；只有带证据的成功调用才能用于结论。
            </p>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
