/** 同时限制 result() 与迭代器等待；上游忽略取消时也能收尾本地占用。 */
export function managedModelStream<T>(stream: { result(): Promise<T>; [Symbol.asyncIterator](): AsyncIterator<unknown> }, controller: AbortController, timeoutMs: number, finish: (message: T | null, reason?: string) => Promise<void>, release: () => void, sourceSignal?: AbortSignal) {
  let terminal = false; let stopping = false; let released = false; let timer: NodeJS.Timeout;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const cleanup = () => { clearTimeout(timer); sourceSignal?.removeEventListener('abort', onAbort); if (!released) { released = true; release(); } };
  const unknown = (reason: string) => {
    if (terminal || stopping) return;
    stopping = true; controller.abort();
    void finish(null, reason).finally(() => { cleanup(); rejectDeadline(new Error(reason)); }).catch(() => undefined);
  };
  const onAbort = () => unknown('模型请求已取消，供应商实际用量可能尚未返回');
  const actual = Promise.resolve().then(() => stream.result()).then(async (message) => {
    await finish(message); terminal = true; return message;
  }, async (error) => { await finish(null, error instanceof Error ? error.message : String(error)); terminal = true; throw error; }).finally(cleanup);
  timer = setTimeout(() => {
    unknown(`模型流超过 ${timeoutMs}ms 本地等待上限，实际用量未知`);
  }, timeoutMs);
  timer.unref?.();
  sourceSignal?.addEventListener('abort', onAbort, { once: true });
  if (sourceSignal?.aborted) void Promise.resolve().then(onAbort);
  const result = Promise.race([actual, deadline]);
  void result.catch(() => undefined);
  return {
    result: () => result,
    [Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();
      return {
        next: () => Promise.race([iterator.next(), deadline]),
        return: async () => { unknown('模型流消费者停止等待，保留未知用量额度'); if (iterator.return) void Promise.resolve(iterator.return()).catch(() => undefined); return { value: undefined, done: true as const }; },
      };
    },
  };
}
