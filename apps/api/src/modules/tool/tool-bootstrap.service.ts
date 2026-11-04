import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ToolInvoker } from './tool-invoker';
import { McpCallExecutor } from './mcp-call.executor';
import { ToolCatalogService } from './tool-catalog.service';

/**
 * 把真实执行器接到 Invoker 上。
 *
 * 背景：ToolInvoker 在构造时只预置了 internal 执行器与一个 MCP 占位执行器；
 * 真实的 MCP 执行器要等 Nest 实例化完 McpCallExecutor 才能注入。之前没有任何
 * 地方做这一步，导致生产环境里所有 MCP 工具调用都被判成"未注册执行器：mcp"。
 *
 * 依赖顺序：ToolCatalogService.onModuleInit 会往 Registry 里注册工具，
 * Nest 按 providers 声明顺序激活，因此把本服务放在它之前，保证
 * "先有执行器，再有可调用工具"。
 */
@Injectable()
export class ToolExecutorBinder implements OnModuleInit {
  private readonly logger = new Logger(ToolExecutorBinder.name);

  constructor(
    private readonly invoker: ToolInvoker,
    private readonly mcpExecutor: McpCallExecutor,
    private readonly catalog: ToolCatalogService,
  ) {}

  onModuleInit(): void {
    this.invoker.registerExecutor(this.mcpExecutor);
    this.logger.log(`工具执行器已装配：[${this.invoker.executorKinds().join(', ')}]，目录同步由 ${ToolCatalogService.name} 负责`);
    void this.catalog;
  }
}
