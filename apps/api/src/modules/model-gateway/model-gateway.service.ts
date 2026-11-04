import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ModelMeta } from './model-catalog';
import { listKnownModels, resolveModelMeta } from './model-catalog';
import { SettingsService } from '../settings/settings.service';
import { ConcurrencyLimiter } from './concurrency-limiter';
import { loadOpenAiCompletionsApi, loadPiAi } from '../pi-runtime/esm-loader';
import { ModelBudgetService } from './model-budget.service';
import { managedModelStream } from './managed-model-stream';
import { TokenBudgetBusyError, waitForBudget } from './token-budget';
import { ConflictException } from '@nestjs/common';
import { RUNTIME_DISABLED } from '../../database/runtime-control';

/** Pi SDK 是纯 ESM 包，后端为 CJS，必须动态导入 */
type PiAiModule = {
  createModels: (options?: unknown) => MutableModelsLike;
  createProvider: (options: unknown) => unknown;
};

interface ModelLike {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

interface AssistantMessageLike {
  role: 'assistant';
  content: unknown[];
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: string;
  errorMessage?: string;
}

interface MutableModelsLike {
  setProvider(provider: unknown): void;
  deleteProvider(id: string): void;
  getModel(provider: string, id: string): ModelLike | undefined;
  streamSimple(model: ModelLike, context: unknown, options?: unknown): unknown;
  completeSimple(model: ModelLike, context: unknown, options?: unknown): Promise<AssistantMessageLike>;
}

export const PROVIDER_ID = 'vulnagent-openai';

/** 单次模型流的最长等待：超过后强制释放并发槽位 */
const STREAM_STALL_TIMEOUT_MS = 300_000;

export interface ModelTestOutcome {
  ok: boolean;
  latencyMs: number;
  message: string;
  httpStatus: number | null;
  outputPreview: string | null;
  modelName: string;
  tokensUsed: number;
  checkedAt: string;
}

/**
 * 模型网关：
 * - 依据数据库中的 OpenAI 兼容配置构建 Pi `Models` 集合
 * - API Key 只在请求级注入（options.apiKey），不写入 provider 对象
 * - 统一并发限流，Planner 与所有 Worker 共享同一配额
 */
@Injectable()
export class ModelGatewayService implements OnModuleInit {
  private readonly logger = new Logger(ModelGatewayService.name);
  private piAi: PiAiModule | null = null;
  private models: MutableModelsLike | null = null;
  private cachedModel: ModelLike | null = null;
  private cachedSignature = '';
  private limiter = new ConcurrencyLimiter(2);

  constructor(private readonly settings: SettingsService, private readonly budgets: ModelBudgetService) {}

  /**
   * 启动阶段只做纯 JS 的注册，**不加载 Pi SDK**。
   * 原因：在 Nest 启动期（TypeORM 的 better-sqlite3 同步句柄仍处于活跃状态）
   * 执行 ESM 动态 import 会触发 Node 原生断言 `RemoveEnvironmentCleanupHook: (env) != nullptr` 崩溃。
   * Pi SDK 改为首次实际调用模型时惰性加载。
   */
  async onModuleInit(): Promise<void> {
    const runtime = await this.settings.get();
    this.limiter = new ConcurrencyLimiter(runtime.runtime.modelMaxConcurrency);
    this.settings.registerModelTester(this);
    this.settings.registerRuntimeReloader(() => this.reload());
    this.logger.log(`ModelGateway 初始化完成，模型并发上限 ${this.limiter.max}`);
  }

  async reload(): Promise<void> {
    this.invalidate();
    await this.refreshLimits();
    this.logger.log('模型配置已重新加载');
  }

  get concurrency(): ConcurrencyLimiter {
    return this.limiter;
  }

  async refreshLimits(): Promise<void> {
    const runtime = await this.settings.get();
    this.limiter.setLimit(runtime.runtime.modelMaxConcurrency);
  }

  /** 强制下次使用时重建 Models（配置变更后调用） */
  invalidate(): void {
    this.models = null;
    this.cachedModel = null;
    this.cachedSignature = '';
  }

  /** 惰性加载 Pi SDK（避免启动期与 sqlite 原生句柄冲突） */
  private async ensurePiAi(): Promise<PiAiModule> {
    if (!this.piAi) {
      this.piAi = (await loadPiAi()) as unknown as PiAiModule;
      this.logger.log('Pi SDK 已加载（首次模型调用时惰性导入）');
    }
    return this.piAi;
  }

  /** 返回可用的 Pi Model 对象；必要时重建 provider */
  async getModel(modelOverride?: string): Promise<ModelLike> {
    const piAi = await this.ensurePiAi();
    const settings = await this.settings.get();
    const modelName = modelOverride || settings.model.modelName;
    const signature = `${settings.model.baseUrl}|${modelName}|${settings.model.provider}`;

    if (this.models && this.cachedModel && this.cachedSignature === signature) {
      return this.cachedModel;
    }

    this.models = piAi.createModels() as MutableModelsLike;
    // 子路径仅通过 ESM exports 暴露，使用变量拼接避免 TS 静态解析（CJS 下无类型入口）
    const lazyModule = await loadOpenAiCompletionsApi();
    const openAICompletionsApi = lazyModule.openAICompletionsApi;

    const meta = resolveModelMeta(modelName);
    const providerModel = toProviderModel(meta, settings.model.baseUrl);

    // Pi 的 auth 契约：resolve() 返回 undefined 表示「未配置」，会抛 Provider is not configured。
    // 本项目把密钥放在请求级（options.apiKey），所以这里必须返回一个非空 AuthResult 以声明「已配置」，
    // 实际密钥由 check() 校验（无密钥时判定为未配置）。
    const self = this;
    this.models.setProvider(
      piAi.createProvider({
        id: PROVIDER_ID,
        name: 'VulnAgent OpenAI Compatible',
        baseUrl: settings.model.baseUrl,
        auth: {
          apiKey: {
            name: 'OpenAI 兼容 API Key',
            async check() {
              const key = await self.settings.readApiKey();
              return key ? { type: 'api_key' as const, source: 'system_settings' } : undefined;
            },
            async resolve() {
              const key = await self.settings.readApiKey();
              // 密钥通过请求级 apiKey 注入；此处只返回「已配置」标记与来源
              return { auth: {}, source: key ? 'system_settings' : 'request' };
            },
          },
        },
        models: [providerModel],
        api: openAICompletionsApi(),
      }),
    );

    const model = this.models.getModel(PROVIDER_ID, modelName);
    if (!model) throw new Error(`模型 ${modelName} 未注册成功`);

    this.cachedModel = model;
    this.cachedSignature = signature;
    this.logger.log(`模型已加载：${modelName} @ ${settings.model.baseUrl}`);
    return model;
  }

  /** streamSimple 的绑定函数，交给 Pi Agent 作为 streamFn */
  async createStreamFn(sessionId?: string): Promise<(
    model: ModelLike,
    context: unknown,
    options?: unknown,
  ) => unknown> {
    const models = this.models;
    if (!models) await this.getModel();
    const initialSettings = await this.settings.get();
    const expectedProvider = initialSettings.model.provider;
    const limiter = this.limiter;
    const target = this.models!;

    return async (model, context, options) => {
      const runtime = await this.settings.get();
      if (!runtime.runtime.piRuntimeEnabled) throw new ConflictException(RUNTIME_DISABLED);
      if (runtime.model.baseUrl !== model.baseUrl || runtime.model.provider !== expectedProvider) throw new Error('模型服务地址或供应商已改变，请重新启动会话后继续，避免把更新后的密钥发给旧服务');
      const apiKey = await this.settings.readApiKey();
      const opts = {
        ...(options as Record<string, unknown> | undefined),
        apiKey: apiKey ?? undefined,
      };
      // 用 promise 包装以纳入限流；Pi 接受返回 stream 或 Promise<stream>
      const sourceSignal = (options as { signal?: AbortSignal } | undefined)?.signal;
      let lease: Awaited<ReturnType<ModelBudgetService['reserve']>> | null = null;
      let releaseRaw!: () => void;
      const startedWaiting = Date.now();
      const requested = (options as { maxTokens?: number })?.maxTokens;
      const maxTokens = Math.min(runtime.model.maxTokens, typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? requested : runtime.model.maxTokens);
      while (true) {
        releaseRaw = await limiter.acquire(sourceSignal);
        try {
          if (sourceSignal?.aborted) throw new Error('模型请求已取消');
          if (!(await this.settings.get()).runtime.piRuntimeEnabled) throw new ConflictException(RUNTIME_DISABLED);
          if (sessionId) lease = await this.budgets.reserve(sessionId, context, model, maxTokens);
          break;
        } catch (error) {
          releaseRaw();
          if (!(error instanceof TokenBudgetBusyError) || Date.now() - startedWaiting >= STREAM_STALL_TIMEOUT_MS) throw error;
          await waitForBudget(sourceSignal);
        }
      }
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          releaseRaw();
        };

        try {
          if (!(await this.settings.get()).runtime.piRuntimeEnabled) {
            if (lease) { await this.budgets.finish(lease.id, null, RUNTIME_DISABLED, true); lease = null; }
            throw new ConflictException(RUNTIME_DISABLED);
          }
          if (sourceSignal?.aborted) {
            if (lease) { await this.budgets.finish(lease.id, null, '发送前已取消', true); lease = null; }
            throw new Error('模型请求已在发送前取消');
          }
          const controller = new AbortController();
          const signal = sourceSignal ? AbortSignal.any([sourceSignal, controller.signal]) : controller.signal;
          const stream = target.streamSimple(model, context, { ...opts, signal, maxTokens: lease?.maxOutputTokens ?? maxTokens }) as { result(): Promise<AssistantMessageLike>; [Symbol.asyncIterator](): AsyncIterator<unknown> };
          if (typeof stream.result !== 'function' || typeof stream[Symbol.asyncIterator] !== 'function') throw new Error('模型流缺少结果或迭代器接口');
          return managedModelStream(stream, controller, Math.min(STREAM_STALL_TIMEOUT_MS, lease?.timeoutMs ?? STREAM_STALL_TIMEOUT_MS), async (message, reason) => {
            if (message?.errorMessage && apiKey) message.errorMessage = message.errorMessage.split(apiKey).join('[REDACTED]');
            if (lease) await this.budgets.finish(lease.id, message, reason);
          }, release, sourceSignal);
        } catch (error) {
          if (lease) await this.budgets.finish(lease.id, null, error instanceof Error ? error.message : String(error));
          release();
          if (apiKey && error instanceof Error) throw new Error(error.message.split(apiKey).join('[REDACTED]'));
          throw error;
        }
    };
  }

  async assertRuntimeEnabled(): Promise<void> { if (!(await this.settings.get()).runtime.piRuntimeEnabled) throw new ConflictException(RUNTIME_DISABLED); }
  async assertToolBudget(sessionId: string): Promise<void> { await this.assertRuntimeEnabled(); return this.budgets.assertToolBudget(sessionId); }

  async getApiKey(): Promise<string | undefined> {
    const key = await this.settings.readApiKey();
    return key ?? undefined;
  }

  listModels(): ModelMeta[] {
    return listKnownModels();
  }

  /**
   * 真实模型连接测试：调用一次 Chat Completions（极短输出），
   * 验证 baseUrl、API Key、模型名三者可用。
   */
  async testModel(modelOverride?: string): Promise<ModelTestOutcome> {
    const started = Date.now();
    const checkedAt = new Date().toISOString();
    const settings = await this.settings.get();
    const modelName = modelOverride || settings.model.modelName;
    const apiKey = await this.settings.readApiKey();

    if (!apiKey) {
      return {
        ok: false,
        latencyMs: 0,
        message: '尚未配置 API Key，请在系统设置页填写后重试',
        httpStatus: null,
        outputPreview: null,
        modelName,
        tokensUsed: 0,
        checkedAt,
      };
    }

    try {
      const model = await this.getModel(modelName);
      const result = await this.limiter.run(() =>
        this.models!.completeSimple(
          model,
          {
            messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
          },
          { apiKey, maxTokens: 16, temperature: 0 },
        ),
      );
      const latencyMs = Date.now() - started;
      const text = extractText(result);
      const tokens = result.usage ? result.usage.input + result.usage.output : 0;
      const ok = result.stopReason !== 'error';
      return {
        ok,
        latencyMs,
        message: ok
          ? `模型调用成功（${latencyMs}ms，${tokens} tokens）`
          : `模型调用失败：${result.errorMessage ?? result.stopReason}`,
        httpStatus: ok ? 200 : null,
        outputPreview: text.slice(0, 80) || null,
        modelName,
        tokensUsed: tokens,
        checkedAt,
      };
    } catch (error) {
      const latencyMs = Date.now() - started;
      return {
        ok: false,
        latencyMs,
        message: `调用异常：${error instanceof Error ? error.message : String(error)}`,
        httpStatus: null,
        outputPreview: null,
        modelName,
        tokensUsed: 0,
        checkedAt,
      };
    }
  }
}

function toProviderModel(meta: ModelMeta, baseUrl: string): ModelLike {
  const perToken = (v: number) => v / 1_000_000;
  return {
    id: meta.id,
    name: meta.name,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: meta.reasoning,
    input: ['text'],
    cost: {
      input: perToken(meta.costPerMTokens.input),
      output: perToken(meta.costPerMTokens.output),
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
  };
}

function extractText(message: AssistantMessageLike): string {
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((block) => {
      const b = block as { type?: string; text?: string };
      return b.type === 'text' ? (b.text ?? '') : '';
    })
    .join('')
    .trim();
}
