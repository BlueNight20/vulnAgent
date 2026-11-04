import { describe, expect, it } from 'vitest';
import { exposedToolNames, remoteToolName } from './tool-names';
import { selectTools, getProfile } from '../worker-skills/profiles';
import { buildMcpTool } from '../tool/mcp-tool-source';
describe('多服务工具身份', () => {
  const rows = [{ id: '1', mcpServerId: 'one', name: 'nmap_scan' }, { id: '2', mcpServerId: 'two', name: 'nmap_scan' }];
  it('所有同名工具均有稳定名称，目录顺序不影响服务归属', () => {
    const names = exposedToolNames(rows);
    expect(names.get('1')).not.toBe(names.get('2'));
    expect(exposedToolNames([...rows].reverse())).toEqual(names);
    expect(remoteToolName(names.get('1')!)).toBe('nmap_scan');
    expect(selectTools(getProfile('recon'), [...names.values()])).toHaveLength(2);
  });
  it('模型名称映射到原始服务 ID 和远端工具名称', async () => {
    const names = exposedToolNames(rows); const calls: string[] = [];
    for (const row of rows) {
      const tool = buildMcpTool({ serverId: row.mcpServerId, serverName: 'same display', name: row.name, description: '', inputSchema: {}, riskLevel: 'safe' },
        { call: async (serverId, name) => { calls.push(`${serverId}/${name}`); return { text: 'ok', isError: false }; } }, { nameOf: () => names.get(row.id)! });
      await tool.call({}, { taskId: 'task', sessionId: null, role: 'explore', allowedTools: [tool.name()], authorizedTargets: [] });
    }
    expect(calls).toEqual(['one/nmap_scan', 'two/nmap_scan']);
  });
});
