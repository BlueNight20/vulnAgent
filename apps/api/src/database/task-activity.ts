import type { EntityManager } from 'typeorm';

const active = new WeakMap<object, Map<string, number>>();
export function hasTaskActivity(manager: EntityManager, taskId: string): boolean {
  return (active.get(manager.connection)?.get(taskId) ?? 0) > 0;
}
/** 同一数据源内所有执行器实例共享计数，覆盖尚未写调用记录的在途请求。 */
export async function trackTaskActivity<T>(manager: EntityManager, taskId: string | null, work: () => Promise<T>): Promise<T> {
  if (!taskId) return work();
  let counts = active.get(manager.connection);
  if (!counts) { counts = new Map(); active.set(manager.connection, counts); }
  counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
  try { return await work(); }
  finally {
    const remaining = (counts.get(taskId) ?? 1) - 1;
    if (remaining) counts.set(taskId, remaining); else counts.delete(taskId);
  }
}
