import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_TIME_BUDGET_MINUTES,
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_WORKER_COUNT,
  TASK_WORKER_COUNT_MAX,
  TASK_WORKER_COUNT_MIN,
  isMissingUrlScheme,
  isValidPortSpec,
  isValidTarget,
  normalizeTargets,
  targetOrigin,
} from '@vulnagent/shared';
import { Drawer } from '../ui/drawer';
import { Button } from '../ui/button';
import { Field, Input, Select, Switch, Textarea } from '../ui/input';
import { tasksApi } from '../../api/tasks';
import { cn } from '../../lib/utils';
import type { TaskGoalInput } from '@vulnagent/shared';
import { settingsApi } from '../../api/settings';
import { ErrorBlock, LoadingBlock } from '../ui/panel';

const MODEL_OPTIONS = [
  { label: 'DeepSeek Chat（openai 兼容）', provider: 'openai-compatible', model: 'deepseek-chat' },
  { label: 'DeepSeek Reasoner（openai 兼容）', provider: 'openai-compatible', model: 'deepseek-reasoner' },
  { label: 'GPT-4o（openai 兼容）', provider: 'openai-compatible', model: 'gpt-4o' },
];

const STEPS = ['授权目标与范围', '模型与预算', '并发与确认'];

export function CreateTaskDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <CreateTaskForm open={open} onClose={onClose} /> : null;
}

function CreateTaskForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings', 'task-defaults'], queryFn: settingsApi.get, staleTime: 0, refetchOnWindowFocus: false });
  const initialized = useRef(false);
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [targetsRaw, setTargetsRaw] = useState('');
  const [ports, setPorts] = useState('1-1000');
  const [authorized, setAuthorized] = useState(false);
  const [modelName, setModelName] = useState('');
  const [modelProvider, setModelProvider] = useState('');
  const [savedModel, setSavedModel] = useState('');
  const [tokenBudget, setTokenBudget] = useState(DEFAULT_TOKEN_BUDGET);
  const [timeBudget, setTimeBudget] = useState(DEFAULT_TIME_BUDGET_MINUTES);
  const [workerCount, setWorkerCount] = useState(DEFAULT_WORKER_COUNT);
  const [autoStart, setAutoStart] = useState(true);
  const [goalMode, setGoalMode] = useState<TaskGoalInput['mode']>('assessment');
  const [goalProtocol, setGoalProtocol] = useState<'tcp' | 'udp'>('tcp');
  const [evidenceText, setEvidenceText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialized.current || !settings.data || settings.isFetching || settings.isError) return;
    const defaults = settings.data;
    setTokenBudget(defaults.runtime.defaultTokenBudget); setTimeBudget(defaults.runtime.defaultTimeBudgetMinutes);
    setWorkerCount(defaults.runtime.defaultWorkerCount); setModelName(defaults.model.modelName);
    setSavedModel(defaults.model.modelName); setModelProvider(defaults.model.provider);
    setAutoStart(defaults.runtime.piRuntimeEnabled);
    initialized.current = true; setReady(true);
  }, [settings.data, settings.isFetching, settings.isError]);

  const modelOptions = [
    ...(savedModel ? [{ label: `系统设置（${savedModel}）`, model: savedModel }] : []),
    ...MODEL_OPTIONS.filter((option) => option.model !== savedModel),
  ];

  const targets = useMemo(() => normalizeTargets(targetsRaw), [targetsRaw]);
  const invalidTargets = targets.filter((t) => !isValidTarget(t));
  const targetError = invalidTargets.length
    ? `格式不合法：${invalidTargets.map((t) => (isMissingUrlScheme(t) ? `${t}（缺少 http:// 或 https://）` : t)).join('、')}`
    : null;
  const portsInvalid = !isValidPortSpec(ports);

  const step1Valid = name.trim().length >= 2 && targets.length > 0 && targets.length <= 64 && invalidTargets.length === 0 && !portsInvalid && (goalMode !== 'evidence' || evidenceText.trim().length >= 8);
  const step2Valid = modelName.trim().length > 0 && Number.isInteger(tokenBudget) && tokenBudget >= 1000 && tokenBudget <= 10000000 && Number.isInteger(timeBudget) && timeBudget >= 1 && timeBudget <= 1440;

  const mutation = useMutation({
    mutationFn: () => {
      return tasksApi.create({
        name: name.trim(),
        description: description.trim() || null,
        targets: targets.map((ip) => ({ ip })),
        scope: { cidrs: [], ports: ports.trim() || null },
        authorizationRef: null,
        authorized: true,
        modelProvider,
        modelName,
        tokenBudget,
        timeBudgetMinutes: timeBudget,
        workerCount,
        autoStart,
        goal: { mode: goalMode, targets, ports: goalMode === 'evidence' ? null : ports.trim() || '1-1000', protocol: goalProtocol, evidenceText: goalMode === 'evidence' ? evidenceText.trim() : null },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      reset();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  function reset() {
    setStep(0);
    setName('');
    setDescription('');
    setTargetsRaw('');
    setPorts('1-1000');
    setAuthorized(false);
    setGoalMode('assessment'); setGoalProtocol('tcp'); setEvidenceText('');
    setError(null);
  }

  const submit = () => {
    if (!ready || !step1Valid || !step2Valid || !Number.isInteger(workerCount) || workerCount < TASK_WORKER_COUNT_MIN || workerCount > TASK_WORKER_COUNT_MAX) { setError('请核对目标、模型、预算和 Worker 数量'); return; }
    if (!authorized) {
      setError('请先确认对测试目标拥有授权');
      return;
    }
    setError(null);
    mutation.mutate();
  };

  if (!ready) return <Drawer open={open} onClose={onClose} title="新建测试任务" footer={<Button onClick={onClose}>取消</Button>}>
    {settings.isError ? <ErrorBlock message={(settings.error as Error).message} onRetry={() => void settings.refetch()} /> : <LoadingBlock />}
  </Drawer>;

  return (
    <Drawer
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="新建测试任务"
      description="按测试目标、预算和验收目标执行；结论需要实际证据支持。"
      width="w-[620px]"
      footer={
        <>
          <Button onClick={() => { reset(); onClose(); }}>取消</Button>
          {step > 0 ? <Button onClick={() => setStep((s) => s - 1)}>上一步</Button> : null}
          {step < STEPS.length - 1 ? (
            <Button
              variant="primary"
              disabled={step === 0 ? !step1Valid : !step2Valid}
              onClick={() => setStep((s) => s + 1)}
            >
              下一步
            </Button>
          ) : (
            <Button variant="primary" loading={mutation.isPending} onClick={submit}>
              创建任务
            </Button>
          )}
        </>
      }
    >
      <ol className="mb-5 flex items-center gap-2 text-[12px]">
        {STEPS.map((label, idx) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                'grid h-5 w-5 place-items-center rounded-full text-[10px] font-semibold',
                idx === step
                  ? 'bg-brand-500 text-white'
                  : idx < step
                    ? 'bg-brand-100 text-brand-700'
                    : 'bg-slate-100 text-ink-400',
              )}
            >
              {idx + 1}
            </span>
            <span className={idx === step ? 'font-medium text-ink-900' : 'text-ink-600'}>{label}</span>
            {idx < STEPS.length - 1 ? <span className="w-6 border-t border-dashed border-ink-200" /> : null}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <div className="space-y-3.5">
          <Field label="任务名称" required error={name && name.trim().length < 2 ? '至少 2 个字符' : null}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 VulnHub DC-1 信息收集" />
          </Field>
          <Field label="任务描述">
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="本次测试的目的、范围与约束"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="验收目标" hint="网段目标按扫描流程验收；不将未响应主机视为不存在。">
              <Select aria-label="验收目标类型" value={goalMode} onChange={(e) => setGoalMode(e.target.value as TaskGoalInput['mode'])}>
                <option value="assessment">范围观测、漏洞分析与候选复核</option><option value="recon">指定范围观测</option><option value="evidence">指定证据标记</option>
              </Select>
            </Field>
            <Field label="验收协议" hint="范围观测使用下方端口；留空端口时验收默认 1-1000。">
              <Select aria-label="验收协议" value={goalProtocol} onChange={(e) => setGoalProtocol(e.target.value as 'tcp' | 'udp')}><option value="tcp">TCP</option><option value="udp">UDP</option></Select>
            </Field>
          </div>
          {goalMode === 'evidence' && <Field label="工具输出必须包含的标记" hint="8 到 2000 个字符，按原文精确匹配。"><Textarea aria-label="证据标记" maxLength={2000} value={evidenceText} onChange={(e) => setEvidenceText(e.target.value)} /></Field>}
          <Field
            label="测试目标"
            required
            hint="支持公网 URL、域名、IPv4 或 CIDR（多个用空格或分号分隔；URL 请写完整协议，例如 https://host:port/path）"
            error={invalidTargets.length ? targetError : null}
          >
            <Textarea
              rows={2}
              value={targetsRaw}
              onChange={(e) => setTargetsRaw(e.target.value)}
              placeholder="192.168.56.101"
              className="font-mono"
            />
          </Field>
          <Field label="端口范围" hint="留空表示不限；网段目标验收默认 1-1000。" error={portsInvalid ? '格式不合法，例如 1-1000 或 80,443' : null}>
            <Input value={ports} onChange={(e) => setPorts(e.target.value)} className="font-mono" />
          </Field>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="space-y-3.5">
          <Field label="云模型">
            <Select aria-label="任务模型" value={modelName} onChange={(e) => setModelName(e.target.value)}>
              {!savedModel && <option value="">请选择模型或先在系统设置中配置</option>}
              {modelOptions.map((m) => (
                <option key={m.model} value={m.model}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Token 预算" required error={tokenBudget < 1000 ? '不得少于 1000' : null}>
              <Input
                aria-label="任务 Token 预算"
                type="number"
                min={1000}
                max={10000000}
                step={1000}
                value={tokenBudget}
                onChange={(e) => setTokenBudget(Number(e.target.value))}
                className="font-mono"
              />
            </Field>
            <Field label="时间预算（分钟）" required>
              <Input
                aria-label="任务时间预算"
                type="number"
                min={1}
                max={1440}
                value={timeBudget}
                onChange={(e) => setTimeBudget(Number(e.target.value))}
                className="font-mono"
              />
            </Field>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="space-y-3.5">
          <Field label={`Worker 数量（${TASK_WORKER_COUNT_MIN}–${TASK_WORKER_COUNT_MAX}）`} hint="任务自身的并发上限；实际派发还受系统全局上限约束。">
            <Input
              aria-label="任务 Worker 数量"
              type="number"
              min={TASK_WORKER_COUNT_MIN}
              max={TASK_WORKER_COUNT_MAX}
              value={workerCount}
              onChange={(e) => setWorkerCount(Number(e.target.value))}
              className="w-28 font-mono"
            />
          </Field>
          <div className="flex items-center gap-2.5">
            <Switch checked={autoStart} onCheckedChange={setAutoStart} label="创建后立即开始" />
            <span className="text-[12px] text-ink-600">创建后立即置为「运行中（排队）」</span>
          </div>

          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 rounded-md border border-ink-200 bg-slate-50/60 p-3 text-[12px]">
            <dt className="text-ink-400">任务名称</dt>
            <dd className="text-ink-900">{name || '—'}</dd>
            <dt className="text-ink-400">目标</dt>
            <dd className="break-all font-mono text-ink-900">{targets.map(targetOrigin).join(', ') || '—'}</dd>
            <dt className="text-ink-400">端口范围</dt>
            <dd className="font-mono text-ink-900">{ports || '不限'}</dd>
            <dt className="text-ink-400">模型</dt>
            <dd className="text-ink-900">{modelName}</dd>
            <dt className="text-ink-400">预算</dt>
            <dd className="font-mono text-ink-900">
              {tokenBudget.toLocaleString()} token · {timeBudget} 分钟
            </dd>
            <dt className="text-ink-400">Worker</dt>
            <dd className="font-mono text-ink-900">{workerCount}</dd>
          </dl>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50/60 p-3">
            <input
              type="checkbox"
              checked={authorized}
              onChange={(e) => setAuthorized(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-amber-600"
            />
            <span className="text-[12px] text-amber-900">
              我确认已获得对上方目标的测试授权，执行范围仅限已填写的目标，平台不会对目标之外的主机发起任何操作。
            </span>
          </label>
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 rounded border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-700">
          {error}
        </p>
      ) : null}
    </Drawer>
  );
}
