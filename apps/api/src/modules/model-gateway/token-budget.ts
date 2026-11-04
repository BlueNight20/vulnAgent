export class TokenBudgetError extends Error {
  constructor(public readonly scope: 'task' | 'worker' | 'context', detail: string) { super(`Token 预算限制（${scope}）：${detail}`); }
}
export class TokenBudgetBusyError extends Error {}
export function waitForBudget(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new Error('等待模型预算时被取消')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, 100);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
/** 供应商无关的保守估算，包含协议余量；不是精确分词器或费用保证。 */
export function estimateInputTokens(context: unknown): number {
  const serialized = JSON.stringify(context);
  if (!serialized) throw new TokenBudgetError('context', '上下文不可序列化');
  return Math.ceil(Buffer.byteLength(serialized, 'utf8') / 2) + 512;
}
export function providerUsage(value: unknown): { input: number; output: number; cost: number } | null {
  const u = value as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } } | null;
  if (!u || ![u.input, u.output, u.cacheRead ?? 0, u.cacheWrite ?? 0].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null;
  const input = Math.ceil(u.input! + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
  const total = typeof u.totalTokens === 'number' && Number.isFinite(u.totalTokens) && u.totalTokens >= 0 ? Math.ceil(u.totalTokens) : input + Math.ceil(u.output!);
  const output = Math.max(Math.ceil(u.output!), total - input);
  if (input + output <= 0) return null; // 缺少 usage 的兼容服务不能被当作免费请求。
  const cost = typeof u.cost?.total === 'number' && Number.isFinite(u.cost.total) && u.cost.total >= 0 ? u.cost.total : 0;
  return { input, output, cost };
}
