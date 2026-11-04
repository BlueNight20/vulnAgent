import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PersistentSecretCipher } from './persistent-secret-cipher';

let directory: string; let file: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'vulnagent-key-test-')); file = join(directory, 'db.key'); });
afterEach(() => {
  expect(dirname(resolve(directory))).toBe(resolve(tmpdir())); expect(basename(directory).startsWith('vulnagent-key-test-')).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});
describe('持久化加密主密钥', () => {
  it('首次保存创建完整密钥，新实例可解密且不会替换原文件', () => {
    const value = new PersistentSecretCipher('', file).encrypt('fixture-secret'); const key = readFileSync(file, 'utf8');
    expect(new PersistentSecretCipher('', file).decrypt(value)).toBe('fixture-secret');
    new PersistentSecretCipher('', file).encrypt('second'); expect(readFileSync(file, 'utf8')).toBe(key);
  });
  it('读取已有密文时缺失文件拒绝生成替代密钥', () => {
    const value = new PersistentSecretCipher(randomBytes(32).toString('base64')).encrypt('fixture-secret');
    expect(() => new PersistentSecretCipher('', file).decrypt(value)).toThrow(/恢复原密钥/); expect(existsSync(file)).toBe(false);
  });
  it('已有无效密钥保留原内容，不能静默重置', () => {
    writeFileSync(file, 'invalid key', { mode: 0o600 });
    expect(() => new PersistentSecretCipher('', file).encrypt('fixture')).toThrow(); expect(readFileSync(file, 'utf8')).toBe('invalid key');
  });
  it('环境主密钥优先，不创建本地文件；不同主密钥不能解密', () => {
    const key = randomBytes(32).toString('base64'); const value = new PersistentSecretCipher(key, file).encrypt('fixture');
    expect(existsSync(file)).toBe(false); expect(new PersistentSecretCipher(key, file).decrypt(value)).toBe('fixture');
    expect(() => new PersistentSecretCipher(randomBytes(32).toString('base64'), file).decrypt(value)).toThrow();
  });
  it('没有持久化配置时拒绝写入，不再退回临时密钥', () => {
    expect(() => new PersistentSecretCipher('').encrypt('fixture')).toThrow(/不能使用临时密钥/);
    expect(() => new PersistentSecretCipher(`${randomBytes(32).toString('base64')}!`).encrypt('fixture')).toThrow();
  });
});
