// Real Nest routes, migrated temporary SQLite, Pi Agent and loopback model protocol. No target access.
const backendRequire = require('./backend-require.cjs'); backendRequire('reflect-metadata');
const assert = require('node:assert/strict'); const http = require('node:http'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { randomBytes } = require('node:crypto');
const createTestApp = require('./create-test-app.cjs');
const load = (file, name) => require(`../apps/api/dist/modules/${file}`)[name];
const E = require('../apps/api/dist/database/entities');
async function until(check, label) { for (let i = 0; i < 1000; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error(`Hint fixture timeout: ${label}`); }
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnagent-hints-')); const file = path.join(directory, 'fixture.sqlite');
  const captures = []; const releases = new Map(); const errors = []; const firstRequests = new Set(); let app; let db; let toolWaiting = false;
  const model = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); captures.push(body);
      const tag = body.messages.filter((m) => m.role === 'user').map((m) => typeof m.content === 'string' ? m.content : m.content?.filter((block) => block.type === 'text').map((block) => block.text).join('')).find((text) => text?.startsWith('hold-'));
      assert.ok(tag, 'only fixed fixture prompts may reach the loopback model');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const emit = (choices, usage) => res.write(`data: ${JSON.stringify({ id: `hint-${captures.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixture-hints', choices, ...(usage ? { usage } : {}) })}\n\n`);
      if (tag === 'hold-worker-b' && !firstRequests.has(tag)) {
        firstRequests.add(tag); releases.set(tag, () => {});
        emit([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'fixed-wait-call', type: 'function', function: { name: 'fixture_wait', arguments: '{}' } }] }, finish_reason: null }]);
        emit([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]); emit([], { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 }); res.end('data: [DONE]\n\n'); return;
      }
      const finish = () => { if (res.destroyed || res.writableEnded) return; emit([{ index: 0, delta: {}, finish_reason: 'stop' }]); emit([], { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 }); res.end('data: [DONE]\n\n'); };
      emit([{ index: 0, delta: { role: 'assistant', content: '固定协议回复，仅验证消息投递。' }, finish_reason: null }]);
      if (!firstRequests.has(tag)) { firstRequests.add(tag); releases.set(tag, finish); } else finish();
    } catch (error) { errors.push(error); res.destroy(); }
  });
  try {
    await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
    Object.assign(process.env, { DB_TYPE: 'sqlite', DB_PATH: file, DB_SYNCHRONIZE: 'false', DB_LOGGING: 'false', MCP_SERVERS: '[]', MCP_GATEWAY_ENABLED: 'false', PI_RUNTIME_ENABLED: 'true', MODEL_API_KEY: 'fixture-not-real-key', MODEL_PROVIDER: 'openai-compatible', MODEL_NAME: 'fixture-hints', MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, VA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    process.env.MODEL_MAX_CONCURRENCY = '8';
    app = await createTestApp(require('../apps/api/dist/app.module').AppModule, { logger: false, abortOnError: false });
    app.useWebSocketAdapter(new (backendRequire('@nestjs/platform-ws').WsAdapter)(app));
    app.useGlobalPipes(new (backendRequire('@nestjs/common').ValidationPipe)({ whitelist: true, transform: true })); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    db = app.get(backendRequire('typeorm').DataSource); const repo = (entity) => db.getRepository(entity);
    const hints = app.get(load('blackboard/hints.service', 'HintsService')); hints.onModuleDestroy(); // deterministic manual pumps below
    const sessions = app.get(load('pi-runtime/session-manager.service', 'SessionManagerService'));
    const store = sessions.store; const tasks = app.get(load('tasks/tasks.service', 'TasksService'));
    const settings = app.get(load('settings/settings.service', 'SettingsService'));
    await settings.update({ runtime: { modelMaxConcurrency: 8 } });
    const task = await tasks.create({ name: 'hint protocol fixture', targets: [{ ip: '192.0.2.10' }], scope: { cidrs: [], ports: '80' }, authorized: true, modelProvider: 'openai-compatible', modelName: 'fixture-hints', tokenBudget: 500000, timeBudgetMinutes: 60, workerCount: 8, autoStart: false });
    await repo(E.TaskEntity).update(task.id, { status: 'running', engineStatus: 'running', startedAt: new Date() });
    const post = (taskId, body) => fetch(`${base}/tasks/${taskId}/hints`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    async function start(tag, role = 'explore') {
      const tools = tag === 'worker-b' ? [{ name: 'fixture_wait', label: 'Fixed local wait', description: 'Local timer only; no target or external tool', parameters: { type: 'object', properties: {} }, execute: async (_id, _args, signal) => { toolWaiting = true; await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); if (signal.aborted) resolve(); }); return { content: [{ type: 'text', text: 'Fixed local wait interrupted' }] }; } }] : [];
      const options = { taskId: task.id, role, profileId: null, modelName: 'fixture-hints', systemPrompt: '固定协议消息测试。', tools };
      const entity = await sessions.createRecord(options);
      if (role !== 'planner') await repo(E.WorkerTaskEntity).save({ id: `worker-${tag}`, taskId: task.id, sessionId: entity.id, title: tag, status: 'running', leaseExpiresAt: new Date(Date.now() + 600000) });
      await sessions.start(entity, options, `hold-${tag}`);
      await until(async () => { const current = await repo(E.AgentSessionEntity).findOneByOrFail({ id: entity.id }); if (current.state === 'failed') throw new Error(`Fixture session failed: ${current.errorMessage}`); return releases.has(`hold-${tag}`); }, `start ${tag}`); return entity;
    }
    const a = await start('worker-a'); const b = await start('worker-b'); await until(() => toolWaiting, 'local tool wait'); const planner = await start('planner', 'planner');
    for (const content of ['', '   ', 'x'.repeat(2001)]) assert.equal((await post(task.id, { content, sessionId: a.id })).status, 400);
    assert.equal((await post('missing-task', { content: 'missing' })).status, 404);
    assert.equal((await post(task.id, { content: 'wrong owner', sessionId: 'missing-session' })).status, 404);
    const other = await tasks.create({ name: 'other hint task', targets: [{ ip: '192.0.2.20' }], scope: { cidrs: [] }, authorized: true, modelProvider: 'fixture', modelName: 'fixture', tokenBudget: 10000, timeBudgetMinutes: 10, workerCount: 1, autoStart: false });
    assert.equal((await post(other.id, { content: 'cross task', sessionId: a.id })).status, 404);
    const before = await repo(E.HintEntity).count();
    await db.query("CREATE TRIGGER fixture_hint_audit BEFORE INSERT ON audit_logs WHEN NEW.action='hint.create' BEGIN SELECT RAISE(ABORT, 'fixture hint audit rollback'); END");
    assert.equal((await post(task.id, { content: 'must rollback', sessionId: a.id })).status, 500);
    assert.equal(await repo(E.HintEntity).count(), before); assert.equal(sessions.getAgent(a.id).peekQueuedMessages().length, 0); await db.query('DROP TRIGGER fixture_hint_audit');
    const directedResponse = await post(task.id, { content: 'ONLY_WORKER_A', sessionId: a.id }); assert.equal(directedResponse.status, 201); const directed = await directedResponse.json();
    const taskHint = await hints.create(task.id, 'ONLY_PLANNER_TASK_HINT');
    const pending = await hints.takePending(task.id); assert.deepEqual(pending.map((h) => h.id), [taskHint.id], 'Planner must not read directed Worker hints');
    await assert.rejects(() => hints.consume(directed.id, planner.id), /定向提示/);
    await assert.rejects(() => hints.consume(taskHint.id, a.id), /仅 Planner/);
    await Promise.all(Array.from({ length: 8 }, () => hints.deliverPending()));
    await Promise.all(Array.from({ length: 8 }, () => sessions.queueHint(directed)));
    assert.equal(sessions.getAgent(a.id).peekQueuedMessages().length, 1); assert.equal(sessions.getAgent(b.id).peekQueuedMessages().length, 0); assert.equal(sessions.getAgent(planner.id).peekQueuedMessages().length, 0);
    assert.equal((await repo(E.HintEntity).findOneByOrFail({ id: directed.id })).status, 'pending', 'queue insertion is not consumption');
    releases.get('hold-worker-a')();
    await until(async () => (await repo(E.AgentSessionEntity).findOneByOrFail({ id: a.id })).state === 'completed', 'A complete with steering');
    const received = await repo(E.HintEntity).findOneByOrFail({ id: directed.id }); assert.equal(received.status, 'consumed'); assert.equal(received.appliedToSessionId, a.id);
    const receipt = await repo(E.AgentSessionMessageEntity).findOneByOrFail({ id: directed.id }); assert.equal(receipt.sessionId, a.id); assert.equal(receipt.messageJson.hintId, directed.id);
    assert.ok(captures.some((body) => body.messages.some((m) => JSON.stringify(m.content).includes('ONLY_WORKER_A'))), 'real next model request receives directed hint');
    for (const tag of ['hold-worker-b', 'hold-planner']) assert.ok(!captures.filter((body) => JSON.stringify(body.messages).includes(tag)).some((body) => JSON.stringify(body.messages).includes('ONLY_WORKER_A')), 'hint cannot leak to other model sessions');
    await store.appendHintMessage(a, receipt.messageJson); assert.equal(await repo(E.AgentSessionMessageEntity).countBy({ id: directed.id }), 1, 'receipt replay is idempotent');
    assert.equal((await post(task.id, { content: 'ended', sessionId: a.id })).status, 409);
    // A queued hint interrupted before the next turn stays pending and is re-admitted only on explicit resume.
    const pausedHint = await hints.create(task.id, 'WORKER_B_AFTER_RESUME', b.id); await sessions.pause(b.id);
    assert.equal(sessions.getAgent(b.id).peekQueuedMessages().length, 0);
    await hints.deliverPending(); assert.equal((await repo(E.HintEntity).findOneByOrFail({ id: pausedHint.id })).status, 'pending');
    assert.equal(await repo(E.AgentSessionMessageEntity).countBy({ id: pausedHint.id }), 0);
    const resumed = await sessions.resume(b.id); assert.equal(resumed.state, 'completed', JSON.stringify(resumed));
    assert.equal((await repo(E.HintEntity).findOneByOrFail({ id: pausedHint.id })).appliedToSessionId, b.id);
    // Failure to commit a receipt cannot become a consumed hint or trigger a follow-up model request.
    const broken = await start('receipt-failure'); const brokenHint = await hints.create(task.id, 'MUST_NOT_DISPATCH_AFTER_FAILED_RECEIPT', broken.id);
    await db.query(`CREATE TRIGGER fixture_hint_receipt BEFORE INSERT ON agent_session_messages WHEN NEW.id='${brokenHint.id}' BEGIN SELECT RAISE(ABORT, 'fixture receipt rollback'); END`);
    releases.get('hold-receipt-failure')();
    await until(async () => (await repo(E.AgentSessionEntity).findOneByOrFail({ id: broken.id })).state === 'failed', 'failed receipt stops session');
    assert.equal((await repo(E.HintEntity).findOneByOrFail({ id: brokenHint.id })).status, 'pending'); assert.equal(await repo(E.AgentSessionMessageEntity).countBy({ id: brokenHint.id }), 0);
    assert.ok(!captures.some((body) => JSON.stringify(body.messages).includes('MUST_NOT_DISPATCH_AFTER_FAILED_RECEIPT'))); await db.query('DROP TRIGGER fixture_hint_receipt');
    // Global runtime and task/session pause gates do not get bypassed by a submitted hint.
    const gated = await start('gated'); await repo(E.TaskEntity).update(task.id, { status: 'paused', engineStatus: 'paused' });
    const gateHint = await hints.create(task.id, 'GATED_HINT', gated.id); await hints.deliverPending(); assert.equal(sessions.getAgent(gated.id).peekQueuedMessages().length, 0);
    await repo(E.TaskEntity).update(task.id, { status: 'running', engineStatus: 'running' });
    await repo(E.SystemSettingEntity).save({ key: 'runtime.piRuntimeEnabled', value: 'false', encrypted: false }); await hints.deliverPending(); assert.equal(sessions.getAgent(gated.id).peekQueuedMessages().length, 0);
    await repo(E.SystemSettingEntity).update({ key: 'runtime.piRuntimeEnabled' }, { value: 'true' });
    await repo(E.WorkerTaskEntity).update({ sessionId: gated.id }, { leaseExpiresAt: new Date(Date.now() - 1000) }); await hints.deliverPending(); assert.equal(sessions.getAgent(gated.id).peekQueuedMessages().length, 0);
    assert.equal((await repo(E.HintEntity).findOneByOrFail({ id: gateHint.id })).status, 'pending');
    await hints.consume(taskHint.id, planner.id); await hints.consume(taskHint.id, planner.id);
    assert.equal((await repo(E.HintEntity).findOneByOrFail({ id: taskHint.id })).appliedToSessionId, planner.id);
    const plannerHint = await hints.create(task.id, 'ONLY_DIRECT_PLANNER', planner.id); releases.get('hold-planner')();
    await until(async () => (await repo(E.AgentSessionEntity).findOneByOrFail({ id: planner.id })).state === 'completed', 'direct Planner steering');
    assert.equal((await repo(E.HintEntity).findOneByOrFail({ id: plannerHint.id })).appliedToSessionId, planner.id);
    assert.ok(captures.some((body) => JSON.stringify(body.messages).includes('ONLY_DIRECT_PLANNER')));
    // Unconsumed session-specific hints survive close/reopen but are not reassigned after reconciliation.
    await sessions.terminate(gated.id, 'fixture shutdown');
    const orphan = await sessions.createRecord({ taskId: task.id, role: 'explore', modelName: 'fixture-hints', systemPrompt: '', tools: [] });
    const orphanHint = await hints.create(task.id, 'ORPHAN_MUST_NOT_REPLAY', orphan.id);
    const oldCaptures = captures.length; await app.close(); app = null;
    const reopened = await new (backendRequire('typeorm').DataSource)(require('../apps/api/dist/database/sqlite-options').sqliteOptions(file)).initialize();
    try {
      const r = (entity) => reopened.getRepository(entity); const eventSink = { broadcast() {} }; const audit = new (load('audit/audit.service', 'AuditService'))(r(E.AuditLogEntity), eventSink);
      const newHints = new (load('blackboard/hints.service', 'HintsService'))(r(E.HintEntity), audit);
      const newSessions = new (load('pi-runtime/session-manager.service', 'SessionManagerService'))(r(E.AgentSessionEntity), {}, {}, eventSink, audit, newHints);
      await newSessions.reconcile(); await newHints.deliverPending(); assert.equal(newSessions.activeCount, 0); assert.equal(captures.length, oldCaptures);
      assert.equal((await r(E.HintEntity).findOneByOrFail({ id: orphanHint.id })).status, 'pending'); assert.equal((await r(E.AgentSessionEntity).findOneByOrFail({ id: orphan.id })).state, 'failed');
    } finally { await reopened.destroy(); }
    assert.deepEqual(errors, []);
    console.log('PASS: full Nest hint HTTP validation/ownership and atomic audit, exact-session real Pi steering and next model request, no Planner/other Worker leakage, concurrent queue deduplication, durable idempotent receipt, paused explicit resume, receipt rollback stops dispatch, task/runtime/lease gates and close/reopen without replay; loopback fixed model only');
  } finally {
    if (app) { const manager = app.get(load('pi-runtime/session-manager.service', 'SessionManagerService')); for (const id of [...manager.handles.keys()]) await manager.terminate(id, 'fixture cleanup').catch(() => {}); await app.close(); }
    model.closeAllConnections(); await new Promise((resolve) => model.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('vulnagent-hints-')); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
