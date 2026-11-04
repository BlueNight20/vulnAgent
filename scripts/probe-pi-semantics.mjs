/**
 * 实测 Pi Agent SDK 的暂停/恢复语义与事件/usage 结构。
 * 使用本地假 streamFn（不访问网络），仅验证运行时行为。
 */
const { Agent } = await import('@earendil-works/pi-agent-core');
const { Type } = await import('@earendil-works/pi-ai');

const model = {
  id: 'probe-model',
  name: 'Probe',
  api: 'openai-completions',
  provider: 'probe',
  baseUrl: 'http://localhost:0/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

function makeUsage(input, output) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  };
}

/** 构造一个假的 AssistantMessageEventStream 兼容对象 */
function fakeStream(message, { delayMs = 0 } = {}) {
  const listeners = [];
  const final = message;
  const result = new Promise((resolve) => setTimeout(() => resolve(final), delayMs));
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: { ...final, content: [] } };
      yield { type: 'text_delta', delta: 'ok', contentIndex: 0 };
      yield { type: 'done', reason: final.stopReason, message: final };
    },
    result() {
      return result;
    },
    on(evt, cb) {
      listeners.push([evt, cb]);
    },
  };
  return stream;
}

let callCount = 0;
const streamFn = async (_model, context) => {
  callCount += 1;
  const toolCallSeen = context.messages.some(
    (m) => m.role === 'toolResult' || (Array.isArray(m.content) && m.content.some((c) => c.type === 'toolCall')),
  );
  if (!toolCallSeen) {
    return fakeStream({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'echo_target', arguments: { ip: '192.168.56.101' } }],
      api: 'openai-completions',
      provider: 'probe',
      model: 'probe-model',
      usage: makeUsage(10, 5),
      stopReason: 'toolUse',
      timestamp: Date.now(),
    });
  }
  return fakeStream(
    {
      role: 'assistant',
      content: [{ type: 'text', text: '已完成探测' }],
      api: 'openai-completions',
      provider: 'probe',
      model: 'probe-model',
      usage: makeUsage(20, 8),
      stopReason: 'stop',
      timestamp: Date.now(),
    },
    { delayMs: 30 },
  );
};

const events = [];
const agent = new Agent({
  initialState: { systemPrompt: '你是探测代理', model, tools: [] },
  streamFn,
  sessionId: 'probe-session',
  toolExecution: 'sequential',
});

agent.state.tools = [
  {
    name: 'echo_target',
    label: 'Echo',
    description: '回显目标',
    parameters: Type.Object({ ip: Type.String() }),
    execute: async (_id, params) => ({
      content: [{ type: 'text', text: `echo:${params.ip}` }],
      details: { ip: params.ip },
    }),
  },
];

agent.subscribe(async (event) => {
  events.push(event.type);
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    events.push(`usage:${event.message.usage?.input}/${event.message.usage?.output}`);
  }
});

console.log('=== 1. 首次 prompt（含工具调用） ===');
await agent.prompt('开始');
console.log('事件序列:', events.join(' -> '));
console.log('streamFn 调用次数:', callCount);
console.log('isStreaming:', agent.state.isStreaming);
console.log('messages 条数:', agent.state.messages.length, '角色:', agent.state.messages.map((m) => m.role).join(','));

console.log('\n=== 2. abort 在无进行中请求时的行为 ===');
agent.abort();
await agent.waitForIdle();
console.log('abort 后 isStreaming:', agent.state.isStreaming);

console.log('\n=== 3. continue() 在 assistant 末尾时的行为 ===');
events.length = 0;
try {
  await agent.continue();
  console.log('continue OK, 事件:', events.join(' -> '));
} catch (err) {
  console.log('continue 抛错:', err.message);
}

console.log('\n=== 4. 追加 user 消息后 continue() ===');
events.length = 0;
agent.state.messages = [
  ...agent.state.messages,
  { role: 'user', content: '继续探索', timestamp: Date.now() },
];
try {
  await agent.continue();
  console.log('continue OK, 事件:', events.join(' -> '));
} catch (err) {
  console.log('continue 抛错:', err.message);
}

console.log('\n=== 5. abort 中断进行中的 prompt ===');
const agent2 = new Agent({
  initialState: { systemPrompt: 'p', model, tools: [] },
  streamFn: async () => fakeStream({
    role: 'assistant',
    content: [{ type: 'text', text: 'slow' }],
    api: 'openai-completions',
    provider: 'probe',
    model: 'probe-model',
    usage: makeUsage(1, 1),
    stopReason: 'stop',
    timestamp: Date.now(),
  }, { delayMs: 300 }),
  sessionId: 'probe-2',
});
const t0 = Date.now();
const p = agent2.prompt('慢请求');
setTimeout(() => agent2.abort(), 50);
try {
  await p;
  console.log('prompt 在 abort 后 resolve，耗时', Date.now() - t0, 'ms');
} catch (err) {
  console.log('prompt 在 abort 后 reject:', err.message);
}
await agent2.waitForIdle();
console.log('agent2 isStreaming:', agent2.state.isStreaming, 'errorMessage:', agent2.state.errorMessage ?? '(none)');

console.log('\n=== 6. 通过 messages 恢复会话 ===');
const restored = new Agent({
  initialState: {
    systemPrompt: '你是探测代理',
    model,
    tools: [],
    messages: agent.state.messages.filter((m) => m.role !== 'system'),
  },
  streamFn,
  sessionId: 'probe-session',
});
console.log('恢复后 messages 条数:', restored.state.messages.length);
