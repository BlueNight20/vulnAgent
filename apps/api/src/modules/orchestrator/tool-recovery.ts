import { remoteToolName } from '../mcp/tool-names';
/** 能力候选关系；只替换工具选择，参数必须依据替代工具 Schema 重新生成。 */
const GROUPS = [
  ['gobuster_scan', 'dirb_scan', 'ffuf_scan', 'dirsearch_scan'],
  ['httpx_probe', 'http_repeater'],
];
export interface RecoveryCall { toolName: string; status: string; targetIp: string | null; errorMessage: string | null; createdAt: Date }

export function recoverToolSelection(selected: string[], catalog: string[], calls: RecoveryCall[], target: string | null, now = Date.now()) {
  const tools = new Set(selected);
  const notes: string[] = [];
  const suppressed = new Set<string>();
  const recent = [...calls].filter((c) => now - c.createdAt.getTime() < 300_000).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const broken = (name: string) => {
    const rows = recent.filter((c) => c.toolName === name && (c.targetIp === target || /command not found|no such file|not installed|return_code\s*127/i.test(c.errorMessage ?? ''))).slice(0, 2);
    return rows.length === 2 && rows.every((c) => c.status === 'error');
  };
  for (const name of selected) {
    if (!broken(name)) continue;
    const rows = recent.filter((c) => c.toolName === name).slice(0, 2);
    const missing = rows.every((c) => /command not found|no such file|not installed|return_code\s*127/i.test(c.errorMessage ?? ''));
    const group = GROUPS.find((group) => group.includes(remoteToolName(name)));
    const alternative = catalog.find((candidate) => candidate !== name && group?.includes(remoteToolName(candidate)) && !broken(candidate));
    // 参数和目标范围错误仍允许修正；仅缺失依赖的工具进入短期冷却。
    if (missing || alternative) { tools.delete(name); suppressed.add(name); }
    if (alternative) tools.add(alternative);
    notes.push(`${name} 最近连续失败：${alternative ? `优先改用 ${alternative}，根据其 Schema 重新生成参数；确认协议、认证方式和预期证据匹配` : missing ? '环境依赖缺失，暂时移出可用工具；保留未覆盖项' : '修正参数或缩小范围后再执行'}。工具故障不代表目标不存在漏洞。`);
  }
  return { tools: [...tools], notes, suppressed: [...suppressed] };
}
