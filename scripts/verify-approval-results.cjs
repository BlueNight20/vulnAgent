const backendRequire = require('./backend-require.cjs');
// This regression exercises an explicitly enabled engine; disabled behavior has its own fixture.
process.env.PI_RUNTIME_ENABLED = 'true';
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { DataSource } = backendRequire('typeorm');
const apiRequire = createRequire(resolve(__dirname, '../apps/api/package.json'));
const E = require('../apps/api/dist/database/entities');
const { FactsService } = require('../apps/api/dist/modules/blackboard/facts.service');
const { EvidenceIngestionService } = require('../apps/api/dist/modules/blackboard/evidence-ingestion.service');
const { createToolStack } = require('../apps/api/dist/modules/tool/tool-stack');
const { ToolCatalogService } = require('../apps/api/dist/modules/tool/tool-catalog.service');
const { ApprovalService } = require('../apps/api/dist/modules/mcp/approval.service');
const { OrchestratorService } = require('../apps/api/dist/modules/orchestrator/orchestrator.service');
const { WorkerRunnerService } = require('../apps/api/dist/modules/orchestrator/worker-runner.service');

async function main() {
  const db = await new DataSource({ type: 'better-sqlite3', driver: apiRequire('better-sqlite3'), database: ':memory:', entities: E.ENTITIES, synchronize: true }).initialize();
  const repo = (e) => db.getRepository(e);
  const gateway = { broadcast() {} };
  const audit = new (require('../apps/api/dist/modules/audit/audit.service').AuditService)(repo(E.AuditLogEntity), gateway);
  const facts = new FactsService(repo(E.FactEntity), repo(E.HypothesisLinkEntity), gateway);
  const ingestion = new EvidenceIngestionService(repo(E.EvidenceEntity), facts);
  const cycles = [];
  const runtime = { sessions: { reconcile: async () => 0 } };
  const orchestrator = new OrchestratorService(repo(E.TaskEntity), repo(E.TargetEntity), repo(E.IntentEntity), repo(E.OrchestratorRunEntity), repo(E.TaskStateEventEntity), runtime, facts, { counts: async () => ({}) }, {}, { listByTask: async () => [], findRunningAll: async () => [] }, {}, {}, {}, gateway, audit, ingestion);
  orchestrator.onModuleDestroy(); // 测试手动驱动消费，避免定时器和外部模型。
  orchestrator.registerCycleBody(async (taskId) => { cycles.push({ taskId, count: await repo(E.FactEntity).countBy({ taskId }) }); });
  try {
    await orchestrator.onApplicationBootstrap();
    await repo(E.TaskEntity).save({ id: 'task', name: 'approval recovery', status: 'running', engineStatus: 'needs_input', stopReason: 'needs_input', scope: { cidrs: ['192.168.56.0/24'] }, modelProvider: 'test', modelName: 'test' });
    await repo(E.McpServerEntity).save({ id: 'server', name: 'stub', endpoint: 'http://unused.invalid/mcp' });
    const inputSchema = { type: 'object', required: ['target'], properties: { target: { type: 'string' } } };
    await repo(E.McpToolEntity).save({ id: 'tool', name: 'lab_scan', mcpServerId: 'server', riskLevel: 'intrusive', inputSchema, syncedAt: new Date() });
    for (const role of ['explore', 'verifier']) await repo(E.AgentToolPermissionEntity).save({ id: role, taskId: 'task', agentRole: role, toolPattern: '*', allowed: true, requireApproval: true });
    let remoteCalls = 0;
    const output = '80/tcp open http Apache httpd 2.4.29\n443/tcp open https\n';
    const stack = createToolStack({
      servers: repo(E.McpServerEntity), tools: repo(E.McpToolEntity), targets: repo(E.TargetEntity),
      tasks: repo(E.TaskEntity), permissions: repo(E.AgentToolPermissionEntity), rules: repo(E.InterceptRuleEntity),
      calls: repo(E.ToolCallEntity), events: gateway, audit,
      factory: { callTool: async () => { remoteCalls += 1; return { ok: true, text: output, latencyMs: 1, raw: { content: [{ type: 'text', text: output }] }, isError: false }; } },
    });
    await new ToolCatalogService(repo(E.McpServerEntity), repo(E.McpToolEntity), stack.registry, stack.driver).sync();
    const approvals = new ApprovalService(repo(E.ToolCallEntity), repo(E.McpToolEntity), audit, gateway, stack.replay);
    const ctx = { taskId: 'task', sessionId: null, role: 'explore', authorizedTargets: [], allowedTools: [] };
    await stack.invoker.invoke('lab_scan', { target: '192.168.56.101' }, ctx);
    const first = await repo(E.ToolCallEntity).findOneByOrFail({ taskId: 'task', status: 'pending_approval' });
    await approvals.approve(first.id);
    const result = await stack.replay.replay(first.id);
    assert.equal(result.ok, true);
    assert.equal(await repo(E.TaskStateEventEntity).countBy({ consumedAt: backendRequire('typeorm').IsNull() }), 1);
    assert.equal(await repo(E.FactEntity).count(), 0, '执行保存与结果消费是独立阶段');
    // 首次回写故障：事件必须保留，不能重复远程执行。
    const realIngest = ingestion.ingest.bind(ingestion);
    ingestion.ingest = async () => { throw new Error('injected ingestion failure'); };
    await orchestrator.consumeTaskStateEvents();
    assert.equal((await repo(E.TaskStateEventEntity).findOneByOrFail({ id: first.id })).consumedAt, null);
    assert.equal(remoteCalls, 1);
    ingestion.ingest = realIngest;
    await orchestrator.consumeTaskStateEvents();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(cycles.length, 1);
    assert.ok(cycles[0].count >= 4, '恢复规划之前，端口及服务事实已可见');
    assert.ok((await repo(E.TaskStateEventEntity).findOneByOrFail({ id: first.id })).consumedAt);
    assert.equal((await repo(E.TaskEntity).findOneByOrFail({ id: 'task' })).engineStatus, 'running');
    assert.equal(await repo(E.HintEntity).count(), 1);
    const before = await repo(E.FactEntity).count();
    await Promise.all([ingestion.ingest('task', [result.evidenceId]), ingestion.ingest('task', [result.evidenceId])]);
    assert.equal(await repo(E.FactEntity).count(), before, 'Worker 收尾与审批结果重复回写不增加事实');
    assert.deepEqual(await ingestion.ingest('different-task', [result.evidenceId]), []);
    await orchestrator.consumeTaskStateEvents();
    assert.equal(cycles.length, 1);
    assert.equal(remoteCalls, 1);
    // 暂停/停止的任务可以接收结果，但不能被审批事件自动恢复。
    for (const state of ['paused', 'stopped']) {
      await repo(E.TaskEntity).update({ id: 'task' }, { status: state, engineStatus: state });
      await stack.invoker.invoke('lab_scan', { target: '192.168.56.102' }, ctx);
      const pending = await repo(E.ToolCallEntity).findOneByOrFail({ taskId: 'task', status: 'pending_approval' });
      await approvals.reject(pending.id);
      await orchestrator.consumeTaskStateEvents();
      assert.equal((await repo(E.TaskEntity).findOneByOrFail({ id: 'task' })).status, state);
    }
    assert.equal(cycles.length, 1);
    // 不再受旧实现的 30 条证据上限影响；校验失败的原文不会成为事实。
    const evidenceIds = [];
    for (let i = 0; i < 35; i++) {
      const content = `${1000 + i}/tcp open unknown`;
      const id = `e-${i}`; evidenceIds.push(id);
      await repo(E.EvidenceEntity).save({ id, taskId: 'task', kind: 'command_output', title: 'batch', content, sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: Buffer.byteLength(content), meta: { tool: 'lab_scan', targetIp: '192.168.56.101' } });
    }
    assert.equal((await ingestion.ingest('task', evidenceIds)).length, 35);
    await repo(E.EvidenceEntity).update({ id: 'e-0' }, { content: '9999/tcp open http' });
    assert.deepEqual(await ingestion.ingest('task', ['e-0']), []);
    // 模型工具描述包含 MCP 真实 Schema，不再只有空对象。
    const worker = Object.create(WorkerRunnerService.prototype);
    Object.assign(worker, { toolInvoker: stack.invoker, toolRecorder: stack.recorder });
    const defs = worker.buildToolDefinitions(['lab_scan'], 'verification', { taskId: 'task' }, [], [], () => null);
    assert.deepEqual(defs[0].parameters, inputSchema);
    const { validateToolArguments } = await import('@earendil-works/pi-ai');
    assert.deepEqual(validateToolArguments(defs[0], { name: 'lab_scan', arguments: { target: '192.168.56.101' } }), { target: '192.168.56.101' });
    assert.throws(() => validateToolArguments(defs[0], { name: 'lab_scan', arguments: {} }), /target/);
    await repo(E.TaskEntity).update({ id: 'task' }, { status: 'paused', engineStatus: 'paused' });
    await repo(E.TaskStateEventEntity).save({ id: 'verify-paused', taskId: 'task', eventType: 'finding.verification_requested', consumedAt: null });
    await orchestrator.consumeTaskStateEvents();
    assert.equal(cycles.length, 1);
    await repo(E.TaskEntity).update({ id: 'task' }, { status: 'running', engineStatus: 'needs_input' });
    await repo(E.TaskStateEventEntity).save({ id: 'verify-running', taskId: 'task', eventType: 'finding.verification_requested', consumedAt: null });
    await orchestrator.consumeTaskStateEvents(); await new Promise((r) => setTimeout(r, 10));
    assert.equal(cycles.length, 2, '新验证请求可以唤醒等待输入的任务，但不能恢复用户暂停的任务');
    console.log('PASS: durable approval outcome, retry without remote re-execution, facts before planning, deduplication, paused/stopped preservation, >30 evidence, integrity/scope, real model tool Schema');
  } finally { orchestrator.onModuleDestroy(); await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
