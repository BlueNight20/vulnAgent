import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import type { ReportDetailDto, ReportSummaryDto } from '@vulnagent/shared';
import { api } from '../../api/client';
import { tasksApi } from '../../api/tasks';
import { downloadReportFile } from '../../api/report-download';
import { PageHeader } from '../../components/layout/page-header';
import { Panel, EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui/panel';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';

export function ReportsPage() {
  const [params, setParams] = useSearchParams(); const client = useQueryClient();
  const taskId = params.get('task') ?? ''; const reportId = params.get('id') ?? '';
  const currentTaskId = useRef(taskId); currentTaskId.current = taskId;
  const [page, setPage] = useState(1);
  const tasks = useQuery({ queryKey: ['tasks', 'report-selector'], queryFn: () => tasksApi.list({ pageSize: 100 }) });
  useEffect(() => { if (!taskId && tasks.data?.items.length) setParams({ task: tasks.data.items[0].id }, { replace: true }); }, [taskId, tasks.data, setParams]);
  const base = `/tasks/${encodeURIComponent(taskId)}/reports`;
  const list = useQuery({ queryKey: ['reports', taskId, page], enabled: Boolean(taskId), queryFn: () => api.get<{ items: ReportSummaryDto[]; total: number }>(`${base}?page=${page}`) });
  const detail = useQuery({ queryKey: ['report', taskId, reportId], enabled: Boolean(taskId && reportId), queryFn: () => api.get<ReportDetailDto>(`${base}/${encodeURIComponent(reportId)}`) });
  const generate = useMutation({
    mutationFn: (id: string) => api.post<ReportDetailDto>(`/tasks/${encodeURIComponent(id)}/reports`),
    onSuccess: (report, id) => { void client.invalidateQueries({ queryKey: ['reports', id] }); client.setQueryData(['report', id, report.id], report); if (currentTaskId.current === id) { setPage(1); setParams({ task: id, id: report.id }); } },
  });
  const download = useMutation({ mutationFn: ({ path, filename }: { path: string; filename: string }) => downloadReportFile(path, filename) });
  const report = detail.data; const intact = report?.integrity === 'match';
  const exportFile = (format: 'markdown' | 'pdf' | 'evidence' | 'bundle') => download.mutate({ path: `${base}/${encodeURIComponent(reportId)}/download?format=${format}`, filename: `report-${reportId}.${format === 'markdown' ? 'md' : format === 'evidence' ? 'evidence.json' : format === 'bundle' ? 'zip' : 'pdf'}` });
  return <>
    <PageHeader title="报告中心" description="保存任务快照，区分已确认结论、待复核候选与验收缺口。" actions={<div className="flex gap-2">
      <Select aria-label="选择任务" value={taskId} onChange={(e) => { setPage(1); setParams({ task: e.target.value }); generate.reset(); download.reset(); }} className="w-[260px]">
        {!tasks.data?.items.length && <option value="">暂无任务</option>}
        {taskId && !tasks.data?.items.some((t) => t.id === taskId) && <option value={taskId}>{taskId}</option>}
        {tasks.data?.items.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}
      </Select><Button variant="primary" disabled={!taskId} loading={generate.isPending} onClick={() => generate.mutate(taskId)}>生成报告快照</Button>
    </div>} />
    {tasks.error && <ErrorBlock message={tasks.error.message} onRetry={() => void tasks.refetch()} />}
    {generate.error && <ErrorBlock message={generate.error.message} />}{download.error && <ErrorBlock message={download.error.message} />}
    <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
      <Panel title={`报告历史（${list.data?.total ?? 0}）`}>
        {!taskId ? <EmptyState title="选择任务后生成报告" /> : list.isPending ? <LoadingBlock /> : list.error ? <ErrorBlock message={list.error.message} onRetry={() => void list.refetch()} /> : <>
          {!list.data?.items.length && <EmptyState title="暂无报告" description="生成报告会固定当前记录，后续执行不会修改已有报告。" />}
          <div className="max-h-[65vh] space-y-2 overflow-auto">{list.data?.items.map((item) => <button key={item.id} aria-pressed={item.id === reportId} onClick={() => { setParams({ task: taskId, id: item.id }); download.reset(); }} className={`w-full rounded border p-3 text-left ${item.id === reportId ? 'border-brand-500 bg-brand-50' : 'border-ink-200 hover:bg-slate-50'}`}>
            <p className="break-words text-sm font-medium">{item.title}</p><p className="my-2 text-xs text-ink-400">{new Date(item.generatedAt ?? item.createdAt).toLocaleString('zh-CN')}</p>
            <Badge tone={item.stats?.kind === 'final' ? 'success' : 'warning'}>{item.stats?.kind === 'final' ? '验收报告' : '阶段报告'}</Badge>
            {item.stats && <p className="mt-2 text-xs">确认 {item.stats.findingCounts.confirmed} · 候选 {item.stats.findingCounts.candidate} · 未确认 {item.stats.findingCounts.unconfirmed}</p>}
          </button>)}</div>
          <div className="mt-3 flex items-center justify-between"><Button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><span className="text-xs">第 {page} 页</span><Button disabled={page * 25 >= (list.data?.total ?? 0)} onClick={() => setPage(page + 1)}>下一页</Button></div>
        </>}
      </Panel>
      <Panel title="报告预览" actions={report && <div className="flex flex-wrap gap-2"><Button disabled={!intact || download.isPending} onClick={() => exportFile('markdown')}>导出 Markdown</Button><Button disabled={!intact || download.isPending} onClick={() => exportFile('pdf')}>导出 PDF</Button><Button disabled={!intact || download.isPending} onClick={() => exportFile('evidence')}>下载证据包</Button><Button disabled={!intact || download.isPending} onClick={() => exportFile('bundle')}>下载 ZIP 包</Button></div>}>
        {!reportId ? <EmptyState title="选择报告或生成新快照" /> : detail.isPending ? <LoadingBlock /> : detail.error ? <ErrorBlock message={detail.error.message} onRetry={() => void detail.refetch()} /> : report && <>
          <Badge tone={intact ? 'success' : 'danger'}>{intact ? '报告快照校验通过' : '快照缺失或完整性异常，请重新生成'}</Badge>
          <p className="my-3 text-xs text-ink-400">报告固定生成时的文本与已保存附件。JSON 包含 Base64 附件，ZIP 包含原始文件、完整文本及清单；外部 URI 仅列引用。PDF 最多 500 页、正文最多 2 MiB，较大报告可下载完整 Markdown。</p>
          {report.content.length > 300000 && <p className="mb-2 text-xs text-amber-700">预览仅显示前 300000 字符，导出包含全部正文。</p>}
          <article className="max-h-[70vh] overflow-auto break-words rounded border border-ink-200 p-5 text-sm" aria-label="报告正文">
            <ReactMarkdown skipHtml components={{
              h1: ({ children }) => <h1 className="mb-5 text-xl font-semibold">{children}</h1>, h2: ({ children }) => <h2 className="mb-3 mt-6 border-b pb-2 text-lg font-semibold">{children}</h2>, h3: ({ children }) => <h3 className="mb-2 mt-4 font-semibold">{children}</h3>,
              p: ({ children }) => <p className="my-2 leading-6">{children}</p>, ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
              pre: ({ children }) => <pre className="my-3 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-3 text-xs">{children}</pre>,
              img: ({ alt }) => <span>{alt ?? '图片附件'}</span>, a: ({ children }) => <span>{children}</span>,
            }}>{report.content.slice(0, 300000)}</ReactMarkdown>
          </article>
          <details className="mt-4"><summary className="cursor-pointer text-sm">证据附件（{report.evidence.length}）</summary><div className="mt-2 max-h-64 space-y-2 overflow-auto">{report.evidence.map((e) => <div key={e.id} className="flex items-center justify-between gap-2 rounded border p-2 text-xs"><div className="min-w-0 break-all">{e.title}<br />{e.id} · {e.integrity} · {e.provenanceValid ? '来源有效' : '来源未通过'}<br /><Link to={`/evidence?task=${encodeURIComponent(taskId)}&id=${encodeURIComponent(e.id)}`} className="text-brand-500 underline">查看当前库记录</Link></div><Button size="sm" disabled={!intact || e.computedSizeBytes === null || download.isPending} onClick={() => download.mutate({ path: `${base}/${encodeURIComponent(reportId)}/evidence/${encodeURIComponent(e.id)}`, filename: `evidence-${e.id}.txt` })}>下载快照</Button></div>)}</div></details>
          <details className="mt-4"><summary className="cursor-pointer text-sm">二进制附件快照（{report.attachments?.length ?? 0}）</summary><div className="mt-2 max-h-64 space-y-2 overflow-auto">{report.attachments?.map((a) => <div key={a.id} className="flex items-center justify-between gap-2 rounded border p-2 text-xs"><div className="min-w-0 break-all">{a.filename} · {a.mimeType} · {a.computedSizeBytes} 字节<br />SHA-256 {a.computedSha256}{a.integrity !== 'match' && <p className="text-amber-700">来源校验不一致，快照仅保留当时的现存字节。</p>}</div><Button size="sm" disabled={!intact || download.isPending} onClick={() => download.mutate({ path: `${base}/${encodeURIComponent(reportId)}/attachments/${encodeURIComponent(a.id)}`, filename: a.filename })}>下载二进制快照</Button></div>)}</div></details>
        </>}
      </Panel>
    </div>
  </>;
}
