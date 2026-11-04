/**
 * 从工具参数中提取探测目标 IP。
 * 抽成独立纯函数模块，便于单元测试且不引入 TypeORM 实体依赖。
 */
const TARGET_KEYS = ['target', 'ip', 'host', 'url', 'target_url', 'hostname', 'address', 'rhost'];

export function extractTargetIp(args: Record<string, unknown>): string | null {
  for (const key of Object.keys(args)) {
    if (!TARGET_KEYS.includes(key.toLowerCase())) continue;
    const value = args[key];
    if (typeof value !== 'string') continue;
    const match = value.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
    if (match) return match[1];
  }
  return null;
}

export function isDestructiveRisk(risk: string): boolean {
  return risk === 'destructive';
}
