import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { configuredCipher, readStoredHeaders, redactHeaderValues, validateHeaders } from './mcp-header-secrets';
const security = { encryptionKey: randomBytes(32).toString('base64') };
describe('MCP 请求头密文', () => {
  it('恢复全部头部，未知自定义凭据也被加密', () => {
    const headers = { Authorization: 'Bearer fixture-token', 'X-Custom-Secret': 'custom-fixture' };
    const headersEncrypted = configuredCipher(security).encrypt(JSON.stringify(headers));
    expect(readStoredHeaders({ headers: null, headersEncrypted }, security)).toEqual(headers);
    expect(headersEncrypted).not.toContain('custom-fixture');
  });
  it('损坏密文或同时存在明文与密文时拒绝回退', () => {
    const headersEncrypted = configuredCipher(security).encrypt('{}');
    expect(() => readStoredHeaders({ headersEncrypted: 'corrupt' }, security)).toThrow(/未发起远端请求/);
    expect(() => readStoredHeaders({ headers: { token: 'plain' }, headersEncrypted }, security)).toThrow(/配置冲突/);
  });
  it('拒绝非字符串对象、非法名称和换行注入', () => {
    for (const value of [[], 'token', { Token: 42 }, { 'bad key': 'value' }, { Token: 'line\r\nvalue' }]) expect(() => validateHeaders(value)).toThrow();
  });
  it('错误脱敏包含 Bearer 凭据本体和自定义头值', () => {
    const text = redactHeaderValues('Bearer fixture-token and fixture-token custom-fixture', { Authorization: 'Bearer fixture-token', 'X-Custom': 'custom-fixture' });
    expect(text).not.toContain('fixture-token'); expect(text).not.toContain('custom-fixture');
  });
});
