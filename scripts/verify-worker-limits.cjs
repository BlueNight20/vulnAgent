const backendRequire = require('./backend-require.cjs');
// This regression exercises an explicitly enabled engine; disabled behavior has its own fixture.
process.env.PI_RUNTIME_ENABLED = 'true';
backendRequire('reflect-metadata');
backendRequire('@nestjs/common').Logger.overrideLogger(['error']);
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = backendRequire('typeorm');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const load = (path, name) => require(`../apps/api/dist/modules/${path}`)[name];
const { createToolStack } = require('../apps/api/dist/modules/tool/tool-stack');
const { ToolCatalogService } = require('../apps/api/dist/modules/tool/tool-catalog.service');

async function main() {
  const db = await new DataSource(sqliteOptions(':memory:')).initialize();
  try {
    await db.runMigrations(); const repo = (e) => db.getRepository(e); const gateway = { broadcast() {} };
    const target = '192.168.56.101'; const taskId = 'limits';
    await repo(E.TaskEntity).save({ id: taskId, name: 'worker limits fixture', status: 'running', engineStatus: 'running', scope: { cidrs: [], ports: null }, modelProvider: 'fixture', modelName: 'fixture' });
    await repo(E.TargetEntity).save({ id: 'scope', taskId, ip: '192.168.56.0/24', kind: 'cidr', inScope: true });
    await repo(E.McpServerEntity).save({ id: 'server', name: 'local fixture only', endpoint: 'http://unused.invalid/mcp' });
    for (const name of ['nmap_scan', 'http_repeater']) await repo(E.McpToolEntity).save({ id: name, mcpServerId: 'server', name, riskLevel: 'safe', inputSchema: { type: 'object', required: ['target'], properties: { target: { type: 'string' } } }, syncedAt: new Date() });
    await repo(E.AgentToolPermissionEntity).save({ id: 'allow', taskId, agentRole: 'explore', toolPattern: '*', allowed: true, requireApproval: false });
    let invocations = 0; let output = { ok: true, text: 'fixture successful output', latencyMs: 1, isError: false, raw: { content: [{ type: 'text', text: 'fixture successful output' }] } }; let passedArgs;
    const factory = { async callTool(options) { invocations++; passedArgs = options; return output; } };
    const stack = createToolStack({
      servers: repo(E.McpServerEntity), tools: repo(E.McpToolEntity), targets: repo(E.TargetEntity), tasks: repo(E.TaskEntity),
      permissions: repo(E.AgentToolPermissionEntity), rules: repo(E.InterceptRuleEntity), calls: repo(E.ToolCallEntity),
      factory, events: gateway, audit: { record: async () => ({}) },
    });
    await new ToolCatalogService(repo(E.McpServerEntity), repo(E.McpToolEntity), stack.registry, stack.driver).sync();
    let ctx = { taskId, sessionId: 'one', role: 'explore', authorizedTargets: [], allowedTools: ['nmap_scan', 'http_repeater'] };
    const invoke = (tool, input, context = ctx) => stack.invoker.invoke(tool, input, context);
    const args = { target, ports: '80', scan_type: '-sT -Pn' };
    let result = await invoke('nmap_scan', { ...args, ports: '1-65535' });
    assert.equal(result.failureKind, 'blocked'); assert.match(result.encoded.text, /拆分/); assert.equal(invocations, 0);
    assert.equal(await repo(E.EvidenceEntity).count(), 0);
    result = await invoke('nmap_scan', args); assert.equal(result.failureKind, null, result.encoded.text); assert.deepEqual(passedArgs.arguments, args, 'guard never rewrites submitted arguments');
    assert.equal(invocations, 1, 'configured CIDR target row authorizes contained hosts without duplicate scope.cidrs');
    assert.equal((await invoke('nmap_scan', args)).deduplicated, true);
    await repo(E.TaskEntity).update(taskId, { scope: { cidrs: [], ports: '443' } });
    const narrowed = await invoke('nmap_scan', args);
    if (narrowed.failureKind !== 'blocked') console.error('[debug]', narrowed.failureKind, narrowed.encoded.text.slice(0, 200));
    assert.equal(narrowed.failureKind, 'blocked'); assert.equal(invocations, 1, 'cached success cannot bypass changed port authorization');
    assert.equal((await invoke('http_repeater', { target: `http://${target}:8080` })).failureKind, 'blocked');
    await repo(E.TaskEntity).update(taskId, { scope: { cidrs: [], ports: '80,443' } });
    const beforeFailures = invocations;
    output = { ok: false, error: 'Request timed out', phase: 'execute', latencyMs: 1 };
    ctx = { ...ctx, sessionId: 'failures', forceRerun: true };
    const failedArgs = { ...args, ports: '443' };
    for (let i = 0; i < 2; i++) assert.equal((await invoke('nmap_scan', failedArgs)).failureKind, 'timeout');
    assert.equal((await invoke('nmap_scan', failedArgs)).failureKind, 'blocked');
    assert.equal(invocations, beforeFailures + 2);
    output = { ok: true, text: JSON.stringify({ return_code: 2, stderr: 'unrecognized argument --bad' }), latencyMs: 1, isError: false, raw: { content: [{ type: 'text', text: JSON.stringify({ return_code: 2, stderr: 'unrecognized argument --bad' }) }] } };
    result = await invoke('nmap_scan', { ...args, target: '192.168.56.102' });
    assert.equal(result.encoded.isError, true, '非零退出码必须作为失败结果告知模型');
    output = { ok: true, text: 'changed-parameter success', latencyMs: 1, isError: false, raw: { content: [{ type: 'text', text: 'changed-parameter success' }] } };
    assert.equal((await invoke('nmap_scan', { ...failedArgs, ports: '80' })).failureKind, null);
    assert.equal((await invoke('nmap_scan', failedArgs, { ...ctx, sessionId: 'independent' })).failureKind, null, 'new session may independently verify the same parameters');
    const aborted = new AbortController(); aborted.abort(); const beforeAbort = invocations;
    assert.equal((await invoke('nmap_scan', args, { ...ctx, signal: aborted.signal })).failureKind, 'cancelled'); assert.equal(invocations, beforeAbort);
    await repo(E.TaskEntity).update(taskId, { startedAt: new Date(Date.now() - 120000), timeBudgetMinutes: 1 });
    assert.equal((await invoke('nmap_scan', { ...args, target: '192.168.56.103' })).failureKind, 'blocked'); assert.match((await invoke('nmap_scan', { ...args, target: '192.168.56.104' })).encoded.text, /时间预算|规模/); assert.equal(invocations, beforeAbort);
    await repo(E.TaskEntity).update(taskId, { startedAt: null, timeBudgetMinutes: 60 });

    const audit = new (load('audit/audit.service', 'AuditService'))(repo(E.AuditLogEntity), gateway);
    const store = new (load('pi-runtime/session-store.service', 'SessionStoreService'))(repo(E.AgentSessionMessageEntity), repo(E.AgentSessionEventEntity), repo(E.AgentSessionEntity), repo(E.ModelUsageEntity), gateway);
    const sessions = new (load('pi-runtime/session-manager.service', 'SessionManagerService'))(repo(E.AgentSessionEntity), store, { assertRuntimeEnabled: () => require('../apps/api/dist/database/runtime-control').requireRuntime(db.manager) }, gateway, audit);
    const intents = new (load('blackboard/intents.service', 'IntentsService'))(repo(E.IntentEntity), gateway);
    const workers = new (load('blackboard/worker-state.service', 'WorkerStateService'))(repo(E.WorkerTaskEntity), repo(E.WorkerResultCardEntity), gateway);
    const facts = new (load('blackboard/facts.service', 'FactsService'))(repo(E.FactEntity), repo(E.HypothesisLinkEntity), gateway);
    const ingestion = new (load('blackboard/evidence-ingestion.service', 'EvidenceIngestionService'))(repo(E.EvidenceEntity), facts);
    const findings = new (load('blackboard/findings.service', 'FindingsService'))(repo(E.FindingEntity));
    async function session(over = {}) { return repo(E.AgentSessionEntity).save({ id: randomUUID(), taskId, role: 'explore', profileId: 'recon', sessionKey: randomUUID(), modelName: 'fixture', state: 'running', startedAt: new Date(), ...over }); }
    const interrupt = await session(); const signal = new AbortController(); let waited = false;
    const handle = { entity: interrupt, unsubscribe() {}, agent: { abort() { signal.abort(); }, async waitForIdle() { waited = true; }, async prompt() { throw new Error('late abort'); } } };
    sessions.handles.set(interrupt.id, handle);
    await sessions.interruptAsFailed(interrupt.id, 'three failures'); assert.equal(signal.signal.aborted, true); assert.equal(waited, false, 'interrupt from tool callback must not wait on itself');
    await sessions.markCompleted(interrupt.id, { skipWaitForIdle: true }); await sessions.runPrompt(handle, 'late');
    assert.equal((await sessions.findOne(interrupt.id)).state, 'failed'); assert.equal((await sessions.findOne(interrupt.id)).errorMessage, 'three failures');
    assert.equal(await repo(E.AuditLogEntity).countBy({ entityId: interrupt.id, action: 'session.failed' }), 1);
    const paused = await session(); let continued = false;
    let clearedSteering = false;
    const pauseHandle = { entity: paused, queuedHintIds: new Set(['fixture-pending']), unsubscribe() {}, agent: { state: { messages: [] }, clearSteeringQueue() { clearedSteering = true; }, abort() { void sessions.handleEvent(pauseHandle, { type: 'agent_end', messages: [] }, {}); }, async waitForIdle() {}, async continue() { continued = true; } } };
    sessions.handles.set(paused.id, pauseHandle);
    await sessions.pause(paused.id); assert.equal((await sessions.findOne(paused.id)).state, 'paused'); assert.equal(sessions.hasHandle(paused.id), true);
    assert.equal(clearedSteering, true); assert.equal(pauseHandle.queuedHintIds.size, 0);
    await sessions.resume(paused.id); assert.equal(continued, true); assert.equal((await sessions.findOne(paused.id)).state, 'running');
    await sessions.interruptAsFailed(paused.id, 'fixture cleanup');

    const WorkerRunnerService = load('orchestrator/worker-runner.service', 'WorkerRunnerService');
    const runner = Object.create(WorkerRunnerService.prototype);
    Object.assign(runner, { finalized: new Set(), lastResults: new Map(), logger: { debug() {}, warn() {}, error(message) { throw new Error(message); } }, toolInvoker: stack.invoker, toolRecorder: stack.recorder, sessions, evidence: repo(E.EvidenceEntity), facts, ingestion, findings, workers, intents, hypotheses: {} });
    const budget = new (load('orchestrator/worker-execution-budget', 'WorkerExecutionBudget'))();
    const defs = await runner.buildToolDefinitions(['nmap_scan', 'http_repeater'], 'recon', { taskId }, [target], [], () => 'bounded', budget);
    output = { ok: true, text: 'bounded success', latencyMs: 1, isError: false };
    for (let i = 0; i < 24; i++) await defs[i % 2].execute(`call-${i}`, args);
    const beforeBlocked = invocations; const blocked = await defs[0].execute('blocked', args);
    assert.equal(blocked.details.failureKind, 'retry_limit'); assert.equal(invocations, beforeBlocked); assert.ok(budget.stopReason.includes('24'));
    async function makeRun(name, sessionRow) {
      const offered = await intents.create({ taskId, title: name, objective: name, targetIp: target, workerProfileId: 'recon', dedupeKey: name });
      await intents.markDispatched(offered.intent.id, 1, {});
      const worker = await workers.create({ taskId, intentId: offered.intent.id, title: name, profileId: 'recon', dedupeKey: name, timeoutSeconds: 600, maxAttempts: 2 });
      await workers.attachSession(worker.id, sessionRow.id);
      return { taskId, intent: offered.intent, workerTaskId: worker.id, onFinished() {} };
    }
    function captureWatch(input, sessionRow) {
      const timers = []; const original = global.setInterval;
      global.setInterval = (callback, ms) => { timers.push({ callback, ms }); return { unref() {} }; };
      try { runner.watchCompletion(sessionRow.id, input, []); } finally { global.setInterval = original; }
      return timers.find((t) => t.ms === 3000).callback;
    }
    const deadlineSession = await session({ startedAt: new Date(Date.now() - 601000), state: 'paused' });
    const deadlineRun = await makeRun('absolute-deadline', deadlineSession); let finishes = 0; deadlineRun.onFinished = () => finishes++;
    const poll = captureWatch(deadlineRun, deadlineSession);
    await poll(); assert.equal((await workers.findById(deadlineRun.workerTaskId)).status, 'running', 'paused session is not misreported as successful');
    await repo(E.AgentSessionEntity).update(deadlineSession.id, { state: 'running' });
    await Promise.all([poll(), poll()]); assert.equal(finishes, 1);
    assert.equal((await workers.findById(deadlineRun.workerTaskId)).status, 'failed'); assert.equal((await intents.findById(deadlineRun.intent.id)).status, 'rejected');
    assert.ok((await sessions.findOne(deadlineSession.id)).errorMessage.includes('绝对执行时限'));
    const lost = await session(); const lostRun = await makeRun('lost-tool-result', lost);
    await repo(E.AgentSessionMessageEntity).save({ id: randomUUID(), taskId, sessionId: lost.id, seq: 1, role: 'assistant', content: 'waiting for a tool', messageJson: { stopReason: 'toolUse' }, createdAt: new Date(Date.now() - 421000) });
    await captureWatch(lostRun, lost)(); assert.equal((await workers.findById(lostRun.workerTaskId)).status, 'failed');
    const duplicate = await session({ state: 'completed' }); const duplicateRun = await makeRun('concurrent-finalization', duplicate);
    await Promise.all([runner.finalize(duplicate.id, duplicateRun, [], null), runner.finalize(duplicate.id, duplicateRun, [], null)]);
    assert.equal(await repo(E.WorkerResultCardEntity).countBy({ workerTaskId: duplicateRun.workerTaskId }), 1, 'concurrent completion writes one result card');
    const lease = await session(); const leaseRun = await makeRun('lease-cap', lease);
    const startedAt = new Date(Date.now() - 700000); await repo(E.WorkerTaskEntity).update(leaseRun.workerTaskId, { startedAt }); await workers.renewLease(leaseRun.workerTaskId);
    assert.ok(new Date((await workers.findById(leaseRun.workerTaskId)).leaseExpiresAt).getTime() <= startedAt.getTime() + 630000);
    await repo(E.TaskEntity).update(taskId, { status: 'paused' }); assert.equal((await workers.findAllExpired()).length, 0, 'paused tasks are not reaped');
    await repo(E.TaskEntity).update(taskId, { status: 'running' }); assert.ok((await workers.findAllExpired()).some((w) => w.id === leaseRun.workerTaskId));
    const OrchestratorService = load('orchestrator/orchestrator.service', 'OrchestratorService'); const orchestrator = Object.create(OrchestratorService.prototype);
    Object.assign(orchestrator, { workers, intents, runtime: { sessions }, contexts: new Map(), logger: { warn() {} }, broadcastSnapshot() {} });
    const workerCount = await repo(E.WorkerTaskEntity).count(); await orchestrator.reapExpiredWorkers();
    assert.equal(await repo(E.WorkerTaskEntity).count(), workerCount, 'reaper requeues intent without orphan queued Worker');
    assert.equal((await intents.findById(leaseRun.intent.id)).status, 'proposed');
    const Cycle = load('orchestrator/orchestrator-cycle.service', 'OrchestratorCycleService'); const cycle = Object.create(Cycle.prototype);
    const context = { activeWorkers: new Map() }; let launched = 0;
    Object.assign(cycle, { workers, intents, intentRepo: repo(E.IntentEntity), targets: repo(E.TargetEntity), logger: { log() {} }, orchestrator: { getContext: () => context, executionAllowed: async () => true }, workerRunner: { async launch(input) { launched++; const row = await session(); await workers.attachSession(input.workerTaskId, row.id); return { sessionId: row.id }; } } });
    const task = await repo(E.TaskEntity).findOneByOrFail({ id: taskId });
    await cycle.dispatchWorker(taskId, task, { id: leaseRun.intent.id, score: 1, breakdown: {}, workerProfileId: 'recon' }, { tokensLeft: 10000 });
    const retry = (await workers.listByTask(taskId)).find((w) => w.intentId === leaseRun.intent.id && w.id !== leaseRun.workerTaskId);
    assert.equal(retry.attempt, 1); assert.equal(launched, 1);
    await repo(E.WorkerTaskEntity).update(retry.id, { leaseExpiresAt: new Date(Date.now() - 60000) }); await orchestrator.reapExpiredWorkers();
    assert.equal((await intents.findById(leaseRun.intent.id)).status, 'rejected');
    await cycle.dispatchWorker(taskId, task, { id: leaseRun.intent.id, score: 1, breakdown: {}, workerProfileId: 'recon' }, { tokensLeft: 10000 }); assert.equal(launched, 1, 'attempt cap does not reset at dispatch');
    await runner.finalize(lease.id, leaseRun, [], 'late callback'); assert.equal((await workers.findById(leaseRun.workerTaskId)).status, 'timeout', 'late callbacks cannot overwrite a timeout');
    console.log('PASS: real migrated services, CIDR authorization, workload/port scope before cache, identical-call retry cap, exit-code classification, cancellation and task budget, shared Worker call budget, pause/resume handles, deadlock-free interruption, absolute deadline, lost-result failure, bounded leases, timeout preservation and retry dispatch without orphan workers');
  } finally { await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
