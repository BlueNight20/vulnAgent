import { describe, expect, it } from 'vitest';
import { normalizeStoredMessage, toPlainMessage } from './message-codec';
import type { PiAgentMessage } from './pi-types';

const assistant: PiAgentMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'hello' }],
  api: 'openai-completions',
  provider: 'vulnagent-openai',
  model: 'deepseek-chat',
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
  },
  stopReason: 'stop',
  timestamp: 1,
};

describe('消息持久化与恢复', () => {
  it('拍平后丢失原型但保留核心字段', () => {
    const plain = toPlainMessage(assistant);
    expect(plain.role).toBe('assistant');
    expect(plain.model).toBe('deepseek-chat');
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
  });

  it('正常对象可直接还原', () => {
    const restored = normalizeStoredMessage(toPlainMessage(assistant));
    expect(restored?.role).toBe('assistant');
    expect(restored?.content).toHaveLength(1);
  });

  it('修复被双重 JSON 编码的历史数据', () => {
    const doubleEncoded = JSON.stringify(JSON.stringify(toPlainMessage(assistant)));
    const restored = normalizeStoredMessage(doubleEncoded);
    expect(restored).not.toBeNull();
    expect(restored?.role).toBe('assistant');
    expect(restored?.model).toBe('deepseek-chat');
  });

  it('非法数据返回 null 而不是抛错', () => {
    expect(normalizeStoredMessage(null)).toBeNull();
    expect(normalizeStoredMessage('not-json')).toBeNull();
    expect(normalizeStoredMessage({ foo: 'bar' })).toBeNull();
  });

  it('保留 toolResult 的关联字段', () => {
    const toolResult: PiAgentMessage = {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'nmap_scan',
      content: [{ type: 'text', text: '80/tcp open' }],
      isError: false,
      timestamp: 2,
    };
    const restored = normalizeStoredMessage(toPlainMessage(toolResult));
    expect(restored?.role).toBe('toolResult');
    expect((restored as { toolName?: string }).toolName).toBe('nmap_scan');
  });
});
