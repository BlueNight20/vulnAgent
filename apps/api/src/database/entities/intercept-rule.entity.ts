import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type InterceptMatchTarget = 'tool_name' | 'tool_input';
export type InterceptMatchType = 'string' | 'regex';
export type InterceptAction = 'allow' | 'deny' | 'ask';
export type InterceptTimeoutAction = 'deny' | 'allow';

/**
 * 工具调用拦截规则。
 *
 * 语义（与 artex 一致）：
 * - priority 越大越先匹配，首个命中生效；
 * - match_target=tool_name 匹配工具名，tool_input 匹配 JSON 序列化后的参数；
 * - action=allow 直接放行并跳过后续规则；deny 阻断并把 message 返回模型；ask 转人工审批；
 * - 仅 ask 使用 timeout* 字段：超时后按 timeoutAction 处理。
 */
@Entity('intercept_rules')
@Index(['enabled', 'priority'])
export class InterceptRuleEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'integer', default: 0 })
  priority: number;

  @Column({ type: 'varchar', length: 16, default: 'tool_name' })
  matchTarget: InterceptMatchTarget;

  @Column({ type: 'varchar', length: 8, default: 'string' })
  matchType: InterceptMatchType;

  @Column({ type: 'text' })
  pattern: string;

  @Column({ type: 'varchar', length: 8, default: 'deny' })
  action: InterceptAction;

  /** deny 时为返回给模型的拒绝理由；ask 时为审批说明 */
  @Column({ type: 'text', nullable: true })
  message: string | null;

  @Column({ type: 'boolean', default: false })
  timeoutEnabled: boolean;

  @Column({ type: 'integer', nullable: true })
  timeoutSeconds: number | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  timeoutAction: InterceptTimeoutAction | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt: Date;
}
