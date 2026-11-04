import { remoteToolName } from '../mcp/tool-names';
import type { WorkerProfileId } from '@vulnagent/shared';

/**
 * Worker 专业能力档案（动态加载，不是固定 Agent）。
 * toolPatterns 使用通配符匹配实际 MCP 工具名；
 * 实际可用工具 = 档案模式 ∩ 角色权限 ∩ MCP 工具目录。
 */
export interface WorkerProfile {
  id: WorkerProfileId;
  name: string;
  role: 'explore' | 'analysis' | 'verifier';
  /** 该档案的工具选择模式（按优先级） */
  toolPatterns: string[];
  /** 技能说明，写入 system prompt */
  skills: SkillDefinition[];
  /** 预期产出，用于校验 Worker 是否真的产出了证据 */
  expectedEvidence: string[];
  /** 单次任务 Token 预算（占任务预算的上限份额） */
  tokenBudgetShare: number;
  /** 默认超时秒数 */
  timeoutSeconds: number;
  promptVersion: string;
}

export interface SkillDefinition {
  id: string;
  name: string;
  /** 该技能的作业指导（进入 system prompt） */
  guidance: string;
}

export const SKILL_RECON: SkillDefinition = {
  id: 'recon.port-scan',
  name: '端口与服务发现',
  guidance: [
    '围绕任务验收的尚缺端口按批扫描；时间取决于目标、网络和工具，不假定固定扫描耗时。',
    '显式设置数字 ports 与 TCP/UDP 模式。需要 TCP 连接扫描时可用 scan_type="-sT -Pn"；任务限制端口时，不能用默认端口或 top-ports 扩大授权。',
    '全端口 1-65535 应拆成有界小批，使用验收缺口继续规划；工作量限制返回本批可用大小，不要原样重试被拒绝的大范围。不要把拆分批次遗漏的范围当作已覆盖。',
    '注意 filtered 不等于 closed：filtered 表示有防火墙或无响应，不能判断服务不存在。',
    '每次调用后读取真实 stdout 并引用证据 ID；模型结论保持推断，确定性提取器负责写入 observed 观测。',
    '禁止重复扫描已经确认过的端口组合。',
  ].join('\n'),
};

export const SKILL_NETWORK_MAP: SkillDefinition = {
  id: 'recon.network-map',
  name: '网段拓扑',
  guidance:
    '对本机存活主机做快速探测，识别操作系统指纹与主机名，构建资产清单。仅扫描授权 CIDR 内的地址。',
};

export const SKILL_TOOL_DISCIPLINE: SkillDefinition = {
  id: 'common.tool-discipline',
  name: '工具使用纪律',
  guidance: [
    '信息收集应复用本轮已确认结果；执行超时需调整范围，连接/握手故障应检查服务后最多再试一次，不盲目改变扫描目标。独立漏洞复核需要新调用，允许为验证可重复性使用相同参数。',
    '工具返回「超时」时，说明任务过重：缩小端口范围、减少线程、去掉 -A/-p- 之类的全量参数后再试一次。',
    '工具返回「权限不足/未授权」时，不要重试，直接换用已授权的工具或记录为阻塞。',
    '每个 Worker 最多调用工具 24 次；连续 3 次失败后系统停止本 Worker，保留证据并交由 Planner 重新规划。大目标需要多批、有依据地继续补齐，不能靠新意图重复失败参数。',
    '优先使用快工具（httpx_probe）确认目标存活，再用重工具（nmap/nikto）做深入探测。',
  ].join('\n'),
};

export const SKILL_WEB_ENUM: SkillDefinition = {
  id: 'web.content-enum',
  name: 'Web 内容枚举',
  guidance:
    '基于已发现的服务做目录与文件枚举，识别 CMS、框架与版本。记录每个可访问路径与响应状态码，把有价值的响应体保存为证据。',
};

export const SKILL_WEB_AUDIT: SkillDefinition = {
  id: 'web.misconfig-audit',
  name: 'Web 配置审计',
  guidance:
    '检查默认页面、目录列举、备份文件、敏感信息泄露、版本过旧等常见配置问题。每个结论必须附带请求证据。',
};

export const SKILL_SERVICE_IDENT: SkillDefinition = {
  id: 'service.fingerprint',
  name: '服务指纹',
  guidance:
    '对已开放端口抓取 banner 与协议握手信息，判断服务版本与潜在已知漏洞。禁止在没有依据时猜测 CVE。',
};

export const SKILL_LINUX_AUDIT: SkillDefinition = {
  id: 'linux.audit',
  name: 'Linux 主机审计',
  guidance: [
    '在已有且可追溯的授权访问凭据或远程会话前提下，审计系统信息、权限配置与常见权限风险。所有结论必须来自命令输出证据。',
    '命令工具运行位置由 MCP 服务决定，不代表已进入靶机。必须使用工具真实 Schema 中的远程连接/会话能力并核对目标身份；没有目标访问依据时记录阻塞，不在 MCP 执行机上冒充靶机审计，不编造凭据或会话。',
    '命令及利用工具须等待人工审批，批准前没有执行结果。批准后以新证据安排独立 verification，不以审计推断或旧权限输出宣称提权成功。',
  ].join('\n'),
};

export const SKILL_VULN_ANALYSIS: SkillDefinition = {
  id: 'vuln.analysis',
  name: '漏洞分析',
  guidance:
    '把服务版本与技术栈映射到已知漏洞，建立攻击假设。只有在存在可靠版本依据时才引用 CVE/CWE，否则标记为推断。',
};

export const SKILL_VERIFY: SkillDefinition = {
  id: 'vuln.verify',
  name: '漏洞验证',
  guidance: [
    '对假设做最小影响验证，只执行可回退的探测。成功验证必须保存请求与响应证据；有明确反证时才可 refuted。超时、工具错误、权限不足或证据不足均为 inconclusive，不能据此排除漏洞。',
    '命令或会话工具必须核对实际执行位置和靶机身份；MCP 执行机的本地权限输出不能证明靶机权限。缺少可追溯的目标访问依据时保持 inconclusive，不能编造远程会话。人工批准前不得声称已经执行。',
  ].join('\n'),
};

export const WORKER_PROFILES: Record<WorkerProfileId, WorkerProfile> = {
  recon: {
    id: 'recon',
    name: '侦察 Worker',
    role: 'explore',
    // 基于 blhackbox HexStrike / Kali 的真实工具名
    toolPatterns: [
      'nmap_scan',
      'nmap_advanced_scan',
      'httpx_probe',
      'list_available_tools',
    ],
    skills: [SKILL_RECON, SKILL_NETWORK_MAP, SKILL_TOOL_DISCIPLINE],
    expectedEvidence: ['端口扫描输出', '主机存活结果'],
    tokenBudgetShare: 0.25,
    timeoutSeconds: 600,
    promptVersion: 'recon.v4',
  },
  web: {
    id: 'web',
    name: 'Web 探测 Worker',
    role: 'explore',
    toolPatterns: [
      'gobuster_scan',
      'ffuf_scan',
      'dirb_scan',
      'dirsearch_scan',
      'feroxbuster_scan',
      'nikto_scan',
      'httpx_probe',
      'wpscan_analyze',
      'whatweb*',
      'wafw00f_scan',
      'http_repeater',
      'http_intruder',
    ],
    skills: [SKILL_WEB_ENUM, SKILL_WEB_AUDIT, SKILL_TOOL_DISCIPLINE],
    expectedEvidence: ['HTTP 响应体', '目录枚举结果'],
    tokenBudgetShare: 0.25,
    timeoutSeconds: 600,
    promptVersion: 'web.v4',
  },
  service: {
    id: 'service',
    name: '服务分析 Worker',
    role: 'explore',
    toolPatterns: [
      'nmap_advanced_scan',
      'enum4linux_scan',
      'enum4linux_ng_advanced',
      'smbmap_scan',
      'rpcclient_enumeration',
      'nbtscan_netbios',
      'netexec_scan',
      'httpx_probe',
    ],
    skills: [SKILL_SERVICE_IDENT, SKILL_TOOL_DISCIPLINE],
    expectedEvidence: ['服务 banner', '协议握手信息'],
    tokenBudgetShare: 0.2,
    timeoutSeconds: 540,
    promptVersion: 'service.v4',
  },
  'linux-audit': {
    id: 'linux-audit',
    name: 'Linux 审计 Worker',
    role: 'verifier',
    toolPatterns: ['run_shell_command', 'run_kali_tool', 'msf_console_execute'],
    skills: [SKILL_LINUX_AUDIT, SKILL_TOOL_DISCIPLINE],
    expectedEvidence: ['系统命令输出', '权限配置清单'],
    tokenBudgetShare: 0.2,
    timeoutSeconds: 600,
    promptVersion: 'linux.v5',
  },
  'vuln-analysis': {
    id: 'vuln-analysis',
    name: '漏洞分析 Worker',
    role: 'analysis',
    toolPatterns: [
      'nuclei_scan',
      'search_exploits',
      'get_exploit_code',
      'vulnerability_intelligence_dashboard',
      'ai_vulnerability_assessment',
      'analyze_target_intelligence',
      'nmap_advanced_scan',
    ],
    skills: [SKILL_VULN_ANALYSIS, SKILL_TOOL_DISCIPLINE],
    expectedEvidence: ['版本比对结果', '漏洞库查询结果'],
    tokenBudgetShare: 0.2,
    timeoutSeconds: 540,
    promptVersion: 'vuln-analysis.v4',
  },
  verification: {
    id: 'verification',
    name: '漏洞验证 Worker',
    role: 'verifier',
    toolPatterns: [
      'nuclei_scan',
      'sqlmap_scan',
      'dalfox_xss_scan',
      'xsser_scan',
      'jaeles_vulnerability_scan',
      'msf_search',
      'msf_module_info',
      'search_exploits',
      'http_repeater',
      'run_shell_command',
      'run_kali_tool',
      'msf_console_execute',
      'msf_run_module',
    ],
    skills: [SKILL_VERIFY, SKILL_TOOL_DISCIPLINE],
    expectedEvidence: ['验证请求与响应', '漏洞可利用性说明'],
    tokenBudgetShare: 0.3,
    timeoutSeconds: 600,
    promptVersion: 'verification.v5',
  },
};

export function getProfile(id: WorkerProfileId): WorkerProfile {
  return WORKER_PROFILES[id];
}

export function listProfiles(): WorkerProfile[] {
  return Object.values(WORKER_PROFILES);
}

/** 通配符匹配（`*` 任意字符） */
export function matchPattern(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === name;
  const regex = new RegExp(
    `^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`,
    'i',
  );
  return regex.test(name);
}

/** 按档案工具模式从 MCP 目录中挑出候选工具 */
export function selectTools(profile: WorkerProfile, catalog: string[]): string[] {
  const selected: string[] = [];
  for (const pattern of profile.toolPatterns) {
    for (const tool of catalog) {
      if ((matchPattern(pattern, tool) || matchPattern(pattern, remoteToolName(tool))) && !selected.includes(tool)) selected.push(tool);
    }
  }
  return selected;
}
