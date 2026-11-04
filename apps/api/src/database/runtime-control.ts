import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { SystemSettingEntity } from './entities';
export const RUNTIME_DISABLED = '执行引擎已关闭；请在系统设置中启用后，手动启动或恢复任务';
export async function runtimeEnabled(manager: EntityManager, fallback?: boolean): Promise<boolean> {
  const row = await manager.findOne(SystemSettingEntity, { where: { key: 'runtime.piRuntimeEnabled' } });
  if (row) return !row.encrypted && row.value === 'true';
  return fallback ?? ['true', '1', 'yes', 'on'].includes((process.env.PI_RUNTIME_ENABLED ?? 'false').toLowerCase());
}
export async function requireRuntime(manager: EntityManager, fallback?: boolean): Promise<void> {
  if (!await runtimeEnabled(manager, fallback)) throw new ConflictException(RUNTIME_DISABLED);
}

export async function workerConcurrency(manager: EntityManager): Promise<number> {
  const row = await manager.findOne(SystemSettingEntity, { where: { key: 'runtime.workerMaxConcurrency' } });
  const value = Number(row ? row.value : process.env.WORKER_MAX_CONCURRENCY ?? 2);
  if (row?.encrypted || !Number.isSafeInteger(value) || value < 1 || value > 8) throw new ServiceUnavailableException('Worker 全局并发配置无效，请在设置页保存 1～8 的整数');
  return value;
}
