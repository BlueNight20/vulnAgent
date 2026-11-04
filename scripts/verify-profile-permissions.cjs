const backendRequire = require('./backend-require.cjs');
// This regression exercises an explicitly enabled engine; disabled behavior has its own fixture.
process.env.PI_RUNTIME_ENABLED = 'true';
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = backendRequire('typeorm');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const load = (path, name) => require(`../apps/api/dist/modules/${path}`)[name];
const { DEFAULT_PERMISSIONS } = require('../apps/api/dist/modules/mcp/default-permissions');
const createToolStack = load('tool/tool-stack', 'createToolStack');
const ToolCatalogService = load('tool/tool-catalog.service', 'ToolCatalogService');
const WorkerSkillsService = load('worker-skills/worker-skills.service', 'WorkerSkillsService');
const WorkerRunnerService = load('orchestrator/worker-runner.service', 'WorkerRunnerService');
const ApprovalService = load('mcp/approval.service', 'ApprovalService');
const FindingsService = load('blackboard/findings.service', 'FindingsService');

/**
 * 工具层重构后的权限与审批回归：
 * 断言的是 ToolInvoker 的钩子链（拦截规则 → 范围 → 权限 → 审批），
 * 以及审批重放仍经过同一入口、不绕过范围与权限。
 */
async function main() {
  const db = await new DataSource(sqliteOptions(':memory:')).initialize();
  try {
    await db.runMigrations();
    const repo = (entity) => db.getRepository(entity);
    const target = '192.0.2.10';
    for (const id of ['task', 'other']) {
      await repo(E.TaskEntity).save({ id, name: '档案与权限固定协议', scope: { cidrs: [] }, modelProvider: 'fixture', modelName: 'fixture', status: 'paused' });
    }
    await repo(E.TargetEntity).save({ id: 'target', taskId: 'task', ip: target, kind: 'host', inScope: true });
    await repo(E.McpServerEntity).save({ id: 'server', name: 'never contacted', endpoint: 'http://unused.invalid/mcp', enabled: true, transport: 'streamable-http' });
    for (const name of ['run_shell_command', 'run_kali_tool', 'msf_console_execute', 'msf_run_module', 'msf_search', 'msf_module_info', 'ungranted_tool']) {
      await repo(E.McpToolEntity).save({
        id: name, name, mcpServerId: 'server',
        riskLevel: name.startsWith('run_') || name.includes('execute') || name === 'msf_run_module' ? 'destructive' : 'read_only',
        inputSchema: { type: 'object', required: ['target', 'fixture'], additionalProperties: false, properties: { target: { type: 'string' }, fixture: { type: 'string' } } },
        syncedAt: new Date(),
      });
    }
    const permissions = repo(E.AgentToolPermissionEntity);
    await permissions.save(DEFAULT_PERMISSIONS.map((permission) => ({ ...permission, id: randomUUID(), taskId: null })));

    const skills = new WorkerSkillsService(repo(E.McpToolEntity), repo(E.WorkerProfileLoadEntity), permissions);
    assert.deepEqual((await skills.resolve('linux-audit', [], 'task')).tools, ['run_shell_command', 'run_kali_tool', 'msf_console_execute']);
    const verifier = await skills.resolve('verification', ['ungranted_tool'], 'task');
    assert.ok(verifier.tools.includes('msf_module_info'));
    assert.ok(verifier.tools.includes('msf_run_module'));
    assert.ok(!verifier.tools.includes('ungranted_tool'));

    const deny = { id: 'deny', taskId: 'task', agentRole: 'verifier', toolPattern: 'run_shell_command', allowed: false, requireApproval: false };
    await permissions.save(deny);
    assert.ok(!(await skills.resolve('linux-audit', ['run_shell_command'], 'task')).tools.includes('run_shell_command'));
    assert.ok((await skills.resolve('linux-audit', [], 'other')).tools.includes('run_shell_command'), 'task denial does not leak to sibling');

    let invoked = 0;
    const quote = 'Fixture target identity and permission marker, independent protocol sample only.';
    // 不执行任何命令、目标 socket、模型或 shell：工厂返回固定文本。
    const factory = { callTool: async () => { invoked += 1; return { ok: true, text: quote, raw: { content: [{ type: 'text', text: quote }] }, latencyMs: 1, isError: false }; } };
    const events = { broadcast() {} };
    const audit = new (load('audit/audit.service', 'AuditService'))(repo(E.AuditLogEntity), events);
    const stack = createToolStack({
      servers: repo(E.McpServerEntity), tools: repo(E.McpToolEntity), targets: repo(E.TargetEntity), tasks: repo(E.TaskEntity),
      permissions, rules: repo(E.InterceptRuleEntity), calls: repo(E.ToolCallEntity), factory, events, audit,
    });
    const catalog = new ToolCatalogService(repo(E.McpServerEntity), repo(E.McpToolEntity), stack.registry, stack.driver);
    await catalog.sync();
    const approvals = new ApprovalService(repo(E.ToolCallEntity), repo(E.McpToolEntity), audit, events, stack.replay);

    const runner = Object.create(WorkerRunnerService.prototype);
    Object.assign(runner, { toolInvoker: stack.invoker, toolRecorder: stack.recorder });
    const args = { target, fixture: 'protocol-only' };

    // 1) 任务级拒绝在权限钩子生效，且不触达工具
    const denied = await stack.invoker.invoke('run_shell_command', args, { taskId: 'task', sessionId: null, role: 'verifier', authorizedTargets: [], allowedTools: ['run_shell_command'], evidenceIds: [] });
    assert.equal(denied.failureKind, 'blocked');
    assert.equal(invoked, 0);
    assert.match(denied.encoded.text, /平台管控/);
    await permissions.delete('deny');

    // 2) 高风险工具在 Worker 侧进入审批队列，且未执行
    await repo(E.AgentSessionEntity).save({ id: 'audit-session', taskId: 'task', role: 'verifier', profileId: 'linux-audit', state: 'completed', modelName: 'fixture', sessionKey: 'audit-session' });
    const auditTools = runner.buildToolDefinitions((await skills.resolve('linux-audit', [], 'task')).tools, 'linux-audit', { taskId: 'task' }, [target], [], () => 'audit-session');
    const runShell = auditTools.find((tool) => tool.name === 'run_shell_command');
    const pending = await runShell.execute('fixture-call', args);
    assert.equal(pending.isError, true);
    assert.match(pending.content[0].text, /等待审批/);
    assert.equal(invoked, 0, 'approval request must not execute the tool');
    const pendingRow = await repo(E.ToolCallEntity).findOneByOrFail({ taskId: 'task', status: 'pending_approval' });

    // 3) 审批通过后按原参数重放，产生独立证据
    await approvals.approve(pendingRow.id);
    const baseline = await stack.replay.replay(pendingRow.id);
    assert.equal(baseline.ok, true);
    assert.equal(invoked, 1);
    const baselineEvidence = await repo(E.EvidenceEntity).findOneByOrFail({ id: baseline.evidenceId });
    assert.equal(baselineEvidence.agentSessionId, 'audit-session');
    assert.equal(baselineEvidence.meta.targetIp, target);

    // 4) 独立复核必须重新申请审批，不能复用上一轮成功
    await repo(E.FindingEntity).save({ id: 'finding', taskId: 'task', title: '固定权限观测候选', description: '本地协议测试，不代表真实权限漏洞', status: 'candidate', severity: 'info', source: 'tool', targetIp: target, evidenceIds: [baseline.evidenceId] });
    const findings = new FindingsService(repo(E.FindingEntity));
    const request = await findings.requestVerification('task', 'finding');
    await repo(E.AgentSessionEntity).save({ id: 'verify-session', taskId: 'task', role: 'verifier', profileId: 'verification', state: 'completed', modelName: 'fixture', sessionKey: 'verify-session' });
    await repo(E.WorkerTaskEntity).save({ id: 'worker', taskId: 'task', intentId: request.intentId, sessionId: 'verify-session', profileId: 'verification', title: '协议复核', status: 'succeeded' });
    const verifierTools = runner.buildToolDefinitions(verifier.tools, 'verification', { taskId: 'task' }, [target], [], () => 'verify-session');
    const verifyTool = verifierTools.find((tool) => tool.name === 'run_shell_command');
    const pendingAgain = await verifyTool.execute('fixture-verify', args);
    assert.match(pendingAgain.content[0].text, /等待审批/);
    assert.equal(invoked, 1, 'approval cannot reuse prior success as independent proof');

    // 5) 审批后策略被收紧：重放仍被拒绝，且不执行
    const pendingRow2 = await repo(E.ToolCallEntity).findOneByOrFail({ taskId: 'task', status: 'pending_approval' });
    await approvals.approve(pendingRow2.id);
    await permissions.save(deny);
    const blockedReplay = await stack.replay.replay(pendingRow2.id);
    assert.equal(blockedReplay.ok, false);
    assert.match(blockedReplay.error ?? '', /平台管控|未被授权/);
    assert.equal(invoked, 1, 'live task denial vetoes old global grant after approval');
    await permissions.delete('deny');

    // 6) 越界目标在范围钩子被拒，审批也不能绕过
    const outOfScope = await stack.invoker.invoke('run_shell_command', { ...args, target: '192.0.2.11' }, { taskId: 'task', sessionId: null, role: 'verifier', authorizedTargets: [], allowedTools: [], evidenceIds: [] });
    assert.equal(outOfScope.failureKind, 'blocked');
    assert.match(outOfScope.encoded.text, /授权范围/);
    assert.equal(invoked, 1, 'approved tool does not bypass scope');

    console.log('PASS: migrated profile/catalog/role intersection, task/global deny precedence, suggested-tool filtering, Linux audit role, real Worker approval request via ToolInvoker, no pre-approval execution, live replay revocation, independent verifier fresh call/evidence and scope preservation; fixed factory only');
  } finally { await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
