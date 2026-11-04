import {
  Activity,
  Bug,
  ClipboardList,
  FileText,
  FolderSearch,
  Gauge,
  LayoutGrid,
  ListChecks,
  Plug,
  Settings,
  ShieldAlert,
  Terminal,
  Workflow,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  key: string;
  label: string;
  path: string;
  icon: LucideIcon;
  /** 第一阶段是否已实现（false 表示占位页） */
  implemented: boolean;
}

export interface NavGroup {
  key: string;
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'workbench',
    label: '工作台',
    items: [
      { key: 'dashboard', label: '仪表盘', path: '/dashboard', icon: Gauge, implemented: true },
      { key: 'tasks', label: '任务中心', path: '/tasks', icon: ListChecks, implemented: true },
    ],
  },
  {
    key: 'agent',
    label: '智能体控制',
    items: [
      { key: 'workflow', label: '工作流', path: '/workflow', icon: Workflow, implemented: true },
      { key: 'agents', label: '智能体工作台', path: '/agents', icon: LayoutGrid, implemented: true },
    ],
  },
  {
    key: 'security',
    label: '安全分析',
    items: [
      {
        key: 'attack-surface',
        label: '攻击面分析',
        path: '/attack-surface',
        icon: FolderSearch,
        implemented: true,
      },
      { key: 'vulnerabilities', label: '漏洞发现', path: '/vulnerabilities', icon: Bug, implemented: true },
      { key: 'evidence', label: '证据管理', path: '/evidence', icon: Activity, implemented: true },
      { key: 'reports', label: '报告中心', path: '/reports', icon: FileText, implemented: true },
    ],
  },
  {
    key: 'tool',
    label: '工具与策略',
    items: [
      { key: 'tools', label: '工具', path: '/tools', icon: Wrench, implemented: true },
      { key: 'mcp', label: 'MCP', path: '/mcp', icon: Plug, implemented: true },
      { key: 'commands', label: '工具执行', path: '/commands', icon: Terminal, implemented: true },
      { key: 'intercept', label: '拦截规则', path: '/intercept', icon: ShieldAlert, implemented: true },
    ],
  },
  {
    key: 'system',
    label: '系统管理',
    items: [
      { key: 'settings', label: '系统设置', path: '/settings', icon: Settings, implemented: true },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export function findNavByPath(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => pathname.startsWith(item.path));
}
