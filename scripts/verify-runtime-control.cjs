const backendRequire = require('./backend-require.cjs');
backendRequire('reflect-metadata');
process.env.PI_RUNTIME_ENABLED = 'false';
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { DataSource } = backendRequire('typeorm'); const { Module, ValidationPipe } = backendRequire('@nestjs/common');
const createTestApp = require('./create-test-app.cjs');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const configuration = require('../apps/api/dist/config/configuration').default;
const load = (name, symbol) => require(`../apps/api/dist/modules/${name}`)[symbol];
const SettingsService = load('settings/settings.service', 'SettingsService'); const SettingsController = load('settings/settings.controller', 'SettingsController');
const TasksService = load('tasks/tasks.service', 'TasksService'); const TasksController = load('tasks/tasks.controller', 'TasksController');
const OrchestratorService = load('orchestrator/orchestrator.service', 'OrchestratorService');
const ModelGatewayService = load('model-gateway/model-gateway.service', 'ModelGatewayService');
const ModelBudgetService = load('model-gateway/model-budget.service', 'ModelBudgetService');
const SessionManagerService = load('pi-runtime/session-manager.service', 'SessionManagerService');
const createToolStack = load('tool/tool-stack', 'createToolStack');
const ToolCatalogService = load('tool/tool-catalog.service', 'ToolCatalogService');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test) { const end = Date.now() + 4000; while (Date.now() < end) { if (await test()) return; await sleep(10); } throw new Error('fixture timeout'); }

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnagent-runtime-control-'));
  const db = await new DataSource(sqliteOptions(':memory:')).initialize(); let app; let orchestrator;
  try {
    await db.runMigrations(); const repo = (entity) => db.getRepository(entity);
    const cfg = configuration(); cfg.security = { encryptionKey: '', encryptionKeyFile: path.join(directory, 'master.key') }; cfg.model.apiKey = 'fixture-key'; cfg.model.baseUrl = 'http://unused.invalid/v1'; cfg.runtime.modelMaxConcurrency = 1;
    const config = { get: (name) => name.split('.').reduce((value, key) => value?.[key], cfg) };
    const pushes = []; const events = { broadcast: (type, payload) => pushes.push({ type, payload }) };
    const audit = new (load('audit/audit.service', 'AuditService'))(repo(E.AuditLogEntity), events);
    const settings = new SettingsService(repo(E.SystemSettingEntity), config, audit);
    const tasks = new TasksService(repo(E.TaskEntity), repo(E.TargetEntity), repo(E.TaskStateEventEntity), db, audit, events);
    const budgets = new ModelBudgetService(repo(E.ModelRequestEntity)); const gateway = new ModelGatewayService(settings, budgets);
    await gateway.onModuleInit();
    let cycles = 0; const pauses = [];
    const sessions = { reconcile: async () => 0, pause: async (id) => { pauses.push(id); await repo(E.AgentSessionEntity).update(id, { state: 'paused' }); }, resume: async (id) => repo(E.AgentSessionEntity).update(id, { state: 'running' }) };
    orchestrator = new OrchestratorService(repo(E.TaskEntity), repo(E.TargetEntity), repo(E.IntentEntity), repo(E.OrchestratorRunEntity), repo(E.TaskStateEventEntity), { sessions }, { counts: async () => ({}), progressKeys: async () => [] }, { counts: async () => ({}) }, {}, { listByTask: async () => [], findRunningAll: async () => [] }, {}, {}, {}, events, audit, {});
    orchestrator.onModuleDestroy(); await orchestrator.onApplicationBootstrap(); orchestrator.registerCycleBody(async () => { cycles++; });
    class TestModule {} Module({ controllers: [SettingsController, TasksController], providers: [{ provide: SettingsService, useValue: settings }, { provide: TasksService, useValue: tasks }] })(TestModule);
    app = await createTestApp(TestModule, { logger: false }); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true })); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    const put = (body) => fetch(`${base}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const dto = { name: '开关固定协议', authorized: true, targets: [{ ip: '192.0.2.10' }], scope: { cidrs: [], ports: '80' }, goal: { mode: 'recon', targets: ['192.0.2.10'], ports: '80', protocol: 'tcp', evidenceText: null }, modelProvider: 'fixture', modelName: 'fixture', tokenBudget: 10000, timeBudgetMinutes: 10, workerCount: 1, autoStart: true };
    assert.equal((await settings.get()).runtime.piRuntimeEnabled, false);
    assert.equal((await fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dto) })).status, 409);
    assert.equal(await repo(E.TaskEntity).count(), 0);
    const task = await tasks.create({ ...dto, autoStart: false });
    await assert.rejects(() => orchestrator.start(task.id), /执行引擎已关闭/); assert.equal(await repo(E.OrchestratorRunEntity).count(), 0);
    const sessionManager = new SessionManagerService(repo(E.AgentSessionEntity), {}, gateway, events, audit);
    await assert.rejects(() => sessionManager.createAndStart({ taskId: task.id, role: 'explore', modelName: 'fixture' }, 'fixture'), /执行引擎已关闭/); assert.equal(await repo(E.AgentSessionEntity).count(), 0);
    assert.equal((await put({ runtime: { piRuntimeEnabled: true } })).status, 200);
    await orchestrator.start(task.id); await until(() => cycles === 1);
    await repo(E.AgentSessionEntity).save({ id: 'session', taskId: task.id, role: 'explore', state: 'running', modelName: 'fixture', sessionKey: 'session', tokenAllowance: 4000 });
    orchestrator.getContext(task.id).plannerSessionId = 'session';
    await repo(E.TaskStateEventEntity).save({ id: 'old-resume', taskId: task.id, eventType: 'task.resume', consumedAt: null });
    await db.query("CREATE TRIGGER fixture_settings_audit BEFORE INSERT ON audit_logs WHEN NEW.action='settings.update' BEGIN SELECT RAISE(ABORT, 'fixture settings audit failure'); END");
    assert.equal((await put({ model: { modelName: 'must-rollback' }, runtime: { piRuntimeEnabled: false } })).status, 500);
    assert.equal((await settings.get()).runtime.piRuntimeEnabled, true); assert.notEqual((await settings.get()).model.modelName, 'must-rollback'); assert.equal((await tasks.detail(task.id)).status, 'running'); assert.equal((await repo(E.TaskStateEventEntity).findOneByOrFail({ id: 'old-resume' })).consumedAt, null);
    await db.query('DROP TRIGGER fixture_settings_audit');
    let modelSends = 0; let toolSends = 0;
    const model = { id: 'fixture', provider: 'fixture', baseUrl: cfg.model.baseUrl, maxTokens: 100, contextWindow: 10000 };
    gateway.models = { streamSimple: () => { modelSends++; return { result: async () => ({ role: 'assistant', content: [], stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }), async *[Symbol.asyncIterator]() {} }; } };
    const stream = await gateway.createStreamFn('session');
    await repo(E.McpServerEntity).save({ id: 'server', name: 'fixed factory only', endpoint: 'http://unused.invalid/mcp' });
    for (const [name, riskLevel] of [['http_repeater', 'safe'], ['fixture_approval', 'destructive']]) await repo(E.McpToolEntity).save({ id: name, name, mcpServerId: 'server', riskLevel, inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] }, syncedAt: new Date() });
    await repo(E.AgentToolPermissionEntity).save({ id: 'allow', taskId: task.id, agentRole: 'verifier', toolPattern: '*', allowed: true, requireApproval: false });
    const stack = createToolStack({
      servers: repo(E.McpServerEntity), tools: repo(E.McpToolEntity), targets: repo(E.TargetEntity), tasks: repo(E.TaskEntity),
      permissions: repo(E.AgentToolPermissionEntity), rules: repo(E.InterceptRuleEntity), calls: repo(E.ToolCallEntity),
      events, audit: { record: async () => ({}) },
      factory: { callTool: async () => { toolSends++; const text = 'fixed protocol observation'; return { ok: true, text, latencyMs: 1, isError: false, raw: { content: [{ type: 'text', text }] } }; } },
    });
    await new ToolCatalogService(repo(E.McpServerEntity), repo(E.McpToolEntity), stack.registry, stack.driver).sync();
    const context = { taskId: task.id, sessionId: null, role: 'verifier', authorizedTargets: [], allowedTools: [] }; const args = { target: '192.0.2.10' };
    assert.equal((await stack.invoker.invoke('http_repeater', args, context)).failureKind, null);
    await stack.invoker.invoke('fixture_approval', args, context);
    assert.equal(await repo(E.ToolCallEntity).countBy({ taskId: task.id, status: 'pending_approval' }), 0, 'automatic mode does not wait for tool approval');
    assert.equal(toolSends, 2);
    assert.equal((await put({ runtime: { piRuntimeEnabled: false } })).status, 200);
    assert.equal((await tasks.detail(task.id)).status, 'paused'); assert.ok((await repo(E.TaskStateEventEntity).findOneByOrFail({ id: 'old-resume' })).consumedAt);
    await assert.rejects(() => stream(model, { messages: [] }, { maxTokens: 20 }), /执行引擎已关闭/);
    await assert.rejects(async () => sessionManager.start(await repo(E.AgentSessionEntity).findOneByOrFail({ id: 'session' }), {}, null), /执行引擎已关闭/);
    const blocked = await stack.invoker.invoke('http_repeater', { ...args, probe: 'second' }, context);
    assert.equal(blocked.failureKind, 'blocked'); assert.ok(!blocked.deduplicated); assert.match(blocked.encoded.text, /执行引擎已关闭/);
    assert.equal((await stack.invoker.invoke('fixture_approval', { ...args, probe: 'disabled' }, context)).failureKind, 'blocked'); assert.equal(toolSends, 2); assert.equal(modelSends, 0); assert.equal(await repo(E.ModelRequestEntity).count(), 0);
    assert.equal((await fetch(`${base}/tasks/${task.id}/resume`, { method: 'POST' })).status, 409);
    // Re-enable before consuming the durable disable event: old controls must still not restart anything.
    await settings.update({ runtime: { piRuntimeEnabled: true } });
    await assert.rejects(() => orchestrator.resume(task.id), /仍在收尾/);
    await assert.rejects(() => tasks.applyAction(task.id, 'resume'), /仍在处理/);
    await orchestrator.consumeTaskStateEvents(); assert.equal(cycles, 1); assert.equal((await tasks.detail(task.id)).status, 'paused'); assert.deepEqual(pauses, ['session']);
    async function manuallyResume() {
      await settings.update({ runtime: { piRuntimeEnabled: true } });
      await tasks.applyAction(task.id, 'resume');
      await orchestrator.consumeTaskStateEvents();
      // 队列里可能还有旧的"引擎关闭"暂停事件，它会把刚恢复的任务再次暂停；
      // 只有确认任务确实回到 running 才算恢复成功。
      for (let i = 0; i < 20; i++) {
        const row = await repo(E.TaskEntity).findOneByOrFail({ id: task.id });
        if (row.status === 'running' && row.engineStatus === 'running') return;
        await orchestrator.consumeTaskStateEvents();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const row = await repo(E.TaskEntity).findOneByOrFail({ id: task.id });
      throw new Error(`任务未能恢复执行：${row.status}/${row.engineStatus}`);
    }
    await manuallyResume();
    await until(() => cycles === 2);
    // Disable while a model request waits for the global concurrency slot.
    const release = await gateway.concurrency.acquire(); const queued = stream(model, { messages: [] }, { maxTokens: 20 }); const rejected = assert.rejects(() => queued, /执行引擎已关闭/);
    await until(() => gateway.concurrency.pending === 1); await settings.update({ runtime: { piRuntimeEnabled: false } }); release(); await rejected; assert.equal(modelSends, 0); assert.equal(await repo(E.ModelRequestEntity).count(), 0);
    await orchestrator.consumeTaskStateEvents(); await manuallyResume();
    // Disable after a real budget reservation but before dispatch; the reservation must be cancelled, not uncertain.
    const reserve = budgets.reserve.bind(budgets); budgets.reserve = async (...input) => { const lease = await reserve(...input); await settings.update({ runtime: { piRuntimeEnabled: false } }); return lease; };
    await assert.rejects(() => stream(model, { messages: [] }, { maxTokens: 20 }), /执行引擎已关闭/); budgets.reserve = reserve;
    assert.equal(modelSends, 0); assert.equal((await repo(E.ModelRequestEntity).findOneByOrFail({ sessionId: 'session' })).state, 'cancelled'); assert.equal(gateway.concurrency.running, 0);
    assert.equal(await repo(E.ModelUsageEntity).count(), 0);
    await orchestrator.consumeTaskStateEvents(); await manuallyResume(); const result = await stream(model, { messages: [] }, { maxTokens: 20 }); await result.result(); assert.equal(modelSends, 1);
    console.log('PASS: real migrated settings HTTP, default off/DB override, no disabled autostart/session/model/tool/cache dispatch, atomic settings/pause/control/audit rollback, durable disable handling, no auto-resume after enabling, manual resume, queued and pre-dispatch gates with cancelled reservation, then enabled dispatch; fixed factories only');
  } finally { if (orchestrator) orchestrator.onModuleDestroy(); if (app) await app.close(); await db.destroy(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
