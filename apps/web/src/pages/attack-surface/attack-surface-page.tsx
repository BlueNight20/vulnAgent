import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { AttackSurfaceDto, SurfaceObservation } from '@vulnagent/shared';
import { api } from '../../api/client';
import { tasksApi } from '../../api/tasks';
import { PageHeader } from '../../components/layout/page-header';
import { Panel, EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui/panel';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';

export function AttackSurfacePage() {
  const [params, setParams] = useSearchParams();
  const taskId = params.get('task') ?? '';
  const [keyword, setKeyword] = useState('');
  const tasks = useQuery({ queryKey: ['tasks', 'surface-selector'], queryFn: () => tasksApi.list({ pageSize: 100 }) });
  useEffect(() => { if (!taskId && tasks.data?.items.length) setParams({ task: tasks.data.items[0].id }, { replace: true }); }, [taskId, tasks.data, setParams]);
  const surface = useQuery({ queryKey: ['attack-surface', taskId], enabled: Boolean(taskId),
    queryFn: () => api.get<AttackSurfaceDto>(`/tasks/${encodeURIComponent(taskId)}/attack-surface`) });
  const assets = surface.data?.assets.filter((asset) => `${asset.address} ${asset.hostname ?? ''} ${asset.ports.flatMap((p) => p.services).join(' ')}`.toLowerCase().includes(keyword.toLowerCase())) ?? [];
  const observations = (rows: SurfaceObservation[]) => rows.map((row) => <li key={row.factId} className="rounded border border-ink-200 p-2 text-xs">
    <p className="mb-1 break-all font-mono text-ink-400">{row.subject}</p><p className="whitespace-pre-wrap break-all">{row.value}</p><div className="mt-1 flex flex-wrap gap-2 text-[11px] text-ink-400"><span>{row.predicate}</span><span>{new Date(row.observedAt).toLocaleString('zh-CN')}</span>{row.conflicting && <span className="text-amber-700">待复核的冲突</span>}{row.evidenceIds.map((id, i) => <Link key={id} className="text-brand-500 underline" to={`/evidence?task=${encodeURIComponent(taskId)}&id=${encodeURIComponent(id)}`}>证据 {i + 1}</Link>)}</div>
  </li>);
  return <>
    <PageHeader title="攻击面分析" description="按目标整理端口、服务、技术观测与信息缺口；所有条目保留来源证据。" actions={<>
      <Select aria-label="选择任务" value={taskId} onChange={(e) => { setKeyword(''); setParams({ task: e.target.value }); }} className="w-[260px]">
        {!tasks.data?.items.length && <option value="">暂无任务</option>}
        {taskId && !tasks.data?.items.some((t) => t.id === taskId) && <option value={taskId}>{taskId}</option>}
        {tasks.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </Select><Button disabled={!taskId} loading={surface.isFetching} onClick={() => void surface.refetch()}>刷新观测</Button>
    </>} />
    {tasks.error && <ErrorBlock message={tasks.error.message} />}
    <div className="mb-4 flex flex-wrap items-center gap-3"><Input aria-label="筛选资产" placeholder="筛选地址、主机名或服务" value={keyword} onChange={(e) => setKeyword(e.target.value)} className="max-w-sm" /><span className="text-xs text-ink-400">资产 {surface.data?.assets.length ?? 0} · 未纳入确认状态的事实 {surface.data?.excludedFacts ?? 0}</span></div>
    {!taskId ? <EmptyState title="选择测试任务" /> : surface.isPending ? <LoadingBlock /> : surface.error ? <ErrorBlock message={surface.error.message} onRetry={() => void surface.refetch()} /> : !assets.length ? <EmptyState title="没有匹配的资产" /> : <div className="space-y-4">{assets.map((asset) => <Panel key={asset.address} title={<span className="font-mono">{asset.address}{asset.hostname ? ` · ${asset.hostname}` : ''}</span>} actions={<><Badge tone={asset.inScope ? 'brand' : 'warning'}>{asset.inScope ? '范围内' : '范围外观测'}</Badge><Badge tone={asset.aliveObserved ? 'success' : 'neutral'}>{asset.kind === 'cidr' ? '授权网段' : asset.aliveObserved ? '有存活证据' : '存活未知'}</Badge></>}>
      <div className="grid gap-4 xl:grid-cols-2"><section><h3 className="mb-2 text-sm font-semibold">端口与服务</h3>
        {!asset.ports.length && <p className="text-xs text-ink-400">尚无有效端口观测，不能据此判断端口关闭。</p>}
        <div className="space-y-3">{asset.ports.map((port) => <div key={`${port.port}/${port.protocol}`} className="rounded border border-ink-200 p-3"><p className="mb-1 text-sm font-medium">{port.port}/{port.protocol} · {port.states.join(' / ') || '状态未注明'}</p><p className="mb-2 break-all text-xs text-ink-600">{port.services.join(' / ') || '服务未识别'}</p><details><summary className="cursor-pointer text-xs text-brand-500">观测记录与证据（{port.observations.length}）</summary><ul className="mt-2 space-y-1">{observations(port.observations)}</ul></details></div>)}</div>
      </section><section><h3 className="mb-2 text-sm font-semibold">技术指纹与端点</h3><ul className="max-h-80 space-y-1 overflow-auto">{observations([...asset.technologies, ...asset.endpoints])}</ul>{!asset.technologies.length && !asset.endpoints.length && <p className="text-xs text-ink-400">尚无有效指纹或端点证据。</p>}
        <h3 className="mb-2 mt-4 text-sm font-semibold">关联漏洞</h3><ul className="space-y-1 text-xs">{asset.findings.map((finding) => <li key={finding.id}><Link className="text-brand-500 underline" to={`/vulnerabilities?task=${encodeURIComponent(taskId)}&id=${encodeURIComponent(finding.id)}`}>{finding.title}</Link><span className="ml-2 text-ink-400">{finding.status}</span></li>)}</ul>
      </section></div>
      <div className="mt-4 rounded bg-slate-50 p-3"><h3 className="mb-1 text-xs font-semibold">下一步信息缺口</h3><ul className="list-inside list-disc space-y-1 text-xs text-ink-600">{asset.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul><p className="mt-2 text-[11px] text-ink-400">模型推断 {asset.inferredFacts} 条 · 探测失败 {asset.probeErrors} 条</p></div>
    </Panel>)}</div>}
  </>;
}
