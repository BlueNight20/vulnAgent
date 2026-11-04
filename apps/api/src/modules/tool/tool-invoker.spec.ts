import { describe, expect, it, vi } from 'vitest';
import { buildTool, errorResult, textResult, type ToolContext } from './core-tool';
import { ToolRegistry } from './tool-registry';
import { ToolInvoker, type ToolExecutor } from './tool-invoker';
import { truncateOutput, TRUNCATED_MARK } from './tool-output';
import { encodeForModel } from './tool-result';
import { ToolHookChain, policyBlockMessage } from './tool-hooks';

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  taskId: 'task', sessionId: 'session', role: 'explore', allowedTools: [], authorizedTargets: [], evidenceIds: [], ...over,
});

function setup(tools = [buildTool({
  name: 'echo_tool',
  description: '回显参数',
  inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  exec: { kind: 'test' },
  run: async (input) => textResult(`echo:${String(input.text)}`),
})]) {
  const registry = new ToolRegistry();
  registry.registerAll(tools);
  const invoker = new ToolInvoker(registry);
  const executor: ToolExecutor = { kind: 'test', run: (tool, input, context) => tool.call(input, context) };
  invoker.registerExecutor(executor);
  return { registry, invoker };
}

describe('工具层契约', () => {
  it('默认更保守：未声明即非只读、不可并发', () => {
    const { registry } = setup();
    const tool = registry.get('echo_tool')!;
    expect(tool.isReadOnly({})).toBe(false);
    expect(tool.isConcurrencySafe({})).toBe(false);
  });

  it('只读工具默认可并发，写工具声明后仍可覆盖', () => {
    const read = buildTool({ name: 'a_read', description: 'x', readOnly: true, exec: { kind: 'test' }, run: async () => textResult('ok') });
    const write = buildTool({ name: 'a_write', description: 'x', exec: { kind: 'test' }, run: async () => textResult('ok') });
    expect(read.isReadOnly({})).toBe(true);
    expect(read.isConcurrencySafe({})).toBe(true);
    expect(write.isConcurrencySafe({})).toBe(false);
  });

  it('重复注册同名工具直接报错，不静默覆盖', () => {
    const registry = new ToolRegistry();
    const tool = buildTool({ name: 'dup', description: 'x', exec: { kind: 'test' }, run: async () => textResult('ok') });
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/重复注册/);
  });

  it('schema 出口把 prompt 合并进 description', () => {
    const registry = new ToolRegistry();
    registry.register(buildTool({ name: 'p', description: '基础说明', prompt: '补充说明', exec: { kind: 'test' }, run: async () => textResult('ok') }));
    expect(registry.schemas()[0]).toMatchObject({ name: 'p', description: '基础说明\n\n补充说明' });
  });

  it('deferred 工具默认不下发，解锁后可见', () => {
    const registry = new ToolRegistry();
    registry.register(buildTool({ name: 'hidden', description: 'x', exec: { kind: 'test' }, run: async () => textResult('ok') }), { deferred: true });
    expect(registry.schemas()).toHaveLength(0);
    expect(registry.deferredNames()).toEqual(['hidden']);
    registry.unlock('s1', 'hidden');
    expect(registry.schemas({ sessionKey: 's1' }).map((s) => s.name)).toEqual(['hidden']);
    expect(registry.schemas({ sessionKey: 'other' })).toHaveLength(0);
  });
});

describe('工具执行唯一入口', () => {
  it('未知工具与越权工具都编码成 isError 结果而不是抛异常', async () => {
    const { invoker } = setup();
    const missing = await invoker.invoke('nope', {}, ctx());
    expect(missing.result.isError).toBe(true);
    expect(missing.failureKind).toBe('unknown_tool');

    const denied = await invoker.invoke('echo_tool', { text: 'a' }, ctx({ allowedTools: ['other'] }));
    expect(denied.failureKind).toBe('blocked');
    expect(denied.encoded.text).toContain('平台管控');
  });

  it('参数不符合 schema 时不执行工具本身', async () => {
    const run = vi.fn(async () => textResult('should not run'));
    const { invoker } = setup([buildTool({ name: 'strict', description: 'x', inputSchema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } }, exec: { kind: 'test' }, run })]);
    const outcome = await invoker.invoke('strict', { n: 'not-a-number' }, ctx());
    expect(outcome.failureKind).toBe('invalid_input');
    expect(run).not.toHaveBeenCalled();
  });

  it('钩子可阻断、可改写入参，且阻断文案带平台框定', async () => {
    const seen: unknown[] = [];
    const { invoker } = setup([buildTool({ name: 'mut', description: 'x', exec: { kind: 'test' }, run: async (input) => { seen.push(input); return textResult('ok'); } })]);
    invoker.hooks.add({ name: 'rewrite', order: -10, preToolUse: async () => ({ action: 'allow', input: { text: '改写后' } }) });
    await invoker.invoke('mut', { text: '原始' }, ctx());
    expect(seen).toEqual([{ text: '改写后' }]);

    invoker.hooks.add({ name: 'blocker', order: -20, preToolUse: async () => ({ action: 'block', message: '危险命令', policy: true }) });
    const blocked = await invoker.invoke('mut', { text: 'x' }, ctx());
    expect(blocked.failureKind).toBe('blocked');
    expect(blocked.encoded.text).toContain('【平台管控');
    expect(blocked.encoded.text).toContain('危险命令');
    expect(blocked.blockReason).toBe('危险命令');
  });

  it('工具抛错转成 isError 结果，调用链不中断', async () => {
    const { invoker } = setup([buildTool({ name: 'boom', description: 'x', exec: { kind: 'test' }, run: async () => { throw new Error('内部崩溃'); } })]);
    const outcome = await invoker.invoke('boom', {}, ctx());
    expect(outcome.result.isError).toBe(true);
    expect(outcome.failureKind).toBe('error');
    expect(outcome.encoded.text).toContain('内部崩溃');
  });

  it('超时被识别为 timeout 而不是普通错误', async () => {
    const { invoker } = setup([buildTool({ name: 'slow', description: 'x', exec: { kind: 'test', timeoutMs: 20 }, run: () => new Promise(() => undefined) })]);
    const outcome = await invoker.invoke('slow', {}, ctx());
    expect(outcome.failureKind).toBe('timeout');
  });

  it('已取消的调用不会实际执行', async () => {
    const run = vi.fn(async () => textResult('ran'));
    const { invoker } = setup([buildTool({ name: 'c', description: 'x', exec: { kind: 'test' }, run })]);
    const controller = new AbortController();
    controller.abort();
    const outcome = await invoker.invoke('c', {}, ctx({ signal: controller.signal }));
    expect(outcome.failureKind).toBe('cancelled');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('输出编码', () => {
  it('超限时保留头尾并标记截断，重复截断幂等', () => {
    const big = 'a'.repeat(40_000);
    const once = truncateOutput(big);
    expect(once.truncated).toBe(true);
    expect(once.text).toContain(TRUNCATED_MARK);
    expect(once.text.length).toBeLessThan(big.length);
    expect(truncateOutput(once.text).truncated).toBe(false);
  });

  it('二进制附件只给元数据，不把字节塞进上下文', () => {
    const encoded = encodeForModel({
      content: [
        { type: 'text', text: '扫描完成' },
        { type: 'attachment', attachmentId: 'a1', filename: 'shot.png', mimeType: 'image/png', sizeBytes: 1024, sha256: 'abc' },
        { type: 'reference', name: 'doc', uri: 'https://example.com' },
      ],
      isError: false,
    });
    expect(encoded.text).toContain('shot.png');
    expect(encoded.text).toContain('不等于模型已读取');
    expect(encoded.text).toContain('尚未获取');
  });

  it('空输出有兜底文案', () => {
    expect(encodeForModel(errorResult('')).text).toBe('工具执行失败但没有返回原因。');
  });
});

describe('钩子链', () => {
  it('钩子抛错不阻断工具系统，按不干预处理并上报', async () => {
    const errors: string[] = [];
    const chain = new ToolHookChain((name) => errors.push(name));
    chain.add({ name: 'broken', preToolUse: async () => { throw new Error('hook 崩溃'); } });
    const outcome = await chain.runPre({ toolName: 't', input: {}, taskId: 'x', sessionId: null, role: 'explore' });
    expect(outcome.action).toBe('allow');
    expect(errors).toEqual(['broken']);
  });

  it('按 order 升序执行，首个 block 立即终止', async () => {
    const order: string[] = [];
    const chain = new ToolHookChain();
    chain.add({ name: 'b', order: 10, preToolUse: async () => { order.push('b'); return { action: 'allow' }; } });
    chain.add({ name: 'a', order: -10, preToolUse: async () => { order.push('a'); return { action: 'allow' }; } });
    chain.add({ name: 'z', order: 0, preToolUse: async () => { order.push('z'); return { action: 'block', message: 'stop' }; } });
    const outcome = await chain.runPre({ toolName: 't', input: {}, taskId: 'x', sessionId: null, role: 'explore' });
    expect(order).toEqual(['a', 'z']);
    expect(outcome.action).toBe('block');
  });

  it('平台管控文案明确不是目标防御', () => {
    expect(policyBlockMessage('越权')).toContain('非目标防御');
    expect(policyBlockMessage('越权')).toContain('请勿尝试绕过');
  });
});
