// Real migrated database and HTTP control routes; no model, tool, target or user data access.
const backendRequire = require('./backend-require.cjs');
const createTestApp = require('./create-test-app.cjs');
backendRequire('reflect-metadata'); process.env.PI_RUNTIME_ENABLED = 'true';
const assert = require('node:assert/strict');
const { DataSource, IsNull } = backendRequire('typeorm');
const { Module, ValidationPipe } = backendRequire('@nestjs/common');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const load = (name, symbol) => require(`../apps/api/dist/modules/${name}`)[symbol];
const TasksService = load('tasks/tasks.service', 'TasksService');
const TasksController = load('tasks/tasks.controller', 'TasksController');
const OrchestratorService = load('orchestrator/orchestrator.service', 'OrchestratorService');
const OrchestratorController = load('orchestrator/orchestrator.controller', 'OrchestratorController');

async function main() {
  const db = await new DataSource(sqliteOptions(':memory:')).initialize(); let app; let engine;
  try {
    await db.runMigrations(); const repo = (entity) => db.getRepository(entity);
    const pushes = []; let rejectPush = false;
    const gateway = { broadcast(type, data) { if (rejectPush) throw new Error('fixture disconnected socket'); pushes.push({ type, data }); } };
    const audit = new (load('audit/audit.service', 'AuditService'))(repo(E.AuditLogEntity), gateway);
    const tasks = new TasksService(repo(E.TaskEntity), repo(E.TargetEntity), repo(E.TaskStateEventEntity), db, audit, gateway);
    const sessionCalls = []; let cycles = 0;
    const sessions = { reconcile: async () => 0, pause: async (id) => { sessionCalls.push(['pause', id]); }, resume: async (id) => { sessionCalls.push(['resume', id]); }, terminate: async (id) => { sessionCalls.push(['terminate', id]); } };
    engine = new OrchestratorService(repo(E.TaskEntity), repo(E.TargetEntity), repo(E.IntentEntity), repo(E.OrchestratorRunEntity), repo(E.TaskStateEventEntity), { sessions }, { counts: async () => ({}), progressKeys: async () => [] }, { counts: async () => ({}) }, {}, { listByTask: async () => [], findRunningAll: async () => [], complete: async () => {} }, {}, {}, {}, gateway, audit, {});
    engine.onModuleDestroy(); await engine.onApplicationBootstrap(); engine.registerCycleBody(async () => { cycles++; });
    class TestModule {} Module({ controllers: [TasksController, OrchestratorController], providers: [{ provide: TasksService, useValue: tasks }, { provide: OrchestratorService, useValue: engine }] })(TestModule);
    app = await createTestApp(TestModule, { logger: false }); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true })); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    const input = { name: '引擎控制协议', authorized: true, targets: [{ ip: '192.0.2.10' }], scope: { cidrs: [], ports: '80' }, modelProvider: 'fixture', modelName: 'fixture', tokenBudget: 10000, timeBudgetMinutes: 10, workerCount: 1, autoStart: false };
    const task = await tasks.create(input); const id = task.id;
    const post = (action, engineRoute = true, taskId = id) => fetch(`${base}/tasks/${taskId}/${engineRoute ? 'engine/' : ''}${action}`, { method: 'POST' });
    const row = () => repo(E.TaskEntity).findOneByOrFail({ id });
    async function auditFault(action, work) {
      await db.query(`CREATE TRIGGER fixture_control_audit BEFORE INSERT ON audit_logs WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END`);
      try { await work(); } finally { await db.query('DROP TRIGGER fixture_control_audit'); }
    }
    assert.equal((await post('pause')).status, 409); assert.equal((await post('resume')).status, 409);
    assert.equal((await post('start', true, 'missing')).status, 404);
    await auditFault('task.start_requested', async () => { assert.equal((await post('start')).status, 500); assert.equal((await row()).status, 'pending'); assert.equal(await repo(E.TaskStateEventEntity).countBy({ taskId: id }), 0); });
    await db.query("CREATE TRIGGER fixture_control_event BEFORE INSERT ON task_state_events BEGIN SELECT RAISE(ABORT, 'fixture event failure'); END");
    assert.equal((await post('start')).status, 500); assert.equal((await row()).status, 'pending'); assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'task.start_requested' }), 0); await db.query('DROP TRIGGER fixture_control_event');
    const runner = db.createQueryRunner(); const commit = runner.commitTransaction.bind(runner); let fail = true;
    runner.commitTransaction = async () => { if (fail) { fail = false; throw new Error('fixture commit failure'); } return commit(); };
    try { assert.equal((await post('start')).status, 500); } finally { runner.commitTransaction = commit; }
    assert.equal((await row()).status, 'pending'); assert.equal(await repo(E.TaskStateEventEntity).countBy({ taskId: id }), 0);
    const starts = await Promise.all([post('start'), post('start')]); assert.deepEqual(starts.map((response) => response.status).sort(), [201, 409]);
    const accepted = await starts.find((response) => response.status === 201).json(); assert.equal(accepted.id, id); assert.equal(accepted.status, 'running');
    assert.equal((await post('pause', false)).status, 409, 'task and engine APIs share one pending-control fence');
    await auditFault('engine.start', async () => { await engine.consumeTaskStateEvents(); assert.equal(await repo(E.OrchestratorRunEntity).countBy({ taskId: id }), 0); assert.equal(engine.getContext(id), undefined); assert.equal((await row()).engineStatus, 'idle'); assert.equal(cycles, 0); });
    await engine.consumeTaskStateEvents(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(cycles, 1); assert.equal(await repo(E.OrchestratorRunEntity).countBy({ taskId: id }), 1);
    const ctx = engine.getContext(id); ctx.plannerSessionId = 'planner'; ctx.activeWorkers.set('worker', { sessionId: 'worker-session' });
    await auditFault('engine.pause', async () => {
      await assert.rejects(() => engine.pause(id), /fixture audit failure/);
      assert.equal((await row()).status, 'running'); assert.equal(ctx.status, 'planning'); assert.equal(sessionCalls.length, 0);
      assert.equal((await repo(E.OrchestratorRunEntity).findOneByOrFail({ id: ctx.runId })).status, 'planning');
    });
    rejectPush = true; assert.equal((await post('pause')).status, 201); rejectPush = false;
    assert.equal((await post('resume', false)).status, 409); assert.equal((await engine.snapshot(id)).orchestratorStatus, 'paused');
    await auditFault('engine.pause', async () => { await engine.consumeTaskStateEvents(); assert.equal(ctx.status, 'planning'); assert.equal(sessionCalls.length, 0); assert.equal(await repo(E.TaskStateEventEntity).countBy({ taskId: id, consumedAt: IsNull() }), 1); });
    await engine.consumeTaskStateEvents(); assert.equal(ctx.status, 'paused'); assert.deepEqual(sessionCalls.map(([action]) => action), ['pause', 'pause']);
    const pauseCount = sessionCalls.length;
    await auditFault('task.resume', async () => { assert.equal((await post('resume')).status, 500); assert.equal((await row()).status, 'paused'); });
    assert.equal((await post('resume')).status, 201); assert.equal((await post('resume')).status, 409);
    await auditFault('engine.resume', async () => { await engine.consumeTaskStateEvents(); assert.equal(ctx.status, 'paused'); assert.equal((await row()).engineStatus, 'paused'); assert.equal(sessionCalls.length, pauseCount); });
    await db.query("CREATE TRIGGER fixture_resume_ack BEFORE UPDATE ON task_state_events WHEN NEW.eventType='task.resume' AND NEW.consumedAt IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture acknowledgement failure'); END");
    await assert.rejects(() => engine.consumeTaskStateEvents(), /fixture acknowledgement failure/);
    await new Promise((resolve) => setImmediate(resolve)); assert.equal(ctx.status, 'planning'); assert.equal(cycles, 2);
    const afterResumeCalls = sessionCalls.length; const resumeAudits = await repo(E.AuditLogEntity).countBy({ taskId: id, action: 'engine.resume' });
    await db.query('DROP TRIGGER fixture_resume_ack'); await engine.consumeTaskStateEvents();
    assert.equal(sessionCalls.length, afterResumeCalls); assert.equal(cycles, 2); assert.equal(await repo(E.AuditLogEntity).countBy({ taskId: id, action: 'engine.resume' }), resumeAudits);
    const resumeCount = sessionCalls.length;
    await auditFault('engine.stop', async () => { await assert.rejects(() => engine.stop(id), /fixture audit failure/); assert.equal(ctx.activeWorkers.size, 1); assert.equal(ctx.status, 'planning'); assert.equal((await row()).status, 'running'); assert.equal(sessionCalls.length, resumeCount); });
    assert.equal((await post('stop')).status, 201);
    await auditFault('engine.stop', async () => { await engine.consumeTaskStateEvents(); assert.equal(ctx.activeWorkers.size, 1); assert.equal(ctx.status, 'planning'); assert.equal(sessionCalls.length, resumeCount); });
    await engine.consumeTaskStateEvents(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(ctx.status, 'stopped'); assert.equal(ctx.activeWorkers.size, 0); assert.equal((await row()).engineStatus, 'stopped');
    for (const status of ['stopped', 'completed', 'failed']) {
      await repo(E.TaskEntity).update(id, { status, engineStatus: status, finishedAt: new Date(), lastError: 'preserved' });
      const before = await row(); const runs = await repo(E.OrchestratorRunEntity).countBy({ taskId: id });
      for (const action of ['start', 'pause', 'resume', 'stop']) assert.equal((await post(action)).status, 409, `${status}: ${action}`);
      await assert.rejects(() => engine.start(id), /终态/); await assert.rejects(() => engine.resume(id), /终态/);
      await engine.pause(id); await engine.stop(id);
      await repo(E.TaskStateEventEntity).save({ id: `obsolete-resume-${status}`, taskId: id, eventType: 'task.resume', consumedAt: null });
      await repo(E.TaskStateEventEntity).save({ id: `obsolete-disable-${status}`, taskId: id, eventType: 'runtime.disabled', consumedAt: null });
      await engine.consumeTaskStateEvents();
      assert.equal(await repo(E.TaskStateEventEntity).countBy({ taskId: id, consumedAt: IsNull() }), 1, 'one event per task is consumed per batch');
      await engine.consumeTaskStateEvents(); assert.equal(await repo(E.TaskStateEventEntity).countBy({ taskId: id, consumedAt: IsNull() }), 0);
      assert.equal((await row()).status, status); assert.equal((await row()).lastError, before.lastError); assert.equal(await repo(E.OrchestratorRunEntity).countBy({ taskId: id }), runs);
      assert.equal((await engine.snapshot(id)).orchestratorStatus, status);
    }
    // Restart-style recovery has no in-memory context and must retain the existing budget epoch.
    const recovered = await tasks.create({ ...input, name: 'recovered' });
    await repo(E.TaskEntity).update(recovered.id, { status: 'paused', engineStatus: 'needs_input', lastError: '确认远端状态后恢复', tokensUsed: 321, startedAt: new Date(Date.now() - 60000) });
    const recoveryRow = await repo(E.TaskEntity).findOneByOrFail({ id: recovered.id });
    assert.equal((await engine.snapshot(recovered.id)).lastError, '确认远端状态后恢复');
    assert.equal((await post('resume', true, recovered.id)).status, 201); await engine.consumeTaskStateEvents();
    const resumed = await repo(E.TaskEntity).findOneByOrFail({ id: recovered.id }); assert.equal(resumed.budgetEpoch, recoveryRow.budgetEpoch); assert.equal(resumed.tokensUsed, 321); assert.equal(new Date(resumed.startedAt).getTime(), new Date(recoveryRow.startedAt).getTime()); assert.ok((await engine.snapshot(recovered.id)).elapsedSeconds >= 60);
    for (const status of ['needs_input', 'stalled']) {
      await repo(E.TaskEntity).update(recovered.id, { status: 'running', engineStatus: status }); engine.getContext(recovered.id).status = status;
      assert.equal((await post('resume', true, recovered.id)).status, 201); await engine.consumeTaskStateEvents(); assert.equal((await engine.snapshot(recovered.id)).orchestratorStatus, 'planning');
    }
    // Creating an autostart task must not leave any runnable state when a later write fails.
    const counts = async () => Promise.all([E.TaskEntity, E.TargetEntity, E.TaskStateEventEntity, E.AuditLogEntity].map((entity) => repo(entity).count()));
    const create = (autoStart) => fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, autoStart }) });
    for (const autoStart of [false, true]) {
      const before = await counts(); const notifications = pushes.length;
      await auditFault('task.create', async () => { assert.equal((await create(autoStart)).status, 500); });
      assert.deepEqual(await counts(), before); assert.equal(pushes.length, notifications);
    }
    for (const table of ['targets', 'task_state_events']) {
      const before = await counts();
      await db.query(`CREATE TRIGGER fixture_create_child BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture create child failure'); END`);
      try { assert.equal((await create(true)).status, 500); } finally { await db.query('DROP TRIGGER fixture_create_child'); }
      assert.deepEqual(await counts(), before);
    }
    const beforeCreateCommit = await counts(); const beforeCreatePushes = pushes.length; let failCreateCommit = true;
    runner.commitTransaction = async () => { if (failCreateCommit) { failCreateCommit = false; throw new Error('fixture create commit failure'); } return commit(); };
    try { assert.equal((await create(true)).status, 500); } finally { runner.commitTransaction = commit; }
    assert.deepEqual(await counts(), beforeCreateCommit); assert.equal(pushes.length, beforeCreatePushes);
    rejectPush = true; const createdResponse = await create(true); rejectPush = false;
    assert.equal(createdResponse.status, 201); const createdTask = await createdResponse.json(); assert.equal(createdTask.targets.length, 1); assert.equal(createdTask.status, 'running'); await engine.consumeTaskStateEvents();
    const taskFor = async (name) => { const t = await tasks.create({ ...input, name }); await engine.start(t.id); await new Promise((resolve) => setImmediate(resolve)); return t; };
    for (const [kind, action, expected] of [['needs_input', 'engine.finished', 'needs_input'], ['stalled', 'engine.stalled', 'stalled'], ['failed', 'engine.failed', 'failed'], ['goal', 'engine.finished', 'completed']]) {
      const t = await taskFor(`automatic ${kind}`); const context = engine.getContext(t.id);
      context.plannerSessionId = `planner-${kind}`; context.activeWorkers.set(`worker-${kind}`, { sessionId: `worker-session-${kind}` });
      const apply = () => kind === 'needs_input' ? engine.stopWithReason(t.id, 'needs_input', '等待操作人员') : kind === 'stalled' ? engine.markStalled(t.id, '暂无新信息') : kind === 'failed' ? engine.failTask(t.id, new Error('固定失败')) : engine.stopWithReason(t.id, 'goal_reached', '证据验收通过');
      const beforeCalls = sessionCalls.length; const beforeRun = await repo(E.OrchestratorRunEntity).findOneByOrFail({ id: context.runId });
      await auditFault(action, async () => { await assert.rejects(apply, /fixture audit failure/); });
      assert.equal((await repo(E.TaskEntity).findOneByOrFail({ id: t.id })).engineStatus, 'running'); assert.equal(context.status, 'planning'); assert.equal(context.activeWorkers.size, 1); assert.equal(sessionCalls.length, beforeCalls);
      assert.deepEqual(await repo(E.OrchestratorRunEntity).findOneByOrFail({ id: context.runId }), beforeRun);
      await apply(); await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await repo(E.TaskEntity).findOneByOrFail({ id: t.id })).engineStatus, expected); assert.equal(context.status, expected);
      assert.equal(await repo(E.AuditLogEntity).countBy({ taskId: t.id, action }), 1);
      if (kind === 'failed' || kind === 'goal') { assert.equal(context.activeWorkers.size, 0); assert.equal(sessionCalls.length, beforeCalls + 2); }
    }
    async function until(predicate) { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('fixture lifecycle wait timed out'); }
    for (const control of ['pause', 'resume', 'stop']) {
      const late = await tasks.create({ ...input, name: `late ${control}` }); let release; let entered = false; let bodyRuns = 0; let oldContext;
      const gate = new Promise((resolve) => { release = resolve; });
      engine.registerCycleBody(async (taskId, context) => {
        if (taskId !== late.id) return;
        bodyRuns++; if (bodyRuns > 1) return; oldContext = context; entered = true; await gate;
        assert.equal(await engine.executionAllowed(taskId), false);
        await engine.stopWithReason(taskId, 'goal_reached', '过期完成'); await engine.markStalled(taskId, '过期停滞'); await engine.setStatus(taskId, 'executing', '过期阶段'); await engine.persistRun(context, 'error');
        throw new Error('过期循环失败');
      });
      await engine.start(late.id); await until(() => entered);
      if (control === 'stop') await engine.stop(late.id); else { await engine.pause(late.id); if (control === 'resume') await engine.resume(late.id); }
      release(); await until(() => !oldContext.plannerBusy && (control !== 'resume' || bodyRuns === 2));
      const current = await repo(E.TaskEntity).findOneByOrFail({ id: late.id });
      assert.equal(current.status, control === 'resume' ? 'running' : control === 'pause' ? 'paused' : 'stopped'); assert.notEqual(current.currentPhase, '过期阶段'); assert.equal(current.lastError, null);
      assert.equal(await repo(E.AuditLogEntity).countBy({ taskId: late.id, action: 'engine.failed' }), 0); assert.equal(await repo(E.AuditLogEntity).countBy({ taskId: late.id, action: 'engine.finished' }), 0);
      if (control === 'stop') {
        await tasks.applyAction(late.id, 'rerun'); await engine.consumeTaskStateEvents(); await engine.start(late.id); await until(() => !engine.getContext(late.id).plannerBusy);
        const newContext = engine.getContext(late.id); newContext.activeWorkers.set('new-worker', { sessionId: 'new-session' });
        const newRun = await repo(E.OrchestratorRunEntity).findOneByOrFail({ id: newContext.runId });
        await engine.persistRun(oldContext, 'error'); await engine.onWorkerFinished(late.id, 'old-worker', 'old-session'); await engine.onWorkerFinished(late.id, 'new-worker', 'wrong-session');
        assert.equal(newContext.activeWorkers.size, 1); assert.deepEqual(await repo(E.OrchestratorRunEntity).findOneByOrFail({ id: newContext.runId }), newRun);
      }
    }
    // A failed bookkeeping write must keep the completion eligible for bounded retry.
    const callbackTask = await taskFor('callback retry'); const callbackContext = engine.getContext(callbackTask.id);
    callbackContext.activeWorkers.set('callback-worker', { sessionId: 'callback-session' });
    await repo(E.TaskEntity).update(callbackTask.id, { tokensUsed: 777, costUsd: 1.25 });
    const countEvidence = engine.facts.progressKeys;
    engine.facts.progressKeys = async () => { throw new Error('fixture evidence count failure'); };
    try { await assert.rejects(() => engine.onWorkerFinished(callbackTask.id, 'callback-worker', 'callback-session'), /fixture evidence count failure/); }
    finally { engine.facts.progressKeys = countEvidence; }
    assert.equal(callbackContext.activeWorkers.size, 1, 'failed reads must not remove the completion before retry');
    await db.query(`CREATE TRIGGER fixture_worker_callback BEFORE UPDATE ON tasks WHEN NEW.id='${callbackTask.id}' AND NEW.currentPhase LIKE '第 %轮 · 活跃 Worker %' BEGIN SELECT RAISE(ABORT, 'fixture callback write failure'); END`);
    await assert.rejects(() => engine.onWorkerFinished(callbackTask.id, 'callback-worker', 'callback-session'), /fixture callback write failure/); assert.equal(callbackContext.activeWorkers.size, 1);
    engine.notifyWorkerFinished(callbackTask.id, 'callback-worker', 'callback-session'); await until(() => engine.callbackTimers.size > 0);
    await db.query('DROP TRIGGER fixture_worker_callback'); await until(() => callbackContext.activeWorkers.size === 0);
    const callbackRow = await repo(E.TaskEntity).findOneByOrFail({ id: callbackTask.id }); assert.equal(callbackRow.tokensUsed, 777); assert.equal(callbackRow.costUsd, 1.25);
    // Real facts/evidence drive completion progress, rather than raw row counts.
    const { FactsService } = require('../apps/api/dist/modules/blackboard/facts.service');
    const realFacts = new FactsService(repo(E.FactEntity), repo(E.HypothesisLinkEntity), gateway);
    const progressTask = await taskFor('knowledge progress'); const progressContext = engine.getContext(progressTask.id);
    const originalProgress = engine.facts.progressKeys;
    engine.facts.progressKeys = (taskId) => realFacts.progressKeys(taskId);
    async function finishProgressWorker(index) {
      progressContext.activeWorkers.set(`progress-${index}`, { sessionId: `session-${index}` });
      await engine.onWorkerFinished(progressTask.id, `progress-${index}`, `session-${index}`);
    }
    try {
      await repo(E.EvidenceEntity).save({ id: 'progress-evidence', taskId: progressTask.id, kind: 'text', title: 'fixture', content: 'port closed' });
      const observation = { taskId: progressTask.id, category: 'service', subject: '192.0.2.10:80', predicate: 'port_state', object: 'closed', status: 'observed', observationKind: 'target_negative', sourceEvidenceIds: ['progress-evidence'], createdBy: 'tool' };
      await repo(E.FactEntity).save({ id: 'progress-fact', ...observation });
      await finishProgressWorker(1); assert.equal(progressContext.noProgressRounds, 0);
      await repo(E.FactEntity).save({ id: 'progress-duplicate', ...observation });
      await finishProgressWorker(2); assert.equal(progressContext.noProgressRounds, 1, 'duplicate rows do not reset stagnation');
      await repo(E.FactEntity).update('progress-fact', { status: 'refuted' });
      await finishProgressWorker(3); assert.equal(progressContext.noProgressRounds, 0, 'evidence-backed refutation advances knowledge without increasing row count');
      await repo(E.FactEntity).save({ id: 'progress-dangling', ...observation, object: 'new unsupported value', sourceEvidenceIds: ['missing'] });
      await finishProgressWorker(4); assert.equal(progressContext.noProgressRounds, 1);
      await repo(E.FactEntity).delete('progress-fact');
      await repo(E.FactEntity).save({ id: 'progress-reinserted', ...observation, status: 'refuted' });
      await finishProgressWorker(5); assert.equal(progressContext.noProgressRounds, 2, 'reinserted knowledge is not new progress');
    } finally { engine.facts.progressKeys = originalProgress; }
    const failedCallbackTask = await taskFor('callback exhausted'); const failedCallbackContext = engine.getContext(failedCallbackTask.id);
    failedCallbackContext.activeWorkers.set('failed-callback-worker', { sessionId: 'failed-callback-session' });
    await db.query(`CREATE TRIGGER fixture_worker_callback BEFORE UPDATE ON tasks WHEN NEW.id='${failedCallbackTask.id}' AND NEW.currentPhase LIKE '第 %轮 · 活跃 Worker %' BEGIN SELECT RAISE(ABORT, 'fixture callback write failure'); END`);
    engine.notifyWorkerFinished(failedCallbackTask.id, 'failed-callback-worker', 'failed-callback-session'); await until(() => failedCallbackContext.status === 'failed');
    await db.query('DROP TRIGGER fixture_worker_callback');
    assert.equal(await repo(E.AuditLogEntity).countBy({ taskId: failedCallbackTask.id, action: 'engine.failed' }), 1); assert.equal(failedCallbackContext.activeWorkers.size, 0);
    console.log('PASS: real HTTP task/engine queue, atomic create/targets/autostart/audit and commit failure, internal control/automatic finish/stall/failure rollback, no premature session effects, consumer acknowledgement retry, terminal and old-cycle revision preservation across pause/resume/stop, new-run/Worker callback identity, bounded callback retry/failure and accounting preservation, persisted snapshots and budget-preserving recovery; no remote execution');
  } finally { if (engine) engine.onModuleDestroy(); if (app) await app.close(); await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
