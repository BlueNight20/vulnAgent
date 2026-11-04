import { McpServerDetails } from '../../components/mcp/mcp-server-details';
import { McpCapabilities } from '../../components/mcp/mcp-capabilities';
import { McpImportDrawer } from '../../components/mcp/mcp-import-drawer';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Layers, Server, CheckCircle2, Wrench, AlertTriangle } from 'lucide-react';
import { PageHeader } from '../../components/layout/page-header';
import { Panel, ErrorBlock, LoadingBlock, EmptyState, TableShell, Th, Td } from '../../components/ui/panel';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/input';
import { Tabs } from '../../components/ui/tabs';
import { McpStatusBadge } from '../../components/common/status-badge';
import { McpToolsTab } from '../../components/mcp/mcp-tools-tab';
import { McpCallsTab } from '../../components/mcp/mcp-calls-tab';
import { McpAddDrawer } from '../../components/mcp/mcp-add-drawer';
import { mcpApi } from '../../api/mcp';

export function McpPage() {
  const client = useQueryClient();
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState('servers');
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [transport, setTransport] = useState('all');
  const [detailTab, setDetailTab] = useState('tools');
  const [keyword, setKeyword] = useState('');
  const servers = useQuery({ queryKey: ['mcp', 'servers'], queryFn: mcpApi.servers });
  const items = servers.data?.items ?? [];
  const active = items.find((s) => s.id === selected) ?? items[0];
  const tools = useQuery({ queryKey: ['mcp', 'tools', active?.id, keyword], queryFn: () => mcpApi.tools(active!.id, keyword), enabled: Boolean(active) });
  const calls = useQuery({ queryKey: ['mcp', 'calls'], queryFn: () => mcpApi.calls(), enabled: tab === 'calls' });
  const check = useMutation({ mutationFn: mcpApi.check, onSuccess: () => { void client.invalidateQueries({ queryKey: ['mcp'] }); } });
  const online = items.filter((s) => s.enabled && s.status === 'online');
  const visible = items.filter((s) => `${s.name} ${s.endpoint}`.toLowerCase().includes(search.toLowerCase()) && (status === 'all' || (status === 'disabled' ? !s.enabled : s.enabled && s.status === status)) && (transport === 'all' || s.transport === transport));
  const stats = [
    { label: '服务总数', value: items.length, icon: Server },
    { label: '已连接', value: online.length, icon: CheckCircle2 },
    { label: '可用工具', value: online.reduce((n, s) => n + s.toolCount, 0), icon: Wrench },
    { label: '异常服务', value: items.filter((s) => s.enabled && !['online', 'unknown'].includes(s.status)).length, icon: AlertTriangle },
  ];
  return <>
    <PageHeader title="MCP 服务中心" description="统一接入、发现与管理不同 MCP 服务" actions={<><Button onClick={() => setImporting(true)}>导入配置</Button><Button variant="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" />添加服务</Button></>} />
    <div className="my-5 grid grid-cols-2 gap-4 xl:grid-cols-4">{stats.map(({ label, value, icon: Icon }) => <div key={label} className="flex items-center gap-4 rounded-lg border border-ink-200 bg-white p-5"><Icon className="h-7 w-7 text-brand-600" /><div><p className="text-sm text-ink-600">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div></div>)}</div>
    <Tabs items={[{ key: 'servers', label: '服务管理' }, { key: 'tools', label: '能力目录' }, { key: 'calls', label: '调用日志' }]} value={tab} onChange={setTab} />
    {check.error && <p role="alert" className="my-3 text-sm text-red-700">{check.error.message}</p>}
    {servers.isLoading ? <LoadingBlock /> : servers.isError ? <ErrorBlock message={servers.error.message} onRetry={() => void servers.refetch()} /> : <>
      {tab === 'servers' && <div className="my-4 space-y-4">
        <div className="flex flex-wrap gap-3"><Input className="min-w-48 flex-1" placeholder="搜索服务名称或地址" aria-label="搜索服务" value={search} onChange={(e) => setSearch(e.target.value)} /><Select className="w-40" aria-label="服务状态" value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">全部状态</option><option value="online">已连接</option><option value="unreachable">无法连接</option><option value="unknown">未检测</option><option value="disabled">已停用</option></Select><Select className="w-48" aria-label="传输方式" value={transport} onChange={(e) => setTransport(e.target.value)}><option value="all">全部传输方式</option><option value="streamable-http">Streamable HTTP</option><option value="sse">SSE</option><option value="stdio">stdio</option></Select></div>
        <TableShell><thead><tr><Th>服务名称</Th><Th>传输方式</Th><Th>状态</Th><Th>能力</Th><Th>响应耗时</Th><Th>操作</Th></tr></thead><tbody>{visible.map((s) => <tr key={s.id} className={active?.id === s.id ? 'bg-brand-50' : 'hover:bg-slate-50'}><Td><button onClick={() => { setSelected(s.id); setKeyword(''); }} className="flex items-center gap-2 font-semibold text-ink-900"><Layers className="h-5 w-5 text-brand-600" />{s.name}</button><p className="mt-1 max-w-80 truncate text-xs text-ink-400" title={s.endpoint}>{s.endpoint}</p></Td><Td>{s.transport === 'streamable-http' ? 'Streamable HTTP' : s.transport === 'stdio' ? 'stdio' : 'SSE'}</Td><Td>{s.enabled ? <McpStatusBadge status={s.status} /> : '已停用'}</Td><Td>{s.toolCount} 工具</Td><Td>{s.latencyMs == null ? '—' : `${s.latencyMs} ms`}</Td><Td><Button disabled={!s.enabled || check.isPending} loading={check.isPending && check.variables === s.id} onClick={() => check.mutate(s.id)}>检测</Button></Td></tr>)}</tbody></TableShell>
        {!visible.length && <EmptyState title={items.length ? '没有匹配的服务' : '添加第一个 MCP 服务'} description="通过右上角添加服务，检测连接后自动发现工具。" />}
      </div>}
      {(tab === 'servers' || tab === 'tools') && active && <Panel title={active.name} description={active.endpoint} bodyClassName="p-0"><div className="flex flex-wrap items-center gap-3 border-b border-ink-200 p-3"><Tabs items={[{ key: 'tools', label: '工具' }, { key: 'resources', label: '资源' }, { key: 'prompts', label: '提示模板' }, { key: 'settings', label: '连接设置' }, { key: 'diagnostics', label: '诊断日志' }]} value={detailTab} onChange={setDetailTab} /><Select aria-label="选择服务" className="ml-auto w-60" value={active.id} onChange={(e) => { setSelected(e.target.value); setKeyword(''); }}>{items.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.toolCount} 工具</option>)}</Select></div>{active.lastError && <p className="p-3 text-sm text-amber-700">{active.lastError}</p>}{['settings', 'diagnostics'].includes(detailTab) ? <McpServerDetails key={active.id} server={active} diagnostics={detailTab === 'diagnostics'} /> : detailTab !== 'tools' ? <McpCapabilities serverId={active.id} kind={detailTab as 'resources' | 'prompts'} /> : tools.isError ? <ErrorBlock message={tools.error.message} onRetry={() => void tools.refetch()} /> : <McpToolsTab tools={tools.data?.items ?? []} keyword={keyword} onKeywordChange={setKeyword} loading={tools.isLoading} />}</Panel>}
      {tab === 'calls' && (calls.isError ? <ErrorBlock message={calls.error.message} onRetry={() => void calls.refetch()} /> : <McpCallsTab calls={calls.data?.items ?? []} total={calls.data?.total ?? 0} loading={calls.isLoading} />)}
    </>}
    {importing && <McpImportDrawer onClose={() => setImporting(false)} onSaved={() => { void client.invalidateQueries({ queryKey: ['mcp'] }); }} />}
    {adding && <McpAddDrawer onClose={() => setAdding(false)} onSaved={(id) => { setSelected(id); setAdding(false); setTab('servers'); void client.invalidateQueries({ queryKey: ['mcp'] }); }} />}
  </>;
}
