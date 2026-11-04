import type { MigrationInterface, QueryRunner } from 'typeorm';
import snapshot from './attachments-sqlite.json';
import { schemaSignature } from './schema-signature';

export class EvidenceAttachments1793577603000 implements MigrationInterface {
  name = 'EvidenceAttachments1793577603000';
  async up(runner: QueryRunner): Promise<void> {
    const existing = await Promise.all(snapshot.tables.map((t) => runner.getTable(t.name)));
    if (existing.some(Boolean)) {
      if (existing.some((t, i) => !t || schemaSignature(t) !== snapshot.tables[i].signature)) throw new Error('附件表部分存在或与冻结迁移结构不一致，拒绝自动修改');
      return;
    }
    for (const query of snapshot.queries) await runner.query(query);
  }
  async down(runner: QueryRunner): Promise<void> {
    for (const table of snapshot.tables) {
      const rows = await runner.query(`SELECT COUNT(*) AS n FROM "${table.name}"`);
      if (rows[0].n) throw new Error('附件数据非空，拒绝删除；请使用备份恢复');
    }
    for (const table of snapshot.tables) await runner.dropTable(table.name);
  }
}
