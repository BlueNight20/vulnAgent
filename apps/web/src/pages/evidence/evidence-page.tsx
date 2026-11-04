import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { EvidenceDetailDto, EvidenceSummaryDto } from '@vulnagent/shared';
import { api } from '../../api/client';
import { tasksApi } from '../../api/tasks';
import { PageHeader } from '../../components/layout/page-header';
import { Panel, EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui/panel';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { EvidenceAttachments } from './evidence-attachments';
import { EvidenceRelations } from './evidence-relations';

const kinds: Record<string, string> = { command_output: '命令输出', http_response: 'HTTP 响应', screenshot: '截图', pcap: '网络抓包', file: '文件', note: '备注' };

function download(evidence: EvidenceDetailDto) {
  const url = URL.createObjectURL(new Blob([evidence.content ?? ''], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `evidence-${evidence.id}.txt`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function EvidencePage() {
  const [params, setParams] = useSearchParams();
  const taskId = params.get('task') ?? '';
  const selectedId = params.get('id') ?? '';
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const tasks = useQuery({ queryKey: ['tasks', 'evidence-selector'], queryFn: () => tasksApi.list({ pageSize: 100 }) });
  useEffect(() => {
    if (!taskId && tasks.data?.items.length) setParams({ task: tasks.data.items[0].id }, { replace: true });
  }, [taskId, tasks.data, setParams]);
  const list = useQuery({
    queryKey: ['evidence', taskId, kind, page], enabled: Boolean(taskId), refetchInterval: 10000,
    queryFn: () => api.get<{ items: EvidenceSummaryDto[]; total: number }>(`/tasks/${encodeURIComponent(taskId)}/evidence?page=${page}&pageSize=25${kind ? `&kind=${kind}` : ''}`),
  });
  const detail = useQuery({
    queryKey: ['evidence-detail', taskId, selectedId], enabled: Boolean(taskId && selectedId),
    queryFn: () => api.get<EvidenceDetailDto>(`/tasks/${encodeURIComponent(taskId)}/evidence/${encodeURIComponent(selectedId)}`),
  });
  const changeTask = (id: string) => { setPage(1); setKind(''); setParams({ task: id }); };
  const evidence = detail.data;
  return <>
    <PageHeader title="证据管理" description="查看任务原始输出、核对完整性并导出证据。" actions={
      <Select aria-label="选择任务" value={taskId} onChange={(e) => changeTask(e.target.value)} className="w-[280px]">
        {!tasks.data?.items.length && <option value="">暂无任务</option>}
        {taskId && !tasks.data?.items.some((t) => t.id === taskId) && <option value={taskId}>{taskId}</option>}
        {tasks.data?.items.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}
      </Select>
    } />
    {tasks.error && <ErrorBlock message={tasks.error.message} onRetry={() => void tasks.refetch()} />}
    <div className="grid gap-4 xl:grid-cols-[minmax(300px,1fr)_minmax(0,2fr)]">
      <Panel title={`证据列表（${list.data?.total ?? 0}）`} actions={<Select aria-label="证据类型" value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }}>
        <option value="">全部类型</option>{Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </Select>}>
        {!taskId ? <EmptyState title={tasks.isPending ? '正在加载任务' : '暂无任务'} /> : list.isPending ? <LoadingBlock /> : list.error ? <ErrorBlock message={list.error.message} onRetry={() => void list.refetch()} /> : <>
          {!list.data?.items.length && <EmptyState title="暂无证据" description="工具成功执行后，原始输出会出现在这里。" />}
          <div className="max-h-[65vh] space-y-2 overflow-auto">
            {list.data?.items.map((item) => <button key={item.id} onClick={() => setParams({ task: taskId, id: item.id })} aria-pressed={item.id === selectedId}
              className={`w-full rounded-md border p-3 text-left hover:bg-slate-50 ${item.id === selectedId ? 'border-brand-500 bg-brand-50' : 'border-ink-200'}`}>
              <p className="break-words text-sm font-medium">{item.title}</p>
              <p className="mt-1 text-xs text-ink-400">{kinds[item.kind] ?? item.kind} · {item.sizeBytes ?? '?'} 字节 · {new Date(item.createdAt).toLocaleString('zh-CN')}</p>
              <pre className="mt-2 max-h-16 overflow-hidden whitespace-pre-wrap break-all text-[11px] text-ink-600">{item.preview}</pre>
            </button>)}
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
            <span className="text-xs">第 {page} 页</span>
            <Button disabled={page * 25 >= (list.data?.total ?? 0)} onClick={() => setPage(page + 1)}>下一页</Button>
          </div>
        </>}
      </Panel>
      <Panel title="证据详情" actions={evidence?.content != null && <Button onClick={() => download(evidence)}>导出原始文本</Button>}>
        {!selectedId ? <EmptyState title="选择一条证据查看原始输出" /> : detail.isPending ? <LoadingBlock /> : detail.error ? <ErrorBlock message={detail.error.message} onRetry={() => void detail.refetch()} /> : evidence && <>
          <h3 className="mb-3 break-words text-sm font-semibold">{evidence.title}</h3>
          <Badge tone={evidence.integrity === 'match' ? 'success' : evidence.integrity === 'mismatch' ? 'danger' : 'warning'}>
            {evidence.integrity === 'match' ? '完整性校验通过' : evidence.integrity === 'mismatch' ? '完整性不一致：请复核原始来源' : '缺少校验信息'}
          </Badge>
          <dl className="my-4 grid grid-cols-[80px_minmax(0,1fr)] gap-2 break-all text-xs">
            <dt>证据 ID</dt><dd>{evidence.id}</dd>
            <dt>记录字节数</dt><dd>{evidence.sizeBytes ?? '未知'}（当前内容 {evidence.computedSizeBytes ?? '未知'}）</dd>
            <dt>SHA-256</dt><dd className="font-mono">{evidence.sha256 ?? '未记录'}</dd>
            {evidence.integrity === 'mismatch' && <><dt>当前哈希</dt><dd className="font-mono">{evidence.computedSha256}</dd></>}
            <dt>工具调用</dt><dd>{evidence.toolCallId ?? '旧证据未关联'}</dd>
            <dt>智能体会话</dt><dd>{evidence.agentSessionId ?? '无会话'} {evidence.agentSessionId && <Link className="text-brand-500 underline" to={`/agents?task=${encodeURIComponent(taskId)}`}>查看智能体</Link>}</dd>
          </dl>
          {evidence.integrity === 'mismatch' && <p className="mb-3 text-xs text-red-700">存储内容与记录的哈希或字节数不一致，可能是旧版截断造成；当前导出仅包含现存内容。</p>}
          {(evidence.content?.length ?? 0) > 120000 && <p className="mb-2 text-xs text-ink-400">页面预览前 120000 个字符，导出包含全部现存文本。</p>}
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-950 p-4 font-mono text-xs text-slate-100">{evidence.content?.slice(0, 120000) ?? '此证据未保存文本内容'}</pre>
          <EvidenceAttachments key={`${taskId}:${selectedId}`} taskId={taskId} evidenceId={selectedId} />
          <EvidenceRelations key={`relations:${taskId}:${selectedId}`} taskId={taskId} evidenceId={selectedId} />
        </>}
      </Panel>
    </div>
  </>;
}
