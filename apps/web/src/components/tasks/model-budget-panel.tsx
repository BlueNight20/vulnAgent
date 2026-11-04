import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ModelBudgetDto } from '@vulnagent/shared';
import { api } from '../../api/client';
import { Button } from '../ui/button';

const stateLabel = { reserved: '请求在途', settled: '已结算', uncertain: '用量未确认', cancelled: '发送前取消' };
export function ModelBudgetPanel({ taskId }: { taskId: string }) {
  const [page, setPage] = useState(1); const [history, setHistory] = useState(false);
  const budget = useQuery({ queryKey: ['model-budget', taskId, page, history], enabled: Boolean(taskId), refetchInterval: 5000,
    queryFn: () => api.get<ModelBudgetDto>(`/tasks/${encodeURIComponent(taskId)}/model-budget?page=${page}&history=${history}`) });
  return <section className="space-y-2 text-xs">
    <p className="font-semibold">模型 Token 额度与请求</p>
    {budget.isPending && <p>正在读取额度…</p>}
    {budget.error && <p role="alert" className="text-red-700">{budget.error.message}</p>}
    {budget.data && <>
      <p>本轮已报告 {budget.data.knownTokens} · 在途/未确认占用 {budget.data.committedTokens} · 可用余额 {budget.data.remainingTokens}</p>
      <p className="text-ink-500">任务预算 {budget.data.tokenBudget}，探索可用 {budget.data.usableTokens}（保留 10%）。{budget.data.note}</p>
      {budget.data.items.some((r) => r.state === 'uncertain') && <p className="rounded bg-amber-50 p-2 text-amber-800">存在用量未确认请求，同一会话不会自动重试。请核查供应商用量；任务重新运行会使用新一轮额度，历史请求仍保留。</p>}
      <label className="flex items-center gap-2"><input type="checkbox" checked={history} onChange={(e) => { setHistory(e.target.checked); setPage(1); }} />包含历史运行请求</label>
      {!budget.data.items.length && <p className="text-ink-500">此范围暂无模型请求账本。</p>}
      <ul className="max-h-72 space-y-2 overflow-auto">{budget.data.items.map((r) => <li key={r.id} className="space-y-1 rounded border border-ink-200 p-2">
        <p>{stateLabel[r.state]} · {r.modelName} · {r.currentRun ? '本轮' : '历史运行'}</p>
        <p>输入预估 {r.inputEstimate} · 输出上限 {r.maxOutputTokens} · 当前占用 {r.committedTokens}</p>
        <p>已报告输入/输出：{r.inputTokens ?? '未知'} / {r.outputTokens ?? '未知'}{r.state === 'uncertain' ? '（可能不完整）' : ''}</p>
        <p className="break-all text-ink-500">请求 {r.id} · 会话 {r.sessionId}</p>
        {r.errorMessage && <p className="break-words text-amber-800">{r.errorMessage}</p>}
      </li>)}</ul>
      <div className="flex items-center gap-2"><Button size="sm" disabled={page <= 1 || budget.isFetching} onClick={() => setPage(page - 1)}>上一页</Button><span>第 {page} 页 · {budget.data.total} 条</span><Button size="sm" disabled={page * 25 >= budget.data.total || budget.isFetching} onClick={() => setPage(page + 1)}>下一页</Button></div>
    </>}
  </section>;
}
