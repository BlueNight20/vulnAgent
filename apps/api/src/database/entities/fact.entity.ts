import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type { FactCategory, FactStatus, FactObservationKind } from '@vulnagent/shared';

@Entity('facts')
@Index(['taskId'])
@Index(['taskId', 'category'])
@Index(['taskId', 'status'])
@Index(['taskId', 'subject', 'predicate'])
export class FactEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  agentSessionId: string | null;

  @Column({ length: 32 })
  category: FactCategory;

  @Column({ length: 200 })
  subject: string;

  @Column({ length: 120 })
  predicate: string;

  @Column({ type: 'text' })
  object: string;

  /**
   * 事实状态：inferred（模型推断）/ observed（工具观测）/ verified（已复核）/ refuted（已推翻）。
   * inferred 不得作为漏洞证据。
   */
  @Column({ length: 16, default: 'inferred' })
  status: FactStatus;

  @Column({ type: 'real', default: 0.5 })
  confidence: number;

  /** 来源证据 ID 列表，保证每条事实可追溯到证据 */
  @Column({ type: 'simple-json' })
  sourceEvidenceIds: string[];

  @Column({ length: 20, default: 'agent' })
  createdBy: 'tool' | 'agent' | 'user';

  @Column({ type: 'simple-json', default: '[]' })
  hypothesisIds: string[];

  /* ===== 溯源字段（第三阶段新增） ===== */

  /** 产出该事实的工具名；模型推断为 null */
  @Column({ type: 'varchar', length: 120, nullable: true })
  sourceTool: string | null;

  /** 观测目标（IP / 域名）；全局性结论为 null */
  @Column({ type: 'varchar', length: 64, nullable: true })
  targetIp: string | null;

  /** 工具实际返回该观测的时间 */
  @Column({ type: 'datetime', nullable: true })
  observedAt: Date | null;

  /**
   * 观测类别：区分「目标的安全状态」与「探测过程本身的失败」。
   * - target_state：目标真实状态（端口开放、服务版本等）
   * - target_negative：目标明确否定（连接被拒绝、端口关闭）
   * - probe_error：探测过程失败（超时、工具报错、权限不足）—— 不能推断目标状态
   * - inference：模型推理
   */
  @Column({ length: 20, default: 'inference' })
  observationKind: FactObservationKind;

  /** 该事实所属的冲突组 ID；同一 subject+predicate 的不同取值共享一个组 */
  @Column({ type: 'varchar', length: 36, nullable: true })
  conflictGroupId: string | null;

  /** 是否为冲突中被采纳的取值（人工或复核确认后置 true） */
  @Column({ type: 'boolean', default: false })
  conflictResolved: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
