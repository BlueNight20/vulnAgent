import { describe, expect, it } from 'vitest';
import { validateToolInput } from './tool-input-validator';

describe('工具执行前参数校验', () => {
  const schema = {
    type: 'object', required: ['request_spec'], additionalProperties: false,
    properties: { request_spec: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } } },
  };
  it('报告缺失参数和嵌套参数', () => {
    expect(validateToolInput(schema, {})).toContain('/request_spec');
    expect(validateToolInput(schema, { request_spec: {} })).toContain('/url');
  });
  it('通过合法输入且不修改参数', () => {
    const args = { request_spec: { url: 'http://lab.test' } };
    const before = JSON.stringify(args);
    expect(validateToolInput(schema, args)).toBeNull();
    expect(JSON.stringify(args)).toBe(before);
  });
  it('拒绝错误类型及多余属性', () => {
    expect(validateToolInput(schema, { request_spec: 'GET' })).toContain('object');
    expect(validateToolInput(schema, { request_spec: { url: 'x' }, surprise: 1 })).toContain('additional');
  });
  it('支持 oneOf、范围、枚举和本地引用', () => {
    const declared = { type: 'object', properties: { port: { $ref: '#/$defs/port' } }, $defs: { port: { oneOf: [{ type: 'integer', minimum: 1, maximum: 65535 }, { enum: ['http'] }] } } };
    expect(validateToolInput(declared, { port: 80 })).toBeNull();
    expect(validateToolInput(declared, { port: 'http' })).toBeNull();
    expect(validateToolInput(declared, { port: 70000 })).not.toBeNull();
  });
  it('支持 2020-12 的 Schema', () => {
    expect(validateToolInput({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['target'] }, {})).toContain('target');
  });
  it('坏 Schema 返回可操作错误而不是抛异常', () => {
    expect(validateToolInput({ type: 'nonsense' }, {})).toContain('inputSchema 无效');
  });
});
