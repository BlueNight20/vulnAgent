import { useState } from 'react';
import { McpAddDrawer } from './mcp-add-drawer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { McpServerDto } from '@vulnagent/shared';
import { mcpApi } from '../../api/mcp';
import { Button } from '../ui/button';
import { ErrorBlock, LoadingBlock, EmptyState } from '../ui/panel';

export function McpServerDetails({ server, diagnostics }: { server: McpServerDto; diagnostics: boolean }) {
  const [editing, setEditing] = useState(false);
  const client = useQueryClient();
  const toggle = useMutation({ mutationFn: () => mcpApi.setEnabled(server.id, !server.enabled), onSuccess: () => { void client.invalidateQueries({ queryKey: ['mcp'] }); } });
  const history = useQuery({ queryKey: ['mcp', 'diagnostics', server.id], queryFn: () => mcpApi.diagnostics(server.id), enabled: diagnostics });
  if (diagnostics) return <div className="p-4"><p className="mb-3 text-sm">最近检测：{server.lastCheckedAt ? new Date(server.lastCheckedAt).toLocaleString('zh-CN') : '尚未检测'}</p>{server.lastError && <p className="mb-3 rounded bg-amber-50 p-3 text-sm text-amber-800">{server.lastError}</p>}{history.isPending ? <LoadingBlock /> : history.error ? <ErrorBlock message={history.error.message} onRetry={() => void history.refetch()} /> : !history.data.items.length ? <EmptyState title="暂无诊断记录" /> : <ul className="divide-y divide-ink-200">{history.data.items.map((row) => <li key={row.id} className="flex justify-between gap-3 py-3 text-xs"><span>{row.action} · {row.result === 'success' ? '成功' : '失败'}</span><time>{new Date(row.createdAt).toLocaleString('zh-CN')}</time></li>)}</ul>}</div>;
  return <div className="space-y-4 p-4"><dl className="grid grid-cols-[100px_1fr] gap-3 break-all text-sm"><dt>服务名称</dt><dd>{server.name}</dd><dt>传输方式</dt><dd>{server.transport}</dd><dt>服务地址</dt><dd>{server.endpoint}</dd><dt>凭据</dt><dd>{server.transport === 'stdio' ? '启动配置已加密保存' : server.headersMasked ?? '未配置认证头'}</dd><dt>配置来源</dt><dd>{server.source === 'env' ? '环境配置导入' : '手动添加'}</dd><dt>状态</dt><dd>{server.enabled ? '已启用' : '已停用'}</dd></dl>
    <Button onClick={() => setEditing(true)}>编辑连接配置</Button>
    {editing && <McpAddDrawer server={server} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void client.invalidateQueries({ queryKey: ['mcp'] }); }} />}
    <Button loading={toggle.isPending} onClick={() => toggle.mutate()}>{server.enabled ? '停用服务' : '启用服务'}</Button>
    <p className="text-xs text-ink-400">停用后不再派发新的工具调用，已有调用可能仍在完成中。</p>
    {toggle.error && <p role="alert" className="text-sm text-red-700">{toggle.error.message}</p>}
  </div>;
}
