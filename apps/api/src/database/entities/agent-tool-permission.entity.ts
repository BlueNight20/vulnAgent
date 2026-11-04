import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { AgentRole } from '@vulnagent/shared';

@Entity('agent_tool_permissions')
@Index(['taskId', 'agentRole', 'toolPattern'], { unique: true })
@Index('IDX_agent_permission_global_unique', ['agentRole', 'toolPattern'], { unique: true, where: '"taskId" IS NULL' })
export class AgentToolPermissionEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  /** null 表示全局默认权限 */
  @Column({ type: 'varchar', length: 36, nullable: true })
  taskId: string | null;

  @Column({ length: 24 })
  agentRole: AgentRole;

  @Column({ length: 140 })
  toolPattern: string;

  @Column({ type: 'boolean', default: false })
  allowed: boolean;

  @Column({ type: 'boolean', default: false })
  requireApproval: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
