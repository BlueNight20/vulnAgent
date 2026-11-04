const createTestApp = require('./create-test-app.cjs');
const backendRequire = require('./backend-require.cjs');
// This regression exercises an explicitly enabled engine; disabled behavior has its own fixture.
process.env.PI_RUNTIME_ENABLED = 'true';
// 编译后的真实服务 + 隔离内存 SQLite；远程工具用确定性替身，不访问靶机。
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { DataSource } = backendRequire('typeorm');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const requireApi = createRequire(resolve(__dirname, '../apps/api/package.json'));
const E = require('../apps/api/dist/database/entities');
const { createToolStack } = require('../apps/api/dist/modules/tool/tool-stack');
const { ToolCatalogService } = require('../apps/api/dist/modules/tool/tool-catalog.service');
const { ApprovalService } = require('../apps/api/dist/modules/mcp/approval.service');
const { BlackboardController } = require('../apps/api/dist/modules/blackboard/blackboard.controller');
const { Module } = backendRequire('@nestjs/common');
const { NestFactory } = backendRequire('@nestjs/core');
const { getRepositoryToken } = backendRequire('@nestjs/typeorm');

async function main() {
  const db = await new DataSource({ type: 'better-sqlite3', driver: requireApi('better-sqlite3'), database: ':memory:', entities: E.ENTITIES, synchronize: true }).initialize();
  try {
    const repo = (entity) => db.getRepository(entity);
    const calls = repo(E.ToolCallEntity);
    const evidence = repo(E.EvidenceEntity);
    await repo(E.TaskEntity).save({ id: 'task', name: 'execution regression', scope: { cidrs: ['192.168.56.0/24'] }, modelProvider: 'test', modelName: 'test' });
    await repo(E.McpServerEntity).save({ id: 'server', name: 'isolated', endpoint: 'http://unused.invalid/mcp' });
    await repo(E.McpToolEntity).save({ id: 'tool', mcpServerId: 'server', name: 'lab_request', riskLevel: 'destructive', inputSchema: { type: 'object', required: ['target', 'request'], properties: { target: { type: 'string' }, request: { type: 'string' } } }, syncedAt: new Date() });
    const perms = repo(E.AgentToolPermissionEntity);
    const permissionsDenyAll = async () => { for (const role of ['explore', 'verifier']) await perms.update({ id: role }, { allowed: false }); };
    const permissionsAllowExplore = async () => { for (const role of ['explore', 'verifier']) await perms.update({ id: role }, { allowed: true }); };
    for (const role of ['explore', 'verifier']) await perms.save({ id: role, taskId: 'task', agentRole: role, toolPattern: '*', allowed: true, requireApproval: true });
    const output = '响应证据🙂\n'.repeat(15000);
    let invocations = 0;
    let lastArgs;
    const factory = { callTool: async (input) => {
      invocations++;
      lastArgs = input.arguments;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, text: output, raw: undefined, latencyMs: 5, isError: false };
    } };
    const events = { broadcast() {} };
    const auditStub = { record: async () => ({}) };
    // 每个"实例"独立装配一套工具栈；它们共享同一个数据库，用于验证 CAS 领取。
    const stack = () => {
      const created = createToolStack({
        servers: repo(E.McpServerEntity), tools: repo(E.McpToolEntity), targets: repo(E.TargetEntity),
        tasks: repo(E.TaskEntity), permissions: perms, rules: repo(E.InterceptRuleEntity), calls,
        factory, events, audit: auditStub,
      });
      const catalog = new ToolCatalogService(repo(E.McpServerEntity), repo(E.McpToolEntity), created.registry, created.driver);
      return { ...created, catalog };
    };
    const service = stack();
    await service.catalog.sync();
    const approvals = new ApprovalService(calls, repo(E.McpToolEntity), auditStub, events, service.replay);
    const ctx = { taskId: 'task', sessionId: null, role: 'explore', authorizedTargets: [], allowedTools: [] };
    const invoke = async (instance, tool, input, context) => instance.invoker.invoke(tool, input, context);
    const args = { target: '192.168.56.101', request: '长参数'.repeat(600) };
    const pending = await invoke(service, 'lab_request', args, ctx);
    assert.equal(pending.failureKind, 'blocked', '高风险工具必须先进入审批');
    assert.match(pending.encoded.text, /等待审批/);
    assert.equal(invocations, 0);
    const pendingRow = await calls.findOneByOrFail({ taskId: 'task', status: 'pending_approval' });
    assert.deepEqual(pendingRow.arguments, args);
    const decisions = await Promise.allSettled([approvals.approve(pendingRow.id), approvals.reject(pendingRow.id)]);
    assert.equal(decisions.filter((r) => r.status === 'fulfilled').length, 1, '并发审批只能有一个决策成功');
    const persistedDecision = await calls.findOneByOrFail({ id: pendingRow.id });
    if (decisions[0].status === 'fulfilled') {
      assert.ok(persistedDecision.approvedAt, '批准成功必须真实提交，不能被并发拒绝事务回滚');
    } else assert.equal(persistedDecision.status, 'rejected');
    // approve 先发起，SQLite 顺序更新应使批准胜出；若拒绝胜出则新建审批。
    let approvedId = pendingRow.id;
    const afterDecision = await calls.findOneByOrFail({ id: approvedId });
    if (!afterDecision.approvedBy || afterDecision.status === 'rejected') {
      await invoke(service, 'lab_request', args, ctx);
      const another = await calls.findOneByOrFail({ taskId: 'task', status: 'pending_approval' });
      approvedId = another.id;
      await approvals.approve(approvedId);
    }
    const other = stack();
    await other.catalog.sync();
    const replay = await Promise.allSettled([service.replay.replay(approvedId), other.replay.replay(approvedId)]);
    assert.equal(replay.filter((r) => r.status === 'fulfilled').length, 1, '两个服务实例不能重复领取审批');
    const result = replay.find((r) => r.status === 'fulfilled').value;
    assert.equal(result.ok, true);
    assert.equal(invocations, 1);
    assert.deepEqual(lastArgs, args, '长参数必须原样执行');
    const saved = await evidence.findOneByOrFail({ id: result.evidenceId });
    assert.equal(saved.content, output);
    assert.equal(saved.sizeBytes, Buffer.byteLength(output));
    assert.equal(saved.sha256, createHash('sha256').update(saved.content).digest('hex'));
    assert.equal(saved.toolCallId, result.toolCallId);
    assert.equal((await calls.findOneByOrFail({ id: approvedId })).rawOutputRef, result.evidenceId);
    await assert.rejects(() => stack().replay.replay(approvedId), /未通过审批|重复|已执行/);

    // 每次申请都会新建一条待审批记录；按参数唯一定位，避免取到上一条已处理的记录。
    const latestPending = async (marker) => {
      const rows = await calls.find({ where: { taskId: 'task', status: 'pending_approval' }, order: { createdAt: 'DESC' } });
      const row = rows.find((item) => item.arguments?.request === marker);
      assert.ok(row, `未找到 ${marker} 的待审批记录`);
      return row;
    };

    await invoke(service, 'lab_request', { ...args, request: 'permission test' }, ctx);
    const p2 = await latestPending('permission test');
    await approvals.approve(p2.id);
    await perms.update({ id: 'verifier' }, { allowed: false });
    await permissionsDenyAll(perms);
    const p2Replay = await service.replay.replay(p2.id);
    assert.equal(p2Replay.ok, false);
    assert.match(p2Replay.error ?? '', /平台管控|未被授权/);
    assert.equal(invocations, 1, '批准后仍须检查当前权限');
    await perms.update({ id: 'verifier' }, { allowed: true });
    await permissionsAllowExplore(perms);

    await invoke(service, 'lab_request', { ...args, request: 'expired test' }, ctx);
    const p3 = await latestPending('expired test');
    await approvals.approve(p3.id);
    await calls.update({ id: p3.id }, { approvalExpiresAt: new Date(Date.now() - 1000) });
    await assert.rejects(() => service.replay.replay(p3.id), /过期/);

    await invoke(service, 'lab_request', { ...args, request: 'tampered test' }, ctx);
    const p4 = await latestPending('tampered test');
    await approvals.approve(p4.id);
    await calls.update({ id: p4.id }, { arguments: { ...args, request: 'changed' } });
    await assert.rejects(() => service.replay.replay(p4.id), /指纹不一致/);

    const scope = await invoke(service, 'lab_request', { ...args, target: '10.0.0.1' }, { ...ctx, authorizedTargets: ['10.0.0.1'] });
    assert.equal(scope.failureKind, 'blocked', '过期授权快照不能放行已移出数据库 Scope 的目标');
    assert.match(scope.encoded.text, /授权范围/);
    assert.equal(invocations, 1);
    const browser = new BlackboardController(repo(E.TaskEntity), evidence, null, null, null, null, null, null);
    const detailed = await browser.evidenceDetail('task', saved.id);
    assert.equal(detailed.integrity, 'match');
    await assert.rejects(() => browser.evidenceDetail('other-task', saved.id), /证据不存在/);
    for (let i = 0; i < 30; i++) await evidence.save({ id: `note-${String(i).padStart(2, '0')}`, taskId: 'task', kind: 'note', title: `note ${i}`, content: 'note content', createdAt: new Date(1700000000000 + i * 1000) });
    const page1 = await browser.listEvidence('task', 1, 10, 'note');
    const page2 = await browser.listEvidence('task', 2, 10, 'note');
    assert.equal(page1.total, 30);
    assert.equal(page2.items.length, 10);
    assert.equal(page1.items[0].preview, 'note content');
    assert.equal(page1.items[0].content, undefined);
    assert.equal(page1.items.some((a) => page2.items.some((b) => a.id === b.id)), false);
    const old = await evidence.save({ id: 'legacy-truncated', taskId: 'task', kind: 'command_output', title: 'legacy', content: 'truncated', sha256: saved.sha256, sizeBytes: saved.sizeBytes });
    assert.equal((await browser.evidenceDetail('task', old.id)).integrity, 'mismatch');
    await assert.rejects(() => browser.listEvidence('task', 1, 10, 'invalid'), /未知证据类型/);
    const serviceTokens = [
      ['blackboard/facts.service', 'FactsService'], ['blackboard/intents.service', 'IntentsService'],
      ['blackboard/hints.service', 'HintsService'], ['blackboard/hypothesis.service', 'HypothesisService'],
      ['blackboard/worker-state.service', 'WorkerStateService'], ['audit/audit.service', 'AuditService'],
    ];
    class TestModule {}
    Module({ controllers: [BlackboardController], providers: [
      { provide: getRepositoryToken(E.TaskEntity), useValue: repo(E.TaskEntity) },
      { provide: getRepositoryToken(E.EvidenceEntity), useValue: evidence },
      ...serviceTokens.map(([path, name]) => ({ provide: require(`../apps/api/dist/modules/${path}`)[name], useValue: {} })),
    ] })(TestModule);
    const app = await createTestApp(TestModule, { logger: false });
    try {
      app.setGlobalPrefix('api');
      await app.listen(0, '127.0.0.1');
      const base = `${await app.getUrl()}/api/tasks/task/evidence`;
      const response = await fetch(`${base}?page=2&pageSize=10&kind=note`);
      assert.equal(response.status, 200);
      const json = await response.json();
      assert.equal(json.total, 30);
      assert.equal(json.items.length, 10);
      assert.equal((await fetch(`${base}?page=bad`)).status, 400);
      assert.equal((await fetch(`${base}?kind=invalid`)).status, 400);
      const detailResponse = await fetch(`${base}/${saved.id}`);
      assert.equal((await detailResponse.json()).integrity, 'match');
      assert.equal((await fetch(`${await app.getUrl()}/api/tasks/other/evidence/${saved.id}`)).status, 404);
    } finally { await app.close(); }
    console.log('PASS: approval CAS, single replay across instances, live permission/scope, expiry, parameter integrity, full Unicode evidence, hash and call provenance');
    console.log('PASS: evidence pagination, type filtering, previews, integrity mismatch and cross-task isolation');
    console.log('PASS: real HTTP routes, pagination pipes, invalid input 400 and cross-task 404');
  } finally {
    await db.destroy();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
