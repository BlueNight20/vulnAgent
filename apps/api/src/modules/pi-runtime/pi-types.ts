/**
 * Pi SDK 的最小结构化类型定义（后端 CJS 无法直接 import ESM 类型入口，
 * 这里只声明用到的部分，字段与实际 .d.ts 保持一致，详见 docs/PI_SDK_VERIFIED_API.md）。
 */

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface PiTextContent {
  type: 'text';
  text: string;
}

export interface PiThinkingContent {
  type: 'thinking';
  thinking: string;
}

export interface PiToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type PiContentBlock = PiTextContent | PiThinkingContent | PiToolCallContent;

export interface PiUserMessage {
  role: 'user';
  /** Local receipt correlation; not an instruction or model-supplied identifier. */
  hintId?: string;
  content: string | PiContentBlock[];
  timestamp: number;
}

export interface PiAssistantMessage {
  role: 'assistant';
  content: PiContentBlock[];
  api: string;
  provider: string;
  model: string;
  usage: PiUsage;
  stopReason: 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred';
  errorMessage?: string;
  timestamp: number;
  durationMs?: number;
}

export interface PiToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: PiContentBlock[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
  durationMs?: number;
}

export interface PiSystemMessage {
  role: 'system';
  content: string;
  timestamp: number;
}

export type PiAgentMessage = PiSystemMessage | PiUserMessage | PiAssistantMessage | PiToolResultMessage;

export type PiAgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: PiAgentMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: PiAgentMessage; toolResults: PiToolResultMessage[] }
  | { type: 'message_start'; message: PiAgentMessage }
  | { type: 'message_update'; message: PiAgentMessage; assistantMessageEvent: unknown }
  | { type: 'message_end'; message: PiAgentMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      durationMs?: number;
    };

export interface PiToolResult {
  content: PiContentBlock[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (partial: unknown) => void,
  ) => Promise<PiToolResult>;
}

export interface PiAgentLike {
  state: {
    readonly systemPrompt: string;
    model: unknown;
    thinkingLevel: string;
    set tools(tools: PiToolDefinition[]);
    get tools(): PiToolDefinition[];
    set messages(messages: PiAgentMessage[]);
    get messages(): PiAgentMessage[];
    readonly isStreaming: boolean;
    readonly errorMessage?: string;
  };
  subscribe(listener: (event: PiAgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
  prompt(message: PiAgentMessage | PiAgentMessage[] | string): Promise<void>;
  continue(): Promise<void>;
  steer(message: PiAgentMessage): void;
  clearSteeringQueue(): void;
  abort(): void;
  waitForIdle(): Promise<void>;
  reset(): void;
}

export function extractText(message: PiAgentMessage): string {
  if (message.role === 'user') {
    if (typeof message.content === 'string') return message.content;
    return message.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();
  }
  if (message.role === 'system') return message.content;
  const blocks = message.content ?? [];
  return blocks
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'thinking') return `[思考] ${b.thinking}`;
      return `[工具调用] ${b.name}`;
    })
    .join('\n')
    .trim();
}

export function usageToNumbers(usage: PiUsage | undefined): { input: number; output: number; cost: number } {
  if (!usage) return { input: 0, output: 0, cost: 0 };
  return {
      input: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
    output: usage.output ?? 0,
    cost: usage.cost?.total ?? 0,
  };
}
