const backendRequire = require('./backend-require.cjs');
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = backendRequire('typeorm');
const { Module, ValidationPipe } = backendRequire('@nestjs/common');
const createTestApp = require('./create-test-app.cjs');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions, SQLITE_MIGRATIONS } = require('../apps/api/dist/database/sqlite-options');
const load = (path, name) => require(`../apps/api/dist/modules/${path}`)[name];
const McpPermissionsService = load('mcp/mcp-permissions.service', 'McpPermissionsService');
const McpController = load('mcp/mcp.controller', 'McpController');
const AuditService = load('audit/audit.service', 'AuditService');
const { toolPermission } = require('../apps/api/dist/modules/mcp/tool-permission');
const INDEX = 'IDX_agent_permission_global_unique';

async function legacyMigration() {
  // 只回退"全局权限唯一索引"那一条迁移；后续迁移（拦截规则等）必须在权限索引之后执行，
  // 这里按迁移名定位而不是"最后一条"，避免新增迁移后本脚本失效。
  const indexMigration = SQLITE_MIGRATIONS.findIndex((m) => m.name.includes('GlobalPermissionUnique'));
  assert.ok(indexMigration >= 0, '未找到全局权限唯一索引迁移');
  const db = await new DataSource({ ...sqliteOptions(':memory:'), migrations: SQLITE_MIGRATIONS.filter((_, index) => index !== indexMigration) }).initialize();
  try {
    await db.runMigrations(); const repo = db.getRepository(E.AgentToolPermissionEntity);
    const originals = [];
    for (const [pattern, allowed, requireApproval] of [['fixture-allow', true, false], ['fixture-allow', true, true], ['fixture-deny', true, true], ['fixture-deny', false, false]]) {
      originals.push(await repo.save({ id: randomUUID(), taskId: null, agentRole: 'verifier', toolPattern: pattern, allowed, requireApproval }));
    }
    // 只把被移除的那条迁移按原有顺序放回，其余迁移已经执行过。
    db.migrations.push(new SQLITE_MIGRATIONS[indexMigration]());
    await db.query('UPDATE agent_tool_permissions SET allowed=? WHERE id=?', ['invalid', originals[0].id]);
    await assert.rejects(() => db.runMigrations(), /重复权限含非布尔值/);
    assert.equal(await repo.count(), 4); assert.equal(await db.getRepository(E.AuditLogEntity).count(), 0);
    await db.query('UPDATE agent_tool_permissions SET allowed=1 WHERE id=?', [originals[0].id]);
    await db.query("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='mcp.permission_duplicates_merged' BEGIN SELECT RAISE(ABORT, 'fixture migration audit failure'); END");
    await assert.rejects(() => db.runMigrations(), /fixture migration audit failure/);
    assert.equal(await repo.count(), 4); assert.equal(await db.getRepository(E.AuditLogEntity).count(), 0);
    assert.equal((await db.query('SELECT name FROM sqlite_master WHERE name=?', [INDEX])).length, 0);
    await db.query('DROP TRIGGER fixture_audit_failure');
    assert.equal((await db.runMigrations()).length, 1);
    assert.equal(await repo.count(), 2);
    for (const pattern of ['fixture-allow', 'fixture-deny']) {
      const before = toolPermission(originals, 'verifier', pattern); const after = toolPermission(await repo.find(), 'verifier', pattern);
      assert.equal(after.allowed, before.allowed);
      if (before.allowed) assert.equal(after.requireApproval, before.requireApproval);
      assert.equal((await repo.findOneByOrFail({ toolPattern: pattern })).requireApproval, true, 'retain the strict approval flag even on a denied merged rule');
    }
    const merged = await db.getRepository(E.AuditLogEntity).findBy({ action: 'mcp.permission_duplicates_merged' });
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.flatMap((row) => row.detail.originals.map((original) => original.id)).sort(), originals.map((row) => row.id).sort());
    await assert.rejects(() => repo.save({ id: randomUUID(), taskId: null, agentRole: 'verifier', toolPattern: 'fixture-allow', allowed: true }), /UNIQUE constraint failed/);
    assert.equal((await db.runMigrations()).length, 0);
    await db.undoLastMigration(); assert.equal(await repo.count(), 2); assert.equal(await db.getRepository(E.AuditLogEntity).count(), 2);
    await db.query(`CREATE INDEX "${INDEX}" ON agent_tool_permissions (agentRole)`);
    await assert.rejects(() => db.runMigrations(), /唯一索引结构不匹配/);
    assert.equal(await repo.count(), 2);
  } finally { await db.destroy(); }
}

async function main() {
  await legacyMigration();
  const db = await new DataSource(sqliteOptions(':memory:')).initialize(); let app;
  try {
    await db.runMigrations(); const repo = (entity) => db.getRepository(entity);
    for (const id of ['task', 'other']) await repo(E.TaskEntity).save({ id, name: '权限事务验证', scope: {}, modelProvider: 'fixture', modelName: 'fixture' });
    const notifications = []; let failPush = false;
    const audit = new AuditService(repo(E.AuditLogEntity), { broadcast: (type, data) => {
      assert.equal(db.createQueryRunner().isTransactionActive, false, 'publish only after commit');
      assert.ok(db.driver.databaseConnection.prepare('SELECT id FROM audit_logs WHERE id=?').get(data.id));
      notifications.push({ type, data }); if (failPush) throw new Error('fixture disconnected socket');
    } });
    const service = () => new McpPermissionsService(repo(E.AgentToolPermissionEntity), repo(E.McpToolEntity), audit);
    const permissions = service();
    class TestModule {}
    Module({ controllers: [McpController], providers: [
      { provide: McpPermissionsService, useValue: permissions },
      ...[['mcp/mcp-servers.service', 'McpServersService'], ['mcp/mcp-health.service', 'McpHealthService'], ['mcp/mcp-calls.service', 'McpCallsService']].map(([path, name]) => ({ provide: load(path, name), useValue: {} })),
    ] })(TestModule);
    app = await createTestApp(TestModule, { logger: false }); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0, '127.0.0.1'); const base = `${await app.getUrl()}/mcp/permissions`;
    const put = (body) => fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const input = { agentRole: 'verifier', toolPattern: 'fixture_tool', allowed: true, requireApproval: true };
    const created = await put({ ...input, toolPattern: ' fixture_tool ' }); assert.equal(created.status, 200); const first = await created.json();
    assert.equal(first.toolPattern, 'fixture_tool'); assert.equal(first.requireApproval, true);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].data.detail.previous, null);
    const update = await put({ ...input, allowed: false, requireApproval: undefined }); assert.equal(update.status, 200);
    const updated = await update.json(); assert.equal(updated.id, first.id); assert.equal(updated.allowed, false); assert.equal(updated.requireApproval, true);
    assert.deepEqual(notifications[1].data.detail.previous, { allowed: true, requireApproval: true });
    // Both creation and update are rolled back if the audit cannot be persisted.
    await db.query("CREATE TRIGGER fixture_permission_audit BEFORE INSERT ON audit_logs WHEN NEW.action='mcp.permission_update' BEGIN SELECT RAISE(ABORT, 'fixture permission audit failure'); END");
    assert.equal((await put(input)).status, 500);
    assert.equal((await put({ ...input, toolPattern: 'must-not-exist' })).status, 500);
    assert.equal((await repo(E.AgentToolPermissionEntity).findOneByOrFail({ id: first.id })).allowed, false);
    assert.equal(await repo(E.AgentToolPermissionEntity).countBy({ toolPattern: 'must-not-exist' }), 0);
    assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'mcp.permission_update' }), 2); assert.equal(notifications.length, 2);
    await db.query('DROP TRIGGER fixture_permission_audit');
    // Inject a commit failure after both writes: no notification or committed mutation may escape.
    const runner = db.createQueryRunner(); const commit = runner.commitTransaction.bind(runner); let failCommit = true;
    runner.commitTransaction = async () => { if (failCommit) { failCommit = false; throw new Error('fixture commit failure'); } return commit(); };
    try { await assert.rejects(() => permissions.upsert(input), /fixture commit failure/); }
    finally { runner.commitTransaction = commit; }
    assert.equal((await repo(E.AgentToolPermissionEntity).findOneByOrFail({ id: first.id })).allowed, false); assert.equal(notifications.length, 2);
    assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'mcp.permission_update' }), 2);
    // Separate service instances must serialize the read/create and audit together.
    const competing = await Promise.all(Array.from({ length: 12 }, (_, index) => service().upsert({ ...input, toolPattern: 'concurrent', allowed: index % 2 === 0 })));
    assert.equal(new Set(competing.map((row) => row.id)).size, 1);
    assert.equal(await repo(E.AgentToolPermissionEntity).countBy({ toolPattern: 'concurrent' }), 1);
    const history = await db.query('SELECT detail FROM audit_logs WHERE entityId=? ORDER BY rowid', [competing[0].id]);
    assert.equal(history.length, 12);
    const chain = history.map((row) => JSON.parse(row.detail)); assert.equal(chain[0].previous, null);
    for (let index = 1; index < chain.length; index++) assert.equal(chain[index].previous.allowed, chain[index - 1].allowed);
    // Database constraint also protects raw writers, independent of the application's queue.
    await assert.rejects(() => repo(E.AgentToolPermissionEntity).save({ ...input, id: randomUUID(), taskId: null, toolPattern: 'concurrent' }), /UNIQUE constraint failed/);
    const scoped = await put({ ...input, taskId: 'task' }); assert.equal(scoped.status, 200); const scopedRule = await scoped.json(); assert.notEqual(scopedRule.id, first.id);
    const matrix = await (await fetch(`${base}?taskId=other`)).json(); assert.ok(matrix.permissions.every((row) => row.taskId === null));
    for (const patch of [{ toolPattern: '' }, { toolPattern: '   ' }, { allowed: 'true' }, { requireApproval: 'false' }, { agentRole: 'unknown' }]) assert.equal((await put({ ...input, ...patch })).status, 400);
    assert.equal((await put({ ...input, taskId: 'missing' })).status, 404);
    assert.equal(await repo(E.AgentToolPermissionEntity).countBy({ taskId: 'missing' }), 0);
    failPush = true; const committed = await put({ ...input, allowed: true }); assert.equal(committed.status, 200, 'socket failure cannot undo committed authority');
    assert.equal((await repo(E.AgentToolPermissionEntity).findOneByOrFail({ id: first.id })).allowed, true);
    assert.ok(await repo(E.AuditLogEntity).findOneBy({ entityId: first.id, action: 'mcp.permission_update' }));
    console.log('PASS: migrated global NULL uniqueness, semantic-preserving duplicate consolidation with full audit and rollback, index drift refusal, real HTTP atomic permission/audit updates, pre/post history, no precommit push, commit/audit faults, competing services, scope isolation, validation and push-failure durability');
  } finally { if (app) await app.close(); await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
