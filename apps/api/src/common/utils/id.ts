import { randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 通配符匹配：支持 `*` 单个通配（nmap_* 匹配 nmap_scan） */
export function matchToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*' || pattern === toolName) return true;
  if (!pattern.includes('*')) return false;
  const escaped = pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(toolName);
}

/** 按风险关键词推断工具风险等级（仅本地启发式，来自工具名/描述） */
/**
 * 推断 MCP 工具的风险等级。
 *
 * 重要：只在**工具名**上判定，不扫描描述文本。
 * 描述里常出现 "payload"、"exploit" 等词（例如工具清单类工具会列举可用攻击工具），
 * 用描述判定会把只读工具误标为 destructive，导致正常侦察被审批阻塞。
 */
export function inferToolRisk(name: string, description: string | null): 'safe' | 'intrusive' | 'destructive' {
  const toolName = name.toLowerCase();
  void description;

  /** 只读元信息查询：永远安全 */
  const readOnly = [
    'list_available_tools',
    'list_screenshots',
    'msf_status',
    'msf_search',
    'msf_module_info',
    'list_encoders',
    'list_loaders',
    'validate_options',
  ];
  if (readOnly.includes(toolName)) return 'safe';

  /** 明确会改变目标状态或执行代码的工具 */
  const destructive = [
    'exploit',
    'metasploit',
    'msf_run',
    'msf_payload',
    'msf_console',
    'hydra',
    'brute',
    'crack',
    'sqlmap',
    'dos',
    'delete',
    'write_file',
    'run_shell',
    'reverse',
    'privesc',
    'upload',
    'pwntools',
    'pacu',
    'generate_payload',
  ];
  if (destructive.some((keyword) => toolName.includes(keyword))) return 'destructive';

  /** 主动扫描类：会向目标发包，但不改变目标状态 */
  const intrusive = [
    'scan',
    'nmap',
    'nuclei',
    'nikto',
    'gobuster',
    'ffuf',
    'dirb',
    'enum',
    'fuzz',
    'request',
    'http',
    'probe',
    'masscan',
    'rustscan',
    'netexec',
    'smbmap',
  ];
  if (intrusive.some((keyword) => toolName.includes(keyword))) return 'intrusive';

  return 'safe';
}
