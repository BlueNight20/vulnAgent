const backendRequire = require('./backend-require.cjs');
// This regression exercises an explicitly enabled engine; disabled behavior has its own fixture.
process.env.PI_RUNTIME_ENABLED = 'true';
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { createHash } = require('node:crypto');
const { DataSource } = backendRequire('typeorm');
const Database = backendRequire('better-sqlite3');
const { Module, ValidationPipe } = backendRequire('@nestjs/common');
const createTestApp = require('./create-test-app.cjs');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions, SQLITE_MIGRATIONS } = require('../apps/api/dist/database/sqlite-options');
const { trackTaskActivity } = require('../apps/api/dist/database/task-activity');
const backupModule = require('../apps/api/dist/database/sqlite-backup');
const load = (name, symbol) => require(`../apps/api/dist/modules/${name}`)[symbol];
const MaintenanceService = load('maintenance/maintenance.service', 'MaintenanceService');
const MaintenanceController = load('maintenance/maintenance.controller', 'MaintenanceController');
const TasksService = load('tasks/tasks.service', 'TasksService');
const AuditService = load('audit/audit.service', 'AuditService');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnagent-retention-')); const file = path.join(root, 'source.sqlite');
  const db = await new DataSource({ ...sqliteOptions(file), migrations: SQLITE_MIGRATIONS.slice(0, 4) }).initialize();
  let app; const backup = backupModule.createSqliteBackup;
  try {
    await db.runMigrations(); const repo = (entity) => db.getRepository(entity);
    const text = '中文原始证据🙂完整保留在备份中'; const blob = Buffer.from([0, 1, 2, 255, 18, 0]);
    const evidence = (id, taskId) => repo(E.EvidenceEntity).save({ id, taskId, title: id, kind: 'command_output', content: text, sha256: createHash('sha256').update(text).digest('hex'), sizeBytes: Buffer.byteLength(text) });
    // Legacy task orphans existed before the ownership migration; upgrade must preserve them until explicit maintenance.
    await evidence('orphan-evidence', 'missing-safe');
    await repo(E.EvidenceAttachmentEntity).save({ id: 'orphan-blob', taskId: 'missing-safe', evidenceId: 'orphan-evidence', filename: 'binary.bin', mimeType: 'application/octet-stream', sha256: createHash('sha256').update(blob).digest('hex'), sizeBytes: blob.length, data: blob });
    await repo(E.ToolCallEntity).save({ id: 'orphan-pending', taskId: 'missing-blocked', toolName: 'fixture', arguments: {}, status: 'pending_approval' });
    await repo(E.AuditLogEntity).save({ id: 'orphan-audit', taskId: 'missing-audit', action: 'legacy.action', entityType: 'task', entityId: 'missing-audit' });
    await evidence('global-evidence', null);
    db.migrations.push(...SQLITE_MIGRATIONS.slice(4).map((Migration) => new Migration())); await db.runMigrations();
    await db.query('PRAGMA journal_mode=WAL');
    for (const [id, status, date] of [['old-a', 'completed', '2020-01-01'], ['old-b', 'stopped', '2021-01-01'], ['old-blocked', 'failed', '2020-02-01'], ['kept', 'completed', '2024-01-01'], ['fresh', 'completed', '2026-01-01'], ['unfinished', 'completed', null], ['running', 'running', '2020-01-01'], ['paused', 'paused', '2020-01-01']]) {
      await repo(E.TaskEntity).save({ id, name: id, status, finishedAt: date ? new Date(`${date}T00:00:00Z`) : null, scope: {}, modelName: 'fixture', modelProvider: 'fixture' });
    }
    await repo(E.AgentSessionEntity).save({ id: 'blocked-session', taskId: 'old-blocked', role: 'explore', sessionKey: 'blocked-session', modelName: 'fixture', state: 'paused' });
    await evidence('old-evidence', 'old-a'); await evidence('kept-evidence', 'kept');
    await repo(E.EvidenceAttachmentEntity).save({ id: 'old-blob', taskId: 'old-a', evidenceId: 'old-evidence', filename: 'binary.bin', mimeType: 'application/octet-stream', sha256: createHash('sha256').update(blob).digest('hex'), sizeBytes: blob.length, data: blob });
    await repo(E.ReportEntity).save({ id: 'old-report', taskId: 'old-a', title: '冻结报告', format: 'markdown', status: 'draft', content: text });
    await repo(E.ReportAttachmentEntity).save({ reportId: 'old-report', attachmentId: 'old-blob', taskId: 'old-a', evidenceId: 'old-evidence', filename: 'binary.bin', mimeType: 'application/octet-stream', sha256: createHash('sha256').update(blob).digest('hex'), sizeBytes: blob.length, data: blob });
    await repo(E.AuditLogEntity).save({ id: 'old-audit', taskId: 'old-a', action: 'fixture.action', entityType: 'evidence', entityId: 'old-evidence' });
    const pushes = []; let failPush = false;
    const events = { broadcast(type, data) { assert.equal(db.createQueryRunner().isTransactionActive, false); pushes.push({ type, data }); if (failPush) throw new Error('fixture socket failure'); } };
    const audit = new AuditService(repo(E.AuditLogEntity), events);
    const tasks = new TasksService(repo(E.TaskEntity), repo(E.TargetEntity), repo(E.TaskStateEventEntity), db, audit, events);
    let directory = path.join(root, 'backups'); const config = { get: () => directory };
    const service = new MaintenanceService(db, tasks, audit, events, config);
    class TestModule {} Module({ controllers: [MaintenanceController], providers: [{ provide: MaintenanceService, useValue: service }] })(TestModule);
    app = await createTestApp(TestModule, { logger: false }); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true })); await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/maintenance`;
    const request = (endpoint, body) => fetch(`${base}/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const policy = { before: '2025-01-01T00:00:00Z', keepLatest: 2, includeOrphans: true, page: 1 };
    const preview = async (input = policy) => { const response = await request('preview', input); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
    const apply = (plan, patch = {}) => request('apply', { ...plan.policy, expiresAt: plan.expiresAt, digest: plan.digest, confirmation: '清理这些数据', ...patch });
    let plan = await preview();
    assert.deepEqual(plan.tasks.filter((row) => !row.blockedReason).map((row) => row.taskId), ['old-a', 'old-b']);
    assert.ok(plan.tasks.find((row) => row.taskId === 'old-blocked').blockedReason);
    assert.deepEqual(plan.orphans.filter((row) => !row.blockedReason).map((row) => row.taskId), ['missing-audit', 'missing-safe']);
    assert.ok(plan.orphans.find((row) => row.taskId === 'missing-blocked').blockedReason);
    assert.equal(plan.tasks[0].rows.evidence_attachments, 1); assert.equal(plan.backupAvailable, true); assert.equal(fs.existsSync(directory), false, 'preview does not create backup or mutate rows');
    await repo(E.TaskEntity).update('old-b', { engineStatus: 'running' });
    assert.match((await preview()).tasks.find((row) => row.taskId === 'old-b').blockedReason, /执行引擎尚未收尾/);
    await repo(E.TaskEntity).update('old-b', { engineStatus: 'idle' }); plan = await preview();
    assert.equal((await apply(plan, { confirmation: 'wrong' })).status, 400);
    assert.equal((await apply(plan, { digest: '0'.repeat(64) })).status, 409);
    assert.equal((await apply(plan, { expiresAt: '2000-01-01T00:00:00Z' })).status, 409);
    assert.equal((await apply(plan, { keepLatest: 0 })).status, 409);
    await assert.rejects(() => new MaintenanceService(db, tasks, audit, events, config).apply({ ...plan.policy, expiresAt: plan.expiresAt, digest: plan.digest, confirmation: '清理这些数据' }), /已变化/);
    await repo(E.AuditLogEntity).update('old-audit', { detail: { changed: true } }); assert.equal((await apply(plan)).status, 409, 'even same-count row edits invalidate preview');
    for (const patch of [{ before: 'bad' }, { before: '2099-01-01T00:00:00Z' }, { before: '2020-01-01T00:00:00+08:00' }, { keepLatest: -1 }, { keepLatest: '1' }, { page: 0 }, { includeOrphans: 'true' }]) assert.equal((await request('preview', { ...policy, ...patch })).status, 400);
    const badDir = path.join(root, 'not-a-directory'); fs.writeFileSync(badDir, 'fixture'); directory = badDir;
    plan = await preview(); assert.equal((await apply(plan)).status, 500); assert.equal(await repo(E.TaskEntity).count(), 8); assert.equal(pushes.length, 0);
    directory = path.join(root, 'backups');
    await db.query("CREATE TRIGGER fixture_maintenance_audit BEFORE INSERT ON audit_logs WHEN NEW.action='maintenance.applied' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
    plan = await preview(); assert.equal((await apply(plan)).status, 500); assert.equal(await repo(E.TaskEntity).count(), 8); assert.equal(await repo(E.TaskDeletionEntity).count(), 0); assert.equal(pushes.length, 0);
    assert.equal(fs.readdirSync(directory).length, 1, 'valid safety backup survives mutation failure');
    await db.query('DROP TRIGGER fixture_maintenance_audit');
    await db.query("CREATE TRIGGER fixture_maintenance_child BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT, 'fixture child failure'); END");
    plan = await preview(); assert.equal((await apply(plan)).status, 500); assert.equal(await repo(E.TaskEntity).count(), 8); assert.ok(await repo(E.EvidenceEntity).existsBy({ id: 'orphan-evidence' })); assert.equal(await repo(E.TaskDeletionEntity).count(), 0);
    assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'maintenance.applied' }), 0); assert.equal(pushes.length, 0);
    await db.query('DROP TRIGGER fixture_maintenance_child');
    let release; let activity; let startActivity = true; let probed = false;
    backupModule.createSqliteBackup = async (...args) => {
      const writer = new Database(file, { timeout: 1 });
      try { assert.throws(() => writer.prepare('UPDATE tasks SET name=? WHERE id=?').run('must-not-write', 'old-a'), /locked/); probed = true; }
      finally { writer.close(); }
      const result = await backup(...args);
      if (startActivity) activity = trackTaskActivity(db.manager, 'old-a', () => new Promise((resolve) => { release = resolve; }));
      return result;
    };
    plan = await preview(); assert.equal((await apply(plan)).status, 409, 'activity starting during backup is recertified'); release(); await activity; startActivity = false;
    assert.equal(await repo(E.TaskEntity).count(), 8); assert.equal(pushes.length, 0);
    // Cross-task attachment cascades are not allowed to delete a sibling's data.
    await repo(E.EvidenceAttachmentEntity).save({ id: 'cross-task', taskId: 'kept', evidenceId: 'old-evidence', filename: 'cross.bin', mimeType: 'application/octet-stream', sha256: 'fixture', sizeBytes: 0, data: Buffer.alloc(0) });
    plan = await preview(); assert.match(plan.tasks.find((row) => row.taskId === 'old-a').blockedReason, /跨任务附件/);
    await assert.rejects(() => tasks.remove('old-a'), /跨任务附件/);
    await repo(E.EvidenceAttachmentEntity).delete('cross-task');
    plan = await preview(); failPush = true; const competing = await Promise.all([apply(plan), apply(plan)]); assert.deepEqual(competing.map((response) => response.status).sort(), [200, 409]); const result = await competing.find((response) => response.status === 200).json();
    assert.deepEqual(result.deletedTasks, ['old-a', 'old-b']); assert.deepEqual(result.cleanedOrphanTasks, ['missing-audit', 'missing-safe']); assert.equal(probed, true);
    assert.equal(await repo(E.TaskEntity).count(), 6); assert.equal(await repo(E.TaskDeletionEntity).count(), 4);
    for (const id of ['fresh', 'kept', 'unfinished', 'running', 'paused', 'old-blocked']) assert.ok(await repo(E.TaskEntity).existsBy({ id }));
    assert.equal(await repo(E.EvidenceAttachmentEntity).count(), 0); assert.equal(await repo(E.ReportAttachmentEntity).count(), 0);
    assert.ok(await repo(E.EvidenceEntity).existsBy({ id: 'global-evidence' })); assert.ok(await repo(E.EvidenceEntity).existsBy({ id: 'kept-evidence' })); assert.ok(await repo(E.ToolCallEntity).existsBy({ id: 'orphan-pending' }));
    for (const id of ['old-audit', 'orphan-audit']) assert.equal((await repo(E.AuditLogEntity).findOneByOrFail({ id })).taskId, null);
    assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'task.delete' }), 2); assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'maintenance.applied' }), 1);
    const restored = new Database(path.join(result.backup.path, 'database.sqlite'), { readonly: true, fileMustExist: true });
    try { assert.equal(restored.prepare('SELECT COUNT(*) n FROM tasks').get().n, 8); assert.equal(restored.prepare('SELECT content FROM evidence WHERE id=?').get('old-evidence').content, text); assert.deepEqual(restored.prepare('SELECT data FROM evidence_attachments WHERE id=?').get('old-blob').data, blob); assert.deepEqual(restored.prepare('SELECT data FROM report_attachments WHERE attachmentId=?').get('old-blob').data, blob); assert.ok(restored.prepare('SELECT id FROM evidence WHERE id=?').get('orphan-evidence')); }
    finally { restored.close(); }
    assert.equal((await backupModule.verifySqliteBackup(result.backup.path)).sha256, result.backup.sha256);
    assert.equal((await apply(plan)).status, 409, 'successful plan cannot replay');
    await assert.rejects(() => repo(E.TaskEntity).save({ id: 'missing-safe', name: 'late callback', modelName: 'fixture', modelProvider: 'fixture', scope: {} }), /cannot be recreated/);
    await db.query('UPDATE tasks SET finishedAt=? WHERE id=?', ['not-a-date', 'unfinished']);
    const invalidDatePlan = await preview();
    assert.deepEqual(invalidDatePlan.tasks.map((row) => row.taskId), ['old-blocked'], 'invalid legacy dates cannot displace the newest valid tasks or become deletion candidates');
    // Pagination is bounded for both task and orphan candidate lists.
    for (let index = 0; index < 102; index++) await repo(E.TaskEntity).save({ id: `page-${index}`, name: '分页', status: 'stopped', finishedAt: new Date('2010-01-01T00:00:00Z'), modelName: 'fixture', modelProvider: 'fixture', scope: {} });
    const firstPage = await preview({ ...policy, keepLatest: 0, includeOrphans: false }); const secondPage = await preview({ ...policy, keepLatest: 0, includeOrphans: false, page: 2 });
    assert.equal(firstPage.tasks.length, 100); assert.equal(secondPage.tasks.length, 4); assert.equal(firstPage.taskCandidates, 104); assert.equal(firstPage.orphans.length, 0);
    for (let index = 0; index < 102; index++) await repo(E.AuditLogEntity).save({ id: `orphan-page-audit-${index}`, taskId: `orphan-page-${index}`, action: 'legacy.action', entityType: 'task' });
    const orphanFirst = await preview({ ...policy, keepLatest: 0 }); const orphanSecond = await preview({ ...policy, keepLatest: 0, page: 2 });
    assert.equal(orphanFirst.orphans.length, 100); assert.equal(orphanSecond.orphans.length, 3); assert.equal(orphanFirst.orphanCandidates, 103);
    assert.equal(new Set([...orphanFirst.orphans, ...orphanSecond.orphans].map((row) => row.taskId)).size, 103);
    const memory = await new DataSource(sqliteOptions(':memory:')).initialize();
    try {
      await memory.runMigrations(); const mr = (entity) => memory.getRepository(entity); const memoryAudit = new AuditService(mr(E.AuditLogEntity), { broadcast() {} });
      const memoryTasks = new TasksService(mr(E.TaskEntity), mr(E.TargetEntity), mr(E.TaskStateEventEntity), memory, memoryAudit, { broadcast() {} });
      const memoryService = new MaintenanceService(memory, memoryTasks, memoryAudit, { broadcast() {} }, config);
      const memoryPlan = await memoryService.preview(policy); assert.equal(memoryPlan.backupAvailable, false);
      await assert.rejects(() => memoryService.apply({ ...memoryPlan.policy, expiresAt: memoryPlan.expiresAt, digest: memoryPlan.digest, confirmation: '清理这些数据' }), /内存库不能执行清理/);
    } finally { await memory.destroy(); }
    console.log('PASS: real migrated legacy orphans, bounded retention policy and quiescence, HMAC/expiry/restart/any-write recertification, real HTTP validation, backup/SQLite write fence, full Unicode/BLOB/report preservation, backup/audit/child faults, activity race, cross-task cascade protection, atomic cleanup/tombstones/audit, retained global/sibling/blocked data, notifications and pagination; no target operations');
  } finally {
    backupModule.createSqliteBackup = backup; if (app) await app.close(); await db.destroy();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('vulnagent-retention-')); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
