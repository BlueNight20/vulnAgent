const createTestApp = require('./create-test-app.cjs');
const backendRequire = require('./backend-require.cjs');
// Full application HTTP + WebSocket compatibility on loopback; no models, MCP calls or targets.
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { WebSocket } = backendRequire('ws');
const { NestFactory } = backendRequire('@nestjs/core');
const { ValidationPipe } = backendRequire('@nestjs/common');
const { WsAdapter } = backendRequire('@nestjs/platform-ws');
Object.assign(process.env, {
  DB_TYPE: 'sqlite', DB_PATH: ':memory:', DB_SYNCHRONIZE: 'false', DB_LOGGING: 'false',
  MCP_SERVERS: '[]', MCP_GATEWAY_ENABLED: 'false', MCP_GATEWAY_HEADERS: '', MCP_GATEWAY_URL: 'http://unused.invalid/mcp',
  PI_RUNTIME_ENABLED: 'false', MODEL_API_KEY: '', MODEL_BASE_URL: 'http://unused.invalid/v1',
  VA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
});
const { AppModule } = require('../apps/api/dist/app.module');
const { ApiExceptionFilter } = require('../apps/api/dist/common/filters/api-exception.filter');

async function waitFor(predicate, label) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { const result = predicate(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`Timed out: ${label}`);
}
async function main() {
  const app = await createTestApp(AppModule, { logger: false, abortOnError: false });
  let socket;
  try {
    app.setGlobalPrefix('api'); app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    const frames = []; socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`);
    socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
    await once(socket, 'open'); const hello = await waitFor(() => frames.find((f) => f.type === 'hello'), 'WebSocket hello'); assert.ok(hello.payload.clientId);
    socket.send(JSON.stringify({ type: 'ping' })); await waitFor(() => frames.find((f) => f.type === 'pong'), 'WebSocket ping/pong');
    assert.equal((await fetch(`${base}/api/tasks?page=bad`)).status, 400);
    const unknown = await fetch(`${base}/api/tasks/does-not-exist`); assert.equal(unknown.status, 404); assert.equal((await unknown.json()).code, 'NOT_FOUND');
    const create = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      name: 'framework compatibility fixture', targets: [{ ip: '192.168.56.101' }], scope: { cidrs: ['192.168.56.0/24'] }, authorized: true,
      modelProvider: 'fixture', modelName: 'fixture', tokenBudget: 1000, timeBudgetMinutes: 1, workerCount: 1, autoStart: false,
    }) });
    assert.equal(create.status, 201, await create.clone().text()); const task = await create.json(); assert.equal(task.status, 'pending');
    const auditFrame = await waitFor(() => frames.find((f) => f.type === 'audit.appended' && f.payload.action === 'task.create'), 'persisted task audit push'); assert.equal(auditFrame.payload.taskId, task.id);
    const filtered = await (await fetch(`${base}/api/tasks?keyword=framework&page=1&pageSize=1`)).json(); assert.equal(filtered.total, 1); assert.equal(filtered.items[0].id, task.id);
    const stopped = await fetch(`${base}/api/tasks/${task.id}/stop`, { method: 'POST' }); assert.equal(stopped.status, 201); assert.equal((await stopped.json()).status, 'stopped');
    await waitFor(() => frames.find((f) => f.type === 'task.updated' && f.payload.id === task.id && f.payload.status === 'stopped'), 'task state push');
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    // A real long history must remain reachable beyond both former 300/500-row caps.
    const source = app.get(backendRequire('typeorm').DataSource);
    const E = require('../apps/api/dist/database/entities');
    await source.getRepository(E.AgentSessionEntity).save({ id: 'history-session', taskId: task.id, role: 'explore', state: 'paused', sessionKey: 'history-session', modelName: 'fixture' });
    const old = new Date(Date.now() - 3600000);
    const rows = Array.from({ length: 625 }, (_, index) => ({ id: `history-${index + 1}`, taskId: task.id, sessionId: 'history-session', seq: index + 1, role: index === 0 || index === 609 || index === 618 ? 'assistant' : 'toolResult', content: index === 618 ? '' : `消息 ${index + 1}`, messageJson: { stopReason: index === 618 ? 'toolUse' : 'stop' }, createdAt: index < 500 ? old : new Date() }));
    await source.getRepository(E.AgentSessionMessageEntity).save(rows);
    const historyUrl = `${base}/api/agents/sessions/history-session/messages`;
    const first = await (await fetch(historyUrl)).json(); assert.equal(first.items.length, 300); assert.equal(first.total, 625); assert.equal(first.nextAfterSeq, 300);
    const second = await (await fetch(`${historyUrl}?afterSeq=${first.nextAfterSeq}`)).json(); assert.equal(second.items.length, 300); assert.equal(second.items[0].seq, 301); assert.equal(second.nextAfterSeq, 600);
    const third = await (await fetch(`${historyUrl}?afterSeq=${second.nextAfterSeq}`)).json(); assert.equal(third.items.length, 25); assert.equal(third.items[24].seq, 625); assert.equal(third.nextAfterSeq, null); assert.equal(third.total, 625);
    const all = [...first.items, ...second.items, ...third.items]; assert.equal(new Set(all.map((row) => row.id)).size, 625);
    assert.equal((await (await fetch(`${historyUrl}?afterSeq=9999`)).json()).items.length, 0);
    for (const invalid of ['bad', '-1', '1.5', '9007199254740992']) assert.equal((await fetch(`${historyUrl}?afterSeq=${invalid}`)).status, 400);
    assert.equal((await fetch(`${base}/api/agents/sessions/missing/messages`)).status, 404);
    const store = app.get(require('../apps/api/dist/modules/pi-runtime/session-store.service').SessionStoreService);
    const completeReply = JSON.stringify({ summary: '完整结论'.repeat(3000), facts: [] });
    await source.getRepository(E.AgentSessionMessageEntity).update('history-610', { content: completeReply.slice(0, 8000), messageJson: { role: 'assistant', content: [{ type: 'text', text: completeReply }], stopReason: 'stop' } });
    assert.equal((await store.latestAssistant('history-session')).seq, 619);
    assert.equal((await store.latestAssistant('history-session', true)).seq, 610);
    assert.equal((await store.latestAssistant('history-session', true)).content, completeReply, 'Worker recovery must read complete JSON rather than the 8k list preview');
    assert.equal(await store.latestAssistant('missing'), null);
    const runner = app.get(require('../apps/api/dist/modules/orchestrator/worker-runner.service').WorkerRunnerService);
    assert.equal(await runner.isStalledButFinished('history-session'), null, 'recent toolUse after row 500 must not be replaced by an old stop');
    const snapshot = await (await fetch(`${base}/api/tasks/${task.id}/model-budget`)).json(); assert.equal(snapshot.knownTokens, 0);
    // Positive rows prove the dashboard aggregates persisted data rather than returning empty defaults.
    await source.getRepository(E.FindingEntity).save(['candidate', 'confirmed'].map((status) => ({ id: `dashboard-${status}`, taskId: task.id, title: `fixed aggregate ${status}`, description: 'Row fixture for aggregation only; not a real vulnerability', severity: 'info', status, evidenceIds: [] })));
    await source.getRepository(E.ModelUsageEntity).save([
      { id: 'dashboard-today', taskId: task.id, agentSessionId: 'history-session', provider: 'fixture', modelName: 'fixture', inputTokens: 40, outputTokens: 10, costUsd: 0.1234, createdAt: new Date() },
      { id: 'dashboard-yesterday', taskId: task.id, agentSessionId: 'history-session', provider: 'fixture', modelName: 'fixture', inputTokens: 20, outputTokens: 5, costUsd: 0.05, createdAt: new Date(Date.now() - 86400000) },
    ]);
    const dashboard = await (await fetch(`${base}/api/dashboard/summary`)).json();
    assert.equal(dashboard.tasks.total, 1); assert.equal(dashboard.tasks.stopped, 1); assert.equal(dashboard.tasks.running, 0);
    assert.equal(dashboard.findings.total, 2); assert.equal(dashboard.findings.candidate, 1); assert.equal(dashboard.findings.confirmed, 1);
    assert.deepEqual(dashboard.usage, { tokens: 75, costUsd: 0.1734 }); assert.equal(dashboard.recentTasks[0].id, task.id);
    assert.equal(dashboard.services.find((service) => service.kind === 'api').status, 'online'); assert.equal(dashboard.services.find((service) => service.kind === 'database').status, 'online');
    const trend = await (await fetch(`${base}/api/dashboard/usage-trend?days=3`)).json(); assert.equal(trend.points.length, 3);
    assert.equal(trend.points.find((point) => point.date === new Date().toISOString().slice(0, 10)).tokens, 50);
    assert.equal(trend.points.find((point) => point.date === new Date(Date.now() - 86400000).toISOString().slice(0, 10)).tokens, 25);
    assert.equal(trend.points.reduce((total, point) => total + point.tokens, 0), 75);
    // Workflow provenance across multiple Planner rounds, Worker-originated branches and prerequisites.
    const when = new Date(Date.now() - 60000);
    await source.getRepository(E.AgentSessionEntity).save(['planner-old', 'planner-current', 'flow-a', 'flow-b', 'flow-unknown'].map((id) => ({ id, taskId: task.id, sessionKey: id, role: id.startsWith('planner') ? 'planner' : 'explore', state: 'completed', modelName: 'fixture', createdAt: id === 'planner-old' ? new Date(when.getTime() - 1000) : when })));
    await source.getRepository(E.IntentEntity).save([
      { id: 'flow-intent-a', taskId: task.id, agentSessionId: 'planner-current', title: 'current Planner output', dedupeKey: 'flow-a' },
      { id: 'flow-intent-b', taskId: task.id, agentSessionId: 'flow-a', title: 'Worker follow-up', dedupeKey: 'flow-b', dependencies: ['flow-intent-a'] },
      { id: 'flow-intent-unknown', taskId: task.id, agentSessionId: null, title: 'deterministic origin', dedupeKey: 'flow-unknown', dependencies: ['flow-intent-a'] },
    ]);
    await source.getRepository(E.WorkerTaskEntity).save([
      { id: 'flow-worker-a', taskId: task.id, sessionId: 'flow-a', intentId: 'flow-intent-a', title: 'first', status: 'succeeded', startedAt: when, endedAt: new Date(when.getTime() + 1000), input: { source: 'fixed input' }, output: { summary: 'fixed output' } },
      { id: 'flow-worker-b', taskId: task.id, sessionId: 'flow-b', intentId: 'flow-intent-b', title: 'follow-up', status: 'succeeded', startedAt: new Date(when.getTime() + 2000) },
      { id: 'flow-worker-unknown', taskId: task.id, sessionId: 'flow-unknown', intentId: 'flow-intent-unknown', title: 'deterministic', status: 'succeeded', startedAt: new Date(when.getTime() + 2000) },
    ]);
    await source.getRepository(E.EvidenceEntity).save({ id: 'flow-evidence', taskId: task.id, agentSessionId: 'flow-a', kind: 'tool_output', title: 'fixed workflow evidence', content: 'fixture only', meta: null });
    await source.getRepository(E.AgentSessionMessageEntity).save([
      { id: 'flow-planner-input', taskId: task.id, sessionId: 'planner-current', seq: 1, role: 'user', content: 'fixed Planner input', messageJson: { role: 'user', content: 'fixed Planner input' } },
      { id: 'flow-planner-output', taskId: task.id, sessionId: 'planner-current', seq: 2, role: 'assistant', content: 'fixed Planner output', messageJson: { role: 'assistant', content: [] } },
    ]);
    const graph = await (await fetch(`${base}/api/workflows/${task.id}/graph`)).json(); assert.equal(graph.source, 'live');
    assert.ok(graph.edges.some((edge) => edge.source === 'planner-current' && edge.target === 'flow-worker-a'));
    assert.ok(!graph.edges.some((edge) => edge.source === 'planner-old' && edge.target.startsWith('flow-worker-')));
    assert.equal(graph.edges.filter((edge) => edge.source === 'flow-worker-a' && edge.target === 'flow-worker-b').length, 1);
    assert.ok(graph.edges.some((edge) => edge.source === 'orchestrator' && edge.target === 'flow-worker-unknown'));
    assert.ok(graph.edges.some((edge) => edge.source === 'flow-worker-a' && edge.target === 'flow-worker-unknown' && edge.kind === 'dependency'));
    assert.ok(graph.edges.some((edge) => edge.source === 'flow-worker-a' && edge.target === 'orchestrator' && edge.kind === 'evidence'));
    const node = graph.nodes.find((item) => item.id === 'flow-worker-a'); assert.equal(node.evidenceCount, 1); assert.deepEqual(node.detail.input, { source: 'fixed input' }); assert.deepEqual(node.detail.output, { summary: 'fixed output' });
    const plannerNode = graph.nodes.find((item) => item.id === 'planner-current'); assert.equal(plannerNode.detail.input.textPreview, 'fixed Planner input'); assert.equal(plannerNode.detail.output.textPreview, 'fixed Planner output'); assert.equal(plannerNode.detail.output.messageId, 'flow-planner-output');
    assert.ok(graph.edges.every((edge) => graph.nodes.some((item) => item.id === edge.source) && graph.nodes.some((item) => item.id === edge.target)));
    socket.close(); await once(socket, 'close'); socket = null;
    console.log('PASS: full Nest application, Express JSON/query/validation and 404 filter, task create/stop persistence, positive dashboard aggregates/trend and API/DB health, live workflow exact Planner provenance/Worker branches/prerequisites/evidence and stored node input/output, 625-message cursor history/validation, latest assistant/Worker recovery beyond row 500, real WsAdapter hello/pong/audit/task pushes and orderly close; no external requests');
  } finally { if (socket) socket.terminate(); await app.close(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
