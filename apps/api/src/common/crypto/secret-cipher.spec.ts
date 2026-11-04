import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SecretCipher } from './secret-cipher';

const key = randomBytes(32).toString('base64');

describe('SecretCipher', () => {
  it('加密后可以解密还原原文', () => {
    const cipher = new SecretCipher(key);
    const encrypted = cipher.encrypt('sk-1234567890abcdef');
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted).not.toContain('1234567890');
    expect(cipher.decrypt(encrypted)).toBe('sk-1234567890abcdef');
  });

  it('每次加密产生不同密文（随机 IV）', () => {
    const cipher = new SecretCipher(key);
    expect(cipher.encrypt('same-value')).not.toBe(cipher.encrypt('same-value'));
  });

  it('篡改密文后解密失败', () => {
    const cipher = new SecretCipher(key);
    const encrypted = cipher.encrypt('secret');
    const parts = encrypted.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => cipher.decrypt(parts.join(':'))).toThrow();
  });

  it('密钥长度不合法时构造失败', () => {
    expect(() => new SecretCipher(Buffer.from('short').toString('base64'))).toThrow();
  });

  it('缺少密钥时生成临时密钥并告警', () => {
    const warn = vi.fn();
    const cipher = new SecretCipher('', { warn });
    expect(cipher.isEphemeral).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('掩码只暴露首尾四位', () => {
    expect(SecretCipher.mask('sk-abcdefghijklmn9f3c')).toBe('sk-a****9f3c');
    expect(SecretCipher.mask('short')).toBe('********');
    expect(SecretCipher.mask('')).toBeNull();
  });
});
