import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('audit_logs')
@Index(['createdAt'])
@Index(['action'])
export class AuditLogEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 60, default: 'system' })
  actor: string;

  @Column({ length: 80 })
  action: string;

  @Column({ length: 40 })
  entityType: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  entityId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  taskId: string | null;

  @Column({ length: 16, default: 'success' })
  result: 'success' | 'failure';

  /** 不允许写入密钥明文 */
  @Column({ type: 'simple-json', nullable: true })
  detail: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;
}
