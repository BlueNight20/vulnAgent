import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { McpServerEntity, McpToolEntity } from '../../database/entities';
import { McpClientFactory } from '../mcp/mcp-client.factory';
import { parseMcpContent } from '../mcp/mcp-result-content';
import { attachmentBlock, errorResult, referenceBlock, type CoreTool, type ToolContext, type ToolResult } from './core-tool';
import { failureNotice } from './tool-result';
import { classifyToolFailure } from '../mcp/tool-failure-classifier';
import type { McpDriver, McpDriverResponse } from './mcp-tool-source';
import { ToolCancelledError, ToolExecutionUncertainError, ToolTimeoutError, type ToolExecutor } from './tool-invoker';

/**
 * MCP 执行器：把 CoreTool 的调用翻译成真实 MCP tools/call。
 *
 * 这里是工具层唯一认识 MCP 协议的地方（传输、内容解析、失败分类）；
 * 工具层其余部分只依赖 `McpDriver` 接口。
 */
@Injectable()
export class McpCallExecutor implements ToolExecutor, McpDriver {
  readonly kind = 'mcp';
  private readonly logger = new Logger(McpCallExecutor.name);

  constructor(
    @InjectRepository(McpServerEntity) private readonly servers: Repository<McpServerEntity>,
    @InjectRepository(McpToolEntity) private readonly tools: Repository<McpToolEntity>,
    private readonly factory: McpClientFactory,
  ) {}

  async run(tool: CoreTool, input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    // 注意：执行规格来自工具定义本身（kind/服务器/远端名），而不是调用方传入的 input。
    const spec = tool.execSpec();
    const serverId = String(spec.meta?.serverId ?? '');
    const remoteName = String(spec.meta?.remoteName ?? tool.name());
    try {
      const response = await this.call(serverId, remoteName, input, _ctx.signal);
      // 远端常以 return_code 表达命令失败而不是 MCP isError：
      // 命令行工具的非零退出码必须作为失败告知模型，否则会把错误输出当成扫描结论。
      const exitCode = exitCodeOf(response.text);
      const failed = response.isError || (exitCode !== null && exitCode !== 0);
      const content = [
        ...(response.text.trim() ? [{ type: 'text' as const, text: response.text }] : []),
        ...(response.attachments ?? []).map((a) => attachmentBlock(a)),
        // 外部引用只登记不抓取：模型看到"尚未获取"，证据保留来源地址。
        ...(response.references ?? []).map((r) => referenceBlock(r)),
      ];
      if (failed) {
        content.unshift({
          type: 'text' as const,
          text: failureNotice({ tool: remoteName, kind: exitCode === null ? 'server_error' : 'invalid_input', retryable: true, reason: exitCode === null ? '远端返回错误' : `命令退出码 ${exitCode}`, suggestion: '按错误输出修正参数后重试，不要原样重复失败调用' }),
        });
      }
      return { content, isError: failed, details: { serverId, remoteName, exitCode } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 建连阶段失败（握手超时/连接被拒）确定尚未派发工具，属于"已知未执行"。
      const handshake = /握手|initialize|protocol|econnrefused|connection refused|enotfound|getaddrinfo/i.test(message);
      // 取消信号可能来自远端回报而非本地 abort，因此必须同时识别错误文案。
      const cancelled = !handshake && (_ctx.signal?.aborted === true || /调用已取消|cancelled|canceled/i.test(message));
      const timedOut = !handshake && /执行超时|-32001|timed out/i.test(message);
      // 超时与取消必须继续上抛：远端可能已经执行，属于"结果未知"，
      // 调用方（重放入口）据此保留待核实状态，不能当作普通失败收尾。
      if (cancelled) throw new ToolCancelledError();
      if (timedOut) throw new ToolTimeoutError(Number(spec.timeoutMs ?? 0));
      // 附件解析失败说明远端已经返回结果、仅本地保存失败：同样属于"结果未知"，不能冒充未执行。
      if (/附件|Base64|MiB/i.test(message)) throw new ToolExecutionUncertainError(message);
      const classification = classifyToolFailure({ error: message });
      return errorResult(failureNotice({
        tool: remoteName,
        kind: classification.kind,
        retryable: classification.retryable,
        reason: classification.reason,
        suggestion: classification.suggestion,
      }));
    }
  }

  /** McpDriver 实现：供 buildMcpTool 直接调用。 */
  async call(serverId: string, toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<McpDriverResponse> {
    const server = await this.servers.findOneBy({ id: serverId });
    if (!server) throw new Error(`MCP 服务不存在或已删除：${serverId}`);
    if (!server.enabled) throw new Error(`MCP 服务 ${server.name} 已停用`);

    const remote = await this.tools.findOneBy({ mcpServerId: serverId, name: toolName });
    const call = await this.factory.callTool({
      endpoint: server.endpoint,
      transport: server.transport,
      headers: server.headers,
      headersEncrypted: server.headersEncrypted,
      stdioConfigEncrypted: server.stdioConfigEncrypted,
      timeoutMs: callTimeout(),
      toolName: remote?.name ?? toolName,
      arguments: input,
      signal,
    });
    if (!call.ok) throw new Error(call.error);

    const parsed = parseMcpContent(call.raw, call.text);
    return {
      text: parsed.text,
      isError: call.isError,
      // 附件由 Invoker 落库后再回填真实 ID 与摘要；此处只携带原始字节。
      attachments: parsed.attachments.map((a) => ({
        id: '', filename: a.filename, mimeType: a.mimeType,
        sizeBytes: a.data.length, sha256: createHash('sha256').update(a.data).digest('hex'),
        data: a.data, sourceUri: a.sourceUri,
      })),
      references: parsed.references,
      unsupported: parsed.unsupported,
    };
  }
}

/** 从文本或 JSON 结构化输出里读取命令退出码；读不到返回 null。 */
export function exitCodeOf(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ['return_code', 'returnCode', 'exit_code', 'exitCode', 'code']) {
        const value = parsed[key];
        if (typeof value === 'number' && Number.isInteger(value)) return value;
      }
    } catch { /* 非 JSON 时按文本匹配 */ }
  }
  const match = trimmed.match(/(?:^|\n)\s*(?:return_code|exit_code|exit code)\s*[:=]\s*(-?\d+)/i);
  return match ? Number(match[1]) : null;
}

/** 单次 MCP 调用上限。执行超时不代表目标状态，由失败文案说明。 */
function callTimeout(): number {
  const raw = Number(process.env.TOOL_CALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}
