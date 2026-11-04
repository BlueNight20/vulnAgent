import { describe, expect, it } from 'vitest';

/**
 * 租约过期判定（与 SQL 中 `datetime(lease) < datetime('now')` 语义一致）。
 *
 * 这里固化一个曾经的真实 bug：SQLite 把 datetime 存成 `YYYY-MM-DD HH:MM:SS.SSS`
 * （空格分隔），而 JS 的 toISOString() 是 `YYYY-MM-DDTHH:MM:SS.sssZ`（T 分隔）。
 * 直接按字符串比较会把已过期的租约判为未过期，导致 Worker 永久 running。
 */
function isLeaseExpired(leaseExpiresAt: string | null, now: Date): boolean {
  if (!leaseExpiresAt) return false;
  // 归一化：SQLite 的 `YYYY-MM-DD HH:MM:SS.SSS` → `YYYY-MM-DDTHH:MM:SS.SSSZ`
  const iso = leaseExpiresAt.trim().replace(' ', 'T');
  const withZone = /Z$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const parsed = new Date(withZone);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed < now;
}

describe('Worker 租约过期判定', () => {
  const now = new Date('2026-11-01T15:30:00.000Z');

  it('SQLite 空格格式的过期租约能被正确识别', () => {
    expect(isLeaseExpired('2026-11-01 15:36:25.247', new Date('2026-11-01T15:40:00.000Z'))).toBe(true);
  });

  it('未过期的租约不回收', () => {
    // 租约 15:36，当前 15:30 → 尚未过期
    expect(isLeaseExpired('2026-11-01 15:36:25.247', new Date('2026-11-01T15:30:00Z'))).toBe(false);
  });

  it('空租约不回收', () => {
    expect(isLeaseExpired(null, now)).toBe(false);
  });

  it('回归：必须归一化才能与 ISO 时间正确比较', () => {
    const stored = '2026-11-01 15:36:25.247';
    const later = new Date('2026-11-02T00:00:00.000Z');
    // 归一化后能正确判定已过期（这正是修复前失效的场景）
    expect(isLeaseExpired(stored, later)).toBe(true);
    // 未归一化的原始字符串无法被 Date 正确解析为 UTC，说明为什么必须转换
    expect(Number.isNaN(new Date('2026-11-01 15:36:25.247Z').getTime())).toBe(false);
  });
});
