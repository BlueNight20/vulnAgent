import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { TaskEntity } from './task.entity';

@Entity('targets')
@Index(['taskId', 'ip'], { unique: true })
export class TargetEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  @ManyToOne(() => TaskEntity, (task) => task.targets, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'taskId' })
  task: TaskEntity;

  @Column({ length: 64 })
  ip: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  hostname: string | null;

  @Column({ length: 16, default: 'host' })
  kind: 'host' | 'cidr';

  @Column({ type: 'boolean', default: true })
  inScope: boolean;

  @Column({ type: 'text', nullable: true })
  note: string | null;
}
