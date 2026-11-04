import type { MigrationInterface, QueryRunner } from 'typeorm';
import snapshot from './verification-sqlite.json';
import { schemaSignature } from './schema-signature';

export class FindingVerification1793577601000 implements MigrationInterface {
  name = 'FindingVerification1793577601000';
  async up(runner: QueryRunner): Promise<void> {
    const existing = await runner.getTable('finding_verifications');
    if (existing) {
      if (schemaSignature(existing) !== snapshot.signature) throw new Error('finding_verifications 与冻结迁移结构不一致');
      return;
    }
    for (const sql of snapshot.queries) await runner.query(sql);
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows = await runner.query('SELECT COUNT(*) AS n FROM finding_verifications');
    if (rows[0].n) throw new Error('验证历史非空，拒绝删除；请使用备份恢复');
    await runner.dropTable('finding_verifications');
  }
}
