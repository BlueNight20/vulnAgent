const createTestApp = require('./create-test-app.cjs');
const backendRequire = require('./backend-require.cjs');
// This regression exercises an explicitly enabled engine; disabled behavior has its own fixture.
process.env.PI_RUNTIME_ENABLED = 'true';
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DataSource } = backendRequire('typeorm');
const { Module, ValidationPipe } = backendRequire('@nestjs/common');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const load = (p, n) => require(`../apps/api/dist/modules/${p}`)[n];
const { createToolStack } = require('../apps/api/dist/modules/tool/tool-stack');
const { ToolCatalogService } = require('../apps/api/dist/modules/tool/tool-catalog.service');
const { ApprovalService } = require('../apps/api/dist/modules/mcp/approval.service');
const { ApprovalController } = require('../apps/api/dist/modules/mcp/approval.controller');
const { ApprovalReplayService } = require('../apps/api/dist/modules/tool/approval-replay.service');
const { OrchestratorService } = require('../apps/api/dist/modules/orchestrator/orchestrator.service');

const ctx = { taskId: 'task', sessionId: null, role: 'explore', authorizedTargets: [], allowedTools: [] };

async function seed(db) {
  const repo = (entity) => db.getRepository(entity);
  await repo(E.TaskEntity).save({ id: 'task', name: 'approval recovery', status: 'running', engineStatus: 'needs_input', scope: { cidrs: ['192.168.56.0/24'] }, modelProvider: 'test', modelName: 'test' });
  await repo(E.McpServerEntity).save({ id: 'server', name: 'fixture', endpoint: 'http://unused.invalid/mcp', enabled: true, transport: 'streamable-http' });
  await repo(E.McpToolEntity).save({ id: 'tool', name: 'lab_scan', mcpServerId: 'server', riskLevel: 'intrusive', inputSchema: { type: 'object', required: ['target'], properties: { target: { type: 'string' } } }, syncedAt: new Date() });
  for (const role of ['explore', 'verifier']) await repo(E.AgentToolPermissionEntity).save({ id: role, taskId: 'task', agentRole: role, toolPattern: '*', allowed: true, requireApproval: true });
}

/** 用真实实现装配工具栈；factory 只返回固定数据，不访问网络。 */
async function services(db, factory) {
  const repo = (entity) => db.getRepository(entity);
  const gateway = { broadcast() {} };
  const stack = createToolStack({
    servers: repo(E.McpServerEntity), tools: repo(E.McpToolEntity), targets: repo(E.TargetEntity), tasks: repo(E.TaskEntity),
    permissions: repo(E.AgentToolPermissionEntity), rules: repo(E.InterceptRuleEntity), calls: repo(E.ToolCallEntity),
    factory, events: gateway, audit: { record: async () => ({}) },
  });
  await new ToolCatalogService(repo(E.McpServerEntity), repo(E.McpToolEntity), stack.registry, stack.driver).sync();
  const approvals = new ApprovalService(repo(E.ToolCallEntity), repo(E.McpToolEntity), { record: async () => ({}) }, gateway, stack.replay);
  return { stack, approvals };
}

async function crashFixture(file) {
  const db = await new DataSource(sqliteOptions(file)).initialize();
  await db.runMigrations(); await seed(db);
  const { stack, approvals } = await services(db, { callTool: async () => { process.exit(17); } });
  await stack.invoker.invoke('lab_scan', { target: '192.168.56.101' }, ctx);
  const pending = await db.getRepository(E.ToolCallEntity).findOneByOrFail({ taskId: 'task', status: 'pending_approval' });
  await approvals.approve(pending.id);
  await stack.replay.replay(pending.id);
  throw new Error('fixture should have exited');
}

async function main() {
  if (process.argv[2] === '--crash-fixture') return crashFixture(process.argv[3]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnagent-approval-recovery-'));
  const file = path.join(directory, 'recovery.sqlite');
  const child = spawnSync(process.execPath, [__filename, '--crash-fixture', file], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 17, child.stderr || child.stdout);
  const db = await new DataSource(sqliteOptions(file)).initialize();
  let app;
  try {
    await db.runMigrations();
    const repo = (entity) => db.getRepository(entity);
    let remoteCalls = 0;
    const factory = { callTool: async () => { remoteCalls++; return { ok: true, text: '80/tcp open http', latencyMs: 1, raw: { content: [{ type: 'text', text: '80/tcp open http' }] }, isError: false }; } };
    const { stack, approvals } = await services(db, factory);
    const original = await repo(E.ToolCallEntity).findOneByOrFail({ status: 'pending_approval' });
    assert.equal(original.replayOfId, original.id);
    assert.equal((await approvals.listPending('task'))[0].executionState, 'needs_review');
    await assert.rejects(stack.replay.replay(original.id), /执行或正在执行/);
    assert.equal(remoteCalls, 0, 'restart must never replay a claimed approval');

    class TestModule {}
    Module({ controllers: [ApprovalController], providers: [
      { provide: ApprovalService, useValue: approvals },
      { provide: ApprovalReplayService, useValue: stack.replay },
    ] })(TestModule);
    app = await createTestApp(TestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/approvals`;
    const post = (id, input) => fetch(`${base}/${id}/reconcile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const input = { reason: '已检查远端进程停止，保留为未确认结果。', remoteStopped: true };
    for (const invalid of [{ reason: '短', remoteStopped: true }, { ...input, remoteStopped: false }, { ...input, remoteStopped: 'true' }, { ...input, reason: 'x'.repeat(2001) }]) {
      assert.equal((await post(original.id, invalid)).status, 400);
    }
    assert.equal((await post('missing', input)).status, 404);
    assert.equal((await post(original.id, input)).status, 400, 'running task cannot be reconciled');
    await repo(E.TaskEntity).update('task', { status: 'paused', engineStatus: 'paused' });
    await db.query("CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'tool.approval_reconciled' BEGIN SELECT RAISE(FAIL, 'injected audit failure'); END");
    assert.equal((await post(original.id, input)).status, 500);
    assert.equal((await repo(E.ToolCallEntity).findOneByOrFail({ id: original.id })).status, 'pending_approval');
    assert.equal(await repo(E.TaskStateEventEntity).count(), 0, 'failed audit rolls back closure and event');
    await db.query('DROP TRIGGER reject_recovery_audit');
    const attempts = await Promise.all([post(original.id, input), post(original.id, input)]);
    assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 400]);
    const closed = await repo(E.ToolCallEntity).findOneByOrFail({ id: original.id });
    assert.equal(closed.status, 'error'); assert.equal(closed.failureKind, 'unknown');
    assert.equal(closed.rawOutputRef, null); assert.equal(closed.replayOfId, original.id);
    assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'tool.approval_reconciled' }), 1);
    assert.equal(await repo(E.TaskStateEventEntity).count(), 1);
    const event = await repo(E.TaskStateEventEntity).findOneByOrFail({ id: original.id });
    assert.equal(event.payload.requiresReview, true);
    assert.equal((await approvals.listPending('task')).length, 0);
    assert.equal((await repo(E.TaskEntity).findOneByOrFail({ id: 'task' })).status, 'paused');
    assert.equal(remoteCalls, 0);
    assert.equal(await repo(E.EvidenceEntity).count(), 0, 'manual closure cannot manufacture evidence');

    // 即使人工稍后恢复任务，旧核实事件也不能再触发自动恢复或规划。
    const orchestrator = Object.create(OrchestratorService.prototype);
    orchestrator.stateEvents = repo(E.TaskStateEventEntity);
    orchestrator.ingestion = { ingest: async () => { throw new Error('must not ingest unknown result'); } };
    orchestrator.findTask = async () => ({ status: 'running', engineStatus: 'needs_input' });
    orchestrator.resume = async () => { throw new Error('must not auto resume'); };
    orchestrator.broadcastSnapshot = () => {};
    await orchestrator.applyApprovalOutcome(event);
    assert.equal(await repo(E.HintEntity).countBy({ id: original.id }), 1);

    // 已批准但未领取（批准与派发之间重启）的记录也可核实，不重放。
    const nextPending = async (marker) => {
      const rows = await repo(E.ToolCallEntity).find({ where: { taskId: 'task', status: 'pending_approval' }, order: { createdAt: 'DESC' } });
      const row = rows.find((item) => item.arguments?.target === marker);
      assert.ok(row, `未找到目标 ${marker} 的待审批记录`);
      return row;
    };
    await stack.invoker.invoke('lab_scan', { target: '192.168.56.102' }, ctx);
    const unclaimed = await nextPending('192.168.56.102');
    await approvals.approve(unclaimed.id);
    assert.equal((await approvals.findById(unclaimed.id)).executionState, 'needs_review');
    assert.equal((await post(unclaimed.id, input)).status, 201);
    await stack.invoker.invoke('lab_scan', { target: '192.168.56.103' }, ctx);
    const unapproved = await nextPending('192.168.56.103');
    assert.equal((await post(unapproved.id, input)).status, 400, 'unapproved calls must use rejection');

    // 活跃请求即使任务暂停也不能被人工收尾；正常完成仍写一次结果。
    let release; let entered;
    const started = new Promise((r) => { entered = r; });
    factory.callTool = async () => { remoteCalls++; entered(); return new Promise((r) => { release = () => r({ ok: true, text: '443/tcp open https', latencyMs: 1, raw: { content: [{ type: 'text', text: '443/tcp open https' }] }, isError: false }); }); };
    await approvals.approve(unapproved.id);
    const running = stack.replay.replay(unapproved.id);
    await started;
    assert.equal((await approvals.findById(unapproved.id)).executionState, 'running');
    assert.equal((await post(unapproved.id, input)).status, 400);
    release(); assert.equal((await running).ok, true);
    assert.equal((await approvals.findById(unapproved.id)).executionState, 'resolved');

    // 执行阶段抛出异常：结果未知，保留原审批供人工核实，不发出自动恢复事件。
    await stack.invoker.invoke('lab_scan', { target: '192.168.56.104' }, ctx);
    const throwing = await nextPending('192.168.56.104');
    await approvals.approve(throwing.id);
    const realInvoke = stack.invoker.invoke.bind(stack.invoker);
    stack.invoker.invoke = async () => { throw new Error('injected uncertain execution failure'); };
    await assert.rejects(stack.replay.replay(throwing.id), /injected uncertain/);
    stack.invoker.invoke = realInvoke;
    assert.equal((await approvals.findById(throwing.id)).executionState, 'needs_review');
    assert.equal(await repo(E.TaskStateEventEntity).countBy({ id: throwing.id }), 0);
    assert.equal((await post(throwing.id, input)).status, 201);

    // 远端失败/取消/附件损坏/证据写入失败：都必须保留原审批供核实。
    for (const [index, response] of [
      { ok: false, text: '', error: '工具执行超时', phase: 'execute', latencyMs: 1 },
      { ok: false, text: '', error: '调用已取消', phase: 'execute', cancelled: true, latencyMs: 1 },
      { ok: true, text: '', raw: { content: [{ type: 'image', mimeType: 'image/png', data: 'invalid-base64' }] }, latencyMs: 1 },
      { ok: true, text: '80/tcp open http', latencyMs: 1, raw: { content: [{ type: 'text', text: '80/tcp open http' }] }, isError: false },
    ].entries()) {
      const target = `192.168.56.${110 + index}`;
      await stack.invoker.invoke('lab_scan', { target }, ctx);
      const call = await nextPending(target);
      await approvals.approve(call.id);
      factory.callTool = async () => response;
      if (index === 3) await db.query("CREATE TRIGGER reject_recovery_evidence BEFORE INSERT ON evidence BEGIN SELECT RAISE(FAIL, 'injected evidence failure'); END");
      const outcome = await stack.replay.replay(call.id);
      if (index === 3) await db.query('DROP TRIGGER reject_recovery_evidence');
      assert.equal(outcome.ok, false);
      assert.equal(outcome.outcomeUncertain, true, `index=${index} 必须保留为结果未知`);
      assert.equal((await approvals.findById(call.id)).executionState, 'needs_review');
      assert.equal(await repo(E.TaskStateEventEntity).countBy({ id: call.id }), 0);
      assert.equal((await post(call.id, input)).status, 201);
    }

    // 派发前的握手失败是"已知未执行"：可以正常收尾，不算结果未知。
    await stack.invoker.invoke('lab_scan', { target: '192.168.56.120' }, ctx);
    const connectFailure = await nextPending('192.168.56.120');
    await approvals.approve(connectFailure.id);
    factory.callTool = async () => ({ ok: false, text: '', error: 'MCP 握手超时', phase: 'connect', latencyMs: 1 });
    const connectOutcome = await stack.replay.replay(connectFailure.id);
    assert.equal(connectOutcome.outcomeUncertain, undefined);
    assert.equal((await approvals.findById(connectFailure.id)).executionState, 'resolved', 'known pre-dispatch failure can finish normally');
    console.log('PASS: actual process exit/reopen, claimed and unclaimed recovery, no tool replay, scoped task pause guard, HTTP validation, active execution protection, atomic audit/outcome, concurrent closure, no fabricated evidence and no automatic resume');
  } finally {
    if (app) await app.close();
    await db.destroy();
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('vulnagent-approval-recovery-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
