import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TargetEntity, TaskEntity } from '../../database/entities';
import { checkScope, extractTargets, type ScopePolicy } from '../mcp/scope-guard';
import { ToolInvoker } from './tool-invoker';
import type { PreToolUseEvent, PreToolUseOutcome, ToolHook } from './tool-hooks';

/**
 * 这些工具必须携带明确目标，否则拒绝。
 * 缺目标就放行是一条常见绕过路径：工具会自己去找默认目标。
 */
const REQUIRES_TARGET_TOOLS = [
  '*scan*', 'nmap*', 'nikto*', 'gobuster*', 'ffuf*', 'dirb*', 'dirsearch*', 'feroxbuster*',
  'nuclei*', 'sqlmap*', 'httpx*', 'whatweb*', 'masscan*', 'rustscan*', 'enum4linux*',
  'smbmap*', 'rpcclient*', 'msf_run_module', 'msf_console_execute',
];

function matchesPattern(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(name);
}

/** 端口表达式展开；非法表达式返回空集合（不因此放行）。 */
function expandPorts(spec: string): Set<number> {
  const ports = new Set<number>();
  for (const part of spec.split(',')) {
    const text = part.trim();
    if (!/^\d{1,5}(?:-\d{1,5})?$/.test(text)) return new Set();
    const [from, to] = text.split('-').map(Number);
    const end = to ?? from;
    if (from < 1 || end > 65535 || end < from) return new Set();
    for (let port = from; port <= end; port++) ports.add(port);
  }
  return ports;
}

/**
 * 授权范围钩子（order = 10）。
 *
 * 目标来源以数据库为准：任务 targets（inScope）与 scope.cidrs。
 * 参数中只要出现一个越界目标即整体拒绝；像目标但无法确定的值也纳入校验。
 */
@Injectable()
export class ScopeGuardHook implements ToolHook, OnModuleInit {
  readonly name = 'scope-guard';
  readonly order = 10;
  private readonly logger = new Logger(ScopeGuardHook.name);

  constructor(
    @InjectRepository(TargetEntity) private readonly targets: Repository<TargetEntity>,
    @InjectRepository(TaskEntity) private readonly tasks: Repository<TaskEntity>,
    private readonly invoker: ToolInvoker,
  ) {}

  onModuleInit(): void {
    this.invoker.hooks.add(this);
  }

  async preToolUse(event: PreToolUseEvent): Promise<PreToolUseOutcome> {
    const extracted = extractTargets(event.input);
    if (!extracted.length) {
      if (REQUIRES_TARGET_TOOLS.some((pattern) => matchesPattern(pattern, event.toolName))) {
        return { action: 'block', message: `工具 ${event.toolName} 需要明确的目标，但参数中未识别到 IP / 域名 / 网段`, policy: true };
      }
      return { action: 'allow' };
    }
    const policy = await this.policy(event.taskId);
    const verdict = checkScope(extracted, policy);
    if (verdict.allow) {
      // 端口维度同样属于授权范围：任务限定了端口时，请求的端口必须被覆盖。
      const denied = this.deniedPorts(event.input, policy.allowedPorts);
      if (denied.length) {
        return { action: 'block', message: `端口不在本任务授权范围内：${denied.join(', ')}。授权端口 = ${policy.allowedPorts ?? '未限定'}`, policy: true };
      }
      return { action: 'allow' };
    }
    const list = verdict.violations.map((v) => `${v.raw}（识别为 ${v.kind}:${v.normalized}）`).join('、');
    const allowed = [...policy.allowedIps, ...policy.allowedCidrs, ...policy.allowedHostnames].join(', ') || '（空）';
    return { action: 'block', message: `目标不在本任务授权范围内：${list}。授权范围 = ${allowed}`, policy: true };
  }

  private async policy(taskId: string): Promise<ScopePolicy & { allowedPorts: string | null }> {
    const allowedIps = new Set<string>();
    const allowedCidrs = new Set<string>();
    const allowedHostnames = new Set<string>();
    let allowedPorts: string | null = null;
    if (taskId) {
      const [rows, task] = await Promise.all([
        this.targets.find({ where: { taskId, inScope: true } }),
        this.tasks.findOneBy({ id: taskId }),
      ]);
      for (const row of rows) {
        if (row.kind === 'cidr' || row.ip.includes('/')) allowedCidrs.add(row.ip);
        else allowedIps.add(row.ip);
        if (row.hostname) allowedHostnames.add(row.hostname.toLowerCase());
      }
      for (const cidr of task?.scope?.cidrs ?? []) allowedCidrs.add(cidr.trim());
      allowedPorts = task?.scope?.ports?.trim() || null;
    }
    return { allowedIps: [...allowedIps], allowedCidrs: [...allowedCidrs], allowedHostnames: [...allowedHostnames], allowedPorts };
  }

  /** 请求显式声明的端口是否全部被任务端口范围覆盖。 */
  private deniedPorts(input: Record<string, unknown>, allowed: string | null): number[] {
    if (!allowed) return [];
    const authorized = expandPorts(allowed);
    if (!authorized.size) return [];
    const requested = new Set<number>();
    const visit = (value: unknown, depth = 0) => {
      if (depth > 6 || value === null || value === undefined) return;
      if (typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          if (/^(?:body|data|headers|cookie|token|output|wordlist|wordlist_path)$/i.test(key)) continue;
          if (/^(?:port|ports|rport|target_port)$/i.test(key)) addPorts(entry);
          else visit(entry, depth + 1);
        }
        return;
      }
      if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return; }
      // URL 里的显式端口同样是请求端口。
      if (typeof value === 'string') {
        try {
          const url = new URL(value);
          if (url.port) requested.add(Number(url.port));
          else if (url.protocol === 'https:') requested.add(443);
          else if (url.protocol === 'http:') requested.add(80);
        } catch { /* 非 URL 文本忽略 */ }
      }
    };
    const addPorts = (entry: unknown) => {
      if (typeof entry === 'number' && Number.isInteger(entry)) { requested.add(entry); return; }
      if (typeof entry !== 'string') return;
      const spec = entry.trim() === '-' ? '1-65535' : entry.trim();
      if (!/^[\d,\-\s]+$/.test(spec)) return;
      for (const port of expandPorts(spec)) requested.add(port);
    };
    visit(input);
    return [...requested].filter((port) => !authorized.has(port)).sort((a, b) => a - b);
  }
}
