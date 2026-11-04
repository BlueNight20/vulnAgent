import { createHash } from 'node:crypto';

export function exposedToolNames(rows: Array<{ id: string; name: string; mcpServerId: string }>): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = owners.get(row.name) ?? new Set<string>(); set.add(row.mcpServerId); owners.set(row.name, set);
  }
  const names = new Map<string, string>();
  for (const row of rows) {
    const needsNamespace = owners.get(row.name)!.size > 1 || !/^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(row.name) || row.name.startsWith('mcp_');
    const prefix = createHash('sha256').update(`${row.mcpServerId}\0${row.name}`).digest('hex').slice(0, 16);
    names.set(row.id, needsNamespace ? `mcp_${prefix}__${row.name.replace(/[^a-zA-Z0-9_.:-]/g, '_')}` : row.name);
  }
  return names;
}

export function remoteToolName(name: string): string {
  return name.replace(/^mcp_[a-f0-9]{16}__/, '');
}
