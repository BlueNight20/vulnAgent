/**
 * 输出上限（唯一保证点）。
 *
 * 与 artex 的 capOutput/Capture 思路等价（代码自写）：
 * - 所有工具输出都在这里统一截断，单个工具不需要各自记得截断；
 * - 超出上限时保留 head + tail，并注明被截断的字符数；
 * - 已带截断标记的文本不再二次截断（幂等），避免重复截断破坏可读结构。
 */

export const DEFAULT_OUTPUT_LIMIT = 30_000;
export const TRUNCATED_MARK = '[truncated]';

const HEAD_RATIO = 0.7;
const TAIL_RATIO = 0.3;

export interface TruncateResult {
  text: string;
  truncated: boolean;
  removed: number;
  /** 原始文本长度（截断前），用于证据完整性说明。 */
  fullLength?: number;
}

export function truncateOutput(text: string, limit = DEFAULT_OUTPUT_LIMIT): TruncateResult {
  if (text.length <= limit) return { text, truncated: false, removed: 0 };
  if (text.includes(TRUNCATED_MARK)) return { text, truncated: false, removed: 0 };
  const head = Math.floor(limit * HEAD_RATIO);
  const tail = Math.floor(limit * TAIL_RATIO);
  const removed = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n\n${TRUNCATED_MARK} 中间 ${removed} 个字符已截断；完整内容见证据原始记录。\n\n${text.slice(-tail)}`,
    truncated: true,
    removed,
  };
}
