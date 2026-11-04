import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

/**
 * AES-256-GCM 加密工具，用于把 API Key 等敏感配置落库。
 * 密文格式： v1:<ivB64>:<tagB64>:<cipherB64>
 */
export class SecretCipher {
  private readonly key: Buffer;
  private readonly ephemeral: boolean;

  constructor(base64Key: string, private readonly logger?: { warn: (msg: string) => void }) {
    if (base64Key) {
      const buf = Buffer.from(base64Key, 'base64');
      if (buf.length !== 32 || buf.toString('base64') !== base64Key) {
        throw new Error('VA_ENCRYPTION_KEY 解码后必须是 32 字节');
      }
      this.key = buf;
      this.ephemeral = false;
    } else {
      // 开发期允许缺失：生成临时密钥（重启后旧密文无法解密，并给出明确告警）
      this.key = randomBytes(32);
      this.ephemeral = true;
      this.logger?.warn(
        '未配置 VA_ENCRYPTION_KEY，已生成临时加密密钥；进程重启后已保存的密钥将无法解密。请在 .env 中配置固定密钥。',
      );
    }
  }

  get isEphemeral(): boolean {
    return this.ephemeral;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
  }

  decrypt(payload: string): string {
    const [version, ivB64, tagB64, dataB64] = payload.split(':');
    if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
      throw new Error('密文格式不受支持');
    }
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  }

  /** 用于展示的掩码，例如 sk-a****9f3c；过短的密钥只显示星号 */
  static mask(plain: string | null | undefined): string | null {
    if (!plain) return null;
    if (plain.length <= 8) return '********';
    return `${plain.slice(0, 4)}****${plain.slice(-4)}`;
  }
}
