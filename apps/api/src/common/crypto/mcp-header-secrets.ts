import type { AppConfig } from '../../config/configuration';
import { PersistentSecretCipher } from './persistent-secret-cipher';

export function configuredCipher(security?: AppConfig['security']): PersistentSecretCipher {
  return new PersistentSecretCipher(security?.encryptionKey ?? '', security?.encryptionKeyFile);
}
export function validateHeaders(value: unknown): Record<string, string> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP 请求头必须是字符串键值对象');
  const entries = Object.entries(value);
  if (entries.some(([key, val]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof val !== 'string' || /[\r\n\0]/.test(val))) throw new Error('MCP 请求头包含非法名称或值');
  return Object.fromEntries(entries);
}
export function readStoredHeaders(value: { headers?: Record<string, string> | null; headersEncrypted?: string | null }, security?: AppConfig['security']): Record<string, string> | null {
  if (value.headersEncrypted != null) {
    try {
      if (value.headers && Object.keys(value.headers).length) throw new Error('conflicting stored headers');
      return validateHeaders(JSON.parse(configuredCipher(security).decrypt(value.headersEncrypted)));
    } catch { throw new Error('MCP 请求头无法解密或配置冲突；请恢复原主密钥并检查配置，未发起远端请求'); }
  }
  return validateHeaders(value.headers);
}
export function redactHeaderValues(message: string, headers?: Record<string, string> | null): string {
  const secrets = Object.values(headers ?? {}).flatMap((v) => /^\s*(Bearer|Basic)\s+/i.test(v) ? [v, v.trim().split(/\s+/).slice(1).join(' ')] : [v]);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) message = message.split(secret).join('[已隐藏请求头]');
  return message;
}
