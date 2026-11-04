import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { FactsService } from '../blackboard/facts.service';
import { FindingsService } from '../blackboard/findings.service';
import { HypothesisService } from '../blackboard/hypothesis.service';
import { buildBusinessTools } from './business-tools';
import { ToolInvoker } from './tool-invoker';
import { ToolRegistry } from './tool-registry';
import { textResult, type ToolResult } from './core-tool';

/**
 * 业务工具注册与执行器。
 *
 * 业务工具走 `internal` 执行器，与 MCP 工具共用 Registry 与 ToolInvoker：
 * 参数校验、拦截规则、范围与权限钩子、输出截断、审计对两类工具完全一致。
 */
@Injectable()
export class BusinessToolRegistrar implements OnModuleInit {
  private readonly logger = new Logger(BusinessToolRegistrar.name);
  private readonly handlers = new Map<string, () => Promise<ToolResult>>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly invoker: ToolInvoker,
    private readonly facts: FactsService,
    private readonly findings: FindingsService,
    private readonly hypotheses: HypothesisService,
  ) {}

  onModuleInit(): void {
    const tools = buildBusinessTools({ facts: this.facts, findings: this.findings, hypotheses: this.hypotheses });
    this.registry.replaceSource('business', tools);
    // internal 执行器：直接调用工具本体；所有关卡已在 Invoker 中完成。
    this.invoker.registerExecutor({
      kind: 'internal',
      run: (tool, input, ctx) => tool.call(input, ctx),
    });
    this.logger.log(`业务工具已注册：${tools.map((tool) => tool.name()).join(', ')}`);
  }

  /** 供测试注入替身使用。 */
  registerHandler(name: string, handler: () => Promise<ToolResult>): void {
    this.handlers.set(name, handler);
  }

  async runHandler(name: string): Promise<ToolResult> {
    const handler = this.handlers.get(name);
    return handler ? handler() : textResult('(no handler)');
  }
}
