import { describe, expect, it } from 'vitest';
import { extractTargetIp, isDestructiveRisk } from './tool-target';

describe('工具目标提取', () => {
  it('从 target 参数提取 IP', () => {
    expect(extractTargetIp({ target: '192.168.56.101' })).toBe('192.168.56.101');
  });

  it('从 URL 中提取 IP', () => {
    expect(extractTargetIp({ url: 'http://192.168.56.101:80/admin' })).toBe('192.168.56.101');
  });

  it('参数名大小写不敏感', () => {
    expect(extractTargetIp({ Target: '172.16.0.2' })).toBe('172.16.0.2');
  });

  it('无数值字段时返回 null', () => {
    expect(extractTargetIp({ ports: '1-1000', flag: '-sV' })).toBeNull();
  });

  it('非字符串值被忽略', () => {
    expect(extractTargetIp({ target: 123 })).toBeNull();
  });

  it('高风险等级判定', () => {
    expect(isDestructiveRisk('destructive')).toBe(true);
    expect(isDestructiveRisk('intrusive')).toBe(false);
    expect(isDestructiveRisk('safe')).toBe(false);
  });
});
