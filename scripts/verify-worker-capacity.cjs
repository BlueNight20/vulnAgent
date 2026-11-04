// Migrated temporary SQLite and real admission/cycle services; fixed worker metadata, no target/model/tool execution.
const backendRequire = require('./backend-require.cjs'); backendRequire('reflect-metadata'); process.env.PI_RUNTIME_ENABLED = 'true';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { randomBytes, randomUUID } = require('node:crypto');
const { DataSource } = backendRequire('typeorm'); const E = require('../apps/api/dist/database/entities'); const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const load = (file, name) => require(`../apps/api/dist/modules/${file}`)[name];
const WorkerStateService = load('blackboard/worker-state.service', 'WorkerStateService'); const OrchestratorService = load('orchestrator/orchestrator.service', 'OrchestratorService');
async function until(predicate) { for (let i = 0; i < 1000; i++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('capacity fixture wait timed out'); }
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnagent-worker-capacity-')); const file = path.join(directory, 'fixture.sqlite'); let db; let engine;
  try {
    db = await new DataSource(sqliteOptions(file)).initialize(); await db.runMigrations();
    const repo = (entity) => db.getRepository(entity); const notifications = [];
    const events = { broadcast(type, dto) { if (type === 'worker.task') assert.equal(db.createQueryRunner().isTransactionActive, false, 'worker notification must follow commit'); notifications.push({ type, dto }); } };
    const audit = new (load('audit/audit.service', 'AuditService'))(repo(E.AuditLogEntity), events);
    const cfg = require('../apps/api/dist/config/configuration').default(); cfg.security = { encryptionKey: randomBytes(32).toString('base64'), encryptionKeyFile: '' };
    const settings = new (load('settings/settings.service', 'SettingsService'))(repo(E.SystemSettingEntity), { get: (key) => cfg[key] }, audit);
    const tasks = new (load('tasks/tasks.service', 'TasksService'))(repo(E.TaskEntity), repo(E.TargetEntity), repo(E.TaskStateEventEntity), db, audit, events);
    const workers = new WorkerStateService(repo(E.WorkerTaskEntity), repo(E.WorkerResultCardEntity), events); const competing = new WorkerStateService(repo(E.WorkerTaskEntity), repo(E.WorkerResultCardEntity), events);
    const intents = new (load('blackboard/intents.service', 'IntentsService'))(repo(E.IntentEntity), events);
    const store = new (load('pi-runtime/session-store.service', 'SessionStoreService'))(repo(E.AgentSessionMessageEntity), repo(E.AgentSessionEventEntity), repo(E.AgentSessionEntity), repo(E.ModelUsageEntity), events);
    const sessions = new (load('pi-runtime/session-manager.service', 'SessionManagerService'))(repo(E.AgentSessionEntity), store, { assertRuntimeEnabled: async () => {} }, events, audit);
    const facts = { counts: async () => ({}), progressKeys: async () => [], listByTask: async () => [] };
    const makeEngine = (runtimeSessions = sessions) => new OrchestratorService(repo(E.TaskEntity), repo(E.TargetEntity), repo(E.IntentEntity), repo(E.OrchestratorRunEntity), repo(E.TaskStateEventEntity), { sessions: runtimeSessions }, facts, intents, {}, workers, {}, {}, {}, events, audit, {});
    engine = makeEngine(); engine.onModuleDestroy(); await engine.onApplicationBootstrap(); engine.registerCycleBody(async () => {});
    const cap = (value) => settings.update({ runtime: { workerMaxConcurrency: value } });
    const task = async (name, workerCount = 8) => { const t = await tasks.create({ name, targets: [{ ip: '192.0.2.10' }], scope: { cidrs: [], ports: '80' }, authorized: true, modelProvider: 'fixture', modelName: 'fixture-selected', tokenBudget: 200000, timeBudgetMinutes: 60, workerCount, autoStart: false }); await engine.start(t.id); await new Promise((resolve) => setImmediate(resolve)); return t; };
    let sequence = 0;
    const intent = async (taskId) => (await intents.create({ taskId, title: `capacity ${++sequence}`, dedupeKey: `capacity-${sequence}`, targetIp: '192.0.2.10', workerProfileId: 'recon', suggestedTools: ['nmap_scan'] })).intent;
    const input = (i) => ({ taskId: i.taskId, intentId: i.id, title: i.title, profileId: 'recon', dedupeKey: i.dedupeKey, timeoutSeconds: 600, maxAttempts: 2 });
    const reserve = (i, service = workers) => service.reserve(input(i), 1, {});
    const complete = async (rows) => { for (const item of rows) if (item.worker) await workers.complete(item.worker.id, { status: 'succeeded' }); };
    await cap(2); const a = await task('task A'); const b = await task('task B');
    const offered = await Promise.all(Array.from({ length: 12 }, (_, index) => intent(index % 2 ? a.id : b.id)));
    const results = await Promise.all(offered.map((i, index) => reserve(i, index % 2 ? workers : competing)));
    assert.equal(results.filter((r) => r.worker).length, 2); assert.equal((await workers.capacity(a.id)).active, 2);
    for (let index = 0; index < results.length; index++) if (!results[index].worker) { assert.equal(results[index].reason, 'capacity'); const unchanged = await repo(E.IntentEntity).findOneByOrFail({ id: offered[index].id }); assert.equal(unchanged.status, 'proposed'); assert.equal(unchanged.dispatchCount, 0); assert.equal(await repo(E.WorkerTaskEntity).countBy({ intentId: offered[index].id }), 0); }
    const held = results.filter((r) => r.worker); const deferred = offered[results.findIndex((r) => !r.worker)];
    await cap(1); assert.equal((await reserve(deferred)).reason, 'capacity'); await workers.complete(held[0].worker.id, { status: 'succeeded' }); assert.equal((await reserve(deferred)).reason, 'capacity');
    await workers.complete(held[1].worker.id, { status: 'succeeded' }); const next = await reserve(deferred); assert.ok(next.worker); assert.equal(next.worker.attempt, 0);
    await cap(3); const more = await Promise.all(offered.filter((i) => i.id !== deferred.id).map((i) => reserve(i))); assert.equal(more.filter((r) => r.worker).length, 2); assert.equal((await workers.capacity(a.id)).active, 3); await complete([next, ...more]);
    await cap(8); await repo(E.TaskEntity).update(a.id, { workerCount: 1 }); const ai = await intent(a.id); const ai2 = await intent(a.id); const bi = await intent(b.id);
    const ar = await reserve(ai); assert.ok(ar.worker); assert.equal((await reserve(ai2)).reason, 'capacity'); const br = await reserve(bi); assert.ok(br.worker); await complete([ar, br]); await repo(E.TaskEntity).update(a.id, { workerCount: 8 });
    const duplicate = await intent(a.id); const duplicates = await Promise.all([reserve(duplicate), reserve(duplicate, competing)]); assert.equal(duplicates.filter((r) => r.worker).length, 1); assert.equal(await repo(E.WorkerTaskEntity).countBy({ intentId: duplicate.id }), 1); await complete(duplicates);
    for (const [table, condition] of [['worker_tasks', ''], ['intents', "WHEN NEW.status='dispatched'"]]) {
      const i = await intent(a.id); const before = await repo(E.WorkerTaskEntity).count(); const pushes = notifications.filter((n) => n.type === 'worker.task').length;
      await db.query(`CREATE TRIGGER fixture_capacity_failure BEFORE ${table === 'worker_tasks' ? 'INSERT' : 'UPDATE'} ON ${table} ${condition} BEGIN SELECT RAISE(ABORT, 'fixture reserve failure'); END`);
      try { await assert.rejects(() => reserve(i), /fixture reserve failure/); } finally { await db.query('DROP TRIGGER fixture_capacity_failure'); }
      assert.equal(await repo(E.WorkerTaskEntity).count(), before); assert.equal((await repo(E.IntentEntity).findOneByOrFail({ id: i.id })).status, 'proposed'); assert.equal(notifications.filter((n) => n.type === 'worker.task').length, pushes);
    }
    const commitIntent = await intent(a.id); const runner = db.createQueryRunner(); const commit = runner.commitTransaction.bind(runner); let fail = true;
    runner.commitTransaction = async () => { if (fail) { fail = false; throw new Error('fixture reservation commit failure'); } return commit(); };
    try { await assert.rejects(() => reserve(commitIntent), /fixture reservation commit failure/); } finally { runner.commitTransaction = commit; }
    assert.equal(await repo(E.WorkerTaskEntity).countBy({ intentId: commitIntent.id }), 0); assert.equal((await repo(E.IntentEntity).findOneByOrFail({ id: commitIntent.id })).status, 'proposed');
    await repo(E.SystemSettingEntity).update({ key: 'runtime.workerMaxConcurrency' }, { value: '0' }); await assert.rejects(() => reserve(commitIntent), /配置无效/); await cap(8);
    const expired = await reserve(commitIntent); await repo(E.WorkerTaskEntity).update(expired.worker.id, { leaseExpiresAt: new Date(Date.now() - 1000) });
    await engine.reapExpiredWorkers(); assert.equal((await workers.findById(expired.worker.id)).status, 'timeout'); assert.equal((await repo(E.IntentEntity).findOneByOrFail({ id: commitIntent.id })).status, 'proposed');
    await assert.rejects(() => workers.attachSession(expired.worker.id, 'late-session'), /占位已失效/); await workers.renewLease(expired.worker.id); await workers.complete(expired.worker.id, { status: 'succeeded' }); assert.equal((await workers.findById(expired.worker.id)).status, 'timeout');
    // Real cycle admission waits without consuming retries/no-progress/cycles, then wakes on the scan.
    await cap(1); const holdIntent = await intent(b.id); const hold = await reserve(holdIntent); assert.ok(hold.worker);
    const Cycle = load('orchestrator/orchestrator-cycle.service', 'OrchestratorCycleService'); const cycle = Object.create(Cycle.prototype); let launched = 0;
    const goals = { evaluate: async () => ({ configured: true, complete: false }), prepare: async () => {} };
    Object.assign(cycle, { tasks: repo(E.TaskEntity), targets: repo(E.TargetEntity), intentRepo: repo(E.IntentEntity), goals, orchestrator: engine, runtime: { sessions }, workers, intents, facts, hypotheses: { findByTargets: async () => [] }, skills: { catalogToolNames: async () => ['nmap_scan'] }, logger: { log() {}, debug() {}, warn() {} }, workerRunner: { async launch(value) { launched++; const row = await sessions.createRecord({ taskId: value.taskId, role: 'explore', profileId: 'recon', modelName: '', tools: [] }); await workers.attachSession(value.workerTaskId, row.id); return { sessionId: row.id, workerTaskId: value.workerTaskId }; } } });
    const waitingIntent = await intent(a.id); const scored = { id: waitingIntent.id, score: 1, breakdown: {}, workerProfileId: 'recon' };
    const ctx = engine.getContext(a.id); const activeTask = await engine.findTask(a.id); assert.equal(await cycle.dispatchWorker(a.id, activeTask, scored, { tokensLeft: 100000 }), false);
    assert.equal(ctx.capacityDeferred, true); ctx.noProgressRounds = 2; const cycleCount = ctx.cycle;
    for (let index = 0; index < 35; index++) await cycle.run(a.id, ctx);
    assert.equal(ctx.cycle, cycleCount); assert.equal(ctx.noProgressRounds, 2); assert.equal(await repo(E.WorkerTaskEntity).countBy({ intentId: waitingIntent.id }), 0); assert.equal((await engine.snapshot(a.id)).waitingForWorkerCapacity, true);
    engine.registerCycleBody((id, context) => id === a.id ? cycle.run(id, context) : Promise.resolve());
    await workers.complete(hold.worker.id, { status: 'succeeded' }); await engine.reapExpiredWorkers(); await until(() => launched === 1 && !ctx.plannerBusy); assert.equal((await workers.capacity(a.id)).active, 1);
    await repo(E.TaskEntity).update(a.id, { startedAt: new Date(Date.now() - 120000), timeBudgetMinutes: 1 }); await cycle.run(a.id, ctx); assert.equal((await repo(E.TaskEntity).findOneByOrFail({ id: a.id })).stopReason, 'budget_time'); await until(async () => (await workers.capacity(a.id)).active === 0);
    // A failed launch releases its reservation; the intent never gets stuck as dispatched.
    const failureTask = await task('launch failure'); const failureIntent = await intent(failureTask.id); cycle.workerRunner = { launch: async () => { throw new Error('fixture launch failure'); } };
    const failureTaskRow = await engine.findTask(failureTask.id);
    await assert.rejects(() => cycle.dispatchWorker(failureTask.id, failureTaskRow, { ...scored, id: failureIntent.id }, { tokensLeft: 100000 }), /fixture launch failure/);
    assert.equal((await workers.capacity(failureTask.id)).active, 0); assert.equal((await repo(E.IntentEntity).findOneByOrFail({ id: failureIntent.id })).status, 'proposed');
    const preparationFailure = await intent(failureTask.id); const targetFind = cycle.targets.find;
    cycle.targets.find = async () => { throw new Error('fixture target read failure'); };
    try { await assert.rejects(() => cycle.dispatchWorker(failureTask.id, failureTaskRow, { ...scored, id: preparationFailure.id }, { tokensLeft: 100000 }), /fixture target read failure/); }
    finally { cycle.targets.find = targetFind; }
    assert.equal((await workers.capacity(failureTask.id)).active, 0); assert.equal((await repo(E.IntentEntity).findOneByOrFail({ id: preparationFailure.id })).status, 'proposed');
    const pausedLaunch = await task('pause during launch'); const pausedIntent = await intent(pausedLaunch.id); let pausedSessionId;
    cycle.workerRunner = { async launch(value) { const row = await sessions.createRecord({ taskId: value.taskId, role: 'explore', profileId: 'recon', modelName: '' }); pausedSessionId = row.id; await workers.attachSession(value.workerTaskId, row.id); await engine.pause(value.taskId); return { workerTaskId: value.workerTaskId, sessionId: row.id }; } };
    assert.equal(await cycle.dispatchWorker(pausedLaunch.id, await engine.findTask(pausedLaunch.id), { ...scored, id: pausedIntent.id }, { tokensLeft: 100000 }), false);
    assert.equal((await workers.capacity(pausedLaunch.id)).active, 0); assert.equal((await sessions.findOne(pausedSessionId)).state, 'terminated'); assert.equal(engine.getContext(pausedLaunch.id).activeWorkers.size, 0);
    const attachFailure = await task('real worker launch cleanup'); const attachIntent = await intent(attachFailure.id);
    const RealRunner = load('orchestrator/worker-runner.service', 'WorkerRunnerService'); const realRunner = Object.create(RealRunner.prototype);
    Object.assign(realRunner, { evidence: repo(E.EvidenceEntity), targets: repo(E.TargetEntity), tools: repo(E.McpToolEntity), workers, sessions, catalog: { sync: async () => {} }, toolInvoker: { schemas: () => [] }, toolRecorder: {}, skills: { resolve: async () => ({ tools: [] }), catalogToolNames: async () => [] }, facts, hypotheses: { list: async () => [] }, hints: { takePending: async () => [] }, surface: { summary: async () => '' }, goals: { summary: async () => '' }, buildEvidenceBrief: async () => '', logger: { log() {} } });
    cycle.workerRunner = realRunner;
    const attachTaskRow = await engine.findTask(attachFailure.id);
    await db.query(`CREATE TRIGGER fixture_attach_failure BEFORE UPDATE ON worker_tasks WHEN NEW.taskId='${attachFailure.id}' AND NEW.status='running' BEGIN SELECT RAISE(ABORT, 'fixture attach failure'); END`);
    try { await assert.rejects(() => cycle.dispatchWorker(attachFailure.id, attachTaskRow, { ...scored, id: attachIntent.id }, { tokensLeft: 100000 }), /fixture attach failure/); }
    finally { await db.query('DROP TRIGGER fixture_attach_failure'); }
    assert.equal((await workers.capacity(attachFailure.id)).active, 0); assert.equal(await repo(E.AgentSessionEntity).countBy({ taskId: attachFailure.id, state: 'terminated' }), 1);
    // UI session resume cannot revive an ended/unallocated Worker or a paused task outside admission.
    const agents = new (load('agents/agents.service', 'AgentsService'))({ sessions: { findOne: (id) => sessions.findOne(id), resume: async () => 'resumed' } }, repo(E.ToolCallEntity));
    const resumeSession = await sessions.createRecord({ taskId: failureTask.id, role: 'explore', modelName: 'fixture' });
    await assert.rejects(() => agents.resume(resumeSession.id), /Worker 已收尾/); await repo(E.TaskEntity).update(failureTask.id, { status: 'paused' }); await assert.rejects(() => agents.resume(resumeSession.id), /先通过任务控制/);
    // Reopen the real file DB: queued reservations and created/paused sessions become history, never replay.
    const restartTask = await task('restart pending launch'); const restartIntent = await intent(restartTask.id); const pending = await reserve(restartIntent); assert.ok(pending.worker);
    for (const state of ['created', 'paused']) await repo(E.AgentSessionEntity).save({ id: randomUUID(), taskId: restartTask.id, role: 'explore', state, modelName: 'fixture', sessionKey: randomUUID() });
    engine.onModuleDestroy(); await db.destroy(); db = await new DataSource(sqliteOptions(file)).initialize(); await db.runMigrations();
    const restartedWorkers = new WorkerStateService(repo(E.WorkerTaskEntity), repo(E.WorkerResultCardEntity), events); const restartedSessions = new (load('pi-runtime/session-manager.service', 'SessionManagerService'))(repo(E.AgentSessionEntity), new (load('pi-runtime/session-store.service', 'SessionStoreService'))(repo(E.AgentSessionMessageEntity), repo(E.AgentSessionEventEntity), repo(E.AgentSessionEntity), repo(E.ModelUsageEntity), events), {}, events, new (load('audit/audit.service', 'AuditService'))(repo(E.AuditLogEntity), events));
    const restartedIntents = new (load('blackboard/intents.service', 'IntentsService'))(repo(E.IntentEntity), events);
    engine = new OrchestratorService(repo(E.TaskEntity), repo(E.TargetEntity), repo(E.IntentEntity), repo(E.OrchestratorRunEntity), repo(E.TaskStateEventEntity), { sessions: restartedSessions }, facts, restartedIntents, {}, restartedWorkers, {}, {}, {}, events, new (load('audit/audit.service', 'AuditService'))(repo(E.AuditLogEntity), events), {});
    engine.onModuleDestroy(); await engine.onApplicationBootstrap(); assert.equal((await restartedWorkers.capacity(restartTask.id)).active, 0); assert.equal((await restartedWorkers.findById(pending.worker.id)).status, 'timeout'); assert.equal((await repo(E.TaskEntity).findOneByOrFail({ id: restartTask.id })).status, 'paused');
    assert.equal(await repo(E.AgentSessionEntity).countBy({ taskId: restartTask.id, state: 'created' }), 0); assert.equal(await repo(E.AgentSessionEntity).countBy({ taskId: restartTask.id, state: 'paused' }), 0); assert.equal(engine.getContext(restartTask.id), undefined);
    console.log('PASS: migrated file DB global/task Worker reservation under competing services, live limit changes, untouched deferred attempts, duplicate intent fence, insert/update/commit rollback, expired reservation/terminal protection, actual cycle wait/wake/time budget, failed launch release, session-resume fence and real file reopen recovery without replay; no remote execution');
  } finally { if (engine) engine.onModuleDestroy(); if (db?.isInitialized) await db.destroy(); const target = path.resolve(directory); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('vulnagent-worker-capacity-')); fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
