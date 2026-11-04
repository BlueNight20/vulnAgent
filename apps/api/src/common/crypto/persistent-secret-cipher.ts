import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, fstatSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { SecretCipher } from './secret-cipher';

/** A missing key may be created for a new secret, never while reading existing ciphertext. */
export class PersistentSecretCipher {
  private cipher?: SecretCipher;
  readonly isEphemeral = false;
  constructor(private readonly configuredKey: string, private readonly keyFile?: string) {}

  encrypt(plain: string): string { return this.load(true).encrypt(plain); }
  decrypt(payload: string): string { return this.load(false).decrypt(payload); }

  private load(create: boolean): SecretCipher {
    if (this.cipher) return this.cipher;
    if (this.configuredKey) return this.cipher = new SecretCipher(this.configuredKey);
    if (!this.keyFile) throw new Error('请配置 VA_ENCRYPTION_KEY 或 VA_ENCRYPTION_KEY_FILE，不能使用临时密钥保存配置');
    const path = resolve(this.keyFile);
    let key: string;
    try { key = this.readKey(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) {
        throw new Error('加密主密钥文件缺失、不可读或不安全；请恢复原密钥，不要覆盖已有密文');
      }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      let fd: number | undefined;
      let created = false;
      try {
        fd = openSync(temporary, 'wx', 0o600); created = true;
        writeFileSync(fd, `${randomBytes(32).toString('base64')}\n`); fsyncSync(fd); closeSync(fd); fd = undefined;
        // Linking publishes a complete file atomically and never overwrites another process's key.
        try { linkSync(temporary, path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        key = this.readKey(path);
      } catch { throw new Error('无法安全创建加密主密钥文件；请检查目录权限或配置 VA_ENCRYPTION_KEY'); }
      finally { if (fd !== undefined) closeSync(fd); if (created) unlinkSync(temporary); }
    }
    return this.cipher = new SecretCipher(key);
  }

  private readKey(path: string): string {
    if (lstatSync(path).isSymbolicLink()) throw new Error('不允许使用符号链接密钥文件');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 128 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('不安全的密钥文件');
      return readFileSync(fd, 'utf8').trim();
    } finally { closeSync(fd); }
  }
}
