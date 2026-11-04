import { describe, expect, it } from 'vitest';
import { formatCost, formatDuration, formatNumber } from './utils';

describe('格式化工具', () => {
  it('大数字使用紧凑表示', () => {
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(12345)).toBe('12.3K');
    expect(formatNumber(2400000)).toBe('2.40M');
    expect(formatNumber(null)).toBe('0');
  });

  it('成本按量级保留小数位', () => {
    expect(formatCost(0.1234)).toBe('$0.1234');
    expect(formatCost(12.3456)).toBe('$12.35');
  });

  it('时长按毫秒/秒/分钟分级', () => {
    expect(formatDuration(120)).toBe('120ms');
    expect(formatDuration(2500)).toBe('2.5s');
    expect(formatDuration(125000)).toBe('2m 5s');
    expect(formatDuration(null)).toBe('—');
  });
});
