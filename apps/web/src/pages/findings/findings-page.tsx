import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FindingDto, FindingVerificationDto } from '@vulnagent/shared';
import { api } from '../../api/client';
import { tasksApi } from '../../api/tasks';
import { PageHeader } from '../../components/layout/page-header';
import { Panel, EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui/panel';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';

const statusLabels: Record<string, string> = { candidate: '候选', verifying: '验证中', confirmed: '已确认', refuted: '已排除', unconfirmed: '无法确认' };
const outcomeLabels: Record<string, string> = { pending: '已入队', confirmed: '已确认', refuted: '已排除', inconclusive: '无法确认' };

export function FindingsPage() {
  const [params, setParams] = useSearchParams();
  const taskId = params.get('task') ?? '';
  const selectedId = params.get('id') ?? '';
  const [page, setPage] = useState(1);
  const [level, setLevel] = useState('actionable');
  const [status, setStatus] = useState('');
  const client = useQueryClient();
  const tasks = useQuery({ queryKey: ['tasks', 'finding-selector'], queryFn: () => tasksApi.list({ pageSize: 100 }) });
  useEffect(() => { if (!taskId && tasks.data?.items.length) setParams({ task: tasks.data.items[0].id }, { replace: true }); }, [taskId, tasks.data, setParams]);
  const base = `/tasks/${encodeURIComponent(taskId)}/findings`;
  const list = useQuery({ queryKey: ['findings', taskId, status, page, level], enabled: Boolean(taskId), refetchInterval: 5000,
    queryFn: () => api.get<{ items: FindingDto[]; total: number }>(`${base}?page=${page}${level ? `&clueLevel=${level}` : ''}${status ? `&status=${status}` : ''}`) });
  const detail = useQuery({ queryKey: ['finding-detail', taskId, selectedId], enabled: Boolean(taskId && selectedId), refetchInterval: 5000,
    queryFn: () => api.get<{ finding: FindingDto; verifications: FindingVerificationDto[] }>(`${base}/${encodeURIComponent(selectedId)}`) });
  const invalidate = () => { void client.invalidateQueries({ queryKey: ['findings', taskId] }); void client.invalidateQueries({ queryKey: ['finding-detail', taskId] }); };
  const refresh = useMutation({ mutationFn: () => api.post<{ created: number }>(`${base}/refresh`), onSuccess: invalidate });
  const verify = useMutation({ mutationFn: () => api.post<FindingVerificationDto>(`${base}/${encodeURIComponent(selectedId)}/verify`), onSuccess: invalidate });
  const finding = detail.data?.finding;
  const evidenceLink = (id: string) => `/evidence?task=${encodeURIComponent(taskId)}&id=${encodeURIComponent(id)}`;
  return <>
    <PageHeader title="漏洞发现" description="从真实事实整理候选，查看独立验证结果与证据链。" actions={<>
      <Select aria-label="选择任务" value={taskId} onChange={(e) => { setPage(1); setStatus(''); verify.reset(); refresh.reset(); setParams({ task: e.target.value }); }} className="w-[260px]">
        {!tasks.data?.items.length && <option value="">暂无任务</option>}
        {taskId && !tasks.data?.items.some((t) => t.id === taskId) && <option value={taskId}>{taskId}</option>}
        {tasks.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </Select>
      <Button disabled={!taskId} loading={refresh.isPending} onClick={() => refresh.mutate()}>同步历史候选</Button>
    </>} />
    {(tasks.error || refresh.error || verify.error) && <ErrorBlock message={(tasks.error ?? refresh.error ?? verify.error)!.message} />}
    {verify.data && <p role="status" className="mb-3 rounded border border-brand-200 bg-brand-50 p-3 text-xs">验证已入队。运行中的任务会继续调度；暂停或停止的任务需先恢复运行。<Link className="ml-2 text-brand-600 underline" to={`/agents?task=${encodeURIComponent(taskId)}`}>查看执行状态</Link></p>}
    <div className="grid gap-4 xl:grid-cols-[minmax(300px,1fr)_minmax(0,2fr)]">
      <Panel title={`漏洞列表（${list.data?.total ?? 0}）`} actions={<><Select aria-label="线索级别" value={level} onChange={(e) => { setLevel(e.target.value); setPage(1); }}><option value="actionable">漏洞候选</option><option value="weakness">弱点与加固建议</option><option value="">全部线索</option></Select><Select aria-label="漏洞状态" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
        <option value="">全部状态</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </Select></>}>
        {!taskId ? <EmptyState title="选择测试任务" /> : list.isPending ? <LoadingBlock /> : list.error ? <ErrorBlock message={list.error.message} onRetry={() => void list.refetch()} /> : <>
          {!list.data?.items.length && <EmptyState title="暂无漏洞候选" description="Worker 产出漏洞类事实后会进入候选列表；端口开放或工具失败不会直接算作漏洞。" />}
          <div className="max-h-[65vh] space-y-2 overflow-auto">{list.data?.items.map((item) => <button key={item.id} aria-pressed={item.id === selectedId}
            className={`w-full rounded-md border p-3 text-left hover:bg-slate-50 ${item.id === selectedId ? 'border-brand-500 bg-brand-50' : 'border-ink-200'}`}
            onClick={() => { verify.reset(); setParams({ task: taskId, id: item.id }); }}>
            <p className="mb-2 break-words text-sm font-medium">{item.title}</p>{item.clueLevel === 'weakness' && <Badge tone="neutral">弱点线索</Badge>}
            <Badge tone={item.status === 'confirmed' ? 'danger' : item.status === 'refuted' ? 'success' : 'neutral'}>{statusLabels[item.status] ?? item.status}</Badge>
            <span className="ml-2 text-xs text-ink-400">{item.targetIp ?? '目标待补充'}</span>
          </button>)}</div>
          <div className="mt-3 flex items-center justify-between"><Button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><span className="text-xs">第 {page} 页</span><Button disabled={page * 25 >= (list.data?.total ?? 0)} onClick={() => setPage(page + 1)}>下一页</Button></div>
        </>}
      </Panel>
      <Panel title="漏洞详情与验证历史" actions={finding && <Button loading={verify.isPending} disabled={finding.status === 'verifying'} onClick={() => verify.mutate()}>{finding.status === 'candidate' ? '安排独立验证' : '重新验证'}</Button>}>
        {!selectedId ? <EmptyState title="选择候选查看详情" /> : detail.isPending ? <LoadingBlock /> : detail.error ? <ErrorBlock message={detail.error.message} onRetry={() => void detail.refetch()} /> : finding && <>
          <h3 className="text-sm font-semibold">{finding.title}</h3><p className="my-3 whitespace-pre-wrap break-words text-sm text-ink-600">{finding.description}</p>
          <dl className="grid grid-cols-[85px_minmax(0,1fr)] gap-2 break-all text-xs"><dt>状态</dt><dd>{statusLabels[finding.status]}</dd><dt>严重程度</dt><dd>{finding.severity === 'info' ? '未评级' : finding.severity}</dd><dt>CVE / CWE</dt><dd>{finding.cve ?? '未提供'} / {finding.cwe ?? '未提供'}</dd><dt>修复建议</dt><dd>{finding.remediation ?? '待验证后补充'}</dd><dt>候选来源</dt><dd className="flex flex-wrap gap-2">{finding.evidenceIds.map((id, i) => <Link key={id} className="text-brand-500 underline" to={evidenceLink(id)}>证据 {i + 1}</Link>)}</dd></dl>
          <h4 className="mb-2 mt-5 text-sm font-semibold">独立验证记录</h4>
          {!detail.data?.verifications.length && <p className="text-xs text-ink-400">尚无验证记录；候选不会仅凭模型猜测或版本匹配变为已确认。</p>}
          <div className="space-y-3">{detail.data?.verifications.map((record) => <article key={record.id} className="rounded border border-ink-200 p-3">
            <div className="flex items-center justify-between"><Badge tone={record.outcome === 'confirmed' ? 'danger' : record.outcome === 'refuted' ? 'success' : 'neutral'}>{outcomeLabels[record.outcome]}</Badge><span className="text-xs text-ink-400">{new Date(record.createdAt).toLocaleString('zh-CN')}</span></div>
            <p className="my-2 whitespace-pre-wrap break-words text-xs">{record.summary}</p>
            {record.evidenceQuotes.map((quote, i) => <div key={`${quote.evidenceId}-${i}`} className="mt-2"><Link className="text-xs text-brand-500 underline" to={evidenceLink(quote.evidenceId)}>验证证据 {i + 1}</Link><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-xs">{quote.quote}</pre></div>)}
            <p className="mt-2 break-all text-[11px] text-ink-400">意图 {record.intentId} · 会话 {record.agentSessionId ?? '尚未执行'}</p>
          </article>)}</div>
        </>}
      </Panel>
    </div>
  </>;
}
