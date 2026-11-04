import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type { ToolCallDecision, ToolCallStatus, ToolFailureKind } from '@vulnagent/shared';

@Entity('tool_calls')
@Index(['taskId'])
@Index(['createdAt'])
@Index(['taskId', 'argumentsHash'])
export class ToolCallEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  /** 全局 MCP 检测时为 null */
  @Column({ type: 'varchar', length: 36, nullable: true })
  taskId: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  agentSessionId: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  mcpServerId: string | null;

  @Column({ length: 120 })
  toolName: string;

  @Column({ type: 'simple-json' })
  arguments: Record<string, unknown>;

  /** 工具名 + 规范化参数的指纹，用于重复动作识别与审批重放 */
  @Column({ type: 'varchar', length: 500, nullable: true })
  argumentsHash: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  targetIp: string | null;

  @Column({ length: 20, default: 'allow' })
  decision: ToolCallDecision;

  @Column({ type: 'varchar', length: 200, nullable: true })
  decisionReason: string | null;

  @Column({ length: 20, default: 'success' })
  status: ToolCallStatus;

  @Column({ type: 'integer', default: 0 })
  latencyMs: number;

  @Column({ type: 'varchar', length: 36, nullable: true })
  rawOutputRef: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  /**
   * 失败原因分类。成功时为 null。
   * probe 类失败（超时/连接/握手）不得被当作目标状态事实。
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  failureKind: ToolFailureKind | null;

  /** 审批通过/拒绝的时间；未审批为 null */
  @Column({ type: 'datetime', nullable: true })
  approvedAt: Date | null;

  /** 审批人身份（当前为本地操作者标识） */
  @Column({ type: 'varchar', length: 120, nullable: true })
  approvedBy: string | null;

  /** 待审批的过期时间，超时自动置为 expired */
  @Column({ type: 'datetime', nullable: true })
  approvalExpiresAt: Date | null;

  /** 审批通过后实际重放的调用记录 ID */
  @Column({ type: 'varchar', length: 36, nullable: true })
  replayOfId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
