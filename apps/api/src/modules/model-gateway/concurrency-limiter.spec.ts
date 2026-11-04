import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter } from './concurrency-limiter';

describe('ConcurrencyLimiter', () => {
  it('不超过并发上限', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let peak = 0;
    let current = 0;

    const task = () =>
      limiter.run(async () => {
        current += 1;
        peak = Math.max(peak, current);
        await new Promise((r) => setTimeout(r, 20));
        current -= 1;
      });

    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
    expect(limiter.running).toBe(0);
  });

  it('释放槽位后排队任务继续执行', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        limiter.run(async () => {
          order.push(n);
          await new Promise((r) => setTimeout(r, 5));
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it('异常时仍释放槽位', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(limiter.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(limiter.running).toBe(0);
  });

  it('可以动态调整上限', async () => {
    const limiter = new ConcurrencyLimiter(1);
    limiter.setLimit(4);
    expect(limiter.max).toBe(4);
  });

  it('已取消的信号直接拒绝', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const controller = new AbortController();
    controller.abort();
    await expect(limiter.acquire(controller.signal)).rejects.toThrow();
  });
});
