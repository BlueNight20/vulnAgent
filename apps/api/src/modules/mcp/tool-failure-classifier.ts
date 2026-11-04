import type { ToolFailureKind } from '@vulnagent/shared';

/**
 * 工具调用失败分类（纯函数）。
 *
 * 目的：把失败拆成可操作的原因，避免「探测失败」被误读为「目标状态」。
 *
 * | 类别 | 含义 | 是否可重试 | 能否推断目标状态 |
 * | --- | --- | --- | --- |
 * | handshake_failed | MCP 握手失败（服务未就绪/协议不兼容） | 是 | 否 |
 * | connection_failed | 连接被拒绝/网络不可达 | 是 | 否 |
 * | exec_timeout | 工具已开始执行但超时 | 是（缩小范围后） | 否 |
 * | server_error | 服务端返回错误（-32000 等） | 视情况 | 否 |
 * | permission_denied | 被策略/权限拒绝 | 否 | 否 |
 * | empty_result | 执行成功但无有效输出 | 否 | 否 |
 * | unauthorised_target | 目标不在授权范围 | 否 | 否 |
 */

export interface ClassifyFailureInput {
  /** 错误原文 */
  error: string | null;
  /** 是否为策略拒绝（decision=deny） */
  denied?: boolean;
  /** 是否为授权范围拒绝 */
  outOfScope?: boolean;
  /** 工具返回文本是否为空 */
  emptyOutput?: boolean;
  phase?: 'connect' | 'execute';
  cancelled?: boolean;
}

export interface FailureClassification {
  kind: ToolFailureKind;
  retryable: boolean;
  /** 一句话原因，可直接展示给用户 */
  reason: string;
  /** 建议的下一步动作 */
  suggestion: string;
}

const HANDSHAKE_PATTERNS = [
  '握手',
  'initialize',
  'protocol',
  'not initialized',
  'transport',
  'mcp 握手',
];

const CONNECTION_PATTERNS = [
  'econnrefused',
  'connection refused',
  'enotfound',
  'getaddrinfo',
  'network is unreachable',
  'no route to host',
  'connect timeout',
  'socket hang up',
  'econnreset',
];

const TIMEOUT_PATTERNS = [
  '-32001',
  'request timed out',
  'execution timeout',
  '工具执行超时',
  'timed out',
  'timeout',
];

const SERVER_ERROR_PATTERNS = ['-32000', '-32603', 'internal error', 'server error', 'exception', 'traceback'];

export function classifyToolFailure(input: ClassifyFailureInput): FailureClassification {
  if (input.cancelled) return { kind: 'cancelled', retryable: false, reason: '调用已取消', suggestion: '核实远程操作是否已停止；取消不能证明目标状态，不自动重放副作用不明的调用' };
  if (input.outOfScope) {
    return {
      kind: 'unauthorised_target',
      retryable: false,
      reason: '目标不在任务的授权范围内',
      suggestion: '检查任务 targets 与 scope.cidrs 配置，不要尝试绕过授权范围',
    };
  }

  if (input.denied) {
    return {
      kind: 'permission_denied',
      retryable: false,
      reason: '该工具被当前角色的权限策略拒绝',
      suggestion: '换用已授权的工具，或在 MCP 管理页调整权限矩阵',
    };
  }

  const text = (input.error ?? '').toLowerCase();
  if (/(?:invalid|unrecognized|unknown) (?:argument|option|parameter)|missing required|usage:/.test(text)) return { kind: 'invalid_input', retryable: true, reason: '工具参数无效或缺少必填值', suggestion: '按 inputSchema 和工具用法修正参数，不原样重复失败调用' };

  if ((input.phase === 'connect' || text.includes('握手超时')) && /timeout|timed out|超时|-32001/.test(text)) {
    return { kind: 'handshake_failed', retryable: true, reason: 'MCP 连接握手超时，尚未执行工具', suggestion: '检查 MCP 服务与连接配置；握手故障无需缩小目标端口范围' };
  }

  if (TIMEOUT_PATTERNS.some((p) => text.includes(p)) || text.includes('执行超时')) {
    return {
      kind: 'exec_timeout',
      retryable: true,
      reason: '工具执行超时，未在限定时间内返回结果',
      suggestion: '缩小扫描范围（减少端口、降低并发、去掉全量参数）后重试',
    };
  }

  if (CONNECTION_PATTERNS.some((p) => text.includes(p))) {
    return {
      kind: 'connection_failed',
      retryable: true,
      reason: '无法连接到 MCP 服务端点',
      suggestion: '确认对应 blhackbox 容器已启动且端口映射正确',
    };
  }

  if (HANDSHAKE_PATTERNS.some((p) => text.includes(p))) {
    return {
      kind: 'handshake_failed',
      retryable: true,
      reason: 'MCP 握手未完成，服务端可能尚未就绪',
      suggestion: '稍后重试；若持续失败请检查该服务健康状态',
    };
  }

  if (SERVER_ERROR_PATTERNS.some((p) => text.includes(p))) {
    return {
      kind: 'server_error',
      retryable: false,
      reason: 'MCP 服务端返回错误',
      suggestion: '查看该服务日志；连续出现时停止重试并上报阻塞',
    };
  }

  if (input.emptyOutput) {
    return {
      kind: 'empty_result',
      retryable: false,
      reason: '工具执行成功但未返回有效内容',
      suggestion: '检查工具参数是否正确（如目标、端口、字典路径）',
    };
  }

  if (text) {
    return {
      kind: 'unknown',
      retryable: false,
      reason: input.error ?? '未知错误',
      suggestion: '记录为阻塞，人工检查该工具与服务状态',
    };
  }

  return {
    kind: 'empty_result',
    retryable: false,
    reason: '工具执行未产生输出',
    suggestion: '确认参数正确后重试一次',
  };
}

/** 只有成功且非空的结果才允许被缓存复用 */
export function isCacheableSuccess(success: boolean, text: string): boolean {
  return success && text.trim().length > 0 && !/^\[(?:image|audio|binary|resource)\]$/i.test(text.trim());
}
