import type { PiToolDefinition, PiToolResult } from '../pi-runtime/pi-types';
import type { ToolContext } from '../tool/core-tool';
import type { ToolInvoker } from '../tool/tool-invoker';
import { toPiResult } from '../tool/tool-invoker';
import type { ToolRecorder } from '../tool/tool-recorder';
import type { WorkerExecutionBudget } from './worker-execution-budget';

export interface WorkerToolFactoryDeps {
  invoker: ToolInvoker;
  recorder: ToolRecorder;
}

export interface WorkerToolRequest {
  toolNames: string[];
  taskId: string;
  role: string;
  authorizedTargets: string[];
  evidenceIds: string[];
  sessionKey: string;
  getSessionId: () => string | null;
  budget: WorkerExecutionBudget;
}

/**
 * 把 Registry 里的工具转成 Pi SDK 可用的工具定义。
 *
 * 这是工具层与 Agent 运行时的唯一桥接点：
 * - schema 来自 Registry，不在这里另写一份；
 * - 执行只经 ToolInvoker，Agent 无法绕过参数校验、拦截规则与权限；
 * - 调用记录与证据由 ToolRecorder 统一落库。
 */
export function buildWorkerTools(deps: WorkerToolFactoryDeps, request: WorkerToolRequest): PiToolDefinition[] {
  const schemas = deps.invoker.schemas({ allowed: request.toolNames, sessionKey: request.sessionKey });
  return schemas.map((schema) => ({
    name: schema.name,
    label: schema.name,
    description: schema.description,
    // Pi SDK 接受原始 JSON Schema；模型必须看到真实参数定义。
    parameters: schema.inputSchema,
    execute: async (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<PiToolResult> => {
      const blocked = request.budget.begin();
      if (blocked) return { content: [{ type: 'text', text: blocked }], details: { ok: false, failureKind: 'retry_limit' } };

      const ctx: ToolContext = {
        taskId: request.taskId,
        sessionId: request.getSessionId(),
        role: request.role,
        allowedTools: request.toolNames,
        authorizedTargets: request.authorizedTargets,
        evidenceIds: request.evidenceIds,
        signal,
        toolCallId,
        forceRerun: request.role === 'verifier' || request.role === 'verification',
      };

      const outcome = await deps.invoker.invoke(schema.name, params ?? {}, ctx);
      const saved = await deps.recorder.record({
        taskId: request.taskId,
        sessionId: ctx.sessionId,
        role: request.role,
        outcome,
        input: params ?? {},
      });
      request.budget.record({ ok: !outcome.encoded.isError });
      if (saved.evidenceId) request.evidenceIds.push(saved.evidenceId);

      const base = toPiResult(outcome);
      const prefix = [
        saved.evidenceId ? `证据ID: ${saved.evidenceId}` : null,
        saved.storageError,
      ].filter(Boolean).join('\n');
      return {
        content: [{ type: 'text', text: prefix ? `${prefix}\n${outcome.encoded.text}` : outcome.encoded.text }],
        isError: outcome.encoded.isError,
        details: { ...base.details, toolCallId: saved.toolCallId || toolCallId, evidenceId: saved.evidenceId },
      };
    },
  }));
}
