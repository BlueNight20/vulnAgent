import type { McpServerInput } from '../../api/mcp';

export function parseMcpImport(text: string): McpServerInput[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('配置不是有效 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置需要包含 mcpServers 对象');
  const servers = (value as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('配置需要包含 mcpServers 对象');
  const entries = Object.entries(servers);
  if (!entries.length || entries.length > 50) throw new Error('每次可导入 1–50 个服务');
  return entries.map(([name, config]) => {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${name}：服务配置必须为对象`);
    const row = config as Record<string, unknown>;
    if (row.command || row.type === 'stdio' || row.transport === 'stdio') {
      if (typeof row.command !== 'string' || !row.command.trim()) throw new Error(`${name}：缺少启动命令`);
      if (row.args && (!Array.isArray(row.args) || row.args.some((arg) => typeof arg !== 'string'))) throw new Error(`${name}：args 必须为字符串数组`);
      if (row.env && (typeof row.env !== 'object' || Array.isArray(row.env) || Object.values(row.env).some((v) => typeof v !== 'string'))) throw new Error(`${name}：env 必须为字符串键值对象`);
      return { name, endpoint: 'stdio://local', transport: 'stdio', command: row.command, args: row.args as string[] | undefined, env: row.env as Record<string, string> | undefined };
    }
    const endpoint = row.url ?? row.endpoint;
    if (typeof endpoint !== 'string') throw new Error(`${name}：缺少服务 url`);
    const transport = row.type ?? row.transport ?? 'streamable-http';
    if (!['http', 'streamable-http', 'sse'].includes(String(transport))) throw new Error(`${name}：未知传输方式`);
    if (row.headers && (typeof row.headers !== 'object' || Array.isArray(row.headers) || Object.values(row.headers).some((v) => typeof v !== 'string'))) throw new Error(`${name}：请求头必须为字符串键值对象`);
    return { name, endpoint, transport: transport === 'sse' ? 'sse' : 'streamable-http', headers: row.headers as Record<string, string> | undefined };
  });
}
