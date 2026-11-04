import { randomUUID } from 'node:crypto';
import type { MigrationInterface, QueryRunner } from 'typeorm';

const INDEX = 'IDX_agent_permission_global_unique';
const SQL = `CREATE UNIQUE INDEX "${INDEX}" ON "agent_tool_permissions" ("agentRole", "toolPattern") WHERE "taskId" IS NULL`;
const normalized = (sql: string) => sql.replace(/[\s"`\[\]]/g, '').toLowerCase();
interface LegacyPermission { id: string; agentRole: string; toolPattern: string; allowed: number; requireApproval: number; createdAt: string; updatedAt: string }

/** SQLite's composite UNIQUE permits duplicate NULL task IDs; preserve effective deny/approval semantics. */
export class GlobalPermissionUnique1793577609000 implements MigrationInterface {
  name = 'GlobalPermissionUnique1793577609000';
  async up(runner: QueryRunner): Promise<void> {
    const [index] = await runner.query('SELECT sql FROM sqlite_master WHERE type=\'index\' AND name=?', [INDEX]);
    if (index) {
      if (normalized(index.sql ?? '') !== normalized(SQL)) throw new Error('全局权限唯一索引结构不匹配');
      return;
    }
    const groups: { agentRole: string; toolPattern: string }[] = await runner.query('SELECT agentRole, toolPattern FROM agent_tool_permissions WHERE taskId IS NULL GROUP BY agentRole, toolPattern HAVING COUNT(*) > 1');
    for (const group of groups) {
      const rows: LegacyPermission[] = await runner.query('SELECT * FROM agent_tool_permissions WHERE taskId IS NULL AND agentRole=? AND toolPattern=? ORDER BY createdAt, id', [group.agentRole, group.toolPattern]);
      if (rows.some((row) => ![0, 1].includes(row.allowed) || ![0, 1].includes(row.requireApproval))) throw new Error('重复权限含非布尔值，拒绝自动合并');
      const kept = rows[0];
      const allowed = rows.every((row) => Boolean(row.allowed));
      const requireApproval = rows.some((row) => Boolean(row.requireApproval));
      await runner.query('INSERT INTO audit_logs (id, actor, action, entityType, entityId, taskId, result, detail) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
        [randomUUID(), 'system:migration', 'mcp.permission_duplicates_merged', 'agent_tool_permission', kept.id, 'success', JSON.stringify({ agentRole: group.agentRole, toolPattern: group.toolPattern, allowed, requireApproval, keptId: kept.id, originals: rows })]);
      await runner.query('UPDATE agent_tool_permissions SET allowed=?, requireApproval=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?', [Number(allowed), Number(requireApproval), kept.id]);
      for (const row of rows.slice(1)) await runner.query('DELETE FROM agent_tool_permissions WHERE id=?', [row.id]);
    }
    await runner.query(SQL);
  }
  async down(runner: QueryRunner): Promise<void> {
    // Only remove the index. Consolidated effective rules and their full original audit history remain.
    await runner.query(`DROP INDEX "${INDEX}"`);
  }
}
