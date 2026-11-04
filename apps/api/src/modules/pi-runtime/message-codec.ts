import type { PiAgentMessage } from './pi-types';

/**
 * Pi 消息与数据库存储之间的编解码（纯函数，无框架依赖，便于单测）。
 */

/** 把 Pi 消息拍平成纯 JSON：只保留自有可枚举字段，去掉原型上的内部引用 */
export function toPlainMessage(message: PiAgentMessage): Record<string, unknown> {
  return JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
}

/**
 * 兼容历史数据：早期版本出现过 messageJson 被序列化成字符串的双重编码，
 * 读取时最多尝试解析 3 层，避免恢复上下文拿到字符串而不是对象。
 */
export function normalizeStoredMessage(value: unknown): PiAgentMessage | null {
  if (value === null || value === undefined) return null;
  let current: unknown = value;
  for (let depth = 0; depth < 3 && typeof current === 'string'; depth += 1) {
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      return null;
    }
  }
  if (!current || typeof current !== 'object') return null;
  const candidate = current as { role?: unknown };
  return typeof candidate.role === 'string' ? (current as PiAgentMessage) : null;
}
