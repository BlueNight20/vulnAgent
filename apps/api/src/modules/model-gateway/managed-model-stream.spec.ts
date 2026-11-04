import { describe, expect, it, vi } from 'vitest';
import { managedModelStream } from './managed-model-stream';
function source<T>(result: Promise<T>) { return { result: () => result, [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }) }; }
describe('模型流本地收尾', () => {
  it('即使调用方只等待 result，也会结算并释放槽位', async () => {
    const finish = vi.fn(async () => {}); const release = vi.fn();
    const stream = managedModelStream(source(Promise.resolve({ usage: 5 })), new AbortController(), 1000, finish, release);
    expect(await stream.result()).toEqual({ usage: 5 }); expect(finish).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
  });
  it('上游忽略取消时，超时同时唤醒迭代器和结果等待；晚到结果不重复释放', async () => {
    let done!: (value: number) => void;
    const finish = vi.fn(async () => {}); const release = vi.fn(); const controller = new AbortController();
    const stream = managedModelStream(source(new Promise<number>((resolve) => { done = resolve; })), controller, 15, finish, release);
    const next = stream[Symbol.asyncIterator]().next();
    await Promise.all([expect(stream.result()).rejects.toThrow('用量未知'), expect(next).rejects.toThrow('用量未知')]);
    expect(controller.signal.aborted).toBe(true); expect(release).toHaveBeenCalledOnce();
    done(20); await new Promise((r) => setTimeout(r, 5));
    expect(finish).toHaveBeenCalledWith(20); expect(release).toHaveBeenCalledOnce();
  });
  it('外部取消不等待五分钟，不把未知结果当成未发送', async () => {
    const external = new AbortController(); const finish = vi.fn(async () => {}); const release = vi.fn();
    const stream = managedModelStream(source(new Promise(() => {})), new AbortController(), 300000, finish, release, external.signal);
    const result = stream.result(); external.abort();
    await expect(result).rejects.toThrow('取消'); expect(finish).toHaveBeenCalledWith(null, expect.stringContaining('取消')); expect(release).toHaveBeenCalledOnce();
  });
});
