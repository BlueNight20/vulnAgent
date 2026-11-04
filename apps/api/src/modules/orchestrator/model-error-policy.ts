/**
 * 模型错误分类策略（纯函数，无框架依赖）。
 *
 * 目的：区分「可恢复的上游故障」与「配置/鉴权错误」。
 * 只有可恢复故障才允许自动重试，否则会无限重试一个根本不可能成功的请求。
 */

/** 可恢复故障的信号词：网络瞬断、限流、上游 5xx */
const TRANSIENT_PATTERNS = [
  'connection error',
  'econnreset',
  'econnrefused',
  'econnaborted',
  'etimedout',
  'enotfound',
  'socket hang up',
  'fetch failed',
  'network error',
  'request timed out',
  'timeout',
  'rate limit',
  'too many requests',
  'overloaded',
  'temporarily unavailable',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'internal server error',
  'internal error',
];

/** 不可恢复故障：配置错误，重试无意义 */
const PERMANENT_PATTERNS = [
  '401',
  '403',
  'invalid api key',
  'unauthorized',
  'forbidden',
  'model not found',
  'does not exist',
  'context length',
  'maximum context',
  'insufficient balance',
  'quota exceeded',
];

/**
 * 上游 5xx 状态码（429 由限流信号词覆盖）。
 * 部分 OpenAI 兼容服务只回 `Internal server error` 而不带数字，因此还要匹配纯文本形式。
 */
const TRANSIENT_STATUS_RE = /\b(?:429|5\d{2})\b/;

/** 会话没有产出可解析回复、由运行时填入的占位错误。 */
const NO_REPLY_PATTERN = /未产生|没有(?:任何)?(?:回复|输出)|no reply|empty reply/i;

export function isTransientModelError(message: string): boolean {
  const text = (message ?? '').toLowerCase();
  if (!text) return false;
  if (PERMANENT_PATTERNS.some((pattern) => text.includes(pattern))) return false;
  if (NO_REPLY_PATTERN.test(text)) return true;
  if (TRANSIENT_PATTERNS.some((pattern) => text.includes(pattern))) return true;
  return TRANSIENT_STATUS_RE.test(text);
}

/** 只用于界面展示：把冗长的上游报文压缩成一句可读原因。 */
export function describeModelError(message: string): string {
  const text = (message ?? '').trim();
  if (!text) return '模型没有返回内容';
  const permanent = PERMANENT_PATTERNS.some((pattern) => text.toLowerCase().includes(pattern));
  // 不可恢复的鉴权/配额问题优先说明，其余按可恢复性归类，避免把配置错误说成“暂时不可用”。
  if (permanent) return `模型调用配置有误（${text.slice(0, 120)}）`;
  if (isTransientModelError(text)) return `模型服务暂时不可用（${text.slice(0, 120)}）`;
  return text.slice(0, 200);
}

/** Planner 重试上限 */
export const MAX_PLANNER_RETRIES = 3;
/** 重试基础退避（毫秒），按尝试次数线性增长 */
export const PLANNER_RETRY_DELAY_MS = 4000;

export function retryDelay(attempt: number): number {
  return PLANNER_RETRY_DELAY_MS * Math.max(1, attempt);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
