import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, Send, Square } from 'lucide-react';
import type { SessionDto } from '@vulnagent/shared';
import { SESSION_STATE_LABEL } from '@vulnagent/shared';
import { Button } from '../ui/button';
import { Textarea } from '../ui/input';
import { formatCost, formatNumber } from '../../lib/utils';
import { agentsApi, blackboardApi } from '../../api/agents';

export function SessionPanel({
  session,
  taskId,
}: {
  session: SessionDto;
  taskId: string;
}) {
  const queryClient = useQueryClient();
  const [hint, setHint] = useState('');
  const [hintTarget, setHintTarget] = useState<'session' | 'task'>('session');

  const hints = useQuery({
    queryKey: ['blackboard', 'hints', taskId],
    queryFn: () => blackboardApi.hints(taskId),
    refetchInterval: 8000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['agents'] });
    void queryClient.invalidateQueries({ queryKey: ['blackboard', 'hints', taskId] });
  };

  const control = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'terminate') => agentsApi[action](session.id),
    onSettled: invalidate,
    retry: false,
  });
  const addHint = useMutation({
    mutationFn: () => blackboardApi.createHint(taskId, hint.trim(), hintTarget === 'session' ? session.id : undefined),
    onSuccess: () => {
      setHint('');
      invalidate();
    },
  });

  const card = session.stateCard;
  const canPause = session.state === 'running';
  const canResume = session.state === 'paused';
  const canHint = ['created', 'running', 'paused'].includes(session.state);

  return (
    <div className="flex h-full flex-col">
      <section className="border-b border-ink-200 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] font-semibold text-ink-900">状态卡</p>
          <span className="text-[10px] text-ink-400">{SESSION_STATE_LABEL[session.state]}</span>
        </div>
        <dl className="mt-2 space-y-1 text-[11px]">
          <div className="flex justify-between gap-2">
            <dt className="text-ink-400">当前阶段</dt>
            <dd className="truncate text-ink-900">{card?.phase ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-ink-400">当前意图</dt>
            <dd className="truncate text-ink-900">{card?.currentIntentTitle ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-ink-400">工具调用</dt>
            <dd className="font-mono text-ink-900">{card?.toolCallCount ?? 0}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-ink-400">消息数</dt>
            <dd className="font-mono text-ink-900">{session.messageCount}</dd>
          </div>
        </dl>
        {card?.plan?.length ? (
          <ul className="mt-2 space-y-0.5">
            {card.plan.map((item) => (
              <li key={item} className="flex items-start gap-1.5 text-[11px] text-ink-600">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand-500" />
                {item}
              </li>
            ))}
          </ul>
        ) : null}
        {session.errorMessage ? (
          <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700">
            {session.errorMessage}
          </p>
        ) : null}
      </section>

      <section className="border-b border-ink-200 px-4 py-3">
        <p className="mb-1.5 text-[12px] font-semibold text-ink-900">Token 统计</p>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded border border-ink-200 px-1 py-1.5">
            <p className="font-mono text-[13px] tabular text-ink-900">{formatNumber(session.tokenInput)}</p>
            <p className="text-[10px] text-ink-400">输入</p>
          </div>
          <div className="rounded border border-ink-200 px-1 py-1.5">
            <p className="font-mono text-[13px] tabular text-ink-900">{formatNumber(session.tokenOutput)}</p>
            <p className="text-[10px] text-ink-400">输出</p>
          </div>
          <div className="rounded border border-ink-200 px-1 py-1.5">
            <p className="font-mono text-[13px] tabular text-ink-900">{formatCost(session.costUsd)}</p>
            <p className="text-[10px] text-ink-400">成本</p>
          </div>
        </div>
        <div className="mt-2 flex gap-1.5">
          <Button size="sm" disabled={!canPause || control.isPending} loading={control.isPending && control.variables === 'pause'} onClick={() => control.mutate('pause')}>
            <Pause className="h-3 w-3" />
            暂停
          </Button>
          <Button size="sm" disabled={!canResume || control.isPending} loading={control.isPending && control.variables === 'resume'} onClick={() => control.mutate('resume')}>
            <Play className="h-3 w-3" />
            恢复
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={control.isPending || session.state === 'terminated' || session.state === 'completed'}
            loading={control.isPending && control.variables === 'terminate'}
            onClick={() => control.mutate('terminate')}
          >
            <Square className="h-3 w-3" />
            终止
          </Button>
        </div>
        {control.isError ? <p role="alert" className="mt-2 text-[11px] text-danger">会话操作失败：{control.error.message}</p> : null}
      </section>

      <section className="border-b border-ink-200 px-4 py-3">
        <p className="mb-1.5 text-[12px] font-semibold text-ink-900">注入人工提示</p>
        <select aria-label="提示投递目标" className="mb-1.5 w-full rounded border border-ink-200 px-2 py-1 text-[12px]" value={hintTarget} onChange={(event) => setHintTarget(event.target.value as 'session' | 'task')} disabled={addHint.isPending}>
          <option value="session">当前会话</option>
          <option value="task">任务规划（Planner）</option>
        </select>
        <Textarea
          rows={2}
          maxLength={2000}
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          placeholder="例如：优先尝试 admin/admin 登录，注意 8080 端口"
          className="text-[12px]"
        />
        <Button
          size="sm"
          variant="primary"
          className="mt-1.5 w-full"
          disabled={(hintTarget === 'session' && !canHint) || !hint.trim() || addHint.isPending}
          loading={addHint.isPending}
          onClick={() => addHint.mutate()}
        >
          <Send className="h-3 w-3" />
          {hintTarget === 'session' ? '提交给该会话' : '提交任务提示'}
        </Button>
        <p className="mt-1 text-[10px] text-ink-400">{hintTarget === 'task' ? '供 Planner 后续规划使用，不自动启动或恢复任务。' : canHint ? '仅投递给该会话；暂停时等待恢复。已消费表示提示已进入会话记录，不表示模型已采纳。' : '该会话已结束，请选择当前活动会话或提交任务提示。'}</p>
        {addHint.isError ? (
          <p className="mt-1 text-[10px] text-danger">{(addHint.error as Error).message}</p>
        ) : null}
      </section>

      <section className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p className="mb-1.5 text-[12px] font-semibold text-ink-900">提示历史</p>
        {hints.isError ? <p role="alert" className="text-[11px] text-danger">提示历史加载失败：{hints.error.message}</p> : (hints.data?.items ?? []).length === 0 ? (
          <p className="text-[11px] text-ink-400">暂无提示</p>
        ) : (
          <ul className="space-y-1.5">
            {(hints.data?.items ?? []).map((h) => (
              <li key={h.id} className="rounded border border-ink-200 px-2 py-1.5">
                <p className="text-[11px] text-ink-900">{h.content}</p>
                <p className="mt-0.5 text-[10px] text-ink-400">
                  {h.agentSessionId ? `定向 ${h.agentSessionId.slice(0, 8)} · ` : '任务提示（Planner） · '}
                  {h.status === 'consumed' ? '已消费' : h.status === 'pending' ? '待消费' : '已忽略'}
                  {h.appliedToSessionId ? ` · 会话 ${h.appliedToSessionId.slice(0, 8)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
