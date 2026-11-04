import { describe, expect, it } from 'vitest';
import { describeModelError, isTransientModelError } from './model-error-policy';

describe('模型错误可恢复判定', () => {
  it('连接错误属于可恢复故障', () => {
    expect(isTransientModelError('Connection error.')).toBe(true);
  });

  it('请求超时属于可恢复故障', () => {
    expect(isTransientModelError('Request timed out.')).toBe(true);
  });

  it('限流属于可恢复故障', () => {
    expect(isTransientModelError('429 Too Many Requests')).toBe(true);
    expect(isTransientModelError('rate limit exceeded')).toBe(true);
  });

  it('上游 5xx 属于可恢复故障', () => {
    expect(isTransientModelError('503 Service Unavailable')).toBe(true);
    expect(isTransientModelError('502 bad gateway')).toBe(true);
  });

  it('连接被重置属于可恢复故障', () => {
    expect(isTransientModelError('socket hang up')).toBe(true);
    expect(isTransientModelError('ECONNRESET')).toBe(true);
  });

  it('鉴权失败不属于可恢复故障', () => {
    expect(isTransientModelError('401 Unauthorized')).toBe(false);
    expect(isTransientModelError('invalid api key')).toBe(false);
  });

  it('模型不存在不属于可恢复故障', () => {
    expect(isTransientModelError('model not found')).toBe(false);
  });

  it('无数字的上游 500 文案也属于可恢复故障', () => {
    // 实际故障：Planner 会话因模型返回 Internal server error 失败，但旧规则不含该文案，
    // 导致一次瞬时上游错误直接计入无进展轮次并停在「失败」。
    expect(isTransientModelError('Internal server error')).toBe(true);
    expect(isTransientModelError('500 Internal Server Error')).toBe(true);
    expect(isTransientModelError('OpenAI compatible upstream returned: Internal server error')).toBe(true);
  });

  it('余额与配额问题不属于可恢复故障，避免无意义重试', () => {
    expect(isTransientModelError('Insufficient Balance')).toBe(false);
    expect(isTransientModelError('403 Forbidden')).toBe(false);
  });

  it('失败原因压缩为界面可读句子', () => {
    expect(describeModelError('Internal server error')).toContain('暂时不可用');
    expect(describeModelError('invalid api key')).toContain('配置有误');
    expect(describeModelError('')).toBe('模型没有返回内容');
  });
});
