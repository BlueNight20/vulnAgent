import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { InterceptService, type RuleInput } from './intercept.service';
import { ToolRegistry } from './tool-registry';

interface RuleDto {
  name: string;
  enabled?: boolean;
  priority?: number;
  matchTarget?: RuleInput['matchTarget'];
  matchType?: RuleInput['matchType'];
  pattern: string;
  action: RuleInput['action'];
  message?: string | null;
  timeoutEnabled?: boolean;
  timeoutSeconds?: number | null;
  timeoutAction?: RuleInput['timeoutAction'];
}

/** 与前端「拦截规则」页一一对应的 REST 表面。 */
@Controller('intercept')
export class InterceptController {
  constructor(private readonly rules: InterceptService, private readonly registry: ToolRegistry) {}

  /** 可被拦截规则覆盖的工具清单，供"调整范围"分组展示。 */
  @Get('tools')
  tools() {
    return { tools: this.registry.all().map((tool) => ({ name: tool.name(), source: tool.source(), risk: tool.risk() })) };
  }

  @Get('rules')
  async list() {
    return { rules: await this.rules.list() };
  }

  @Post('rules')
  create(@Body() body: RuleDto) {
    return this.rules.create(toInput(body));
  }

  @Put('rules/:id')
  update(@Param('id') id: string, @Body() body: RuleDto) {
    return this.rules.update(id, toInput(body));
  }

  @Post('rules/:id/toggle')
  toggle(@Param('id') id: string, @Body() body: { enabled: boolean }) {
    return this.rules.toggle(id, Boolean(body.enabled));
  }

  @Delete('rules/:id')
  remove(@Param('id') id: string) {
    return this.rules.remove(id);
  }
}

function toInput(body: RuleDto): RuleInput {
  return {
    name: body.name, enabled: body.enabled, priority: body.priority, matchTarget: body.matchTarget,
    matchType: body.matchType, pattern: body.pattern, action: body.action, message: body.message ?? null,
    timeoutEnabled: body.timeoutEnabled, timeoutSeconds: body.timeoutSeconds ?? null, timeoutAction: body.timeoutAction ?? null,
  };
}
