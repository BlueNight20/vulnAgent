const createTestApp = require('./create-test-app.cjs');
const backendRequire = require('./backend-require.cjs');
// This regression exercises an explicitly enabled engine; disabled behavior has its own fixture.
process.env.PI_RUNTIME_ENABLED = 'true';
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { DataSource } = backendRequire('typeorm');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const load = (path, name) => require(`../apps/api/dist/modules/${path}`)[name];
const { createToolStack } = require('../apps/api/dist/modules/tool/tool-stack');
const { ToolCatalogService } = require('../apps/api/dist/modules/tool/tool-catalog.service');
const TasksService = load('tasks/tasks.service', 'TasksService');
const TaskGoalsService = load('blackboard/task-goals.service', 'TaskGoalsService');
const FindingsService = load('blackboard/findings.service', 'FindingsService');
const FactsService = load('blackboard/facts.service', 'FactsService');
const EvidenceIngestionService = load('blackboard/evidence-ingestion.service', 'EvidenceIngestionService');
const IntentsService = load('blackboard/intents.service', 'IntentsService');
const WorkerStateService = load('blackboard/worker-state.service', 'WorkerStateService');
const WorkerRunnerService = load('orchestrator/worker-runner.service', 'WorkerRunnerService');
const OrchestratorService = load('orchestrator/orchestrator.service', 'OrchestratorService');
const OrchestratorCycleService = load('orchestrator/orchestrator-cycle.service', 'OrchestratorCycleService');

async function main() {
  const db = await new DataSource(sqliteOptions(':memory:')).initialize();
  try {
    await db.runMigrations();
    const repo = (e) => db.getRepository(e);
    const gateway = { broadcast() {} }; const audit = new (load('audit/audit.service', 'AuditService'))(repo(E.AuditLogEntity), gateway);
    const tasks = new TasksService(repo(E.TaskEntity), repo(E.TargetEntity), repo(E.TaskStateEventEntity), db, audit, gateway);
    const findings = new FindingsService(repo(E.FindingEntity));
    const goals = new TaskGoalsService(repo(E.TaskEntity), findings);
    const facts = new FactsService(repo(E.FactEntity), repo(E.HypothesisLinkEntity), gateway);
    const ingestion = new EvidenceIngestionService(repo(E.EvidenceEntity), facts);
    const intents = new IntentsService(repo(E.IntentEntity), gateway);
    const workers = new WorkerStateService(repo(E.WorkerTaskEntity), repo(E.WorkerResultCardEntity), gateway);
    const target = '192.168.56.101';
    const input = { name: '验收本地夹具', targets: [{ ip: target }], scope: { cidrs: [], ports: '80,443' }, authorized: true, modelProvider: 'fixture', modelName: 'fixture', tokenBudget: 10000, timeBudgetMinutes: 10, workerCount: 1,
      goal: { mode: 'recon', targets: [target], ports: '80,443', protocol: 'tcp', evidenceText: null }, autoStart: true };
    const task = await tasks.create(input);
    assert.equal(task.goal.mode, 'recon');
    assert.equal(await repo(E.TaskStateEventEntity).countBy({ taskId: task.id, eventType: 'task.start_requested' }), 1);
    // Exercise the actual durable consumer without starting a model or network worker.
    const started = [];
    const consumer = Object.create(OrchestratorService.prototype);
    consumer.contexts = new Map();
    Object.assign(consumer, { booted: true, consumingEvents: false, stateEvents: repo(E.TaskStateEventEntity), tasks: repo(E.TaskEntity), logger: { warn(message) { throw new Error(message); } }, start: async (id) => { started.push(id); await repo(E.TaskEntity).update(id, { engineStatus: 'running', startedAt: new Date() }); } });
    const paused = await tasks.create(input);
    await repo(E.TaskEntity).update(paused.id, { status: 'paused' });
    await consumer.consumeTaskStateEvents(); await consumer.consumeTaskStateEvents();
    assert.deepEqual(started, [task.id], 'autoStart is durable, idempotent and respects a pause before consumption');
    async function evidence(content, { date = new Date(), tool = 'nmap_scan', args = { target, ports: '80,443' }, sessionId = null } = {}) {
      const id = randomUUID(); const call = randomUUID();
      await repo(E.ToolCallEntity).save({ id: call, taskId: task.id, agentSessionId: sessionId, toolName: tool, targetIp: target, arguments: args, status: 'success', rawOutputRef: id, createdAt: date });
      return repo(E.EvidenceEntity).save({ id, taskId: task.id, agentSessionId: sessionId, toolCallId: call, kind: 'command_output', title: 'fixture', content, sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: Buffer.byteLength(content), meta: { tool, targetIp: target }, createdAt: date });
    }
    const scan = (rows) => `Nmap scan report for ${target}\nHost is up.\n${rows}`;
    await evidence(scan('80/tcp open http\n443/tcp closed https'), { date: new Date(Date.now() - 60000) });
    assert.equal((await goals.evaluate(task.id)).complete, false, 'previous-run evidence cannot satisfy this run');
    await evidence(scan('80/tcp open http'));
    await facts.create({ taskId: task.id, category: 'service', subject: `${target}:443/tcp`, predicate: 'has_open_port', object: '443/tcp https', status: 'observed', createdBy: 'agent', sourceEvidenceIds: [], targetIp: target });
    assert.equal((await goals.evaluate(task.id)).complete, false, 'an arbitrary fact row cannot invent scan coverage');
    const cycle = Object.create(OrchestratorCycleService.prototype);
    Object.assign(cycle, { goals, approvals: { async listPending() { return []; } }, intentRepo: repo(E.IntentEntity), orchestrator: { findTask: (id) => repo(E.TaskEntity).findOneByOrFail({ id }) } });
    const context = { activeWorkers: new Map(), noProgressRounds: 0 };
    assert.equal((await cycle.evaluateWithEvidence(task.id, context, 'goal_reached')).status, 'stalled');
    await evidence(scan('443/tcp closed https'));
    assert.equal((await goals.evaluate(task.id)).complete, true);
    assert.equal((await cycle.evaluateWithEvidence(task.id, context, 'in_progress')).status, 'completed');
    await repo(E.TaskEntity).update(task.id, { tokensUsed: 10000 });
    assert.equal((await cycle.evaluateWithEvidence(task.id, context, 'in_progress')).reason, 'budget_tokens');
    await repo(E.TaskEntity).update(task.id, { tokensUsed: 0 });
    await assert.rejects(() => goals.set(task.id, input.goal), /暂停/);
    await repo(E.TaskEntity).update(task.id, { status: 'paused', engineStatus: 'paused' });
    await new Promise((r) => setTimeout(r, 5));
    await goals.set(task.id, { ...input.goal, mode: 'assessment' });
    assert.equal((await goals.evaluate(task.id)).complete, false, 'newly configured goals exclude earlier evidence');
    const proof = await evidence(scan('80/tcp open http\n443/tcp closed https'));
    assert.equal((await goals.evaluate(task.id)).complete, false, 'assessment requires analysis, even when no candidates exist');
    const offered = await intents.create({ taskId: task.id, title: '分析现有证据', objective: '分析已观测服务与候选风险', workerProfileId: 'vuln-analysis', targetIp: target, dedupeKey: 'goal-analysis' });
    const worker = await workers.create({ taskId: task.id, intentId: offered.intent.id, title: '分析夹具', profileId: 'vuln-analysis', dedupeKey: 'goal-analysis', timeoutSeconds: 60, maxAttempts: 1 });
    const sessionId = randomUUID();
    await repo(E.AgentSessionEntity).save({ id: sessionId, taskId: task.id, role: 'explorer', profileId: 'vuln-analysis', sessionKey: sessionId, modelName: 'fixture', state: 'completed' });
    await workers.attachSession(worker.id, sessionId);
    const structured = { summary: '已阅读当前端口证据，HTTP 服务仍需进一步内容识别。', usedEvidenceIds: [proof.id, 'missing'], facts: [{ category: 'service', subject: `${target}:9999/tcp`, predicate: 'has_open_port', object: 'invented service', confidence: 1, evidenceIndex: 0 }] };
    const runner = Object.create(WorkerRunnerService.prototype);
    Object.assign(runner, { finalized: new Set(), lastResults: new Map(), logger: { debug() {}, warn() {}, error(message) { throw new Error(message); } },
      sessions: { findOne: async () => repo(E.AgentSessionEntity).findOneByOrFail({ id: sessionId }), store: { latestAssistant: async () => ({ role: 'assistant', content: JSON.stringify(structured) }) } },
      evidence: repo(E.EvidenceEntity), facts, ingestion, findings, workers, intents, hypotheses: {} });
    await runner.finalize(sessionId, { taskId: task.id, intent: offered.intent, workerTaskId: worker.id }, [], null);
    const invented = await repo(E.FactEntity).findOneByOrFail({ taskId: task.id, subject: `${target}:9999/tcp` });
    assert.equal(invented.status, 'inferred'); assert.equal(invented.createdBy, 'agent');
    await facts.create({ taskId: task.id, category: 'service', subject: invented.subject, predicate: invented.predicate, object: invented.object, status: 'inferred', observationKind: 'inference', confidence: 0.5, createdBy: 'agent', sourceEvidenceIds: [proof.id], targetIp: target });
    assert.equal((await repo(E.FactEntity).findOneByOrFail({ id: invented.id })).createdBy, 'agent', 'merging repeated model claims must preserve model provenance');
    assert.equal((await goals.evaluate(task.id)).complete, true, 'analysis can cite existing fresh evidence without repeating tools');
    const card = await repo(E.WorkerResultCardEntity).findOneByOrFail({ workerTaskId: worker.id });
    assert.deepEqual(card.evidenceIds, [proof.id]);
    await repo(E.WorkerResultCardEntity).update(card.id, { synthetic: true });
    assert.equal((await goals.evaluate(task.id)).complete, false, 'fallback cards cannot satisfy analysis');
    await repo(E.WorkerResultCardEntity).update(card.id, { synthetic: false });
    const candidate = await facts.create({ taskId: task.id, category: 'vulnerability', subject: `${target}/backup`, predicate: 'candidate_exposure', object: '备份资源可能公开', status: 'inferred', confidence: 0.5, createdBy: 'agent', sourceEvidenceIds: [proof.id], targetIp: target });
    await findings.captureCandidates(task.id, [candidate.id]);
    await repo(E.TaskEntity).update(task.id, { status: 'running', engineStatus: 'running' });
    await goals.prepare(task.id); await goals.prepare(task.id);
    assert.equal(await repo(E.FindingVerificationEntity).countBy({ taskId: task.id }), 1, 'prepare queues one verification per candidate/run');
    assert.equal((await goals.evaluate(task.id)).complete, false, 'unresolved candidate prevents completion');
    const record = await repo(E.FindingVerificationEntity).findOneByOrFail({ taskId: task.id });
    await repo(E.IntentEntity).update(record.intentId, { status: 'done' });
    await repo(E.FindingVerificationEntity).update(record.id, { outcome: 'inconclusive' });
    await goals.prepare(task.id);
    assert.equal(await repo(E.FindingVerificationEntity).countBy({ taskId: task.id }), 1, 'inconclusive does not cause endless automatic verification');
    assert.equal((await goals.evaluate(task.id)).complete, false);
    await repo(E.TaskEntity).update(task.id, { status: 'paused', engineStatus: 'paused' });
    await goals.set(task.id, { ...input.goal, mode: 'evidence', ports: null, evidenceText: 'expected-marker-123' });
    const marker = await evidence('HTTP/1.1 200 OK\nexpected-marker-123', { tool: 'http_repeater', args: { target } });
    assert.equal((await goals.evaluate(task.id)).complete, true);
    await repo(E.EvidenceEntity).update(marker.id, { content: 'changed' });
    assert.equal((await goals.evaluate(task.id)).complete, false, 'hash tampering invalidates marker proof');
    await repo(E.McpServerEntity).save({ id: 'fixture', name: 'fixture', endpoint: 'http://unused.invalid/mcp' });
    await repo(E.McpToolEntity).save({ id: 'fixture-tool', mcpServerId: 'fixture', name: 'http_repeater', riskLevel: 'safe', inputSchema: { type: 'object', required: ['target'], properties: { target: { type: 'string' } } }, syncedAt: new Date() });
    await repo(E.AgentToolPermissionEntity).save({ id: 'fixture-permission', taskId: task.id, agentRole: 'explore', toolPattern: '*', allowed: true, requireApproval: false });
    let invocations = 0;
    const stack = createToolStack({
      servers: repo(E.McpServerEntity), tools: repo(E.McpToolEntity), targets: repo(E.TargetEntity), tasks: repo(E.TaskEntity),
      permissions: repo(E.AgentToolPermissionEntity), rules: repo(E.InterceptRuleEntity), calls: repo(E.ToolCallEntity),
      events: gateway, audit: { record: async () => ({}) },
      factory: { async callTool() { invocations++; const text = 'HTTP/1.1 200 OK\nexpected-marker-123'; return { ok: true, text, latencyMs: 1, isError: false, raw: { content: [{ type: 'text', text }] } }; } },
    });
    await new ToolCatalogService(repo(E.McpServerEntity), repo(E.McpToolEntity), stack.registry, stack.driver).sync();
    const ctx = { taskId: task.id, sessionId: null, role: 'explore', authorizedTargets: [], allowedTools: ['http_repeater'] };
    const run = async (input, context = ctx) => {
      const outcome = await stack.invoker.invoke('http_repeater', input, context);
      const saved = await stack.recorder.record({ taskId: task.id, sessionId: null, role: 'explore', outcome, input });
      return { ok: !outcome.encoded.isError && !saved.storageError, evidenceId: saved.evidenceId, deduplicated: outcome.deduplicated === true };
    };
    const first = await run({ target });
    assert.equal(first.ok, true); assert.equal(invocations, 1, 'damaged cache must rerun');
    assert.equal((await run({ target })).deduplicated, true);
    assert.equal(invocations, 1, 'same-run intact evidence is reusable');
    await new Promise((r) => setTimeout(r, 5));
    await goals.set(task.id, { ...input.goal, mode: 'evidence', ports: null, evidenceText: 'expected-marker-123' });
    assert.equal((await goals.evaluate(task.id)).complete, false);
    await run({ target }, { ...ctx, forceRerun: true });
    assert.equal(invocations, 2, 'goal changes invalidate old cache');
    assert.equal((await goals.evaluate(task.id)).complete, true);
    await repo(E.EvidenceEntity).update(first.evidenceId, { content: 'changed' });
    await assert.rejects(() => new (require('../apps/api/dist/database/migrations/1793577602000-TaskGoal').TaskGoal1793577602000)().down(db.createQueryRunner()), /已存在任务目标/);

    const { Module, ValidationPipe } = backendRequire('@nestjs/common'); const { NestFactory } = backendRequire('@nestjs/core');
    class TestModule {}
    Module({ controllers: [load('blackboard/task-goals.controller', 'TaskGoalsController'), load('tasks/tasks.controller', 'TasksController')], providers: [{ provide: TaskGoalsService, useValue: goals }, { provide: TasksService, useValue: tasks }] })(TestModule);
    const app = await createTestApp(TestModule, { logger: false });
    try {
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.listen(0, '127.0.0.1');
      const base = await app.getUrl(); const url = `${base}/tasks/${task.id}/goal`;
      const send = (path, method, body) => fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal((await fetch(url)).status, 200);
      assert.equal((await fetch(`${base}/tasks/missing/goal`)).status, 404);
      assert.equal((await send(url, 'PUT', { ...input.goal, targets: ['10.0.0.1'] })).status, 400);
      assert.equal((await send(url, 'PUT', { ...input.goal, targets: null })).status, 400);
      assert.equal((await send(url, 'PUT', input.goal)).status, 200);
      assert.equal((await send(`${base}/tasks`, 'POST', { ...input, goal: { ...input.goal, protocol: 'invalid' } })).status, 400);
      assert.equal((await send(`${base}/tasks`, 'POST', { ...input, scope: undefined })).status, 400);
      const created = await send(`${base}/tasks`, 'POST', { ...input, autoStart: false, goal: undefined });
      assert.equal(created.status, 201); assert.equal((await created.json()).goal.mode, 'assessment');
    } finally { await app.close(); }
    await repo(E.TaskEntity).update(paused.id, { goal: null });
    assert.equal((await goals.evaluate(paused.id)).configured, false);
    assert.equal((await cycle.evaluateWithEvidence(paused.id, context, 'goal_reached')).status, 'needs_input');
    console.log('PASS: migrated SQLite, durable autoStart, freshness boundaries, target/port evidence, independent completion, budgets, analysis citations, model inference, candidate queue, inconclusive handling, marker integrity, rollback protection and validated HTTP routes');
  } finally { await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
