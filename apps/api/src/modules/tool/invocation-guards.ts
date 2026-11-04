import { Injectable, Logger } from '@nestjs/common';
import { checkToolWorkload, DEFAULT_SCAN_LIMITS } from '../mcp/tool-workload';
import { extractTargets } from '../mcp/scope-guard';
import type { ToolHook, PreToolUseEvent, PreToolUseOutcome } from './tool-hooks';
import { policyBlockMessage } from './tool-hooks';

/**
 * 三条"调用前"保护钩子（与原执行器语义一致，迁移到新链路）。
 *
 * 它们不是业务策略，而是防止单次调用失控的护栏：
 *  - 工作负载：端口×地址×协议组合超限时拒绝，要求拆批；
 *  - 重试上限：同一会话中相同工具+参数连续失败达到阈值后禁止原样重试；
 *  - 去重：成功且非空的相同调用直接复用结果，避免重复扫描拖垮预算。
 */

/** 组合数上限（与 .env.example 的 MCP_MAX_SCAN_* 默认值一致）。 */
export interface ScanLimits { maxHosts: number; maxPorts: number; maxProbes: number }

function limits(): ScanLimits {
  const read = (key: string, fallback: number) => {
    const value = Number(process.env[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    maxHosts: read('MCP_MAX_SCAN_HOSTS', DEFAULT_SCAN_LIMITS.maxHosts),
    maxPorts: read('MCP_MAX_SCAN_PORTS', DEFAULT_SCAN_LIMITS.maxPorts),
    maxProbes: read('MCP_MAX_SCAN_PROBES', DEFAULT_SCAN_LIMITS.maxProbes),
  };
}

@Injectable()
export class WorkloadGuardHook implements ToolHook {
  readonly name = 'workload-guard';
  readonly order = -50;

  constructor(private readonly tasks?: { findOneBy(where: { id: string }): Promise<{ startedAt: Date | null; timeBudgetMinutes: number } | null> }) {}

  async preToolUse(event: PreToolUseEvent): Promise<PreToolUseOutcome> {
    const verdict = checkToolWorkload(event.toolName, event.input, null, limits());
    if (!verdict.allow) {
      return { action: 'block', message: `${verdict.reason}；${verdict.suggestion}`, policy: false };
    }
    // 任务时间预算耗尽后不再派发新的工具调用；已发出的调用仍会被回收。
    const task = this.tasks && event.taskId ? await this.tasks.findOneBy({ id: event.taskId }).catch(() => null) : null;
    if (task?.startedAt && task.timeBudgetMinutes > 0) {
      const elapsedMs = Date.now() - new Date(task.startedAt).getTime();
      if (elapsedMs > task.timeBudgetMinutes * 60_000) {
        return {
          action: 'block',
          message: `任务时间预算（${task.timeBudgetMinutes} 分钟）已用尽，本次调用未发起。请缩小子任务范围，或由操作者调整预算后重新运行。`,
          policy: false,
        };
      }
    }
    return { action: 'allow' };
  }
}

/** 同一任务内，相同参数连续失败后进入短期冷却，跨 Worker 生效。 */
@Injectable()
export class RetryLimitHook implements ToolHook {
  readonly name = 'retry-limit';
  readonly order = -40;
  private readonly failures = new Map<string, { taskId: string; count: number; at: number }>();
  private key(event: { taskId: string; toolName: string; input: Record<string, unknown> }): string {
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)])) : value;
    return JSON.stringify([event.taskId, event.toolName, stable(event.input)]);
  }
  private prune(): void {
    for (const [key, row] of this.failures) if (Date.now() - row.at >= 300_000) this.failures.delete(key);
    while (this.failures.size > 5000) this.failures.delete(this.failures.keys().next().value!);
  }
  static readonly MAX_IDENTICAL_FAILURES = 2;

  preToolUse(event: PreToolUseEvent): PreToolUseOutcome {
    this.prune();
    const key = this.key(event);
    const record = this.failures.get(key);
    if (!record || record.count < RetryLimitHook.MAX_IDENTICAL_FAILURES) return { action: 'allow' };
    return {
      action: 'block',
      message: `相同参数的调用已连续失败 ${record.count} 次，本次不再执行。请修正参数、缩小范围或改用其他工具，不要原样重复调用。`,
      policy: false,
    };
  }

  postToolUse(event: { taskId: string; toolName: string; input: Record<string, unknown>; sessionId: string | null; isError: boolean }): void {
    this.prune();
    const key = this.key(event);
    if (event.isError) {
      const record = this.failures.get(key);
      if (!record || record.count < RetryLimitHook.MAX_IDENTICAL_FAILURES) this.failures.set(key, { taskId: event.taskId, count: (record?.count ?? 0) + 1, at: Date.now() });
    } else {
      this.failures.delete(key);
    }
  }

  reset(taskId: string): void {
    for (const [key, record] of this.failures) if (record.taskId === taskId) this.failures.delete(key);
  }
}

/** 去重与结果复用：由 ToolInvoker 在成功后写入，下次相同调用直接返回缓存结果。 */
export interface DedupeEntry {
  key: string;
  tool: string;
  input: Record<string, unknown>;
  text: string;
  createdAt: number;
}

@Injectable()
export class ToolDedupeStore {
  private readonly logger = new Logger(ToolDedupeStore.name);
  private readonly entries = new Map<string, DedupeEntry>();
  private static readonly MAX_ENTRIES = 500;

  key(tool: string, input: Record<string, unknown>): string {
    return `${tool}:${JSON.stringify(input)}`;
  }

  get(tool: string, input: Record<string, unknown>): DedupeEntry | undefined {
    return this.entries.get(this.key(tool, input));
  }

  put(tool: string, input: Record<string, unknown>, text: string): void {
    // 空输出不缓存：可能只是瞬时失败，缓存会让模型永久看不到真实结果。
    if (!text.trim() || /^\[(?:image|audio|binary|resource)\]$/i.test(text.trim())) return;
    if (this.entries.size >= ToolDedupeStore.MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(this.key(tool, input), { key: this.key(tool, input), tool, input, text, createdAt: Date.now() });
  }

  clear(): void {
    this.entries.clear();
    this.logger.debug('去重缓存已清空');
  }
}

/** 组合数超限时的统一文案，供前端提示复用。 */
export function workloadBlockMessage(reason: string, suggestion: string): string {
  return policyBlockMessage(`调用规模超出平台上限：${reason}；${suggestion}`);
}

export { extractTargets };
