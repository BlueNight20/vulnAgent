import { describe, expect, it } from 'vitest';
import { isValidCidr, isValidIPv4, isValidPortSpec } from './validation';

describe('端口范围校验', () => {
  it('单端口合法', () => {
    expect(isValidPortSpec('80')).toBe(true);
    expect(isValidPortSpec('8080')).toBe(true);
  });

  it('逗号分隔的多个端口合法', () => {
    expect(isValidPortSpec('80,443')).toBe(true);
    expect(isValidPortSpec('80,443,445,8080')).toBe(true);
    expect(isValidPortSpec('22, 80, 443')).toBe(true);
  });

  it('范围合法', () => {
    expect(isValidPortSpec('1-1000')).toBe(true);
    expect(isValidPortSpec('80,443,8000-8080')).toBe(true);
  });

  it('空值视为合法（表示不限）', () => {
    expect(isValidPortSpec('')).toBe(true);
    expect(isValidPortSpec('   ')).toBe(true);
  });

  it('越界端口非法', () => {
    expect(isValidPortSpec('0')).toBe(false);
    expect(isValidPortSpec('65536')).toBe(false);
    expect(isValidPortSpec('100-50')).toBe(false);
  });

  it('非数字内容非法', () => {
    expect(isValidPortSpec('abc')).toBe(false);
    expect(isValidPortSpec('80;443')).toBe(false);
    expect(isValidPortSpec('80-')).toBe(false);
  });
});

describe('IP 与 CIDR 校验', () => {
  it('合法 IPv4', () => {
    expect(isValidIPv4('192.168.56.101')).toBe(true);
    expect(isValidIPv4('10.0.0.1')).toBe(true);
  });

  it('非法 IPv4', () => {
    expect(isValidIPv4('256.1.1.1')).toBe(false);
    expect(isValidIPv4('192.168.56')).toBe(false);
  });

  it('合法 CIDR', () => {
    expect(isValidCidr('192.168.56.0/24')).toBe(true);
    expect(isValidCidr('10.0.0.0/8')).toBe(true);
  });

  it('非法 CIDR', () => {
    expect(isValidCidr('192.168.56.0/33')).toBe(false);
    expect(isValidCidr('192.168.56.0')).toBe(false);
  });
});
