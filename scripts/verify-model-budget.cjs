const createTestApp = require('./create-test-app.cjs');
const backendRequire = require('./backend-require.cjs');
// This regression exercises an explicitly enabled engine; disabled behavior has its own fixture.
process.env.PI_RUNTIME_ENABLED = 'true';
// Real Pi SDK + real migrated SQLite + loopback OpenAI-compatible protocol fixture.
// The only tool returns fixed text; no target service, scanning, external model or real credential is used.
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DataSource } = backendRequire('typeorm');
const { Module, ValidationPipe } = backendRequire('@nestjs/common');
const { NestFactory } = backendRequire('@nestjs/core');
const { getRepositoryToken } = backendRequire('@nestjs/typeorm');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const { hydrateTaskAccounting, sessionAccounting } = require('../apps/api/dist/database/model-accounting');
const { serialTransaction } = require('../apps/api/dist/database/serial-transaction');
const load = (module, name) => require(`../apps/api/dist/modules/${module}`)[name];
const createToolStack = load('tool/tool-stack', 'createToolStack');
const ToolCatalogService = load('tool/tool-catalog.service', 'ToolCatalogService');
const ModelBudgetService = load('model-gateway/model-budget.service', 'ModelBudgetService');
const ModelBudgetController = load('model-gateway/model-budget.controller', 'ModelBudgetController');
const context = { messages: [{ role: 'user', content: 'fixed input', timestamp: 1 }] };
const modelMeta = { id: 'fixture-budget', provider: 'fixture', maxTokens: 2000, contextWindow: 100000 };

async function task(db, id, tokenBudget = 20000) {
  return db.getRepository(E.TaskEntity).save({ id, name: id, status: 'running', scope: { cidrs: ['192.168.56.0/24'] }, modelName: 'fixture-budget', modelProvider: 'fixture', tokenBudget, startedAt: new Date(), timeBudgetMinutes: 10 });
}
async function until(test, label, limit = 5000) {
  const end = Date.now() + limit;
  while (Date.now() < end) { if (await test()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`Timed out: ${label}`);
}
async function crashFixture(file) {
  const db = await new DataSource(sqliteOptions(file)).initialize(); await db.runMigrations();
  await task(db, 'crash', 5000);
  await db.getRepository(E.AgentSessionEntity).save({ id: 'crash-session', taskId: 'crash', sessionKey: 'crash-session', modelName: 'fixture-budget', role: 'explore', state: 'running', tokenAllowance: 4000 });
  await new ModelBudgetService(db.getRepository(E.ModelRequestEntity)).reserve('crash-session', context, modelMeta, 1000);
  process.exit(17);
}

async function main() {
  if (process.argv[2] === '--crash-fixture') return crashFixture(process.argv[3]);
  const db = await new DataSource(sqliteOptions(':memory:')).initialize();
  const captures = []; const serverErrors = []; const slow = new Set();
  let server; let app; let directory; let restarted; let releaseBudgetResponse;
  let secret = 'fixture-secret-not-a-real-key';
  try {
    await db.runMigrations(); const repo = (entity) => db.getRepository(entity);
    const budget = new ModelBudgetService(repo(E.ModelRequestEntity)); await budget.onApplicationBootstrap();
    const gatewayEvents = { broadcast() {} }; const audit = { record: async () => {} };
    const store = new (load('pi-runtime/session-store.service', 'SessionStoreService'))(repo(E.AgentSessionMessageEntity), repo(E.AgentSessionEventEntity), repo(E.AgentSessionEntity), repo(E.ModelUsageEntity), gatewayEvents);
    server = http.createServer(async (req, res) => {
      try {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); const serialized = JSON.stringify(body.messages);
        const mode = ['tool-normal', 'quota-overrun', 'missing-usage', 'secret-error', 'cancel-stream', 'key-rotation', 'budget-wait'].find((s) => serialized.includes(s)) ?? 'normal';
        const capture = { mode, body, authorization: req.headers.authorization, closed: false }; captures.push(capture);
        res.on('close', () => { capture.closed = true; slow.delete(res); });
        assert.equal(req.url, '/v1/chat/completions');
        if (mode === 'secret-error') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `rejected test key ${secret}` } })); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const emit = (choices, usage) => res.write(`data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: 'fixture-budget', choices, ...(usage ? { usage } : {}) })}\n\n`);
        const firstTool = ['tool-normal', 'quota-overrun'].includes(mode) && !body.messages.some((m) => m.role === 'tool');
        if (mode === 'budget-wait' && captures.filter((c) => c.mode === mode).length === 1) {
          emit([{ index: 0, delta: { role: 'assistant', content: 'fixed pending budget response' }, finish_reason: null }]);
          slow.add(res);
          releaseBudgetResponse = () => { emit([{ index: 0, delta: {}, finish_reason: 'stop' }]); emit([], { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }); res.end('data: [DONE]\n\n'); };
          return;
        }
        if (mode === 'cancel-stream') { emit([{ index: 0, delta: { role: 'assistant', content: 'fixed pending text' }, finish_reason: null }]); slow.add(res); return; }
        if (firstTool) {
          emit([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: 'fixture_observe', arguments: '{"target":"192.168.56.101"}' } }] }, finish_reason: null }]);
          emit([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]);
        } else {
          emit([{ index: 0, delta: { role: 'assistant', content: '固定协议结果，不代表真实目标观测。' }, finish_reason: null }]);
          emit([{ index: 0, delta: {}, finish_reason: 'stop' }]);
        }
        if (mode !== 'missing-usage') {
          const input = mode === 'quota-overrun' ? 5000 : firstTool ? 120 : 180; const output = firstTool ? 30 : 20;
          emit([], { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: 20 } });
        }
        res.end('data: [DONE]\n\n');
      } catch (error) { serverErrors.push(error); res.destroy(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const runtime = { model: { provider: 'openai-compatible', modelName: 'fixture-budget', baseUrl, maxTokens: 2000, temperature: 0 }, runtime: { modelMaxConcurrency: 2, piRuntimeEnabled: true } };
    const settings = { get: async () => runtime, readApiKey: async () => secret, registerModelTester() {}, registerRuntimeReloader() {} };
    const gateway = new (load('model-gateway/model-gateway.service', 'ModelGatewayService'))(settings, budget); await gateway.onModuleInit();
    const sessions = new (load('pi-runtime/session-manager.service', 'SessionManagerService'))(repo(E.AgentSessionEntity), store, gateway, gatewayEvents, audit);
    let toolCalls = 0;
    const tools = [{ name: 'fixture_observe', label: 'fixture', description: 'Only returns fixed text; no network or target interaction', parameters: { type: 'object', required: ['target'], properties: { target: { type: 'string' } }, additionalProperties: false }, execute: async () => { toolCalls++; return { content: [{ type: 'text', text: 'fixed fixture observation' }] }; } }];
    async function createSession(taskId, allowance, mode, start = true, modelName = 'fixture-budget') {
      const options = { taskId, role: 'explore', profileId: 'recon', modelName, systemPrompt: '本机模型协议夹具。只返回固定数据。', tools, tokenAllowance: allowance };
      const row = await sessions.createRecord(options);
      if (start) {
        await sessions.start(row, options, `mode:${mode}`);
        const agent = sessions.getAgent(row.id); if (agent) await agent.waitForIdle();
      } else await repo(E.AgentSessionEntity).update(row.id, { state: 'running' });
      return sessions.findOne(row.id);
    }

    await task(db, 'normal'); const normal = await createSession('normal', 6000, 'tool-normal');
    assert.equal(normal.state, 'completed'); assert.equal(toolCalls, 1);
    assert.equal(normal.tokenInput, 300, 'cached input must be counted'); assert.equal(normal.tokenOutput, 50);
    assert.equal((await hydrateTaskAccounting(db.manager, await repo(E.TaskEntity).findOneByOrFail({ id: 'normal' }))).tokensUsed, 350);
    assert.equal(await repo(E.ModelUsageEntity).countBy({ taskId: 'normal' }), 2, 'gateway and message callback must not double bill');
    assert.ok(captures.filter((c) => c.mode === 'tool-normal').every((c) => (c.body.max_tokens ?? c.body.max_completion_tokens) <= 2000));
    assert.equal((await store.listMessages(normal.id)).items.filter((m) => m.role === 'assistant').length, 2);

    // Concurrent sessions must use their selected model, rather than silently following the global default.
    await task(db, 'model-selected'); await task(db, 'model-default');
    await repo(E.TaskEntity).update('model-selected', { modelName: 'fixture-secondary' });
    const [selectedModel, defaultModel] = await Promise.all([
      createSession('model-selected', 6000, 'selected-model-fixture', true, ''),
      createSession('model-default', 6000, 'default-model-fixture'),
    ]);
    assert.equal(selectedModel.state, 'completed'); assert.equal(defaultModel.state, 'completed');
    assert.equal(selectedModel.modelName, 'fixture-secondary');
    assert.ok(captures.some((capture) => JSON.stringify(capture.body.messages).includes('selected-model-fixture') && capture.body.model === 'fixture-secondary'));
    assert.ok(captures.some((capture) => JSON.stringify(capture.body.messages).includes('default-model-fixture') && capture.body.model === 'fixture-budget'));
    assert.equal((await repo(E.ModelRequestEntity).findOneByOrFail({ sessionId: selectedModel.id })).modelName, 'fixture-secondary');

    await task(db, 'overrun'); const beforeTool = toolCalls; const overrun = await createSession('overrun', 4000, 'quota-overrun');
    assert.equal(overrun.state, 'failed'); assert.equal(toolCalls, beforeTool, 'quota-exhausting toolUse must never execute a tool');
    assert.equal(overrun.tokenInput + overrun.tokenOutput, 5030, 'provider overrun must be charged, not clamped to estimate');
    assert.match(overrun.errorMessage, /Token|额度/);
    assert.equal(captures.filter((c) => c.mode === 'quota-overrun').length, 1);

    // 工具层也必须独立执行预算闸门：即使调用方绕过 SDK 的工具拦截，额度耗尽也不能触碰远端。
    let remoteCalls = 0;
    // 工具层独立预算闸门需要真实的工具目录，否则调用会先被判为"未知工具"。
    await repo(E.McpServerEntity).save({ id: 'budget-server', name: 'budget fixture only', endpoint: 'http://unused.invalid/mcp', enabled: true, transport: 'streamable-http' });
    await repo(E.McpToolEntity).save({ id: 'budget-tool', mcpServerId: 'budget-server', name: 'fixture_observe', riskLevel: 'read_only', inputSchema: { type: 'object', required: ['target'], properties: { target: { type: 'string' } } }, syncedAt: new Date() });
    const stack = createToolStack({
      servers: repo(E.McpServerEntity), tools: repo(E.McpToolEntity), targets: repo(E.TargetEntity), tasks: repo(E.TaskEntity),
      permissions: repo(E.AgentToolPermissionEntity), rules: repo(E.InterceptRuleEntity), calls: repo(E.ToolCallEntity),
      events: gatewayEvents, audit: { record: async () => ({}) }, sessions: repo(E.AgentSessionEntity),
      factory: { callTool: async () => { remoteCalls++; throw new Error('exhausted worker must never reach MCP'); } },
    });
    await new ToolCatalogService(repo(E.McpServerEntity), repo(E.McpToolEntity), stack.registry, stack.driver).sync();
    const blocked = await stack.invoker.invoke('fixture_observe', { target: '192.168.56.101' },
      { taskId: 'overrun', sessionId: overrun.id, role: 'explore', authorizedTargets: [], allowedTools: [] });
    assert.equal(blocked.failureKind, 'blocked'); assert.equal(remoteCalls, 0);
    assert.match(blocked.encoded.text, /额度|Token/);

    await task(db, 'unknown'); const unknown = await createSession('unknown', 6000, 'missing-usage');
    let unknownTask = await hydrateTaskAccounting(db.manager, await repo(E.TaskEntity).findOneByOrFail({ id: 'unknown' }));
    assert.equal(unknownTask.tokensUsed, 0); assert.ok(unknownTask.tokensCommitted > 0);
    const unknownLease = await repo(E.ModelRequestEntity).findOneByOrFail({ taskId: 'unknown' }); assert.equal(unknownLease.state, 'uncertain');
    await repo(E.AgentSessionEntity).update(unknown.id, { state: 'running' });
    await assert.rejects(budget.reserve(unknown.id, context, modelMeta, 100), /不能自动重试/);
    await repo(E.AgentSessionEntity).update(unknown.id, { state: 'failed' });

    await task(db, 'errors'); const errors = await createSession('errors', 6000, 'secret-error');
    assert.equal(errors.state, 'failed'); assert.ok(!errors.errorMessage.includes(secret));
    assert.ok(!JSON.stringify((await store.listMessages(errors.id)).items).includes(secret));
    assert.ok(!(await repo(E.ModelRequestEntity).findOneByOrFail({ taskId: 'errors' })).errorMessage.includes(secret));

    await task(db, 'cancel');
    const cancelOptions = { taskId: 'cancel', role: 'explore', modelName: 'fixture-budget', systemPrompt: 'loopback only', tools: [], tokenAllowance: 6000 };
    const cancelling = await sessions.createRecord(cancelOptions); await sessions.start(cancelling, cancelOptions, 'mode:cancel-stream');
    await until(() => captures.some((c) => c.mode === 'cancel-stream'), 'model request started');
    const cancelStart = Date.now(); await sessions.pause(cancelling.id); assert.ok(Date.now() - cancelStart < 5000);
    await until(() => captures.find((c) => c.mode === 'cancel-stream').closed, 'provider connection cancelled');
    assert.equal((await repo(E.ModelRequestEntity).findOneByOrFail({ taskId: 'cancel' })).state, 'uncertain');
    await sessions.terminate(cancelling.id);

    await task(db, 'keys'); const keys = await createSession('keys', 10000, 'key-rotation', false);
    const model = await gateway.getModel(); const streamFn = await gateway.createStreamFn(keys.id);
    const keyContext = { messages: [{ role: 'user', content: 'mode:key-rotation', timestamp: 1 }] };
    runtime.model.maxTokens = 500;
    await (await streamFn(model, keyContext, { maxTokens: 9999 })).result();
    const oldSecret = secret; secret = 'rotated-fixture-secret';
    await (await streamFn(model, keyContext, { maxTokens: 9999 })).result();
    const keyCalls = captures.filter((c) => c.mode === 'key-rotation');
    assert.equal(keyCalls[0].authorization, `Bearer ${oldSecret}`); assert.equal(keyCalls[1].authorization, `Bearer ${secret}`);
    assert.ok(keyCalls.every((c) => (c.body.max_tokens ?? c.body.max_completion_tokens) === 500));
    runtime.model.baseUrl = `${baseUrl}/changed`;
    await assert.rejects(streamFn(model, keyContext), /重新启动/); assert.equal(captures.filter((c) => c.mode === 'key-rotation').length, 2);
    runtime.model.baseUrl = baseUrl;

    // A budget waiter yields its concurrency slot, and resumes when another request settles.
    runtime.model.maxTokens = 5000; await task(db, 'wait-budget', 5000);
    const waitingOptions = { taskId: 'wait-budget', role: 'explore', modelName: 'fixture-budget', systemPrompt: 'loopback budget wait', tools: [], tokenAllowance: 10000 };
    const holding = await sessions.createRecord(waitingOptions); await sessions.start(holding, waitingOptions, 'mode:budget-wait');
    await until(() => Boolean(releaseBudgetResponse), 'held budget response started');
    const holderAgent = sessions.getAgent(holding.id);
    const waiting = createSession('wait-budget', 10000, 'budget-wait');
    await task(db, 'independent-task'); const independent = await createSession('independent-task', 10000, 'normal');
    assert.equal(independent.state, 'completed', 'budget wait must not monopolize model concurrency');
    assert.equal(captures.filter((c) => c.mode === 'budget-wait').length, 1);
    releaseBudgetResponse(); if (holderAgent) await holderAgent.waitForIdle();
    assert.equal((await waiting).state, 'completed');
    assert.equal(captures.filter((c) => c.mode === 'budget-wait').length, 2);
    assert.equal(await repo(E.TaskStateEventEntity).countBy({ taskId: 'wait-budget', eventType: 'model.budget_blocked' }), 0);

    // Two contenders cannot reserve the same balance. Temporary contention is not a task-budget stop.
    await task(db, 'concurrent', 2000);
    const s1 = await createSession('concurrent', 4000, '', false); const s2 = await createSession('concurrent', 4000, '', false);
    const first = await budget.reserve(s1.id, context, modelMeta, 1000);
    await assert.rejects(budget.reserve(s2.id, context, modelMeta, 1000), load('model-gateway/token-budget', 'TokenBudgetBusyError'));
    assert.equal(await repo(E.TaskStateEventEntity).countBy({ taskId: 'concurrent', eventType: 'model.budget_blocked' }), 0);
    await Promise.all([budget.finish(first.id, { usage: { input: 100, output: 50 }, stopReason: 'stop' }), budget.finish(first.id, { usage: { input: 100, output: 50 }, stopReason: 'stop' })]);
    assert.equal(await repo(E.ModelUsageEntity).countBy({ taskId: 'concurrent' }), 1);
    const second = await budget.reserve(s2.id, context, modelMeta, 1000);
    await budget.finish(second.id, { usage: { input: 20, output: 5 }, stopReason: 'aborted' });
    const partial = await hydrateTaskAccounting(db.manager, await repo(E.TaskEntity).findOneByOrFail({ id: 'concurrent' }));
    assert.equal(partial.tokensUsed, 175); assert.equal(partial.tokensCommitted, second.reservedTokens - 25);
    await budget.finish(second.id, null); assert.equal((await repo(E.ModelRequestEntity).findOneByOrFail({ id: second.id })).inputTokens, 20);
    await budget.finish(second.id, { usage: { input: 100, output: 30 }, stopReason: 'stop' });
    assert.equal((await hydrateTaskAccounting(db.manager, await repo(E.TaskEntity).findOneByOrFail({ id: 'concurrent' }))).tokensCommitted, 0);

    // Failure of one reservation cannot roll back a concurrent session message; cold seq allocation is serialized too.
    await db.query("CREATE TRIGGER fail_model_reservation BEFORE INSERT ON model_requests BEGIN SELECT RAISE(FAIL, 'injected reservation failure'); END");
    const own = await repo(E.AgentSessionEntity).findOneByOrFail({ id: s1.id });
    const writes = await Promise.allSettled([budget.reserve(s1.id, context, modelMeta, 100), store.appendMessage(own, { role: 'user', content: 'must survive another transaction rollback', timestamp: 1 })]);
    assert.equal(writes[0].status, 'rejected'); assert.equal(writes[1].status, 'fulfilled');
    assert.equal((await store.listMessages(own.id)).items.length, 1);
    await db.query('DROP TRIGGER fail_model_reservation');
    store.releaseSeq(s2.id);
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.appendMessage({ ...own, id: s2.id }, { role: 'user', content: `parallel-${i}`, timestamp: i })));
    assert.equal(new Set((await store.listMessages(s2.id)).items.map((m) => m.seq)).size, 10);

    // Local HTTP summary and explicit new run: late prior-run usage stays in history.
    const taskService = new (load('tasks/tasks.service', 'TasksService'))(repo(E.TaskEntity), repo(E.TargetEntity), repo(E.TaskStateEventEntity), db, audit, gatewayEvents);
    await repo(E.TaskEntity).update('unknown', { status: 'stopped' });
    await taskService.applyAction('unknown', 'rerun');
    await budget.finish(unknownLease.id, { usage: { input: 90, output: 10 }, stopReason: 'stop' });
    unknownTask = await hydrateTaskAccounting(db.manager, await repo(E.TaskEntity).findOneByOrFail({ id: 'unknown' }));
    assert.equal(unknownTask.tokensUsed, 0); assert.equal(unknownTask.tokensCommitted, 0);
    class TestModule {}
    Module({ controllers: [ModelBudgetController], providers: [{ provide: getRepositoryToken(E.ModelRequestEntity), useValue: repo(E.ModelRequestEntity) }] })(TestModule);
    app = await createTestApp(TestModule, { logger: false }); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.listen(0, '127.0.0.1'); const apiBase = await app.getUrl();
    assert.equal((await (await fetch(`${apiBase}/tasks/unknown/model-budget`)).json()).total, 0);
    assert.equal((await (await fetch(`${apiBase}/tasks/unknown/model-budget?history=true`)).json()).total, 1);
    assert.equal((await fetch(`${apiBase}/tasks/missing/model-budget`)).status, 404);
    assert.equal((await fetch(`${apiBase}/tasks/unknown/model-budget?page=bad`)).status, 400);
    assert.equal((await fetch(`${apiBase}/tasks/unknown/model-budget?history=bad`)).status, 400);

    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnagent-model-budget-'));
    const file = path.join(directory, 'restart.sqlite');
    const child = spawnSync(process.execPath, [__filename, '--crash-fixture', file], { encoding: 'utf8', timeout: 30000 }); assert.equal(child.status, 17, child.stderr || child.stdout);
    restarted = await new DataSource(sqliteOptions(file)).initialize();
    await new ModelBudgetService(restarted.getRepository(E.ModelRequestEntity)).onApplicationBootstrap();
    const afterCrash = await hydrateTaskAccounting(restarted.manager, await restarted.getRepository(E.TaskEntity).findOneByOrFail({ id: 'crash' }));
    assert.equal(afterCrash.tokensUsed, 0); assert.ok(afterCrash.tokensCommitted > 0);
    assert.equal((await restarted.getRepository(E.ModelRequestEntity).findOneByOrFail({ taskId: 'crash' })).state, 'uncertain');
    assert.equal(await restarted.getRepository(E.ModelUsageEntity).count(), 0);
    assert.equal(gateway.concurrency.running, 0); assert.equal(gateway.concurrency.pending, 0); assert.deepEqual(serverErrors, []);
    const { ModelTokenBudget1793577606000 } = require('../apps/api/dist/database/migrations/1793577606000-ModelTokenBudget');
    await assert.rejects(new ModelTokenBudget1793577606000().down(db.createQueryRunner()), /预算记录非空/);
    console.log('PASS: real Pi Agent/AI + loopback SSE, configured output caps, cached input usage, no double billing, quota-before-tools, provider overrun accounting, missing/partial usage retention, prompt-free ledger, cancellation, key rotation/endpoint isolation, atomic competing reservations, independent rollback/message sequence, late old-run settlement, scoped HTTP and real process-exit recovery');
  } finally {
    if (app) await app.close();
    for (const res of slow) res.destroy();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await new Promise((resolve) => setImmediate(resolve));
    await serialTransaction(db.manager, async () => {});
    if (restarted) await restarted.destroy(); await db.destroy();
    if (directory) { const target = path.resolve(directory); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('vulnagent-model-budget-')); fs.rmSync(target, { recursive: true, force: true }); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
