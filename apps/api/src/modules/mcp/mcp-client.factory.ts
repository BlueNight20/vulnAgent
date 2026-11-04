import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';
import { configuredCipher, readStoredHeaders, redactHeaderValues } from '../../common/crypto/mcp-header-secrets';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpTransport } from '@vulnagent/shared';

export interface RemoteTool {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
}

export interface McpProbeSuccess {
  ok: true;
  tools: RemoteTool[];
  resources?: Array<{ name: string; uri: string; description?: string }>;
  prompts?: Array<{ name: string; description?: string }>;
  latencyMs: number;
}

export interface McpProbeFailure {
  ok: false;
  error: string;
  latencyMs: number;
}

export type McpProbeResult = McpProbeSuccess | McpProbeFailure;

export interface McpConnectionOptions {
  endpoint: string;
  stdioConfigEncrypted?: string | null;
  transport: McpTransport;
  headers?: Record<string, string> | null;
  headersEncrypted?: string | null;
  timeoutMs: number;
  /** 握手超时；不传则用默认值 */
  connectTimeoutMs?: number;
}

export interface McpCallOptions extends McpConnectionOptions {
  toolName: string;
  arguments: Record<string, unknown>;
  /** 握手阶段独立超时；不传则使用默认 60s */
  connectTimeoutMs?: number;
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface McpCallSuccess {
  ok: true;
  latencyMs: number;
  /** 拼接后的纯文本输出 */
  text: string;
  isError: boolean;
  /** 原始 content 数组，用于证据留存 */
  raw: unknown;
}

export interface McpCallFailure {
  ok: false;
  latencyMs: number;
  error: string;
  phase?: 'connect' | 'execute';
  cancelled?: boolean;
}

export type McpCallResult = McpCallSuccess | McpCallFailure;

/** MCP 握手超时默认值：并发场景下服务端可能排队，给足 60s */
const CONNECT_TIMEOUT_MS = 60_000;

/** 每个端点最多保留的空闲连接数 */
const MAX_IDLE_PER_ENDPOINT = 3;

/**
 * MCP 客户端封装（单一入口，便于 SDK v1 → v2 迁移）。
 * 仅使用官方 README 中确认的 API：
 *   new StreamableHTTPClientTransport(url) / client.connect(transport) / client.listTools() / client.close()
 */
@Injectable()
export class McpClientFactory implements OnModuleDestroy {
  private readonly logger = new Logger(McpClientFactory.name);
  constructor(@Optional() private readonly config?: ConfigService) {}

  async probe(options: McpConnectionOptions, includeCapabilities = false): Promise<McpProbeResult> {
    const started = Date.now();
    let client: Client | null = null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), options.timeoutMs);

    try {
      options = { ...options, headers: readStoredHeaders(options, this.config?.get<AppConfig['security']>('security')) };
      const transport = this.createTransport(options);
      client = new Client({ name: 'vulnagent-api', version: '0.1.0' });

      await this.withTimeout(client.connect(transport, { timeout: options.timeoutMs, signal: abort.signal }), options.timeoutMs, abort.signal);
      const capabilities = client.getServerCapabilities();
      const requestOptions = { timeout: options.timeoutMs, signal: abort.signal };
      const collect = async <T>(fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>): Promise<T[]> => {
        const items: T[] = []; const seen = new Set<string>(); let cursor: string | undefined;
        for (let page = 0; page < 100; page++) {
          const result = await this.withTimeout(fetchPage(cursor), options.timeoutMs, abort.signal);
          items.push(...result.items);
          if (!result.nextCursor) return items;
          if (seen.has(result.nextCursor)) throw new Error('MCP 分页游标重复，目录未完成同步');
          seen.add(result.nextCursor); cursor = result.nextCursor;
        }
        throw new Error('MCP 目录分页超过上限，目录未完成同步');
      };
      const tools = capabilities?.tools ? await collect<RemoteTool>(async (cursor) => {
        const result = await client!.listTools(cursor ? { cursor } : undefined, requestOptions);
        return { nextCursor: result.nextCursor, items: result.tools.map((tool) => ({ name: tool.name, description: tool.description ?? null, inputSchema: tool.inputSchema as Record<string, unknown> })) };
      }) : [];
      const resources = includeCapabilities && capabilities?.resources ? await collect(async (cursor) => {
        const result = await client!.listResources(cursor ? { cursor } : undefined, requestOptions);
        return { nextCursor: result.nextCursor, items: result.resources.map((r) => ({ name: r.name, uri: r.uri, description: r.description })) };
      }) : [];
      const prompts = includeCapabilities && capabilities?.prompts ? await collect(async (cursor) => {
        const result = await client!.listPrompts(cursor ? { cursor } : undefined, requestOptions);
        return { nextCursor: result.nextCursor, items: result.prompts.map((p) => ({ name: p.name, description: p.description })) };
      }) : [];
      return { ok: true, tools, ...(includeCapabilities ? { resources, prompts } : {}), latencyMs: Date.now() - started };
    } catch (error) {
      const message = redactHeaderValues(this.describeError(error, options.timeoutMs), options.headers);
      this.logger.warn(`MCP 探测失败 [${options.endpoint}]: ${message}`);
      return { ok: false, error: message, latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
      if (client) {
        try {
          await client.close();
        } catch {
          /* 关闭失败不影响探测结果 */
        }
      }
    }
  }

  /** 仅复用成功完成请求的连接；失败和取消的连接不再承接新请求。 */
  private sessionKey(options: McpConnectionOptions): string {
    const headerKey = JSON.stringify([Object.entries(options.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)), options.stdioConfigEncrypted]);
    return `${options.transport}::${options.endpoint}::${createHash('sha256').update(headerKey).digest('hex')}`;
  }

  /** 空闲连接池（按端点区分），限制每个端点最多保留的常驻连接数 */
  private readonly pool = new Map<string, Client[]>();
  private readonly clients = new Set<Client>();
  private readonly cancellationSends = new Map<Client, Set<Promise<void>>>();

  private async acquireConnection(options: McpCallOptions, signal: AbortSignal): Promise<Client> {
    const key = this.sessionKey(options);
    const idle = this.pool.get(key) ?? [];
    let reused = idle.pop();
    while (reused && !this.clients.has(reused)) reused = idle.pop();
    return reused ?? this.createConnection(options, signal);
  }

  private async releaseConnection(key: string, client: Client): Promise<void> {
    if (!this.clients.has(client)) return;
    const idle = this.pool.get(key) ?? [];
    if (idle.length >= MAX_IDLE_PER_ENDPOINT) {
      await this.discard(client);
      return;
    }
    idle.push(client);
    this.pool.set(key, idle);
  }

  private createTransport(options: McpConnectionOptions): Transport {
    if (options.transport === 'stdio') {
      if (!options.stdioConfigEncrypted) throw new Error('缺少 stdio 配置');
      const config = JSON.parse(configuredCipher(this.config?.get<AppConfig['security']>('security')).decrypt(options.stdioConfigEncrypted));
      return new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: 'ignore' });
    }
    const url = new URL(options.endpoint);
    const requestInit = options.headers ? { headers: options.headers } : undefined;
    if (options.transport === 'sse') {
      return new SSEClientTransport(url, {
        requestInit,
        eventSourceInit: { fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
          return fetch(input, { ...init, headers, redirect: 'error' });
        } },
      });
    }
    return new StreamableHTTPClientTransport(url, { requestInit });
  }

  private async createConnection(options: McpConnectionOptions, signal: AbortSignal): Promise<Client> {
    const transport = this.createTransport(options);
    const client = new Client({ name: 'vulnagent-api', version: '0.1.0' });
    const pending = new Set<Promise<void>>();
    this.cancellationSends.set(client, pending);
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      const sent = send(message, options);
      if ('method' in message && message.method === 'notifications/cancelled') {
        pending.add(sent);
        void sent.then(() => pending.delete(sent), () => pending.delete(sent));
      }
      return sent;
    };
    this.clients.add(client);
    client.onclose = () => { this.clients.delete(client); this.cancellationSends.delete(client); };
    const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const abort = new AbortController();
    const cancel = () => abort.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(() => abort.abort(), connectTimeoutMs);
    try {
      await this.withTimeout(client.connect(transport, { timeout: connectTimeoutMs, signal: abort.signal }), connectTimeoutMs, abort.signal);
    } catch (error) {
      await this.discard(client);
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
    return client;
  }

  private async discard(client: Client): Promise<void> {
    this.clients.delete(client);
    for (const [key, idle] of this.pool) { const remaining = idle.filter((c) => c !== client); if (remaining.length) this.pool.set(key, remaining); else this.pool.delete(key); }
    await client.close().catch(() => undefined);
    this.cancellationSends.delete(client);
  }

  /** 关闭空闲及在途连接（进程退出或配置变更）。 */
  async closeAllSessions(): Promise<void> {
    const all = [...this.clients]; this.clients.clear();
    this.pool.clear();
    await Promise.all(all.map((c) => c.close().catch(() => undefined)));
  }
  onModuleDestroy(): Promise<void> { return this.closeAllSessions(); }

  /**
   * 真实执行一次 MCP 工具调用（tools/call）。
   * 复用端点级长连接，避免服务端在工具执行中被 ClientDisconnect。
   */
  async callTool(options: McpCallOptions): Promise<McpCallResult> {
    const started = Date.now();
    let client: Client | null = null;
    const abort = new AbortController();
    const cancel = () => abort.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const totalBudgetMs = Math.max(1, Math.min(options.timeoutMs + (options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS), (options.deadlineAt ?? Infinity) - started));
    const timer = setTimeout(() => abort.abort(), totalBudgetMs);
    let phase: 'connect' | 'execute' = 'connect';
    let phaseTimeoutMs = Math.min(options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, totalBudgetMs);

    try {
      options = { ...options, headers: readStoredHeaders(options, this.config?.get<AppConfig['security']>('security')) };
      if (abort.signal.aborted) throw new Error('调用已取消');
      client = await this.acquireConnection(options, abort.signal);
      phase = 'execute';
      const timeoutMs = Math.max(1, Math.min(options.timeoutMs, (options.deadlineAt ?? Infinity) - Date.now()));
      phaseTimeoutMs = timeoutMs;
      const result = await this.withTimeout(client.callTool({ name: options.toolName, arguments: options.arguments }, undefined,
        { timeout: timeoutMs, maxTotalTimeout: timeoutMs, signal: abort.signal }), timeoutMs, abort.signal);

      const text = (Array.isArray(result.content) ? result.content : [])
        .map((block: { text?: unknown; type?: string; resource?: { text?: unknown } }) => typeof block.text === 'string' ? block.text : typeof block.resource?.text === 'string' ? block.resource.text : '')
        .join('\n');

      await this.releaseConnection(this.sessionKey(options), client);
      client = null;
      return {
        ok: true,
        latencyMs: Date.now() - started,
        text,
        isError: Boolean(result.isError),
        raw: result,
      };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const cancelled = Boolean(options.signal?.aborted);
      const timedOut = /-32001|Request timed out|__TIMEOUT__/i.test(raw) || abort.signal.aborted;
      const message = cancelled ? '调用已取消；取消通知不保证远程进程已经停止，请核实后再执行可能产生副作用的操作'
        : timedOut ? phase === 'connect' ? `MCP 握手超时（${phaseTimeoutMs}ms），尚未发起工具请求`
          : `工具执行超时（${phaseTimeoutMs}ms）；请缩小端口或目标范围，超时不代表目标状态`
        : redactHeaderValues(this.describeError(error, options.timeoutMs), options.headers);
      this.logger.warn(`MCP 工具调用失败 [${options.toolName} @ ${options.endpoint}]: ${message}`);

      if (client) {
        // SDK cancellation is sent asynchronously. Let that notification settle before closing
        // the transport, otherwise immediate close can abort the cancellation POST itself.
        abort.abort(error);
        const sends = [...(this.cancellationSends.get(client) ?? [])];
        if (sends.length) {
          let cleanupTimer: NodeJS.Timeout | undefined;
          await Promise.race([Promise.allSettled(sends), new Promise((resolve) => { cleanupTimer = setTimeout(resolve, 1000); })]);
          if (cleanupTimer) clearTimeout(cleanupTimer);
        }
        await this.discard(client);
      }
      return { ok: false, latencyMs: Date.now() - started, error: message, phase, cancelled };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
      const onAbort = () => { cleanup(); reject(new Error(`__TIMEOUT__${timeoutMs}`)); };
      const timer = setTimeout(onAbort, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    });
  }

  private describeError(error: unknown, timeoutMs: number): string {
    const raw = error instanceof Error ? error.message : String(error);
    // undici 把底层网络错误放在 cause 里（fetch failed → cause: ECONNREFUSED）
    const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
    const causeText =
      cause instanceof Error
        ? `${(cause as { code?: string }).code ?? ''} ${cause.message}`.trim()
        : cause
          ? String(cause)
          : '';
    const text = `${raw} ${causeText}`;

    if (text.includes('__TIMEOUT__')) {
      // 拼接的标记里带有真实超时值，优先取它，避免文案与配置不一致
      const marker = text.match(/__TIMEOUT__(\d+)/);
      const actual = marker ? Number(marker[1]) : timeoutMs;
      return `连接超时（${actual}ms 内未完成 MCP 握手或工具响应）。若为长任务扫描，请调大 MCP_TOOL_TIMEOUT_MS 或缩小扫描范围`;
    }
    if (text.includes('ECONNREFUSED')) {
      return '连接被拒绝（ECONNREFUSED），目标端口未监听。请确认对应的 blhackbox MCP 服务已启动。';
    }
    if (text.includes('ENOTFOUND') || text.includes('EAI_AGAIN')) {
      return `域名解析失败：${causeText || raw}`;
    }
    if (text.includes('fetch failed')) {
      return `网络请求失败：${causeText || raw}`;
    }
    if (text.includes('Unexpected content type') || text.includes('Unexpected token')) {
      return `端点返回了非 MCP 响应，可能不是 Streamable HTTP MCP 地址：${raw}`;
    }
    if (text.includes('HTTP 404') || text.includes('404')) {
      return `端点返回 404，请确认路径（blhackbox MCP Gateway 为 /mcp）：${raw}`;
    }
    return causeText ? `${raw}（${causeText}）` : raw;
  }
}
