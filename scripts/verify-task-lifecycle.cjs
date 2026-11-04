const createTestApp = require('./create-test-app.cjs');
const backendRequire = require('./backend-require.cjs');
// This regression exercises an explicitly enabled engine; disabled behavior has its own fixture.
process.env.PI_RUNTIME_ENABLED = 'true';
// 隔离迁移数据库与本机 HTTP。模型/工具仅返回固定数据，不执行靶机操作。
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = backendRequire('typeorm');
const { Module, ValidationPipe } = backendRequire('@nestjs/common');
const { NestFactory } = backendRequire('@nestjs/core');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const { TaskOwnership1793577604000 } = require('../apps/api/dist/database/migrations/1793577604000-TaskOwnership');
const { TASK_OWNED_TABLES_V3: TASK_OWNED_TABLES_V1 } = require('../apps/api/dist/database/migrations/1793577608000-FindingAssessments');
const { trackTaskActivity } = require('../apps/api/dist/database/task-activity');
const { TasksService } = require('../apps/api/dist/modules/tasks/tasks.service');
const { TasksController } = require('../apps/api/dist/modules/tasks/tasks.controller');
const { OrchestratorController } = require('../apps/api/dist/modules/orchestrator/orchestrator.controller');
const { IntentsService } = require('../apps/api/dist/modules/blackboard/intents.service');
const { OrchestratorService } = require('../apps/api/dist/modules/orchestrator/orchestrator.service');
const { createToolStack } = require('../apps/api/dist/modules/tool/tool-stack');
const { ToolCatalogService } = require('../apps/api/dist/modules/tool/tool-catalog.service');

async function main() {
  const db = await new DataSource(sqliteOptions(':memory:')).initialize();
  let app; let orchestrator;
  try {
    await db.runMigrations();
    const repo = (entity) => db.getRepository(entity);
    const gateway = { broadcast() {} }; const audit = new (require('../apps/api/dist/modules/audit/audit.service').AuditService)(repo(E.AuditLogEntity), gateway);
    const tasks = new TasksService(repo(E.TaskEntity), repo(E.TargetEntity), repo(E.TaskStateEventEntity), db, audit, gateway);
    const intents = new IntentsService(repo(E.IntentEntity), gateway);
    const dto = { name: '生命周期夹具', authorized: true, targets: [{ ip: '192.168.56.101' }], scope: { cidrs: ['192.168.56.0/24'], ports: '80' }, goal: { mode: 'recon', targets: ['192.168.56.101'], ports: '80', protocol: 'tcp', evidenceText: null }, modelProvider: 'fixture', modelName: 'fixture', tokenBudget: 10000, timeBudgetMinutes: 10, workerCount: 1, autoStart: false };
    const task = await tasks.create(dto);
    await repo(E.TaskEntity).update(task.id, { status: 'running', engineStatus: 'running' });
    const interruptedControl = randomUUID();
    await repo(E.TaskStateEventEntity).save({ id: interruptedControl, taskId: task.id, eventType: 'task.resumed', consumedAt: null });
    orchestrator = new OrchestratorService(repo(E.TaskEntity), repo(E.TargetEntity), repo(E.IntentEntity), repo(E.OrchestratorRunEntity), repo(E.TaskStateEventEntity), { sessions: { reconcile: async () => 0 } }, { counts: async () => ({}), progressKeys: async () => [] }, { counts: async () => ({}) }, {}, { listByTask: async () => [], findRunningAll: async () => [] }, {}, {}, {}, gateway, audit, {});
    orchestrator.onModuleDestroy();
    await db.query("CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'engine.recovered' BEGIN SELECT RAISE(FAIL, 'injected recovery audit failure'); END");
    await assert.rejects(orchestrator.onApplicationBootstrap(), /injected recovery audit failure/);
    assert.equal((await repo(E.TaskEntity).findOneByOrFail({ id: task.id })).status, 'running');
    assert.equal((await repo(E.TaskStateEventEntity).findOneByOrFail({ id: interruptedControl })).consumedAt, null);
    await db.query('DROP TRIGGER reject_recovery_audit'); await orchestrator.onApplicationBootstrap();
    assert.equal((await repo(E.TaskEntity).findOneByOrFail({ id: task.id })).status, 'paused');
    assert.equal((await repo(E.TaskEntity).findOneByOrFail({ id: task.id })).engineStatus, 'needs_input');
    assert.ok((await repo(E.TaskStateEventEntity).findOneByOrFail({ id: interruptedControl })).consumedAt);
    assert.equal(await repo(E.AuditLogEntity).countBy({ taskId: task.id, action: 'engine.recovered' }), 1);
    let cycles = 0;
    orchestrator.registerCycleBody(async () => { cycles++; });
    await orchestrator.consumeTaskStateEvents(); assert.equal(cycles, 0, 'old resume request must not restart an interrupted task');
    await repo(E.TaskEntity).update(task.id, { status: 'running', engineStatus: 'running', stopReason: null, lastError: null });
    const beforeActionEvents = await repo(E.TaskStateEventEntity).countBy({ taskId: task.id });
    class TestModule {}
    Module({ controllers: [TasksController, OrchestratorController], providers: [{ provide: TasksService, useValue: tasks }, { provide: OrchestratorService, useValue: orchestrator }] })(TestModule);
    app = await createTestApp(TestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api'); // 与生产入口一致；前端 client 统一请求 /api 前缀。
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    const action = (id, name) => fetch(`${base}/api/tasks/${id}/${name}`, { method: 'POST' });
    const remove = (id) => fetch(`${base}/api/tasks/${id}`, { method: 'DELETE' });

    // 新建任务必须能启动：启动请求不得先被旧事件/状态机拦住，消费器必须真正进入编排。
    const fresh = await tasks.create({ ...dto, name: '新建任务启动夹具', autoStart: false });
    assert.equal((await fetch(`${base}/api/tasks/${fresh.id}/engine/start`, { method: 'POST' })).status, 201);
    const queued = await repo(E.TaskEntity).findOneByOrFail({ id: fresh.id });
    assert.equal(queued.status, 'running'); assert.equal(queued.engineStatus, 'idle');
    assert.equal((await repo(E.TaskStateEventEntity).countBy({ taskId: fresh.id, eventType: 'task.start_requested' })), 1);
    await orchestrator.consumeTaskStateEvents(); await new Promise((r) => setTimeout(r, 5));
    const started = await repo(E.TaskEntity).findOneByOrFail({ id: fresh.id });
    assert.equal(started.engineStatus, 'running', 'start_requested must be consumed into a real engine context');
    assert.ok(orchestrator.getContext(fresh.id), 'orchestrator context must exist after consuming start');
    assert.equal(cycles, 1, 'start_requested must drive one real planning cycle');
    cycles = 0;
    // 另一个任务的失败事件不能饿死后续任务的启动请求。
    await repo(E.TaskStateEventEntity).save({ id: 'poison', taskId: task.id, eventType: 'tool.approval_resolved', payload: null, consumedAt: null });
    const second = await tasks.create({ ...dto, name: '队首阻塞夹具', autoStart: false });
    assert.equal((await action(second.id, 'engine/start')).status, 201);
    await orchestrator.consumeTaskStateEvents(); await new Promise((r) => setTimeout(r, 5));
    assert.ok(orchestrator.getContext(second.id), 'a stuck event on another task must not block this start');
    assert.equal((await repo(E.TaskStateEventEntity).findOneByOrFail({ id: 'poison' })).consumedAt, null, 'failed events stay queued for retry');
    await repo(E.TaskStateEventEntity).delete({ id: 'poison' });
    cycles = 0;
    await orchestrator.stop(second.id); await orchestrator.stop(fresh.id);

    assert.equal((await remove(task.id)).status, 409);

    // 审计或事件失败，任务状态不能先行改变。
    for (const [table, name] of [['audit_logs', 'reject_action_audit'], ['task_state_events', 'reject_action_event']]) {
      await db.query(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(FAIL, 'injected action failure'); END`);
      assert.equal((await action(task.id, 'pause')).status, 500);
      assert.equal((await repo(E.TaskEntity).findOneByOrFail({ id: task.id })).status, 'running');
      assert.equal(await repo(E.TaskStateEventEntity).countBy({ taskId: task.id }), beforeActionEvents);
      await db.query(`DROP TRIGGER ${name}`);
    }
    const pauseAttempts = await Promise.all([action(task.id, 'pause'), action(task.id, 'pause')]);
    assert.deepEqual(pauseAttempts.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await action(task.id, 'resume')).status, 409, 'cannot enqueue a second lifecycle action before first is consumed');
    await orchestrator.consumeTaskStateEvents();
    assert.equal((await repo(E.TaskEntity).findOneByOrFail({ id: task.id })).engineStatus, 'paused', 'task.pause must actually reach orchestrator');
    assert.equal((await action(task.id, 'resume')).status, 201);
    await orchestrator.consumeTaskStateEvents(); await new Promise((r) => setTimeout(r, 5));
    assert.equal(cycles, 1, 'task.resume must start/resume real cycle entry');
    assert.equal((await action(task.id, 'stop')).status, 201);
    await orchestrator.consumeTaskStateEvents();
    assert.equal((await repo(E.TaskEntity).findOneByOrFail({ id: task.id })).engineStatus, 'stopped');

    // 旧数据留存，但不能继续派发或占住新一轮相同意图的去重键。
    const old = await intents.create({ taskId: task.id, title: 'scan same port', dedupeKey: 'same-plan', targetIp: '192.168.56.101' });
    await repo(E.HintEntity).save({ id: 'old-hint', taskId: task.id, content: 'old hint' });
    await repo(E.WorkerTaskEntity).save({ id: 'queued', taskId: task.id, title: 'old queued', status: 'queued', intentId: old.intent.id });
    await repo(E.FindingEntity).save({ id: 'finding', taskId: task.id, title: 'candidate', description: 'fixture candidate', severity: 'low', status: 'verifying', evidenceIds: [] });
    await repo(E.FindingVerificationEntity).save({ id: 'verification', taskId: task.id, findingId: 'finding', intentId: old.intent.id, outcome: 'pending' });
    await repo(E.EvidenceEntity).save({ id: 'historical', taskId: task.id, kind: 'command_output', title: 'old evidence', content: 'history remains' });
    await repo(E.ReportEntity).save({ id: 'old-report', taskId: task.id, title: 'old report', format: 'markdown', content: 'frozen old report' });
    const before = await repo(E.TaskEntity).findOneByOrFail({ id: task.id });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await action(task.id, 'rerun')).status, 201);
    const rerun = await repo(E.TaskEntity).findOneByOrFail({ id: task.id });
    assert.equal(rerun.status, 'pending'); assert.equal(rerun.engineStatus, 'idle');
    assert.equal(rerun.startedAt, null); assert.equal(rerun.tokensUsed, 0); assert.equal(rerun.stopReason, null);
    assert.ok(new Date(rerun.goal.configuredAt) > new Date(before.goal.configuredAt));
    assert.equal((await repo(E.IntentEntity).findOneByOrFail({ id: old.intent.id })).status, 'rejected');
    assert.equal((await repo(E.HintEntity).findOneByOrFail({ id: 'old-hint' })).status, 'dismissed');
    assert.equal((await repo(E.WorkerTaskEntity).findOneByOrFail({ id: 'queued' })).status, 'cancelled');
    assert.equal((await repo(E.FindingVerificationEntity).findOneByOrFail({ id: 'verification' })).outcome, 'inconclusive');
    assert.equal((await repo(E.FindingEntity).findOneByOrFail({ id: 'finding' })).status, 'unconfirmed');
    assert.equal((await repo(E.EvidenceEntity).findOneByOrFail({ id: 'historical' })).content, 'history remains');
    assert.equal((await repo(E.ReportEntity).findOneByOrFail({ id: 'old-report' })).content, 'frozen old report');
    assert.equal((await intents.create({ taskId: task.id, title: 'scan same port again', dedupeKey: 'same-plan' })).created, true);
    // 用户在轮询消费之前立即启动；旧 rerun 事件不能删掉刚创建的新上下文。
    await orchestrator.start(task.id); await new Promise((r) => setTimeout(r, 5));
    const newContext = orchestrator.getContext(task.id);
    const rerunEvent = await repo(E.TaskStateEventEntity).findOneByOrFail({ taskId: task.id, eventType: 'task.rerun' });
    newContext.startedAt = rerunEvent.createdAt; // 相同毫秒仍必须按运行 ID 区分。
    await orchestrator.consumeTaskStateEvents();
    assert.equal(orchestrator.getContext(task.id), newContext);
    await orchestrator.stop(task.id);

    // 活跃工作、未收尾审批、会话和待消费事件均阻止删除/重跑。
    let release; const held = trackTaskActivity(db.manager, task.id, () => new Promise((r) => { release = r; }));
    assert.equal((await remove(task.id)).status, 409); assert.equal((await action(task.id, 'rerun')).status, 409);
    release(); await held;
    await repo(E.McpServerEntity).save({ id: 'fixture-server', name: 'fixture', endpoint: 'http://unused.invalid/mcp' });
    await repo(E.McpToolEntity).save({ id: 'fixture-tool', mcpServerId: 'fixture-server', name: 'fixture_read', riskLevel: 'safe', inputSchema: { type: 'object', properties: { target: { type: 'string' } } }, syncedAt: new Date() });
    await repo(E.AgentToolPermissionEntity).save({ id: 'fixture-permission', taskId: task.id, agentRole: 'explore', toolPattern: '*', allowed: true, requireApproval: false });
    let releaseTool; let entered;
    const toolStarted = new Promise((r) => { entered = r; });
    const stack = createToolStack({
      servers: repo(E.McpServerEntity), tools: repo(E.McpToolEntity), targets: repo(E.TargetEntity), tasks: repo(E.TaskEntity),
      permissions: repo(E.AgentToolPermissionEntity), rules: repo(E.InterceptRuleEntity), calls: repo(E.ToolCallEntity),
      events: gateway, audit: { record: async () => ({}) },
      factory: { callTool: async () => { entered(); return new Promise((r) => { releaseTool = () => r({ ok: true, text: 'fixture result', latencyMs: 1, isError: false, raw: { content: [{ type: 'text', text: 'fixture result' }] } }); }); } },
    });
    await new ToolCatalogService(repo(E.McpServerEntity), repo(E.McpToolEntity), stack.registry, stack.driver).sync();
    const inFlight = stack.invoker.invoke('fixture_read', { target: '192.168.56.101' }, { taskId: task.id, sessionId: null, role: 'explore', authorizedTargets: [], allowedTools: [] });
    await toolStarted;
    assert.equal((await remove(task.id)).status, 409, 'actual executor must register activity before a call row exists');
    assert.equal((await action(task.id, 'rerun')).status, 409);
    releaseTool(); assert.equal((await inFlight).failureKind, null);
    await repo(E.ToolCallEntity).save({ id: 'pending', taskId: task.id, toolName: 'fixture', arguments: {}, status: 'pending_approval', approvedAt: new Date(), replayOfId: 'pending' });
    assert.equal((await remove(task.id)).status, 409); assert.equal((await action(task.id, 'rerun')).status, 409);
    await repo(E.ToolCallEntity).delete('pending');
    await repo(E.AgentSessionEntity).save({ id: 'paused-session', taskId: task.id, role: 'planner', modelName: 'fixture', sessionKey: 'paused-session', state: 'paused' });
    assert.equal((await remove(task.id)).status, 409);
    await repo(E.AgentSessionEntity).update('paused-session', { state: 'terminated' });
    await repo(E.TaskStateEventEntity).save({ id: 'pending-event', taskId: task.id, eventType: 'fixture', payload: null });
    assert.equal((await remove(task.id)).status, 409);
    await repo(E.TaskStateEventEntity).update('pending-event', { consumedAt: new Date() });

    // 根据真实元数据给每张归属表写入父/兄弟/全局夹具，验证数据库层全量清理。
    const metadataNames = db.entityMetadatas.filter((m) => m.columns.some((c) => c.propertyName === 'taskId') && !['audit_logs', 'task_deletions'].includes(m.tableName)).map((m) => m.tableName).sort();
    assert.deepEqual(metadataNames, [...TASK_OWNED_TABLES_V1].sort(), 'new owned tables must extend lifecycle migration');
    const sibling = await tasks.create({ ...dto, name: 'sibling' });
    async function seedOwned(taskId) {
      const rows = new Map();
      for (const tableName of TASK_OWNED_TABLES_V1) {
        const meta = db.entityMetadatas.find((m) => m.tableName === tableName);
        const taskColumn = meta.columns.find((c) => c.propertyName === 'taskId');
        if (taskId === null && !taskColumn.isNullable) continue;
        const input = { taskId };
        for (const c of meta.columns) {
          if (c.propertyName === 'taskId' || c.isCreateDate || c.isUpdateDate || c.default !== undefined || c.isNullable) continue;
          if (c.propertyName === 'reportId') input[c.propertyName] = rows.get('reports').id;
          else if (c.propertyName === 'evidenceId') input[c.propertyName] = rows.get('evidence').id;
          else if (c.isPrimary) input[c.propertyName] = randomUUID();
          else if (c.type === 'blob') input[c.propertyName] = Buffer.from('fixture');
          else if (c.type === 'simple-json') input[c.propertyName] = {};
          else if (c.type === Number || ['integer', 'real'].includes(c.type)) input[c.propertyName] = 1;
          else if (c.type === Boolean || c.type === 'boolean') input[c.propertyName] = false;
          else input[c.propertyName] = randomUUID();
        }
        if (tableName === 'agent_sessions') input.state = 'completed';
        if (tableName === 'worker_tasks') input.status = 'succeeded';
        if (tableName === 'tool_calls') input.status = 'success';
        if (tableName === 'task_state_events') input.consumedAt = new Date();
        rows.set(tableName, await repo(meta.target).save(repo(meta.target).create(input)));
      }
      return rows;
    }
    await seedOwned(task.id); const siblingRows = await seedOwned(sibling.id); await seedOwned(null);
    await repo(E.AuditLogEntity).save({ id: 'retained-audit', action: 'fixture', entityType: 'task', entityId: task.id, taskId: task.id });
    const counts = new Map();
    for (const name of TASK_OWNED_TABLES_V1) counts.set(name, await db.query(`SELECT taskId, COUNT(*) AS n FROM "${name}" WHERE taskId IS NULL OR taskId = ? GROUP BY taskId`, [sibling.id]));
    const savedTask = await repo(E.TaskEntity).findOneByOrFail({ id: task.id });
    const [guard] = await db.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'task_owner_facts_insert'");
    await db.query('DROP TRIGGER task_owner_facts_insert');
    assert.equal((await remove(task.id)).status, 409, 'missing ownership migration/guard must block deletion');
    await db.query(guard.sql);
    await db.query("CREATE TRIGGER fail_task_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(FAIL, 'injected deletion failure'); END");
    assert.equal((await remove(task.id)).status, 500);
    assert.ok(await repo(E.TaskEntity).existsBy({ id: task.id }));
    assert.equal(await repo(E.TaskDeletionEntity).count(), 0);
    assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'task.delete' }), 0);
    await db.query('DROP TRIGGER fail_task_delete');
    await db.query("CREATE TRIGGER fail_owned_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(FAIL, 'injected child deletion failure'); END");
    assert.equal((await remove(task.id)).status, 500);
    assert.ok(await repo(E.TaskEntity).existsBy({ id: task.id }));
    for (const name of TASK_OWNED_TABLES_V1) assert.ok((await db.query(`SELECT COUNT(*) AS n FROM "${name}" WHERE taskId = ?`, [task.id]))[0].n > 0, `${name}: rollback restores earlier child deletions`);
    await db.query('DROP TRIGGER fail_owned_delete');
    assert.equal((await remove(task.id)).status, 200);
    assert.equal((await remove(task.id)).status, 404);
    for (const name of TASK_OWNED_TABLES_V1) {
      assert.equal((await db.query(`SELECT COUNT(*) AS n FROM "${name}" WHERE taskId = ?`, [task.id]))[0].n, 0, name);
      assert.deepEqual(await db.query(`SELECT taskId, COUNT(*) AS n FROM "${name}" WHERE taskId IS NULL OR taskId = ? GROUP BY taskId`, [sibling.id]), counts.get(name), `${name}: sibling/global preservation`);
      await assert.rejects(db.query(`UPDATE "${name}" SET taskId = ? WHERE taskId = ?`, [task.id, sibling.id]), /task no longer exists/);
      const meta = db.entityMetadatas.find((m) => m.tableName === name);
      const late = { ...siblingRows.get(name), taskId: task.id };
      for (const c of meta.primaryColumns) late[c.propertyName] = randomUUID();
      await assert.rejects(repo(meta.target).insert(late), /task no longer exists/);
    }
    assert.equal((await repo(E.AuditLogEntity).findOneByOrFail({ id: 'retained-audit' })).taskId, null);
    assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'task.delete' }), 1);
    assert.ok(await repo(E.TaskDeletionEntity).existsBy({ taskId: task.id }));
    await assert.rejects(repo(E.TaskEntity).save(savedTask), /deleted task cannot be recreated/);
    await assert.rejects(new TaskOwnership1793577604000().down(db.createQueryRunner()), /防重建记录非空/);
    await orchestrator.consumeTaskStateEvents(); assert.equal(orchestrator.getContext(task.id), undefined);
    console.log('PASS: real lifecycle event consumption, atomic state/audit/events and concurrent actions, rerun cancellation/dedupe/history, late rerun versus new context, quiescence guards, all 25 owned tables cascade, sibling/global isolation, late insert/update rejection, deleted-task resurrection prevention and rollback protection');
  } finally { if (orchestrator) orchestrator.onModuleDestroy(); if (app) await app.close(); await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
