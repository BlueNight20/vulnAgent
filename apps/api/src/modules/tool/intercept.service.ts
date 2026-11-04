import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InterceptRuleEntity, type InterceptAction } from '../../database/entities/intercept-rule.entity';
import { newId } from '../../common/utils/id';
import { AuditService } from '../audit/audit.service';

export interface RuleInput {
  name: string;
  enabled?: boolean;
  priority?: number;
  matchTarget?: 'tool_name' | 'tool_input';
  matchType?: 'string' | 'regex';
  pattern: string;
  action: InterceptAction;
  message?: string | null;
  timeoutEnabled?: boolean;
  timeoutSeconds?: number | null;
  timeoutAction?: 'deny' | 'allow' | null;
}

export interface RuleMatch {
  rule: InterceptRuleEntity;
  action: InterceptAction;
  message: string | null;
  reason: string;
}

/**
 * 拦截规则匹配与维护。
 *
 * 匹配语义（与 artex 一致，实现自写）：
 * - 按 priority 降序，先启用规则；首个命中即生效；
 * - matchTarget=tool_name 比对工具名；tool_input 比对 JSON 序列化后的参数文本；
 * - matchType=string 为包含匹配；regex 使用 JavaScript 正则（Go RE2 的扩展语法在前端只警告不阻断）。
 * 正则编译失败时按"不匹配"处理并记录日志，绝不放行到执行层造成误判。
 */
@Injectable()
export class InterceptService {
  private readonly logger = new Logger(InterceptService.name);

  constructor(
    @InjectRepository(InterceptRuleEntity) private readonly rules: Repository<InterceptRuleEntity>,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<InterceptRuleEntity[]> {
    return this.rules.find({ order: { priority: 'DESC', createdAt: 'ASC' } });
  }

  async create(input: RuleInput): Promise<InterceptRuleEntity> {
    this.validate(input);
    const saved = await this.rules.save(this.rules.create({
      id: newId(), name: input.name.trim(), enabled: input.enabled ?? true, priority: input.priority ?? 0,
      matchTarget: input.matchTarget ?? 'tool_name', matchType: input.matchType ?? 'string',
      pattern: input.pattern, action: input.action, message: input.message?.trim() || null,
      timeoutEnabled: input.action === 'ask' ? input.timeoutEnabled ?? false : false,
      timeoutSeconds: input.action === 'ask' ? input.timeoutSeconds ?? null : null,
      timeoutAction: input.action === 'ask' ? input.timeoutAction ?? null : null,
    }));
    await this.audit.record({ action: 'intercept.rule_created', entityType: 'intercept_rule', entityId: saved.id, detail: { name: saved.name, action: saved.action, priority: saved.priority } });
    return saved;
  }

  async update(id: string, input: RuleInput): Promise<InterceptRuleEntity> {
    const existing = await this.rules.findOneBy({ id });
    if (!existing) throw new NotFoundException('拦截规则不存在');
    this.validate(input);
    const previous = { ...existing };
    Object.assign(existing, {
      name: input.name.trim(), enabled: input.enabled ?? existing.enabled, priority: input.priority ?? existing.priority,
      matchTarget: input.matchTarget ?? existing.matchTarget, matchType: input.matchType ?? existing.matchType,
      pattern: input.pattern, action: input.action, message: input.message?.trim() || null,
      timeoutEnabled: input.action === 'ask' ? input.timeoutEnabled ?? false : false,
      timeoutSeconds: input.action === 'ask' ? input.timeoutSeconds ?? null : null,
      timeoutAction: input.action === 'ask' ? input.timeoutAction ?? null : null,
    });
    const saved = await this.rules.save(existing);
    await this.audit.record({ action: 'intercept.rule_updated', entityType: 'intercept_rule', entityId: id, detail: { before: this.snapshot(previous), after: this.snapshot(saved) } });
    return saved;
  }

  async toggle(id: string, enabled: boolean): Promise<InterceptRuleEntity> {
    const existing = await this.rules.findOneBy({ id });
    if (!existing) throw new NotFoundException('拦截规则不存在');
    existing.enabled = enabled;
    const saved = await this.rules.save(existing);
    await this.audit.record({ action: 'intercept.rule_toggled', entityType: 'intercept_rule', entityId: id, detail: { enabled } });
    return saved;
  }

  async remove(id: string): Promise<{ deleted: boolean }> {
    const existing = await this.rules.findOneBy({ id });
    if (!existing) throw new NotFoundException('拦截规则不存在');
    await this.rules.delete({ id });
    await this.audit.record({ action: 'intercept.rule_deleted', entityType: 'intercept_rule', entityId: id, detail: this.snapshot(existing) });
    return { deleted: true };
  }

  /** 返回首个命中的规则；全部未命中返回 null（表示放行）。 */
  async match(toolName: string, input: Record<string, unknown>): Promise<RuleMatch | null> {
    const rules = await this.rules.find({ where: { enabled: true }, order: { priority: 'DESC', createdAt: 'ASC' } });
    const inputText = safeStringify(input);
    for (const rule of rules) {
      const subject = rule.matchTarget === 'tool_name' ? toolName : inputText;
      if (!this.hit(subject, rule)) continue;
      return {
        rule,
        action: rule.action,
        message: rule.message,
        reason: `命中规则「${rule.name}」(${rule.matchType} ${rule.matchTarget}=${rule.pattern})`,
      };
    }
    return null;
  }

  private hit(subject: string, rule: InterceptRuleEntity): boolean {
    if (rule.matchType === 'string') return subject.includes(rule.pattern);
    try {
      return new RegExp(rule.pattern, rule.matchTarget === 'tool_name' ? 'i' : '').test(subject);
    } catch (error) {
      this.logger.warn(`拦截规则「${rule.name}」正则无效，按不匹配处理：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private validate(input: RuleInput): void {
    if (!input.name?.trim()) throw new BadRequestException('规则名称不能为空');
    if (!input.pattern) throw new BadRequestException('匹配模式不能为空');
    if (!['allow', 'deny', 'ask'].includes(input.action)) throw new BadRequestException('策略必须是 allow / deny / ask');
    if (!['tool_name', 'tool_input'].includes(input.matchTarget ?? 'tool_name')) throw new BadRequestException('匹配目标必须是 tool_name 或 tool_input');
    if (!['string', 'regex'].includes(input.matchType ?? 'string')) throw new BadRequestException('匹配类型必须是 string 或 regex');
    if ((input.matchType ?? 'string') === 'regex') {
      try { new RegExp(input.pattern); } catch { throw new BadRequestException('正则表达式无法编译，请检查语法'); }
    }
    if (input.action === 'ask' && input.timeoutEnabled) {
      if (!Number.isInteger(input.timeoutSeconds) || (input.timeoutSeconds ?? 0) < 1) throw new BadRequestException('启用超时后必须填写大于 0 的秒数');
      if (!['deny', 'allow'].includes(input.timeoutAction ?? '')) throw new BadRequestException('超时后动作必须是 deny 或 allow');
    }
  }

  private snapshot(rule: InterceptRuleEntity) {
    return { name: rule.name, enabled: rule.enabled, priority: rule.priority, matchTarget: rule.matchTarget, matchType: rule.matchType, pattern: rule.pattern, action: rule.action, message: rule.message };
  }
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}
