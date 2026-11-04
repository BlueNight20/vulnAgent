# Pi SDK 已核实 API

- 版本：`@earendil-works/pi-agent-core@1.4.0`、`@earendil-works/pi-ai@1.4.0`
- 核实来源：官方仓库 `earendil-works/pi`（`packages/agent/README.md`、`packages/ai/README.md`）+ 实际安装包 `node_modules` 的 `package.json` 导出字段
- 原则：与 README 冲突时以 `node_modules` 实际行为为准；本项目所有 Pi 调用均以本文档和 `pi-types.ts` 为依据

---

## 1. 模块加载方式（重要）

Pi SDK 是**纯 ESM 包**，本项目后端编译为 **CommonJS**。

- `@earendil-works/pi-ai` 的 `exports` 只有 `"."`（types + import），**没有 `require` 条件**
- 因此 CommonJS `require('@earendil-works/pi-ai')` 会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`
- TypeScript 会把 `import()` 静态降级为 `require()`

**解决方案**：`apps/api/src/modules/pi-runtime/esm-loader.ts`

```ts
const nativeImport = new Function('specifier', 'return import(specifier);');
```

用 `Function` 构造器保留原生动态 import 语义，绕过 TS 降级。

导出函数：

| 函数 | 返回 | 说明 |
| --- | --- | --- |
| `loadPiAi()` | `PiAiModule` | `createModels` / `createProvider` / `Type`（typebox） |
| `loadPiAgentCore()` | `{ Agent }` | Agent 构造函数 |
| `loadOpenAiCompletionsApi()` | `{ openAICompletionsApi }` | OpenAI 兼容 Chat Completions API 实现 |

> `@earendil-works/pi-ai/api/openai-completions.lazy` 是子路径，CommonJS 下无类型入口，必须走 `esm-loader`。

---

## 2. pi-ai

### 2.1 创建模型集合

```ts
const models = createModels();
models.setProvider(provider);
const model = models.getModel(providerId, modelId); // 同步，可能 undefined
```

### 2.2 OpenAI 兼容 Provider

```ts
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const provider = createProvider({
  id: 'vulnagent-openai',
  name: 'VulnAgent OpenAI Compatible',
  baseUrl: 'https://api.deepseek.com/v1',
  auth: { apiKey: { name: 'OpenAI 兼容', resolve: async () => undefined } },
  models: [providerModel],
  api: openAICompletionsApi(),
});
```

- **API Key 不放入 provider 对象**，而是通过请求级 `options.apiKey` 注入，避免密钥进入可序列化结构。
- `auth.apiKey.resolve` 返回 `undefined` 表示交给请求级 `apiKey` 提供。

### 2.3 Model 对象结构

```ts
{
  id: string;
  name: string;
  api: 'openai-completions';
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ['text'];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; // 每 token 单价
  contextWindow: number;
  maxTokens: number;
}
```

> `cost` 单位是**每 token**，不是每百万 token。本项目在 `model-catalog.ts` 里按每百万 token 配置，再除以 1e6。

### 2.4 调用

| 方法 | 说明 |
| --- | --- |
| `models.streamSimple(model, context, options)` | 返回异步可迭代流，Agent 通过 `streamFn` 使用 |
| `models.completeSimple(model, context, options)` | 一次性返回 `AssistantMessage`，用于连接测试 |

`context` 至少要含 `messages`：

```ts
{ messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] }
```

`options` 常用字段：`apiKey`、`maxTokens`、`temperature`、`signal`、`headers`。

### 2.5 AssistantMessage 与 usage

```ts
interface AssistantMessage {
  role: 'assistant';
  content: Array<{ type: 'text'; text: string } | { type: 'toolCall'; ... } | { type: 'thinking'; ... }>;
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred';
  errorMessage?: string;
  timestamp: number;
  durationMs?: number;
}
```

- **Token 与成本只从这里读取**：`usage.input` / `usage.output` / `usage.cost.total`（USD）
- 中止或错误时 `usage` 仍保留已产生部分

---

## 3. pi-agent-core

### 3.1 构造

```ts
const agent = new Agent({
  initialState: {
    systemPrompt: string,
    model: Model,
    thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    tools: AgentTool[],
    messages: AgentMessage[],
  },
  streamFn: (model, context, options) => Promise<stream> | stream, // 必需
  sessionId: string,
  getApiKey: async (provider) => string | undefined,
  toolExecution: 'parallel' | 'sequential',
  beforeToolCall?: async ({ toolCall, args, context }) => ({ block?, reason?, terminate? }),
  afterToolCall?: async ({ toolCall, result, isError, context }) => ({ details?, terminate? }),
  convertToLlm?, transformContext?, prepareRequest?, finishTurn?,
  steeringMode?: 'one-at-a-time' | 'all',
  followUpMode?: 'one-at-a-time' | 'all',
  thinkingBudgets?: { minimal, low, medium, high },
});
```

**没有 `createAgent`，没有独立 session 模块** —— 会话就是一个 `Agent` 实例 + `sessionId`。

### 3.2 事件

`agent.subscribe(async (event, signal) => {...})` 返回 `unsubscribe`。监听器按注册顺序 **await**。

| type | 关键字段 |
| --- | --- |
| `agent_start` | — |
| `agent_end` | `messages` |
| `turn_start` | — |
| `turn_end` | `message`, `toolResults` |
| `message_start` | `message` |
| `message_update` | `message`, `assistantMessageEvent`（`text_delta` 有 `delta`） |
| `message_end` | `message` ← **usage 在这里** |
| `tool_execution_start` | `toolCallId`, `toolName`, `args` |
| `tool_execution_update` | `toolCallId`, `toolName`, `partialResult` |
| `tool_execution_end` | `toolCallId`, `toolName`, `result`, `isError` |

### 3.3 方法

| 方法 | 说明 |
| --- | --- |
| `await agent.prompt(message \| string)` | 发送消息并运行 |
| `await agent.continue()` | 从现有上下文续跑 |
| `agent.steer(msg)` / `agent.followUp(msg)` | 队列注入 |
| `agent.clearSteeringQueue()` | 清空尚未被 SDK 接收的定向提示队列；暂停中止并等待空闲后使用 |
| `agent.abort()` | 中止当前运行 |
| `await agent.waitForIdle()` | 等待完全 settle |
| `agent.reset()` | 清空 |
| `agent.state.messages` | 可读写（赋值会复制顶层数组） |

### 3.4 AgentTool

```ts
{
  name: string;
  label: string;
  description: string;
  parameters: Type.Object({ ... }),   // typebox
  executionMode?: 'sequential';
  execute: async (toolCallId, params, signal, onUpdate) => ({
    content: [{ type: 'text', text: string }],
    details?: unknown,
    terminate?: boolean,
  }),
}
```

- 工具失败必须 **throw**，不要用 content 返回错误
- `parameters` 来自 `pi-ai` 导出的 `Type`（typebox），不是 zod

---

## 4. 暂停 / 恢复语义（实测结论）

2026-11-03 补充：实际安装包 agent.js / agent-loop.js 中，steer 同步入队，循环在轮次边界取出后依次 await message_start / message_end，再将消息放入上下文。活动流不能调用 prompt，否则会抛出 already processing。当前定向提示据此在 message_end 保存消息及消费状态，真实 SDK/固定回环模型的下一次请求已验证；暂停清理未接收队列，明确恢复时重新读取 pending。仅入队不算消费。详见 HINT_DELIVERY.md。

| 场景 | 行为 | 本项目实现 |
| --- | --- | --- |
| 运行中 `abort()` | 当前 turn 取消，`stopReason='aborted'`，已产生 usage 保留 | `SessionManager.pause()`：`abort()` → `waitForIdle()` → 状态置 `paused` |
| 暂停后 `continue()` | **末尾是 assistant 消息时 `continue()` 会拒绝** | `resume()` 先追加一条 user 消息（"继续执行你的任务…"）再 `continue()` |
| 恢复后状态 | `isStreaming` 直到 `agent_end` 订阅者完成才为 false | `pause()` 中 `await waitForIdle()` 保证落库完成 |
| 进程重启后恢复 | 内存中的 Agent 实例不存在 | `reconcile()` 把遗留 `running` 标记为 `failed`；新建会话时从 `agent_session_messages.messageJson` 重建 `initialState.messages` |
| 终止 | `abort()` → `waitForIdle()` → `unsubscribe()` → 移除实例 | `SessionManager.terminate()` |

> **关键结论**：`continue()` 不能直接用于「assistant 结尾」的会话，必须补一条 user 消息。这一条已写入 `SessionManagerService.resume()` 并注释。

---

## 5. 与 README 的差异

| 项 | README | 实际（已按实际实现） |
| --- | --- | --- |
| CommonJS 支持 | 未说明 | 不支持，必须用原生 ESM 动态 import |
| `model.cost` 单位 | 未说明 | 每 token，需要 /1e6 |
| agent 事件中的 usage | 未说明位置 | 只在 assistant `message_end.message.usage` |
| `continue()` 前置条件 | 提到「assistant 尾巴不能直接发送」 | 实测确实会拒绝，需补 user 消息 |
| `Type` 来源 | 示例从 typebox 导入 | `pi-ai` 也导出 `Type`，本项目统一从 `pi-ai` 取，避免额外依赖 |
