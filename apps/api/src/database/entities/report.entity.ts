import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type { ReportFormat, ReportStatus } from '@vulnagent/shared';

@Entity('reports')
@Index(['taskId'])
export class ReportEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  @Column({ length: 12 })
  format: ReportFormat;

  @Column({ length: 200 })
  title: string;

  @Column({ type: 'text', nullable: true })
  content: string | null;

  @Column({ type: 'varchar', length: 400, nullable: true })
  filePath: string | null;

  @Column({ length: 16, default: 'draft' })
  status: ReportStatus;

  @Column({ type: 'simple-json', nullable: true })
  stats: Record<string, unknown> | null;

  @Column({ type: 'datetime', nullable: true })
  generatedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
