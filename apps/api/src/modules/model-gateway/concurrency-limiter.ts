/**
 * 简单信号量：限制同一时刻并发的模型请求数。
 * 默认上限 2，可通过配置动态调整。
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, Math.trunc(limit) || 1);
  }

  get running(): number {
    return this.active;
  }

  get pending(): number {
    return this.waiters.length;
  }

  get max(): number {
    return this.limit;
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.trunc(limit) || 1);
    this.drain();
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('请求已取消');
    if (this.active < this.limit) {
      this.active += 1;
      return this.makeRelease();
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const idx = this.waiters.indexOf(wake);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('等待并发槽位时被取消'));
      };
      // 唤醒时由 drain 直接把槽位"移交"给该等待者（active 已在 drain 中计数）
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (!next) break;
      // 槽位直接移交给等待者，避免释放与获取之间出现竞态
      this.active += 1;
      next();
    }
  }
}
