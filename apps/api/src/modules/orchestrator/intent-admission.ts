import type { IntentRejectReason } from '@vulnagent/shared';
import { checkScope, extractTargets } from '../mcp/scope-guard';

export interface AdmissionCandidate {
  id: string;
  title: string;
  objective?: string;
  dedupeKey: string;
  targetIp: string | null;
  suggestedTools: string[];
  dependencies: string[];
  status: string;
  prerequisites: string[];
}

export interface AdmissionContext {
  /** 任务授权范围内的 IP */
  authorizedIps: string[];
  authorizedCidrs?: string[];
  /** 任务授权范围内的域名（URL/域名目标解析出的 host） */
  authorizedHostnames?: string[];
  /** 已存在的 dedupeKey（含历史任务） */
  existingDedupeKeys: Set<string>;
  /** 已完成或已派发的 intentId */
  satisfiedIntentIds: Set<string>;
  /** 当前角色被允许的工具名（已展开权限矩阵后） */
  allowedTools: Set<string>;
  /** MCP 目录中真实存在的工具名 */
  catalogTools: Set<string>;
}

export interface AdmissionResult {
  accepted: AdmissionCandidate[];
  rejected: Array<{ intent: AdmissionCandidate; reason: IntentRejectReason; detail: string }>;
}

/**
 * 意图准入（确定性规则，纯函数）。
 * Planner 只提出方向，是否可执行由这里决定。
 */
export function admitIntents(candidates: AdmissionCandidate[], ctx: AdmissionContext): AdmissionResult {
  const accepted: AdmissionCandidate[] = [];
  const rejected: AdmissionResult['rejected'] = [];
  const seenKeys = new Set(ctx.existingDedupeKeys);

  for (const intent of candidates) {
    const work = `${intent.title} ${intent.objective ?? ''}`;
    const platform = /(?:本平台|平台镜像|编排模板|编排\/镜像|vulnagent|blhackbox|(?:本地|本机)\s*MCP\s*(?:服务端|server))/i;
    const maintenance = /(?:修改|修复|重建|固化|安装|升级|部署|rebuild|install|upgrade|modify)/i;
    if (platform.test(work) && maintenance.test(work)) {
      rejected.push({ intent, reason: 'platform_maintenance', detail: '平台维护不属于目标探索；应记录工具不可用原因并选择替代能力' });
      continue;
    }
    if (intent.status !== 'proposed') {
      rejected.push({ intent, reason: 'duplicate', detail: `状态为 ${intent.status}，不是待执行` });
      continue;
    }

    if (seenKeys.has(intent.dedupeKey)) {
      rejected.push({ intent, reason: 'duplicate', detail: `去重键 ${intent.dedupeKey} 已存在` });
      continue;
    }

    if (!intent.dedupeKey.trim()) {
      rejected.push({ intent, reason: 'duplicate', detail: '缺少去重键' });
      continue;
    }

    const targets = intent.targetIp ? extractTargets({ target: intent.targetIp }) : [];
    if (intent.targetIp && (!targets.length || !checkScope(targets, { allowedIps: ctx.authorizedIps, allowedCidrs: ctx.authorizedCidrs ?? [], allowedHostnames: ctx.authorizedHostnames ?? [] }).allow)) {
      rejected.push({
        intent,
        reason: 'out_of_scope',
        detail: `目标 ${intent.targetIp} 不在授权范围内`,
      });
      continue;
    }

    const missingTools = intent.suggestedTools.filter(
      (tool) => !ctx.allowedTools.has(tool) && !ctx.allowedTools.has('*'),
    );
    if (missingTools.length > 0) {
      rejected.push({
        intent,
        reason: 'tool_not_allowed',
        detail: `工具未授权：${missingTools.join(', ')}`,
      });
      continue;
    }

    const missingCatalog = intent.suggestedTools.filter((tool) => !ctx.catalogTools.has(tool));
    if (missingCatalog.length > 0) {
      const detail =
        ctx.catalogTools.size === 0
          ? `MCP 工具目录为空（未连接 blhackbox Gateway），无法执行：${missingCatalog.join(', ')}`
          : `工具不在 MCP 目录中：${missingCatalog.join(', ')}`;
      rejected.push({ intent, reason: 'tool_not_allowed', detail });
      continue;
    }

    const pendingDeps = intent.dependencies.filter((dep) => !ctx.satisfiedIntentIds.has(dep));
    if (pendingDeps.length > 0) {
      rejected.push({
        intent,
        reason: 'prerequisite',
        detail: `依赖未完成：${pendingDeps.join(', ')}`,
      });
      continue;
    }

    seenKeys.add(intent.dedupeKey);
    accepted.push(intent);
  }

  return { accepted, rejected };
}
