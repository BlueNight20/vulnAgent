import type { ToolRiskLevel } from '@vulnagent/shared';

/**
 * 工具层的唯一契约。
 *
 * 所有工具（内置、MCP、业务、自定义）都实现该接口，并在调用路径上只经过
 * ToolInvoker 一个入口。这样"参数校验 / 权限 / 拦截 / 截断 / 错误编码"只需实现一次。
 *
 * 设计取向来自对 artex 的观察（只借鉴设计，代码全部自写）：
 * 1) 默认更保守：未显式声明即视为「不可并发、需要审批、非只读」；
 * 2) schema 与执行解耦：schema 只描述"模型该传什么"，执行仍由代码决定；
 * 3) 失败不是异常，而是带 isError 的正常结果，保证 tool_use / tool_result 永远成对。
 */

/** 工具来源，决定前端分组与权限默认值。 */
export type ToolSource = 'builtin' | 'mcp' | 'business' | 'custom';

/** 工具执行规格：由各 Driver 自行解释。 */
export type ToolExecutorKind = 'mcp' | 'http' | 'shell' | 'internal';

export interface ToolExecSpec {
  kind: ToolExecutorKind;
  /** MCP：服务器 ID；internal：处理器键名 */
  handler?: string;
  serverId?: string;
  command?: string;
  url?: string;
  method?: string;
  timeoutMs?: number;
  /** 执行器私有信息（MCP 的远端工具名等），不进入模型上下文 */
  meta?: Record<string, unknown>;
}

/** 单次调用的执行上下文。 */
export interface ToolContext {
  taskId: string;
  sessionId: string | null;
  /** 调用方的 agent 角色（planner / explore / verification ...） */
  role: string;
  /** 本会话允许调用的工具名；空数组表示不做额外限制（仍受授权范围与权限矩阵约束） */
  allowedTools: string[];
  /** 已授权的目标（IP / 域名 / CIDR） */
  authorizedTargets: string[];
  /** 本轮证据 ID，供业务工具引用 */
  evidenceIds: string[];
  /** 取消信号，所有执行必须尊重 */
  signal?: AbortSignal;
  /** 语言模型侧的工具调用 ID */
  toolCallId?: string;
  /** 强制执行（验证流程不受去重复用影响） */
  forceRerun?: boolean;
  /**
   * 该调用已通过人工审批（重放入口设置）。
   * 审批钩子据此跳过重复排队，但范围与权限钩子仍然生效。
   */
  approvedReplay?: boolean;
  /** 进度回传，可多次调用 */
  emit?: (partial: ToolProgress) => void;
}

export interface ToolProgress {
  text?: string;
  percent?: number;
}

/** 工具产出的内容块。文本之外的二进制内容必须落到证据附件，模型只收到元数据。 */
export type ToolContentBlock =
  | { type: 'text'; text: string }
  | {
    type: 'attachment'; attachmentId: string; filename: string; mimeType: string; sizeBytes: number; sha256: string;
    /** 原始字节：只用于落库，编码给模型时会被剔除 */
    data: Buffer;
    sourceUri?: string | null;
  }
  | { type: 'reference'; name: string; uri: string };

/** 统一结果：绝不向调用方抛异常。 */
export interface ToolResult {
  content: ToolContentBlock[];
  isError: boolean;
  /** 供编排层附加信息（证据 ID、审批状态等），不进入模型上下文 */
  details?: Record<string, unknown>;
  /** 附带作为独立 user 消息注入的消息文本（例如需要立刻看到的提醒） */
  extraMessage?: string;
}

export interface CoreTool {
  /** 全局唯一的工具键，形如 `nmap_scan` / `mcp__blhackbox__nmap` */
  name(): string;
  description(): string;
  /** 追加到描述后的补充说明（参数语义、注意事项） */
  prompt?(): string;
  inputSchema(): Record<string, unknown>;
  source(): ToolSource;
  risk(): ToolRiskLevel;
  /** 只读工具可跳过审批；默认 false */
  isReadOnly(input: unknown): boolean;
  /** 并发安全工具可并行执行；默认 false */
  isConcurrencySafe(input: unknown): boolean;
  execSpec(): ToolExecSpec;
  /** 工具执行本体。抛出的异常会被执行器转成 isError 结果。 */
  call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** 工具定义参数：缺省值一律按最保守处理。 */
export interface ToolSpec {
  name: string;
  description: string;
  prompt?: string;
  inputSchema?: Record<string, unknown>;
  source?: ToolSource;
  risk?: ToolRiskLevel;
  readOnly?: boolean | ((input: unknown) => boolean);
  concurrencySafe?: boolean | ((input: unknown) => boolean);
  exec: ToolExecSpec;
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/** 工具产出的二进制附件：数据在调用方落库，模型只看到元数据。 */
export interface ToolAttachmentInput {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  data: Buffer;
  sourceUri?: string | null;
}

/**
 * 附件内容块：元数据给模型看，原始字节只给落库用（不进上下文）。
 * 两者必须在同一个块里，否则二进制证据会在编码时丢失。
 */
export function attachmentBlock(input: ToolAttachmentInput): ToolContentBlock {
  return {
    type: 'attachment',
    attachmentId: input.id,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    data: input.data,
    sourceUri: input.sourceUri ?? null,
  };
}

export function referenceBlock(input: { name: string; uri: string }): ToolContentBlock {
  return { type: 'reference', name: input.name, uri: input.uri };
}

export function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  const value = text.trim() ? text : '(no output)';
  return { content: [{ type: 'text', text: value }], isError: false, details };
}

export function errorResult(text: string, details?: Record<string, unknown>): ToolResult {
  const value = text.trim() ? text : '工具执行失败但没有返回原因。';
  return { content: [{ type: 'text', text: value }], isError: true, details };
}

class SpecTool implements CoreTool {
  constructor(private readonly spec: ToolSpec) {}

  name(): string { return this.spec.name; }
  description(): string { return this.spec.description; }
  prompt(): string { return this.spec.prompt ?? ''; }
  inputSchema(): Record<string, unknown> { return this.spec.inputSchema ?? { type: 'object', properties: {} }; }
  source(): ToolSource { return this.spec.source ?? 'builtin'; }
  risk(): ToolRiskLevel { return this.spec.risk ?? 'safe'; }
  execSpec(): ToolExecSpec { return this.spec.exec; }

  isReadOnly(input: unknown): boolean {
    const value = this.spec.readOnly;
    if (typeof value === 'function') return value(input);
    return value === true;
  }

  isConcurrencySafe(input: unknown): boolean {
    const value = this.spec.concurrencySafe;
    if (typeof value === 'function') return value(input);
    // 只读工具默认可以并行；写类工具默认排他。
    return value === true || (value === undefined && this.isReadOnly(input));
  }

  call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return this.spec.run(input, ctx);
  }
}

export function buildTool(spec: ToolSpec): CoreTool {
  if (!/^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(spec.name)) {
    throw new Error(`工具名不合法：${spec.name}（需以字母开头，仅含字母数字与 _ . : -）`);
  }
  return new SpecTool(spec);
}
