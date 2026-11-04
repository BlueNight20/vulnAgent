import type { MigrationInterface, QueryRunner } from 'typeorm';
import snapshot from './model-requests-sqlite.json';
import { schemaSignature } from './schema-signature';
import { TASK_OWNED_TABLES_V1 } from './1793577604000-TaskOwnership';

export const TASK_OWNED_TABLES_V2 = [...TASK_OWNED_TABLES_V1, 'model_requests'] as const;
function deleteTrigger(tables: readonly string[]): string {
  return `CREATE TRIGGER "task_delete_owned_rows" AFTER DELETE ON "tasks" BEGIN
    INSERT INTO "task_deletions" ("taskId") VALUES (OLD."id");
    ${tables.map((name) => `DELETE FROM "${name}" WHERE "taskId" = OLD."id";`).join('\n')}
    UPDATE "audit_logs" SET "taskId" = NULL WHERE "taskId" = OLD."id";
  END`;
}
export class ModelTokenBudget1793577606000 implements MigrationInterface {
  name = 'ModelTokenBudget1793577606000';
  async up(runner: QueryRunner): Promise<void> {
    const table = await runner.getTable('model_requests');
    if (table && schemaSignature(table) !== snapshot.signature) throw new Error('模型请求账本结构与冻结迁移不匹配');
    if (!table) for (const sql of snapshot.queries) await runner.query(sql);
    for (const [name, fields] of [
      ['tasks', { budgetEpoch: 'varchar(36)', tokenBaseline: 'integer NOT NULL DEFAULT 0', costBaseline: 'real NOT NULL DEFAULT 0' }],
      ['agent_sessions', { tokenAllowance: 'integer', budgetManaged: 'boolean NOT NULL DEFAULT 0', budgetEpoch: 'varchar(36)', baselineInput: 'integer NOT NULL DEFAULT 0', baselineOutput: 'integer NOT NULL DEFAULT 0', baselineCost: 'real NOT NULL DEFAULT 0' }],
    ] as const) {
      const existing = await runner.getTable(name);
      for (const [field, sql] of Object.entries(fields)) {
        const column = existing?.findColumnByName(field);
        if (!column) await runner.query(`ALTER TABLE "${name}" ADD COLUMN "${field}" ${sql}`);
        else if (column.type !== sql.split(/[ (]/)[0] || column.isNullable !== !sql.includes('NOT NULL')) throw new Error(`模型预算字段不匹配：${name}.${field}`);
      }
    }
    for (const operation of ['INSERT', 'UPDATE']) await runner.query(`CREATE TRIGGER "task_owner_model_requests_${operation.toLowerCase()}" BEFORE ${operation} ON "model_requests"
      WHEN NEW."taskId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "tasks" WHERE "id" = NEW."taskId")
      BEGIN SELECT RAISE(ABORT, 'Task ownership: task no longer exists'); END`);
    await runner.query('DROP TRIGGER "task_delete_owned_rows"');
    await runner.query(deleteTrigger(TASK_OWNED_TABLES_V2));
  }
  async down(runner: QueryRunner): Promise<void> {
    const [requests] = await runner.query('SELECT COUNT(*) AS n FROM model_requests');
    const [sessions] = await runner.query('SELECT COUNT(*) AS n FROM agent_sessions WHERE budgetManaged != 0 OR tokenAllowance IS NOT NULL OR budgetEpoch IS NOT NULL');
    const [tasks] = await runner.query('SELECT COUNT(*) AS n FROM tasks WHERE budgetEpoch IS NOT NULL');
    if (requests.n || sessions.n || tasks.n) throw new Error('模型预算记录非空，拒绝删除；请使用备份恢复');
    await runner.query('DROP TRIGGER "task_delete_owned_rows"');
    await runner.query(deleteTrigger(TASK_OWNED_TABLES_V1));
    for (const operation of ['insert', 'update']) await runner.query(`DROP TRIGGER "task_owner_model_requests_${operation}"`);
    await runner.dropTable('model_requests');
    for (const field of ['budgetEpoch', 'tokenBaseline', 'costBaseline']) await runner.query(`ALTER TABLE tasks DROP COLUMN "${field}"`);
    for (const field of ['tokenAllowance', 'budgetManaged', 'budgetEpoch', 'baselineInput', 'baselineOutput', 'baselineCost']) await runner.query(`ALTER TABLE agent_sessions DROP COLUMN "${field}"`);
  }
}
