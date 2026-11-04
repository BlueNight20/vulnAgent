import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { trackTaskActivity } from '../../database/task-activity';
import { errorResult, textResult, type CoreTool, type ToolContext, type ToolResult } from './core-tool';
import { ToolRegistry } from './tool-registry';
import { ToolHookChain, policyBlockMessage } from './tool-hooks';
import { ToolDedupeStore } from './invocation-guards';
import { encodeForModel, type EncodedResult } from './tool-result';
import { validateToolInput } from '../mcp/tool-input-validator';

export type InvokeFailure =
  | 'unknown_tool'
  | 'invalid_input'
  | 'blocked'
  | 'cancelled'
  | 'timeout'
  /** 远端可能已执行但无法确认结果，需人工核实 */
  | 'uncertain'
  | 'error';

export interface InvokeOutcome {
  result: ToolResult;
  encoded: EncodedResult;
  tool: string;
  durationMs: number;
  failureKind: InvokeFailure | null;
  /** 被平台拦截时的原始理由（审计用，模型只看到框定后的文案） */
  blockReason?: string;
  /** 命中去重缓存，未真正执行远端调用 */
  deduplicated?: boolean;
}

export interface ToolExecutor {
  kind: string;
  run(tool: CoreTool, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** 超时与取消用独立错误类型区分，避免依赖错误文案匹配。 */
export class ToolTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`超过单次调用上限 ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
  }
}

export class ToolCancelledError extends Error {
  constructor() {
    super('工具执行已取消');
    this.name = 'ToolCancelledError';
  }
}

/**
 * 远端已执行但本地无法确认结果（附件损坏、存储失败等）。
 * 必须保留为"待核实"，禁止自动重放。
 */
export class ToolExecutionUncertainError extends Error {
  constructor(detail: string) {
    super(`执行结果未知（远端可能已完成）：${detail}`);
    this.name = 'ToolExecutionUncertainError';
  }
}

/**
 * 进程内执行器：业务工具（记录事实、报告漏洞等）直接调用工具本体。
 * 不涉及传输，因此随 Invoker 一起注册。
 */
class InternalExecutor implements ToolExecutor {
  readonly kind = 'internal';
  run(tool: CoreTool, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return tool.call(input, ctx);
  }
}

/**
 * MCP 执行器占位：真实实现由 ToolModule 在启动时通过 registerExecutor 注入。
 *
 * 它存在的意义是"不可用时给出可诊断的失败"，而不是让整次调用落进
 * `未注册执行器：mcp` 这种装配级错误——那种文案会被模型误读成工具不存在，
 * 也掩盖了真正的原因（执行器未注入）。
 */
class McpExecutorProxy implements ToolExecutor {
  readonly kind = 'mcp';
  private delegate: ToolExecutor | null = null;

  attach(executor: ToolExecutor): void {
    this.delegate = executor;
  }

  get bound(): boolean {
    return this.delegate !== null;
  }

  async run(tool: CoreTool, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!this.delegate) {
      throw new Error('MCP 执行器尚未装配（ToolModule 未完成注入），本次调用没有发往远端');
    }
    return this.delegate.run(tool, input, ctx);
  }
}

/**
 * 工具调用的唯一入口。
 *
 * 调用方（Worker、业务工具、未来的 MCP 客户端）不得直接调用 `tool.call()`，
 * 否则会绕过参数校验、拦截链与输出截断。
 *
 * 关卡顺序（固定，不可重排）：
 *   1. 工具存在性
 *   2. 会话允许清单
 *   3. inputSchema 校验
 *   4. PreToolUse 钩子链（可阻断 / 可改写入参）
 *   5. 取消信号检查
 *   6. 执行（含超时）
 *   7. 异常 → isError 结果
 *   8. 统一截断与编码
 *   9. PostToolUse 钩子链
 */
@Injectable()
export class ToolInvoker {
  private readonly logger = new Logger(ToolInvoker.name);
  readonly hooks = new ToolHookChain((hook, error) =>
    this.logger.warn(`工具钩子 ${hook} 失败：${error instanceof Error ? error.message : String(error)}`));
  private readonly executors = new Map<string, ToolExecutor>();

  private managerRef?: () => EntityManager;
  /** 去重缓存由 tool 模块注入；构造参数仅保留 DI 可解析的 Registry。 */
  readonly dedupe: ToolDedupeStore = new ToolDedupeStore();

  constructor(private readonly registry: ToolRegistry) {
    // 内置执行器随 Invoker 一起就绪：MCP 与进程内业务工具不依赖外部装配顺序，
    // 避免出现"工具已注册但执行器没注册"的半装配状态。
    this.registerExecutor(new McpExecutorProxy());
    this.registerExecutor(new InternalExecutor());
  }

  /** 可选注入 EntityManager：用于在执行期间登记任务活动（删除/重跑保护）。 */
  bindManager(manager: () => EntityManager): void {
    this.managerRef = manager;
  }

  private manager(): EntityManager | null {
    return this.managerRef?.() ?? null;
  }

  /**
   * 注册/替换某类执行器。
   * MCP 的真实执行器由 Nest 在启动后注入，这里只是把 kind 预置好。
   */
  registerExecutor(executor: ToolExecutor): void {
    this.executors.set(executor.kind, executor);
  }

  /** 已注册的执行器种类，健康检查与排障用。 */
  executorKinds(): string[] {
    return [...this.executors.keys()];
  }

  /** 模型可见的 schema，委托给 Registry，保证只有一个出口。 */
  schemas(options: { allowed?: string[]; sessionKey?: string | null } = {}) {
    return this.registry.schemas(options);
  }

  async invoke(name: string, rawInput: Record<string, unknown>, ctx: ToolContext): Promise<InvokeOutcome> {
    const started = Date.now();
    const tool = this.registry.get(name);
    if (!tool) {
      const result = errorResult(`未知工具：${name}。请只使用当前会话暴露的工具名，或先搜索可用工具。`);
      return this.finish(name, result, started, 'unknown_tool');
    }
    if (ctx.allowedTools.length && !ctx.allowedTools.includes(name)) {
      const result = errorResult(policyBlockMessage(`工具 ${name} 不在当前会话的允许清单内`));
      return this.finish(name, result, started, 'blocked');
    }

    const schemaError = validateToolInput(tool.inputSchema(), rawInput);
    if (schemaError) return this.finish(name, errorResult(schemaError), started, 'invalid_input');

    const pre = await this.hooks.runPre({
      toolName: name, input: rawInput, taskId: ctx.taskId, sessionId: ctx.sessionId, role: ctx.role,
      approvedReplay: ctx.approvedReplay === true,
    });
    if (pre.action === 'block') {
      const result = errorResult(pre.policy === false ? pre.message : policyBlockMessage(pre.message));
      return this.finish(name, result, started, 'blocked', pre.message);
    }
    const input = pre.input ?? rawInput;

    if (ctx.signal?.aborted) return this.finish(name, errorResult('工具执行已取消，未发起调用。'), started, 'cancelled');

    const executor = this.executors.get(tool.execSpec().kind);
    if (!executor) return this.finish(name, errorResult(`未注册执行器：${tool.execSpec().kind}。请检查工具层装配。`), started, 'error');

    // 去重复用：钩子链（范围/权限/策略）已经在上面全部通过，这里才允许复用缓存结果。
    // 顺序很重要——先执行钩子，收紧授权后旧缓存不能绕过检查。
    if (!ctx.forceRerun) {
      const cached = this.dedupe.get(name, input);
      if (cached) {
        const reused = textResult(cached.text, { deduplicated: true });
        return {
          result: reused,
          encoded: encodeForModel(reused),
          tool: name, durationMs: Date.now() - started, failureKind: null, deduplicated: true,
        };
      }
    }

    let result: ToolResult;
    try {
      // 执行期间登记任务活动：删除/重跑必须能看到"工具正在跑"，而不是等落库后才可见。
      const manager = this.manager();
      const work = manager
        ? () => trackTaskActivity(manager, ctx.taskId, () => executor.run(tool, input, ctx))
        : () => executor.run(tool, input, ctx);
      result = await this.withTimeout(work(), tool.execSpec().timeoutMs, ctx.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureKind: InvokeFailure = error instanceof ToolTimeoutError ? 'timeout'
        : error instanceof ToolCancelledError ? 'cancelled'
          : error instanceof ToolExecutionUncertainError ? 'uncertain' : 'error';
      const text = failureKind === 'timeout' ? `工具执行超时：${message}`
        : failureKind === 'cancelled' ? '工具执行已取消。' : `工具执行异常：${message}`;
      return this.finish(name, errorResult(text), started, failureKind, undefined, input, ctx);
    }

    // 模型不可见但需要一次性提示时，附在结果后面，保证同一条 tool_result 内可见。
    if (pre.note) result = { ...result, content: [...result.content, { type: 'text', text: pre.note }] };
    const outcome = this.finish(name, result, started, null, undefined, input, ctx);
    if (!result.isError) this.dedupe.put(name, input, outcome.encoded.text);
    return outcome;
  }

  private finish(
    name: string,
    result: ToolResult,
    started: number,
    failureKind: InvokeFailure | null,
    blockReason?: string,
    input?: Record<string, unknown>,
    ctx?: ToolContext,
  ): InvokeOutcome {
    const encoded = encodeForModel(result);
    const durationMs = Date.now() - started;
    if (ctx && input) {
      void this.hooks.runPost({ toolName: name, input, taskId: ctx.taskId, sessionId: ctx.sessionId, role: ctx.role, isError: result.isError, outputText: encoded.text, durationMs });
    }
    return { result, encoded, tool: name, durationMs, failureKind, blockReason };
  }

  private async withTimeout(promise: Promise<ToolResult>, timeoutMs: number | undefined, signal?: AbortSignal): Promise<ToolResult> {
    if (!timeoutMs || timeoutMs <= 0) return promise;
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<ToolResult>((_, reject) => {
      timer = setTimeout(() => reject(new ToolTimeoutError(timeoutMs)), timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', () => reject(new ToolCancelledError()), { once: true });
    });
    try {
      return await Promise.race([promise, guard]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** 把工具调用结果转成 Pi SDK 的工具返回，失败也保持在正常结果通道内。 */
export function toPiResult(outcome: InvokeOutcome) {
  return {
    content: [{ type: 'text' as const, text: outcome.encoded.text }],
    isError: outcome.encoded.isError,
    details: { tool: outcome.tool, failureKind: outcome.failureKind, durationMs: outcome.durationMs, ...(outcome.result.details ?? {}) },
  };
}

export { textResult };
