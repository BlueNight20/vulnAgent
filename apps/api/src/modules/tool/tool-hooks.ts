/**
 * 工具调用前后钩子。
 *
 * 与 artex 的 hook 契约等价（代码自写）：
 * - PreToolUse 可以 `block`（阻断并把原因回填模型）、可以 `rewrite`（改写入参）、可以 `annotate`（附加提示）；
 * - PostToolUse 只能观察，不能改写已经产生的证据；
 * - 任何一个 hook 抛错都视为该 hook 失败：默认放行并记录，避免拦截器自身故障把工具系统整体打死。
 */

export interface PreToolUseEvent {
  toolName: string;
  input: Record<string, unknown>;
  taskId: string;
  sessionId: string | null;
  role: string;
  /** 已通过人工审批的重放：审批钩子跳过排队，范围与权限照常校验。 */
  approvedReplay?: boolean;
}

export type PreToolUseOutcome =
  | { action: 'allow'; input?: Record<string, unknown>; note?: string }
  | { action: 'block'; message: string; /** 是否算作"平台管控"而非工具失败 */ policy?: boolean };

export interface PostToolUseEvent extends PreToolUseEvent {
  isError: boolean;
  outputText: string;
  durationMs: number;
}

export interface ToolHook {
  name: string;
  /** 数值越小越先执行；平台拦截应放在最前（负数）。 */
  order?: number;
  preToolUse?(event: PreToolUseEvent): Promise<PreToolUseOutcome> | PreToolUseOutcome;
  postToolUse?(event: PostToolUseEvent): Promise<void> | void;
}

export class ToolHookChain {
  private readonly hooks: ToolHook[] = [];

  constructor(private readonly onHookError?: (hook: string, error: unknown) => void) {}

  add(hook: ToolHook): this {
    this.hooks.push(hook);
    this.hooks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return this;
  }

  async runPre(event: PreToolUseEvent): Promise<PreToolUseOutcome> {
    let input = event.input;
    const notes: string[] = [];
    for (const hook of this.hooks) {
      if (!hook.preToolUse) continue;
      let outcome: PreToolUseOutcome;
      try {
        outcome = await hook.preToolUse({ ...event, input });
      } catch (error) {
        // 拦截器故障不能放行危险调用，也不能阻断全部工具：记录后按"不干预"处理，
        // 由后续的平台校验（授权范围、权限矩阵）继续兜底。
        this.onHookError?.(hook.name, error);
        continue;
      }
      if (outcome.action === 'block') return outcome;
      if (outcome.input) input = outcome.input;
      if (outcome.note) notes.push(outcome.note);
    }
    return { action: 'allow', input, note: notes.length ? notes.join('\n') : undefined };
  }

  async runPost(event: PostToolUseEvent): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.postToolUse) continue;
      try {
        await hook.postToolUse(event);
      } catch (error) {
        this.onHookError?.(hook.name, error);
      }
    }
  }
}

/**
 * 被平台拦截时的固定文案。
 *
 * 直接回"403"或"用户拒绝"会被渗透 Agent 误判成目标侧 WAF，从而反复尝试绕过。
 * 必须显式声明这是平台政策而非目标防御，审计仍保留原始理由。
 */
export function policyBlockMessage(reason: string): string {
  return `【平台管控 · 非目标防御】此调用被平台拦截。原因：${reason}。该操作被禁止，请勿尝试绕过；如需继续请改用允许的操作或让操作者调整策略。`;
}
