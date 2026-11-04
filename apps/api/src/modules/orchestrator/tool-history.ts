import type { ToolCallEntity } from '../../database/entities';

export function recentToolSummary(calls: ToolCallEntity[]): string {
  return ['以下是最近 20 次记录，既不代表全部覆盖，也不代表未尝试工具不可用。',
    ...calls.map((c) => `- ${c.toolName} → ${c.targetIp ?? '网段或未记录单 IP'} [${c.status}/${c.failureKind ?? '无失败分类'}] ${c.latencyMs}ms；范围参数 ${JSON.stringify({ ports: c.arguments.ports, scan_type: c.arguments.scan_type, options: c.arguments.options, additional_args: c.arguments.additional_args }).slice(0, 400)}${c.errorMessage || c.decisionReason ? `；${(c.errorMessage ?? c.decisionReason)!.slice(0, 350)}` : ''}`),
    '执行超时：拆分端口/目标后重试；握手或连接失败：检查 MCP 服务，不据此推断目标状态；参数错误：按 Schema 修正；权限拒绝：不能绕过。相同参数两次失败后本会话禁止原样调用。',
  ].join('\n');
}
