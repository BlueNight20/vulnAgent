import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('system_settings')
export class SystemSettingEntity {
  @PrimaryColumn('varchar', { length: 80 })
  key: string;

  @Column({ type: 'text' })
  value: string;

  /** true 时 value 为 AES-256-GCM 密文 */
  @Column({ type: 'boolean', default: false })
  encrypted: boolean;

  @UpdateDateColumn()
  updatedAt: Date;
}
