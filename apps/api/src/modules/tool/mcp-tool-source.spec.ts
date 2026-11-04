import { describe, expect, it, vi } from 'vitest';
import { buildMcpTool, type McpDriver, type McpSourceTool } from './mcp-tool-source';
import type { ToolContext } from './core-tool';

const ctx: ToolContext = { taskId: 't', sessionId: 's', role: 'explore', allowedTools: [], authorizedTargets: [], evidenceIds: [] };

const source = (over: Partial<McpSourceTool> = {}): McpSourceTool => ({
  serverId: 'server-1',
  serverName: 'blhackbox',
  name: 'nmap_scan',
  description: '端口扫描',
  inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
  riskLevel: 'safe',
  ...over,
});

describe('MCP 工具包装为 CoreTool', () => {
  it('保留远端原工具名与 inputSchema，模型看到的是真实参数定义', () => {
    const tool = buildMcpTool(source(), { call: vi.fn() } as unknown as McpDriver);
    expect(tool.name()).toBe('nmap_scan');
    expect(tool.source()).toBe('mcp');
    expect(tool.inputSchema()).toMatchObject({ required: ['target'] });
    expect(tool.description()).toBe('端口扫描');
  });

  it('只读风险级别的工具默认可并发；高风险工具不可并发', () => {
    const driver = { call: vi.fn() } as unknown as McpDriver;
    expect(buildMcpTool(source(), driver).isConcurrencySafe({})).toBe(true);
    expect(buildMcpTool(source({ riskLevel: 'destructive' }), driver).isConcurrencySafe({})).toBe(false);
    expect(buildMcpTool(source({ riskLevel: 'destructive' }), driver).isReadOnly({})).toBe(false);
  });

  it('执行时把远端返回的文本、附件元数据和外部引用一起编码', async () => {
    const call = vi.fn(async () => ({
      text: '22/tcp open ssh',
      isError: false,
      attachments: [{ id: 'a1', filename: 'shot.png', mimeType: 'image/png', sizeBytes: 12, sha256: 'h', data: Buffer.from('x') }],
      references: [{ name: 'doc', uri: 'https://example.com' }],
      unsupported: [{ type: 'video', mimeType: 'video/mp4' }],
    }));
    const tool = buildMcpTool(source(), { call } as unknown as McpDriver);
    const result = await tool.call({ target: '10.0.0.1' }, ctx);
    expect(call).toHaveBeenCalledWith('server-1', 'nmap_scan', { target: '10.0.0.1' }, undefined);
    expect(result.isError).toBe(false);
    const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    expect(text).toContain('22/tcp open ssh');
    expect(text).toContain('尚未支持保存');
    expect(result.content.some((b) => b.type === 'attachment')).toBe(true);
    expect(result.content.some((b) => b.type === 'reference')).toBe(true);
  });

  it('远端 isError 透传为结果 isError，不抛异常', async () => {
    const tool = buildMcpTool(source(), { call: async () => ({ text: 'permission denied', isError: true }) } as unknown as McpDriver);
    const result = await tool.call({}, ctx);
    expect(result.isError).toBe(true);
  });

  it('空输出有兜底文案，不产生空结果块', async () => {
    const tool = buildMcpTool(source(), { call: async () => ({ text: '   ', isError: false }) } as unknown as McpDriver);
    const result = await tool.call({}, ctx);
    expect(result.content).toEqual([{ type: 'text', text: '(no output)' }]);
  });

  it('执行规格携带服务器与远端名，供执行器路由', () => {
    const tool = buildMcpTool(source(), { call: vi.fn() } as unknown as McpDriver, { timeoutMs: 1234 });
    expect(tool.execSpec()).toMatchObject({ kind: 'mcp', timeoutMs: 1234, meta: { serverId: 'server-1', remoteName: 'nmap_scan' } });
  });
});
