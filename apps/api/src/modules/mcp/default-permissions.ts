import type { AgentRole } from '@vulnagent/shared';

export interface DefaultPermission {
  agentRole: AgentRole;
  toolPattern: string;
  allowed: boolean;
  requireApproval: boolean;
}

/**
 * 默认工具权限矩阵（全自动模式）。
 *
 * 当前配置：所有执行型角色均可调用任意已注册工具，且一律不需要人工审批，
 * 由模型自行决定侦察、利用与验证步骤。这里保留矩阵结构只是为了在权限页面
 * 展示和审计，不再对工具能力施加限制。
 *
 * - `explore` / `analysis` / `verifier`：`*` 放行全部工具
 * - `planner` / `reporter`：本身不持有工具，仅读黑板与证据
 * - 授权边界（目标范围、引擎开关）不在此矩阵内，见 scope-guard / runtime-gate
 */
export const DEFAULT_PERMISSIONS: DefaultPermission[] = [
  // 编排器与规划器不直接执行工具
  { agentRole: 'orchestrator', toolPattern: '*', allowed: false, requireApproval: false },
  { agentRole: 'planner', toolPattern: '*', allowed: false, requireApproval: false },
  { agentRole: 'reporter', toolPattern: '*', allowed: false, requireApproval: false },

  // 侦察：端口/资产发现
  { agentRole: 'explore', toolPattern: 'nmap_scan', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'nmap_advanced_scan', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'masscan_high_speed', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'rustscan_fast_scan', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'arp_scan_discovery', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'httpx_probe', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'autorecon_scan', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'list_available_tools', allowed: true, requireApproval: false },

  // Web 枚举
  { agentRole: 'explore', toolPattern: 'gobuster_scan', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'ffuf_scan', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'dirb_scan', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'dirsearch_scan', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'feroxbuster_scan', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'nikto_scan', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'wpscan_analyze', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'wafw00f_scan', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'http_repeater', allowed: true, requireApproval: false },

  // 服务枚举（SMB / RPC / NetBIOS 只读查询）
  { agentRole: 'explore', toolPattern: 'enum4linux_scan', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'enum4linux_ng_advanced', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'smbmap_scan', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'rpcclient_enumeration', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'nbtscan_netbios', allowed: true, requireApproval: false },
  { agentRole: 'explore', toolPattern: 'netexec_scan', allowed: true, requireApproval: false },

  // 分析：漏洞库查询与模板化检测（只读）
  { agentRole: 'analysis', toolPattern: 'nuclei_scan', allowed: true, requireApproval: false },
  { agentRole: 'analysis', toolPattern: 'search_exploits', allowed: true, requireApproval: false },
  { agentRole: 'analysis', toolPattern: 'get_exploit_code', allowed: true, requireApproval: false },
  { agentRole: 'analysis', toolPattern: 'msf_search', allowed: true, requireApproval: false },
  { agentRole: 'analysis', toolPattern: 'msf_module_info', allowed: true, requireApproval: false },
  { agentRole: 'analysis', toolPattern: 'analyze_target_intelligence', allowed: true, requireApproval: false },

  // 验证：全部工具放行，包括利用类与 shell，不再需要审批
  { agentRole: 'verifier', toolPattern: '*', allowed: true, requireApproval: false },
  { agentRole: 'verifier', toolPattern: 'nuclei_scan', allowed: true, requireApproval: false },
  { agentRole: 'verifier', toolPattern: 'http_repeater', allowed: true, requireApproval: false },
  { agentRole: 'verifier', toolPattern: 'search_exploits', allowed: true, requireApproval: false },
  { agentRole: 'verifier', toolPattern: 'msf_search', allowed: true, requireApproval: false },
  { agentRole: 'verifier', toolPattern: 'msf_module_info', allowed: true, requireApproval: false },
  { agentRole: 'verifier', toolPattern: 'sqlmap_scan', allowed: true, requireApproval: false },
  { agentRole: 'verifier', toolPattern: 'dalfox_xss_scan', allowed: true, requireApproval: false },
  { agentRole: 'verifier', toolPattern: 'xsser_scan', allowed: true, requireApproval: false },
  { agentRole: 'verifier', toolPattern: 'jaeles_vulnerability_scan', allowed: true, requireApproval: false },
  { agentRole: 'verifier', toolPattern: 'msf_run_module', allowed: true, requireApproval: false },
  { agentRole: 'verifier', toolPattern: 'msf_console_execute', allowed: true, requireApproval: false },
  { agentRole: 'verifier', toolPattern: 'run_kali_tool', allowed: true, requireApproval: false },
  { agentRole: 'verifier', toolPattern: 'run_shell_command', allowed: true, requireApproval: false },
];

/** 权限矩阵展示的 Agent 角色（编辑矩阵时使用） */
export const MATRIX_ROLES: AgentRole[] = [
  'bootstrap',
  'explore',
  'analysis',
  'verifier',
  'reporter',
  'planner',
];
