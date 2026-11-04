import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ToolInvoker } from './tool-invoker';
import type { PreToolUseEvent, PreToolUseOutcome, ToolHook } from './tool-hooks';

/**
 * 全自动执行：工具调用一律放行，由模型自行决定使用哪些工具与参数。
 *
 * 保留本钩子是为了维持钩子链顺序契约与既有调用点；它不再写入
 * pending_approval 记录，也不基于风险等级或权限矩阵阻塞模型。
 *
 * 授权边界仍然保留在别的钩子里：
 * - runtime-gate：引擎关闭时不发起真实调用（操作者全局开关）；
 * - scope-guard：目标必须落在任务授权范围内（授权承诺，非能力限制）。
 */
@Injectable()
export class ApprovalHook implements ToolHook, OnModuleInit {
  readonly name = 'approval';
  readonly order = 30;
  private readonly logger = new Logger(ApprovalHook.name);

  constructor(private readonly invoker: ToolInvoker) {}

  onModuleInit(): void {
    this.invoker.hooks.add(this);
  }

  preToolUse(event: PreToolUseEvent): PreToolUseOutcome {
    this.logger.debug(`自动放行 ${event.toolName}（角色 ${event.role}）`);
    return { action: 'allow' };
  }
}
