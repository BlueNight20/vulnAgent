import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';

// 冻结清单：新增任务所属表时，需要另加迁移扩展清理和写入约束。
export const TASK_OWNED_TABLES_V1 = [
  'agent_sessions', 'agent_session_events', 'agent_session_messages', 'agent_tool_permissions',
  'evidence', 'evidence_attachments', 'reports', 'report_attachments', 'facts', 'findings',
  'finding_verifications', 'hints', 'hypotheses', 'hypothesis_links', 'intents', 'model_usage',
  'orchestrator_runs', 'targets', 'task_state_events', 'tool_calls', 'worker_profile_loads',
  'worker_result_cards', 'worker_tasks',
] as const;

export class TaskOwnership1793577604000 implements MigrationInterface {
  name = 'TaskOwnership1793577604000';
  async up(runner: QueryRunner): Promise<void> {
    for (const name of TASK_OWNED_TABLES_V1) {
      const table = await runner.getTable(name);
      if (!table?.findColumnByName('taskId')) throw new Error(`任务归属约束缺少表/列：${name}.taskId`);
    }
    // 幂等：synchronize 建出来的库可能已有同表/同触发器，接管时不能因"已存在"失败。
    if (!await runner.hasTable('task_deletions')) {
      await runner.createTable(new Table({ name: 'task_deletions', columns: [
        { name: 'taskId', type: 'varchar', length: '36', isPrimary: true },
        { name: 'deletedAt', type: 'datetime', default: "datetime('now')" },
      ] }));
    }
    for (const name of TASK_OWNED_TABLES_V1) {
      for (const operation of ['INSERT', 'UPDATE'] as const) {
        await runner.query(`CREATE TRIGGER IF NOT EXISTS "task_owner_${name}_${operation.toLowerCase()}" BEFORE ${operation} ON "${name}"
          WHEN NEW."taskId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "tasks" WHERE "id" = NEW."taskId")
          BEGIN SELECT RAISE(ABORT, 'Task ownership: task no longer exists'); END`);
      }
    }
    await runner.query(`CREATE TRIGGER IF NOT EXISTS "task_prevent_resurrection" BEFORE INSERT ON "tasks"
      WHEN EXISTS (SELECT 1 FROM "task_deletions" WHERE "taskId" = NEW."id")
      BEGIN SELECT RAISE(ABORT, 'Task ownership: deleted task cannot be recreated'); END`);
    await runner.query('DROP TRIGGER IF EXISTS "task_delete_owned_rows"');
    await runner.query(`CREATE TRIGGER "task_delete_owned_rows" AFTER DELETE ON "tasks" BEGIN
      INSERT INTO "task_deletions" ("taskId") VALUES (OLD."id");
      ${TASK_OWNED_TABLES_V1.map((name) => `DELETE FROM "${name}" WHERE "taskId" = OLD."id";`).join('\n')}
      UPDATE "audit_logs" SET "taskId" = NULL WHERE "taskId" = OLD."id";
    END`);
  }
  async down(runner: QueryRunner): Promise<void> {
    const [row] = await runner.query('SELECT COUNT(*) AS n FROM task_deletions');
    if (row.n) throw new Error('已删除任务的防重建记录非空，拒绝回滚；请使用备份恢复');
    await runner.query('DROP TRIGGER "task_delete_owned_rows"');
    await runner.query('DROP TRIGGER "task_prevent_resurrection"');
    for (const name of TASK_OWNED_TABLES_V1) for (const operation of ['insert', 'update']) {
      await runner.query(`DROP TRIGGER "task_owner_${name}_${operation}"`);
    }
    await runner.dropTable('task_deletions');
  }
}
