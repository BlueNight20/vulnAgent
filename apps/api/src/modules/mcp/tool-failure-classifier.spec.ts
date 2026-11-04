import { describe, expect, it } from 'vitest';
import { classifyToolFailure, isCacheableSuccess } from './tool-failure-classifier';

describe('工具失败分类', () => {
  it('执行超时归为 exec_timeout 且可重试', () => {
    const result = classifyToolFailure({ error: 'Request timed out.' });
    expect(result.kind).toBe('exec_timeout');
    expect(result.retryable).toBe(true);
  });

  it('HexStrike 的 -32001 归为执行超时', () => {
    const result = classifyToolFailure({ error: 'MCP error -32001: Request timed out' });
    expect(result.kind).toBe('exec_timeout');
  });

  it('连接被拒绝归为 connection_failed', () => {
    const result = classifyToolFailure({ error: 'connect ECONNREFUSED 127.0.0.1:9006' });
    expect(result.kind).toBe('connection_failed');
    expect(result.retryable).toBe(true);
  });

  it('握手问题归为 handshake_failed', () => {
    const result = classifyToolFailure({ error: 'MCP 握手未完成：initialize failed' });
    expect(result.kind).toBe('handshake_failed');
  });

  it('服务端内部错误归为 server_error 且不可重试', () => {
    const result = classifyToolFailure({ error: 'MCP error -32603: internal error' });
    expect(result.kind).toBe('server_error');
    expect(result.retryable).toBe(false);
  });

  it('权限拒绝归为 permission_denied 且不可重试', () => {
    const result = classifyToolFailure({ error: null, denied: true });
    expect(result.kind).toBe('permission_denied');
    expect(result.retryable).toBe(false);
  });

  it('超出授权范围归为 unauthorised_target', () => {
    const result = classifyToolFailure({ error: null, outOfScope: true });
    expect(result.kind).toBe('unauthorised_target');
  });

  it('成功但空输出归为 empty_result', () => {
    const result = classifyToolFailure({ error: null, emptyOutput: true });
    expect(result.kind).toBe('empty_result');
  });

  it('未分类错误归为 unknown 且不可重试', () => {
    const result = classifyToolFailure({ error: 'something weird happened' });
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('优先级：授权范围 > 权限 > 超时', () => {
    const result = classifyToolFailure({
      error: 'Request timed out',
      denied: true,
      outOfScope: true,
    });
    expect(result.kind).toBe('unauthorised_target');
  });

  it('每种失败都给出可操作建议', () => {
    const kinds = [
      { error: 'timeout' },
      { error: 'ECONNREFUSED' },
      { error: null, denied: true },
      { error: null, emptyOutput: true },
    ];
    for (const input of kinds) {
      const result = classifyToolFailure(input);
      expect(result.suggestion.length).toBeGreaterThan(0);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('结果可缓存判定', () => {
  it('区分握手超时、执行超时、参数错误与用户取消', () => {
    expect(classifyToolFailure({ error: 'MCP 握手超时', phase: 'connect' }).kind).toBe('handshake_failed');
    expect(classifyToolFailure({ error: 'Request timed out', phase: 'execute' }).kind).toBe('exec_timeout');
    expect(classifyToolFailure({ error: 'unrecognized argument --wrong' }).kind).toBe('invalid_input');
    expect(classifyToolFailure({ error: 'aborted', cancelled: true })).toMatchObject({ kind: 'cancelled', retryable: false });
  });
  it('成功且有内容可缓存', () => {
    expect(isCacheableSuccess(true, '80/tcp open http')).toBe(true);
  });

  it('成功但空内容不可缓存', () => {
    expect(isCacheableSuccess(true, '')).toBe(false);
    expect(isCacheableSuccess(true, '   \n\t ')).toBe(false);
  });

  it('失败结果不可缓存', () => {
    expect(isCacheableSuccess(false, 'some output')).toBe(false);
  });
});
