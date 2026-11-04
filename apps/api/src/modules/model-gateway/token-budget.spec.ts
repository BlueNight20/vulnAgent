import { describe, expect, it } from 'vitest';
import { estimateInputTokens, providerUsage } from './token-budget';
describe('模型预算输入和供应商用量', () => {
  it('计入缓存读写，供应商总数多出的部分也不丢弃', () => {
    expect(providerUsage({ input: 50, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 120, cost: { total: 0.01 } })).toEqual({ input: 90, output: 30, cost: 0.01 });
  });
  it('缺失、零用量、负数或非有限数字保持未知，不能释放成免费额度', () => {
    for (const u of [null, {}, { input: 0, output: 0 }, { input: -1, output: 3 }, { input: Infinity, output: 4 }, { input: NaN, output: 1 }]) expect(providerUsage(u)).toBeNull();
  });
  it('输入估算覆盖 Unicode 和协议余量，拒绝不可序列化上下文', () => {
    expect(estimateInputTokens({ messages: ['中文'.repeat(100)] })).toBeGreaterThan(estimateInputTokens({ messages: ['ab'.repeat(100)] }));
    expect(estimateInputTokens({ messages: [] })).toBeGreaterThan(0);
    const circular: { value?: unknown } = {}; circular.value = circular;
    expect(() => estimateInputTokens(circular)).toThrow();
  });
});
