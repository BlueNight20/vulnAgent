import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, Save, XCircle, Zap } from 'lucide-react';
import type { ModelTestResult, UpdateSystemSettingsInput } from '@vulnagent/shared';
import { PageHeader } from '../../components/layout/page-header';
import { Panel, ErrorBlock, LoadingBlock } from '../../components/ui/panel';
import { Button } from '../../components/ui/button';
import { Field, Input, Select, Switch } from '../../components/ui/input';
import { NoticeBanner } from '../../components/common/notice-banner';
import { settingsApi } from '../../api/settings';
import { formatDuration } from '../../lib/utils';
import { DataMaintenancePanel } from '../../components/settings/data-maintenance-panel';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const catalog = useQuery({ queryKey: ['settings', 'models'], queryFn: settingsApi.models });

  const [baseUrl, setBaseUrl] = useState('');
  const [modelName, setModelName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [temperature, setTemperature] = useState(0.2);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [workerConcurrency, setWorkerConcurrency] = useState(2);
  const [defaultWorkers, setDefaultWorkers] = useState(2);
  const [modelConcurrency, setModelConcurrency] = useState(2);
  const [defaultTokens, setDefaultTokens] = useState(200000);
  const [defaultMinutes, setDefaultMinutes] = useState(60);
  const [logLevel, setLogLevel] = useState('info');
  const [logToFile, setLogToFile] = useState(false);
  const [runtimeEnabled, setRuntimeEnabled] = useState(false);
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    setBaseUrl(settings.data.model.baseUrl);
    setModelName(settings.data.model.modelName);
    setTemperature(settings.data.model.temperature);
    setMaxTokens(settings.data.model.maxTokens);
    setWorkerConcurrency(settings.data.runtime.workerMaxConcurrency);
    setDefaultWorkers(settings.data.runtime.defaultWorkerCount);
    setModelConcurrency(settings.data.runtime.modelMaxConcurrency);
    setDefaultTokens(settings.data.runtime.defaultTokenBudget);
    setDefaultMinutes(settings.data.runtime.defaultTimeBudgetMinutes);
    setLogLevel(settings.data.runtime.logLevel);
    setLogToFile(settings.data.runtime.logToFile);
    setRuntimeEnabled(settings.data.runtime.piRuntimeEnabled);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => {
      const payload: UpdateSystemSettingsInput = {
        model: {
          baseUrl,
          modelName,
          temperature,
          maxTokens,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
        runtime: {
          piRuntimeEnabled: runtimeEnabled,
          workerMaxConcurrency: workerConcurrency,
          defaultWorkerCount: defaultWorkers,
          modelMaxConcurrency: modelConcurrency,
          defaultTokenBudget: defaultTokens,
          defaultTimeBudgetMinutes: defaultMinutes,
          logLevel,
          logToFile,
        },
      };
      return settingsApi.update(payload);
    },
    onSuccess: () => {
      setApiKey('');
      setSavedAt(new Date().toLocaleTimeString('zh-CN'));
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const test = useMutation({
    mutationFn: () => settingsApi.testModel(),
    onSuccess: (result) => setTestResult(result),
  });

  const keyConfigured = settings.data?.model.apiKeyConfigured ?? false;
  const catalogMeta = (catalog.data?.items ?? []).find((m) => m.id === modelName.trim());

  return (
    <>
      <PageHeader
        title="系统设置"
        description="模型 Provider、API Key 与运行时并发。密钥以 AES-256-GCM 加密存储后段，接口只返回掩码。"
        actions={
          <>
            <Button onClick={() => test.mutate()} loading={test.isPending} disabled={!keyConfigured}>
              <Zap className="h-3.5 w-3.5" />
              测试连接
            </Button>
            <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
              <Save className="h-3.5 w-3.5" />
              保存配置
            </Button>
          </>
        }
      />

      {settings.data?.encryptionKeyEphemeral ? (
        <div className="mb-3">
          <NoticeBanner
            tone="warning"
            text="未配置 VA_ENCRYPTION_KEY，当前使用临时加密密钥：进程重启后已保存的 API Key 将无法解密，请在 .env 中设置固定密钥。"
          />
        </div>
      ) : null}

      {savedAt ? (
        <div className="mb-3">
          <NoticeBanner text={`配置已写入数据库并即时生效（${savedAt}），模型网关已重新加载。`} />
        </div>
      ) : null}

      {testResult ? (
        <div
          className={`mb-3 flex items-start gap-2 rounded-md border px-3 py-2 ${
            testResult.ok ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'
          }`}
        >
          {testResult.ok ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          ) : (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          )}
          <div className="min-w-0 text-[12px]">
            <p className={testResult.ok ? 'font-medium text-emerald-800' : 'font-medium text-red-800'}>
              模型测试结果：{testResult.message}
            </p>
            <p className="mt-0.5 text-ink-600">
              模型 {testResult.modelName} · 耗时 {formatDuration(testResult.latencyMs)} · 消耗{' '}
              {testResult.tokensUsed} tokens
              {testResult.outputPreview ? ` · 输出：${testResult.outputPreview}` : ''}
            </p>
          </div>
        </div>
      ) : null}

      {settings.isLoading ? (
        <LoadingBlock />
      ) : settings.isError ? (
        <ErrorBlock message={(settings.error as Error).message} onRetry={() => void settings.refetch()} />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Panel title="云端模型（OpenAI 兼容）" description="用于 Planner 与全部 Worker 的模型调用">
            <div className="space-y-3">
              <Field label="Base URL" hint="例如 https://api.deepseek.com/v1">
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="font-mono" />
              </Field>
              <Field
                label="模型名称"
                hint={
                  catalogMeta
                    ? `上下文 ${catalogMeta.contextWindow.toLocaleString()} tokens · 单价 $${catalogMeta.costPerMTokens.input}/M 输入、$${catalogMeta.costPerMTokens.output}/M 输出`
                    : '未收录的模型将使用保守默认参数（上下文 128K，成本按默认单价估算），可直接填写服务商提供的任意模型 ID'
                }
              >
                <Input
                  list="model-name-options"
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  placeholder="例如 deepseek-chat、gpt-4o-mini、qwen-plus"
                  className="font-mono"
                  autoComplete="off"
                />
                <datalist id="model-name-options">
                  {(catalog.data?.items ?? []).map((m) => (
                    <option key={m.id} value={m.id} />
                  ))}
                </datalist>
              </Field>
              <Field
                label="API Key"
                hint={
                  keyConfigured
                    ? `当前已配置：${settings.data?.model.apiKeyMasked}。留空表示不修改。`
                    : '尚未配置。填写后保存，密钥仅在后端加密存储。'
                }
              >
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={keyConfigured ? '留空以保持现有密钥' : 'sk-...'}
                    className="pl-7 font-mono"
                    autoComplete="new-password"
                  />
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="温度">
                  <Input
                    type="number"
                    step={0.1}
                    min={0}
                    max={2}
                    value={temperature}
                    onChange={(e) => setTemperature(Number(e.target.value))}
                    className="font-mono"
                  />
                </Field>
                <Field label="单次最大 Token">
                  <Input
                    type="number"
                    min={64}
                    max={200000}
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(Number(e.target.value))}
                    className="font-mono"
                  />
                </Field>
              </div>
            </div>
          </Panel>

          <Panel title="运行时与预算" description="并发限制同时作用于 Planner 与所有 Worker 的模型请求">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="模型请求并发" hint="默认 2">
                  <Input
                    type="number"
                    min={1}
                    max={16}
                    value={modelConcurrency}
                    onChange={(e) => setModelConcurrency(Number(e.target.value))}
                    className="font-mono"
                  />
                </Field>
                <Field label="全局 Worker 并发上限" hint="所有任务合计，含派发排队；降低后等待已有 Worker 收尾，不强制终止">
                  <Input
                    type="number"
                    min={1}
                    max={8}
                    value={workerConcurrency}
                    onChange={(e) => setWorkerConcurrency(Number(e.target.value))}
                    className="font-mono"
                  />
                </Field>
                <Field label="默认任务 Worker 数量" hint="新任务的自身上限，仍受全局上限约束">
                  <Input type="number" min={1} max={8} value={defaultWorkers} onChange={(e) => setDefaultWorkers(Number(e.target.value))} className="font-mono" />
                </Field>
                <Field label="默认 Token 预算">
                  <Input
                    type="number"
                    min={1000}
                    value={defaultTokens}
                    onChange={(e) => setDefaultTokens(Number(e.target.value))}
                    className="font-mono"
                  />
                </Field>
                <Field label="默认时间预算（分钟）">
                  <Input
                    type="number"
                    min={1}
                    value={defaultMinutes}
                    onChange={(e) => setDefaultMinutes(Number(e.target.value))}
                    className="font-mono"
                  />
                </Field>
              </div>
              <Field label="日志级别">
                <Select value={logLevel} onChange={(e) => setLogLevel(e.target.value)}>
                  <option value="debug">debug</option>
                  <option value="info">info</option>
                  <option value="warn">warn</option>
                  <option value="error">error</option>
                </Select>
              </Field>
              <div className="rounded border border-ink-200 bg-slate-50/60 px-3 py-2">
                <div className="flex items-center gap-2.5"><Switch checked={logToFile} onCheckedChange={setLogToFile} disabled={save.isPending} label="保存运行日志到文件" /><span className="text-[12px] text-ink-600">保存运行日志到文件，点击保存后生效。</span></div>
                {settings.data?.loggingStatus ? <p className="mt-1 break-all text-[11px] text-ink-500">当前级别：{settings.data.loggingStatus.level}；文件输出：{settings.data.loggingStatus.fileEnabled ? settings.data.loggingStatus.activeFile : '已关闭'}{settings.data.loggingStatus.lastError ? `；${settings.data.loggingStatus.lastError}` : ''}</p> : null}
              </div>
              <div className="flex items-center gap-2.5 rounded border border-ink-200 bg-slate-50/60 px-3 py-2">
                  <Switch checked={runtimeEnabled} onCheckedChange={setRuntimeEnabled} disabled={save.isPending} label="启用执行引擎" />
                <span className="text-[12px] text-ink-600">
                    {runtimeEnabled ? '执行引擎已选择启用' : '执行引擎已选择关闭'}，点击保存后生效。关闭会阻止任务的新模型和工具请求并暂停运行任务；已发出的操作仍需核实收尾，重新开启后须手动恢复任务。手工测试模型连接仍可使用。
                </span>
              </div>
            </div>
          </Panel>
        </div>
      )}

      {save.isError ? (
        <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          保存失败：{(save.error as Error).message}
        </div>
      ) : null}
      {test.isError && !testResult ? (
        <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          测试请求失败：{(test.error as Error).message}
        </div>
      ) : null}
      <DataMaintenancePanel />
    </>
  );
}
