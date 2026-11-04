import type { MigrationInterface, QueryRunner } from 'typeorm';
import snapshot from './finding-assessments-sqlite.json';
import { schemaSignature } from './schema-signature';
import { TASK_OWNED_TABLES_V2 } from './1793577606000-ModelTokenBudget';
export const TASK_OWNED_TABLES_V3 = [...TASK_OWNED_TABLES_V2, 'finding_assessments'] as const;
function deletion(tables: readonly string[]) {
  return `CREATE TRIGGER task_delete_owned_rows AFTER DELETE ON tasks BEGIN
    INSERT INTO task_deletions (taskId) VALUES (OLD.id);
    ${tables.map((table) => `DELETE FROM "${table}" WHERE taskId = OLD.id;`).join('\n')}
    UPDATE audit_logs SET taskId = NULL WHERE taskId = OLD.id; END`;
}
export class FindingAssessments1793577608000 implements MigrationInterface {
  name = 'FindingAssessments1793577608000';
  async up(runner: QueryRunner): Promise<void> {
    const table = await runner.getTable('finding_assessments');
    if (table && schemaSignature(table) !== snapshot.signature) throw new Error('漏洞维护历史结构与冻结迁移不匹配');
    if (!table) for (const sql of snapshot.queries) await runner.query(sql);
    const column = (await runner.getTable('findings'))?.findColumnByName('metadataRevision');
    if (!column) await runner.query('ALTER TABLE findings ADD COLUMN metadataRevision integer NOT NULL DEFAULT 0');
    else if (column.type !== 'integer' || column.isNullable || String(column.default) !== '0') throw new Error('漏洞维护版本字段不匹配');
    for (const op of ['INSERT', 'UPDATE']) await runner.query(`CREATE TRIGGER task_owner_finding_assessments_${op.toLowerCase()} BEFORE ${op} ON finding_assessments
      WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE id=NEW.taskId) BEGIN SELECT RAISE(ABORT, 'Task ownership: task no longer exists'); END`);
    await runner.query('DROP TRIGGER task_delete_owned_rows'); await runner.query(deletion(TASK_OWNED_TABLES_V3));
  }
  async down(runner: QueryRunner): Promise<void> {
    const [history] = await runner.query('SELECT COUNT(*) AS n FROM finding_assessments');
    const [findings] = await runner.query('SELECT COUNT(*) AS n FROM findings WHERE metadataRevision != 0');
    if (history.n || findings.n) throw new Error('漏洞维护历史非空，拒绝删除；请使用备份恢复');
    await runner.query('DROP TRIGGER task_delete_owned_rows'); await runner.query(deletion(TASK_OWNED_TABLES_V2));
    for (const op of ['insert', 'update']) await runner.query(`DROP TRIGGER task_owner_finding_assessments_${op}`);
    await runner.dropTable('finding_assessments'); await runner.query('ALTER TABLE findings DROP COLUMN metadataRevision');
  }
}
