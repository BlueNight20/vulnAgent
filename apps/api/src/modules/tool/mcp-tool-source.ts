import { attachmentBlock, buildTool, referenceBlock, textResult, type CoreTool, type ToolAttachmentInput, type ToolContentBlock } from './core-tool';
import type { ToolRiskLevel } from '@vulnagent/shared';

/** 远程 MCP 服务的一次调用返回值（与具体 SDK 解耦）。 */
export interface McpDriverResponse {
  text: string;
  isError: boolean;
  attachments?: ToolAttachmentInput[];
  references?: { name: string; uri: string }[];
  unsupported?: { type: string; mimeType: string | null }[];
}

/**
 * MCP Driver 抽象。
 *
 * 工具层只认识这个接口，不认识 @modelcontextprotocol/sdk；
 * 真实实现在 `McpCallExecutor` 中注入，测试可替换为内存实现。
 */
export interface McpDriver {
  call(serverId: string, toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<McpDriverResponse>;
}

export interface McpSourceTool {
  serverId: string;
  serverName: string;
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
}

export interface McpToolOptions {
  /** 暴露给模型的名称；默认保留远端原名。 */
  nameOf?: (tool: McpSourceTool) => string;
  timeoutMs?: number;
}

/**
 * 把一个 MCP 工具包装成 CoreTool。
 *
 * 设计要点：
 * - 远端 inputSchema 原样下发给模型，不改写；
 * - 二进制内容只登记附件与元数据，不把字节塞进上下文；
 * - 远端 isError 透传为结果 isError，不抛异常。
 */
export function buildMcpTool(tool: McpSourceTool, driver: McpDriver, options: McpToolOptions = {}): CoreTool {
  const exposedName = options.nameOf ? options.nameOf(tool) : tool.name;
  return buildTool({
    name: exposedName,
    description: tool.description ?? `${tool.serverName} 提供的远程工具 ${tool.name}`,
    prompt: `远程 MCP 工具：${tool.name}（服务 ${tool.serverName}）。输出受平台上限约束，超限会保留头尾并标记截断。`,
    inputSchema: tool.inputSchema,
    readOnly: tool.riskLevel === 'safe',
    concurrencySafe: tool.riskLevel === 'safe',
    risk: tool.riskLevel,
    source: 'mcp',
    exec: { kind: 'mcp', timeoutMs: options.timeoutMs, meta: { serverId: tool.serverId, remoteName: tool.name } },
    run: async (input, ctx) => {
      const response = await driver.call(tool.serverId, tool.name, input, ctx.signal);
      const blocks: ToolContentBlock[] = response.text.trim() ? [{ type: 'text', text: response.text }] : [];
      for (const attachment of response.attachments ?? []) blocks.push(attachmentBlock(attachment));
      for (const reference of response.references ?? []) blocks.push(referenceBlock(reference));
      if (response.unsupported?.length) {
        blocks.push({
          type: 'text' as const,
          text: `以下内容类型尚未支持保存，未写入证据：${response.unsupported.map((item) => `${item.type}/${item.mimeType ?? 'unknown'}`).join('、')}`,
        });
      }
      if (!blocks.length) blocks.push({ type: 'text' as const, text: '(no output)' });
      return { content: blocks, isError: response.isError, details: { source: 'mcp', serverId: tool.serverId, remoteName: tool.name } };
    },
  });
}

export function textResponse(text: string, isError = false): McpDriverResponse {
  return { text, isError };
}

export { textResult };
