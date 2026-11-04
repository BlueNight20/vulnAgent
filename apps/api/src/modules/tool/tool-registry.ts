import { Injectable, Logger } from '@nestjs/common';
import type { CoreTool, ToolSource } from './core-tool';

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * 工具注册表：模型 schema 的唯一出口。
 *
 * 规则（与 artex 的 Registry 等价，代码自写）：
 * - 同名工具重复注册直接报错，避免后注册静默覆盖导致行为漂移；
 * - `prompt()` 统一拼进 description，模型只看到一份说明；
 * - 被 deferred 的工具默认不下发 schema，需要通过 `tools_search` 解锁后再下发。
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, CoreTool>();
  private readonly deferred = new Set<string>();
  private readonly unlocked = new Map<string, Set<string>>();

  register(tool: CoreTool, options: { deferred?: boolean } = {}): void {
    const name = tool.name();
    if (this.tools.has(name)) throw new Error(`工具名重复注册：${name}`);
    this.tools.set(name, tool);
    if (options.deferred) this.deferred.add(name);
  }

  registerAll(tools: CoreTool[], options: { deferred?: boolean } = {}): void {
    for (const tool of tools) this.register(tool, options);
  }

  /** 替换某个来源（builtin / mcp / business / custom）的全部工具，MCP 刷新工具目录时使用。 */
  replaceSource(source: ToolSource, tools: CoreTool[]): void {
    this.clearSource(source);
    this.registerAll(tools);
  }

  /** 只清空某个来源；用于工具目录同步失败时保留其他来源不受影响。 */
  clearSource(source: ToolSource): void {
    for (const [name, tool] of this.tools) {
      if (tool.source() === source) { this.tools.delete(name); this.deferred.delete(name); }
    }
  }

  get(name: string): CoreTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  all(): CoreTool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  isDeferred(name: string): boolean {
    return this.deferred.has(name);
  }

  /** 为某个会话解锁延迟工具（一次会话内有效）。 */
  unlock(sessionKey: string, name: string): boolean {
    if (!this.tools.has(name)) return false;
    const set = this.unlocked.get(sessionKey) ?? new Set<string>();
    set.add(name);
    this.unlocked.set(sessionKey, set);
    return true;
  }

  releaseSession(sessionKey: string): void {
    this.unlocked.delete(sessionKey);
  }

  private visible(name: string, sessionKey: string | null): boolean {
    if (!this.deferred.has(name)) return true;
    if (!sessionKey) return false;
    return this.unlocked.get(sessionKey)?.has(name) ?? false;
  }

  /** 模型看到的 tools 参数。 */
  schemas(options: { allowed?: string[]; sessionKey?: string | null } = {}): ToolSchema[] {
    const allowed = options.allowed !== undefined ? new Set(options.allowed) : null;
    const out: ToolSchema[] = [];
    for (const [name, tool] of this.tools) {
      if (allowed && !allowed.has(name)) continue;
      if (!this.visible(name, options.sessionKey ?? null)) continue;
      const prompt = tool.prompt?.() ?? '';
      out.push({
        name,
        description: prompt ? `${tool.description()}\n\n${prompt}` : tool.description(),
        inputSchema: tool.inputSchema(),
      });
    }
    return out;
  }

  /** 延迟工具的名字清单，用于提示模型"还有哪些工具可解锁"。 */
  deferredNames(allowed?: string[]): string[] {
    const filter = allowed !== undefined ? new Set(allowed) : null;
    return [...this.deferred].filter((name) => this.tools.has(name) && (!filter || filter.has(name)));
  }
}
