import { describe, expect, it } from 'vitest';
import { parseMcpImport } from './mcp-import';

describe('MCP 配置导入', () => {
  it('保留 stdio 命令参数和环境变量，拒绝字符串形式的参数列表', () => {
    expect(parseMcpImport(JSON.stringify({ mcpServers: { local: { command: 'node', args: ['server.js'], env: { KEY: 'fixture' } } } }))[0]).toEqual({
      name: 'local', endpoint: 'stdio://local', transport: 'stdio', command: 'node', args: ['server.js'], env: { KEY: 'fixture' },
    });
    expect(() => parseMcpImport('{"mcpServers":{"x":{"command":"node","args":"server.js"}}}')).toThrow('args');
  });
  it('按服务名称保留归属，兼容 HTTP 别名、SSE 和认证头', () => {
    expect(parseMcpImport(JSON.stringify({ mcpServers: {
      browser: { url: 'http://localhost:8931/mcp', type: 'http', headers: { Authorization: 'Bearer fixture' } },
      legacy: { url: 'http://localhost:8081/sse', transport: 'sse' },
    } }))).toEqual([
      { name: 'browser', endpoint: 'http://localhost:8931/mcp', transport: 'streamable-http', headers: { Authorization: 'Bearer fixture' } },
      { name: 'legacy', endpoint: 'http://localhost:8081/sse', transport: 'sse', headers: undefined },
    ]);
  });
  it('无效 JSON、空列表或非法认证头不会形成导入请求', () => {
    expect(() => parseMcpImport('{')).toThrow('JSON');
    expect(() => parseMcpImport('{"mcpServers":{}}')).toThrow('1–50');
    expect(() => parseMcpImport('{"mcpServers":{"x":{"url":"http://localhost","headers":{"a":1}}}}')).toThrow('请求头');
  });
});
