import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { PageHeader } from '../../components/layout/page-header';
import { Panel, LoadingBlock, EmptyState, ErrorBlock, TableShell, Th, Td } from '../../components/ui/panel';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Drawer } from '../../components/ui/drawer';
import { Field, Input, Select, Switch, Textarea } from '../../components/ui/input';
import { toolApi, type InterceptRule, type InterceptRuleInput } from '../../api/tools';

const ACTION_LABEL: Record<InterceptRule['action'], string> = { allow: '允许', deny: '禁止', ask: '申请审批' };
const ACTION_TONE: Record<InterceptRule['action'], 'neutral' | 'danger' | 'warning'> = { allow: 'neutral', deny: 'danger', ask: 'warning' };

const EMPTY: InterceptRuleInput = {
  name: '',
  enabled: true,
  priority: 0,
  matchTarget: 'tool_name',
  matchType: 'string',
  pattern: '',
  action: 'deny',
  message: null,
  timeoutEnabled: false,
  timeoutSeconds: 60,
  timeoutAction: 'deny',
};

/**
 * 拦截规则页。
 *
 * 语义与后端 intercept_rules 一致：priority 越大越先匹配，首个命中生效。
 * 允许 = 直接放行并跳过后续规则；禁止 = 阻断并把理由返回模型；申请审批 = 转人工。
 */
export function InterceptPage() {
  const client = useQueryClient();
  const [editing, setEditing] = useState<{ id: string | null; value: InterceptRuleInput } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rules = useQuery({ queryKey: ['tools', 'rules'], queryFn: () => toolApi.rules() });

  const invalidate = () => void client.invalidateQueries({ queryKey: ['tools', 'rules'] });
  const save = useMutation({
    mutationFn: ({ id, value }: { id: string | null; value: InterceptRuleInput }) =>
      id ? toolApi.updateRule(id, value) : toolApi.createRule(value),
    onSuccess: () => { invalidate(); setEditing(null); setError(null); },
    onError: (cause: Error) => setError(cause.message),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => toolApi.toggleRule(id, enabled),
    onSuccess: invalidate,
    onError: (cause: Error) => setError(cause.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => toolApi.removeRule(id),
    onSuccess: invalidate,
    onError: (cause: Error) => setError(cause.message),
  });

  const list = rules.data?.rules ?? [];
  const draft = editing?.value;

  return (
    <>
      <PageHeader
        title="拦截规则"
        description="工具调用前的平台策略。优先级越大越先匹配，首个命中生效；未命中则继续走授权范围与权限检查。"
        actions={
          <Button variant="primary" onClick={() => { setEditing({ id: null, value: { ...EMPTY } }); setError(null); }}>
            <Plus className="h-3.5 w-3.5" />
            新建规则
          </Button>
        }
      />

      {list.length === 0 && !rules.isLoading ? (
        <div className="mt-3 rounded border border-amber-200 bg-amber-50/70 px-3 py-2 text-[12px] text-amber-800">
          <ShieldAlert className="mr-1 inline h-3.5 w-3.5" />
          当前没有任何规则：工具调用不会被额外拦截，仅受授权范围与角色权限约束。
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</p> : null}

      <div className="mt-3">
        <Panel title={`规则（${list.length}）`} dense>
          {rules.isLoading ? (
            <LoadingBlock />
          ) : rules.isError ? (
            <ErrorBlock message={(rules.error as Error).message} onRetry={() => void rules.refetch()} />
          ) : list.length === 0 ? (
            <EmptyState title="暂无规则" description="没有规则时所有通过范围与权限检查的调用都会直接执行。" />
          ) : (
            <TableShell>
              <thead>
                <tr>
                  <Th className="w-[70px]">优先级</Th>
                  <Th>名称</Th>
                  <Th className="w-[90px]">目标</Th>
                  <Th className="w-[70px]">类型</Th>
                  <Th>模式</Th>
                  <Th className="w-[90px]">策略</Th>
                  <Th className="w-[70px]">启用</Th>
                  <Th className="w-[70px]">操作</Th>
                </tr>
              </thead>
              <tbody>
                {list.map((rule) => (
                  <tr key={rule.id} className={rule.enabled ? '' : 'opacity-40'}>
                    <Td className="font-mono tabular">{rule.priority}</Td>
                    <Td>{rule.name}</Td>
                    <Td className="text-[11px] text-ink-600">{rule.matchTarget === 'tool_name' ? '工具名' : '输入内容'}</Td>
                    <Td className="text-[11px] text-ink-600">{rule.matchType === 'regex' ? '正则' : '包含'}</Td>
                    <Td><code className="font-mono text-[11px]">{rule.pattern}</code></Td>
                    <Td><Badge tone={ACTION_TONE[rule.action]}>{ACTION_LABEL[rule.action]}</Badge></Td>
                    <Td><Switch checked={rule.enabled} onCheckedChange={(value) => toggle.mutate({ id: rule.id, enabled: value })} /></Td>
                    <Td>
                      <div className="flex items-center gap-1">
                        <Button size="sm" onClick={() => { setEditing({ id: rule.id, value: toInput(rule) }); setError(null); }}>编辑</Button>
                        <button type="button" aria-label={`删除规则 ${rule.name}`} onClick={() => remove.mutate(rule.id)} className="rounded border border-red-200 p-0.5 text-red-600 hover:bg-red-50">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Panel>
      </div>

      <Drawer open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.id ? '编辑规则' : '新建规则'} width="w-[440px]">
        {draft ? (
          <div className="space-y-3">
            <Field label="规则名称" required>
              <Input value={draft.name} onChange={(e) => setEditing({ ...editing!, value: { ...draft, name: e.target.value } })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="优先级" hint="数字越大越先匹配">
                <Input type="number" value={draft.priority} onChange={(e) => setEditing({ ...editing!, value: { ...draft, priority: Number(e.target.value) } })} />
              </Field>
              <Field label="启用">
                <Switch checked={draft.enabled} onCheckedChange={(value) => setEditing({ ...editing!, value: { ...draft, enabled: value } })} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="匹配目标">
                <Select value={draft.matchTarget} onChange={(e) => setEditing({ ...editing!, value: { ...draft, matchTarget: e.target.value as InterceptRuleInput['matchTarget'] } })}>
                  <option value="tool_name">工具名</option>
                  <option value="tool_input">输入内容</option>
                </Select>
              </Field>
              <Field label="匹配类型">
                <Select value={draft.matchType} onChange={(e) => setEditing({ ...editing!, value: { ...draft, matchType: e.target.value as InterceptRuleInput['matchType'] } })}>
                  <option value="string">包含</option>
                  <option value="regex">正则</option>
                </Select>
              </Field>
            </div>
            <Field label="匹配模式" required hint={draft.matchType === 'regex' ? '正则语法错误会在保存时被拒绝' : '子串匹配，区分大小写'}>
              <Input value={draft.pattern} onChange={(e) => setEditing({ ...editing!, value: { ...draft, pattern: e.target.value } })} className="font-mono" />
            </Field>
            <Field label="策略">
              <Select value={draft.action} onChange={(e) => setEditing({ ...editing!, value: { ...draft, action: e.target.value as InterceptRuleInput['action'] } })}>
                <option value="allow">允许（直接放行并跳过后续规则）</option>
                <option value="deny">禁止（阻断并把理由返回模型）</option>
                <option value="ask">申请审批（转人工）</option>
              </Select>
            </Field>
            {draft.action !== 'allow' ? (
              <Field label={draft.action === 'deny' ? '拒绝理由（返回给模型）' : '审批说明（可选）'}>
                <Textarea rows={3} value={draft.message ?? ''} onChange={(e) => setEditing({ ...editing!, value: { ...draft, message: e.target.value || null } })} />
              </Field>
            ) : null}
            {draft.action === 'ask' ? (
              <div className="grid grid-cols-3 gap-2">
                <Field label="超时启用">
                  <Switch checked={draft.timeoutEnabled} onCheckedChange={(value) => setEditing({ ...editing!, value: { ...draft, timeoutEnabled: value } })} />
                </Field>
                <Field label="超时秒数">
                  <Input type="number" min={1} value={draft.timeoutSeconds ?? 60} disabled={!draft.timeoutEnabled} onChange={(e) => setEditing({ ...editing!, value: { ...draft, timeoutSeconds: Number(e.target.value) } })} />
                </Field>
                <Field label="超时后">
                  <Select value={draft.timeoutAction ?? 'deny'} disabled={!draft.timeoutEnabled} onChange={(e) => setEditing({ ...editing!, value: { ...draft, timeoutAction: e.target.value as InterceptRuleInput['timeoutAction'] } })}>
                    <option value="deny">拒绝</option>
                    <option value="allow">放行</option>
                  </Select>
                </Field>
              </div>
            ) : null}
            <div className="flex justify-end gap-2 pt-2">
              <Button onClick={() => setEditing(null)}>取消</Button>
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ id: editing!.id, value: draft })}>保存</Button>
            </div>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}

function toInput(rule: InterceptRule): InterceptRuleInput {
  return {
    name: rule.name, enabled: rule.enabled, priority: rule.priority,
    matchTarget: rule.matchTarget, matchType: rule.matchType, pattern: rule.pattern,
    action: rule.action, message: rule.message,
    timeoutEnabled: rule.timeoutEnabled, timeoutSeconds: rule.timeoutSeconds, timeoutAction: rule.timeoutAction,
  };
}
