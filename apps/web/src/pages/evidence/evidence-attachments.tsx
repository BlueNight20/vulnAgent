import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { EvidenceAttachmentDto } from '@vulnagent/shared';
import { api } from '../../api/client';
import { downloadReportFile } from '../../api/report-download';
import { Button } from '../../components/ui/button';
import { ErrorBlock, LoadingBlock } from '../../components/ui/panel';

export function EvidenceAttachments({ taskId, evidenceId }: { taskId: string; evidenceId: string }) {
  const base = `/tasks/${encodeURIComponent(taskId)}/evidence/${encodeURIComponent(evidenceId)}/attachments`;
  const query = useQuery({ queryKey: ['evidence-attachments', taskId, evidenceId], queryFn: () => api.get<{ items: EvidenceAttachmentDto[]; missingIds?: string[]; references?: { uri: string; name: string }[]; unsupportedBlocks?: string[] }>(base) });
  const [previewId, setPreviewId] = useState(''); const [previewError, setPreviewError] = useState('');
  const download = useMutation({ mutationFn: (item: EvidenceAttachmentDto) => downloadReportFile(`${base}/${encodeURIComponent(item.id)}/download`, item.filename) });
  return <section className="mt-4 border-t border-ink-200 pt-3" aria-label="证据附件">
    <h3 className="mb-3 text-sm font-semibold">二进制附件（{query.data?.items?.length ?? 0}）</h3>
    {query.isPending ? <LoadingBlock /> : query.error ? <ErrorBlock message={query.error.message} onRetry={() => void query.refetch()} /> : <>
      {!!query.data?.missingIds?.length && <ErrorBlock message={`来源附件已丢失：${query.data.missingIds.join(', ')}`} />}
      {!query.data?.items?.length && <p className="text-xs text-ink-400">没有已保存的内嵌附件。</p>}
      <div className="space-y-2">{query.data?.items?.map((item) => <div key={item.id} className="rounded border border-ink-200 p-3 text-xs">
        <p className="break-all font-medium">{item.filename} · {item.mimeType} · {item.sizeBytes} 字节</p>
        <p className="my-2 break-all text-ink-400">附件 {item.id}<br />SHA-256 {item.sha256}</p>
        {item.integrity !== 'match' && <p className="mb-2 text-red-700">附件完整性不一致，下载与预览已停止。</p>}
        <div className="flex gap-2"><Button size="sm" disabled={item.integrity !== 'match' || download.isPending} onClick={() => download.mutate(item)}>下载附件</Button>{item.previewable && <Button size="sm" onClick={() => { setPreviewId(previewId === item.id ? '' : item.id); setPreviewError(''); }}>{previewId === item.id ? '收起图片' : '预览图片'}</Button>}</div>
        {previewId === item.id && <div className="mt-3">{previewError ? <ErrorBlock message={previewError} /> : <img src={`/api${base}/${encodeURIComponent(item.id)}/preview`} alt={`证据截图：${item.filename}`} loading="lazy" onError={() => setPreviewError('图片预览失败，来源可能已变化；请刷新附件校验状态。')} className="max-h-[60vh] max-w-full rounded border bg-slate-100 object-contain" />}</div>}
      </div>)}</div>
      {!!query.data?.references?.length && <div className="mt-3 space-y-2 text-xs text-ink-500"><p>以下外部引用尚未下载，系统没有自动访问这些地址：</p>{query.data.references.map((r, i) => <p key={i} className="break-all">{r.name}：{r.uri}</p>)}</div>}
      {!!query.data?.unsupportedBlocks?.length && <p className="mt-2 text-xs text-amber-700">未识别的 MCP 内容类型：{query.data.unsupportedBlocks.join(', ')}</p>}
    </>}
    {download.error && <ErrorBlock message={download.error.message} />}
  </section>;
}
