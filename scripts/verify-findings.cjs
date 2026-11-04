const createTestApp = require('./create-test-app.cjs');
const backendRequire = require('./backend-require.cjs');
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { DataSource } = backendRequire('typeorm');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const { FindingsService } = require('../apps/api/dist/modules/blackboard/findings.service');
const { FindingsController } = require('../apps/api/dist/modules/blackboard/findings.controller');
const { FactsService } = require('../apps/api/dist/modules/blackboard/facts.service');
const { EvidenceIngestionService } = require('../apps/api/dist/modules/blackboard/evidence-ingestion.service');
const { IntentsService } = require('../apps/api/dist/modules/blackboard/intents.service');
const { WorkerStateService } = require('../apps/api/dist/modules/blackboard/worker-state.service');
const { WorkerRunnerService } = require('../apps/api/dist/modules/orchestrator/worker-runner.service');
const { parseWorkerResult } = require('../apps/api/dist/modules/orchestrator/result-parser');

async function main() {
  const db = await new DataSource(sqliteOptions(':memory:')).initialize();
  try {
    await db.runMigrations();
    const repo = (e) => db.getRepository(e);
    await repo(E.TaskEntity).save({ id: 'other', name: 'other task scope fixture', modelProvider: 'test', modelName: 'test', scope: {} });
    const gateway = { broadcast() {} };
    const findings = new FindingsService(repo(E.FindingEntity));
    const facts = new FactsService(repo(E.FactEntity), repo(E.HypothesisLinkEntity), gateway);
    const ingestion = new EvidenceIngestionService(repo(E.EvidenceEntity), facts);
    await repo(E.TaskEntity).save({ id: 'task', name: 'verification fixture', scope: { cidrs: ['192.168.56.0/24'] }, modelName: 'test', modelProvider: 'test', status: 'running' });
    const target = '192.168.56.101';
    async function evidence(content, sessionId = null, taskId = 'task') {
      const id = randomUUID(); const call = randomUUID();
      await repo(E.ToolCallEntity).save({ id: call, taskId, agentSessionId: sessionId, toolName: 'http_repeater', arguments: { target }, status: 'success', rawOutputRef: id, createdAt: new Date() });
      return repo(E.EvidenceEntity).save({ id, taskId, agentSessionId: sessionId, toolCallId: call, kind: 'http_response', title: 'fixture', content, sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: Buffer.byteLength(content), meta: { tool: 'http_repeater', targetIp: target }, createdAt: new Date() });
    }
    const baseline = await evidence('HTTP/1.1 200 OK\nCandidate backup resource exists, requires independent verification.');
    const source = await facts.create({ taskId: 'task', category: 'vulnerability', subject: `${target}/backup`, predicate: 'candidate_exposure', object: '备份资源可能公开', status: 'observed', createdBy: 'tool', sourceTool: 'http_repeater', targetIp: target, sourceEvidenceIds: [baseline.id], confidence: 0.7, observationKind: 'target_state' });
    assert.equal(await findings.captureCandidates('task', [source.id]), 1);
    assert.equal(await findings.captureCandidates('task', [source.id]), 0);
    assert.equal(await findings.queueEligibleCandidates('task', [source.id]), 1, '运行中的任务自动为有证据的新候选安排验证');
    const requests = await Promise.all([findings.requestVerification('task', source.id), new FindingsService(repo(E.FindingEntity)).requestVerification('task', source.id)]);
    assert.equal(requests[0].id, requests[1].id);
    assert.equal(await repo(E.FindingVerificationEntity).count(), 1);
    assert.equal(await repo(E.IntentEntity).count(), 1);
    assert.equal((await repo(E.IntentEntity).findOneByOrFail({ id: requests[0].intentId })).workerProfileId, 'verification');
    await assert.rejects(() => findings.detail('other', source.id), /漏洞不存在/);

    async function sessionFor(record) {
      const sessionId = randomUUID(); const workerTaskId = randomUUID();
      await repo(E.AgentSessionEntity).save({ id: sessionId, taskId: 'task', role: 'verifier', profileId: 'verification', sessionKey: sessionId, modelName: 'fixture', state: 'completed' });
      await repo(E.WorkerTaskEntity).save({ id: workerTaskId, taskId: 'task', sessionId, intentId: record.intentId, profileId: 'verification', title: 'verify fixture', status: 'running' });
      return { sessionId, workerTaskId };
    }
    const first = requests[0]; const run = await sessionFor(first);
    const quote = 'Independent response includes the expected backup marker';
    const proof = await evidence(`HTTP/1.1 200 OK\n${quote}\n`, run.sessionId);
    const structured = { summary: '独立请求复核成功', verification: { outcome: 'confirmed', summary: '独立响应中的备份标记与候选相符', evidenceQuotes: [{ evidenceId: proof.id, quote }] } };
    assert.equal(parseWorkerResult(JSON.stringify(structured)).verification.evidenceQuotes[0].evidenceId, proof.id);
    const toolRunner = Object.create(WorkerRunnerService.prototype);
    await repo(E.McpToolEntity).save({ id: 'http-tool', mcpServerId: 'fixture', name: 'http_repeater', syncedAt: new Date(), inputSchema: { type: 'object', properties: { target: { type: 'string' } } } });
    let forced = false;
    Object.assign(toolRunner, {
      toolInvoker: {
        schemas: () => [{ name: 'http_repeater', description: 'fixture', inputSchema: { type: 'object', properties: { target: { type: 'string' } } } }],
        invoke: async (name, params, context) => {
          forced = context.forceRerun;
          return { tool: name, durationMs: 1, failureKind: null, result: { content: [{ type: 'text', text: quote }] }, encoded: { text: quote, isError: false } };
        },
      },
      toolRecorder: { record: async () => ({ toolCallId: 'fixture-call', evidenceId: proof.id }) },
    });
    const defs = await toolRunner.buildToolDefinitions(['http_repeater'], 'verification', { taskId: 'task' }, [target], [], () => run.sessionId);
    const reply = await defs[0].execute('model-tool-call', { target });
    assert.equal(forced, true, '独立验证必须真实重跑，不能命中任务级缓存');
    assert.ok(reply.content[0].text.includes(proof.id), '模型必须能引用稳定的证据 ID');
    // 调用真实 Worker 收尾逻辑：会话消息是固定模型输出，工具和模型均不连接外部服务。
    const runner = Object.create(WorkerRunnerService.prototype);
    Object.assign(runner, {
      finalized: new Set(), lastResults: new Map(), logger: { debug() {}, warn() {}, error(message) { throw new Error(message); } },
      sessions: { findOne: async () => repo(E.AgentSessionEntity).findOneByOrFail({ id: run.sessionId }), store: { latestAssistant: async () => ({ role: 'assistant', content: JSON.stringify(structured) }) } },
      evidence: repo(E.EvidenceEntity), facts, ingestion, findings, hypotheses: {},
      workers: new WorkerStateService(repo(E.WorkerTaskEntity), repo(E.WorkerResultCardEntity), gateway),
      intents: new IntentsService(repo(E.IntentEntity), gateway),
    });
    const intent = (await runner.intents.findById(first.intentId));
    await runner.finalize(run.sessionId, { taskId: 'task', intent, workerTaskId: run.workerTaskId }, [proof.id], null);
    let detail = await findings.detail('task', source.id);
    assert.equal(detail.finding.status, 'confirmed');
    assert.equal(detail.verifications[0].outcome, 'confirmed');
    await assert.rejects(() => new (require('../apps/api/dist/database/migrations/1793577601000-FindingVerification').FindingVerification1793577601000)().down(db.createQueryRunner()), /验证历史非空/);
    assert.equal(await repo(E.FindingVerificationEntity).count(), 1, '拒绝回滚时保留验证历史');
    assert.equal((await repo(E.FactEntity).findOneByOrFail({ id: first.id })).status, 'verified');
    assert.equal((await repo(E.WorkerTaskEntity).findOneByOrFail({ id: run.workerTaskId })).status, 'succeeded');
    await findings.recordWorkerResult('task', first.intentId, run.sessionId, run.workerTaskId, structured.verification);
    assert.equal(await repo(E.FindingVerificationEntity).count(), 1);
    assert.equal(await findings.captureCandidates('task'), 0, '复核事实不会递归创建新候选');

    async function attempt(makeResult) {
      // Each independent scenario gets fresh, traceable exploration evidence.
      const fresh = await evidence(`HTTP/1.1 200 OK\nNew exploration observation ${randomUUID()}`);
      const candidate = await repo(E.FindingEntity).findOneByOrFail({ id: source.id });
      await repo(E.FindingEntity).update(source.id, { evidenceIds: [...candidate.evidenceIds, fresh.id] });
      const record = await findings.requestVerification('task', source.id);
      const run = await sessionFor(record);
      const { result, error } = await makeResult(run);
      await findings.recordWorkerResult('task', record.intentId, run.sessionId, run.workerTaskId, result, error);
      return repo(E.FindingVerificationEntity).findOneByOrFail({ id: record.id });
    }
    const claim = (row, text = quote, outcome = 'confirmed') => ({ outcome, summary: 'test conclusion', evidenceQuotes: [{ evidenceId: row.id, quote: text }] });
    assert.equal((await attempt(async () => ({ result: claim(baseline) }))).outcome, 'inconclusive', '旧来源不能充作本次验证');
    assert.equal((await attempt(async (run) => ({ result: claim(await evidence(baseline.content, run.sessionId), 'Candidate backup resource exists') }))).outcome, 'confirmed', '本次独立调用即使响应相同，也应允许复现确认');
    assert.equal((await attempt(async (run) => {
      const row = await evidence(quote, run.sessionId);
      await repo(E.EvidenceEntity).update({ id: row.id }, { createdAt: new Date(Date.now() - 60000) });
      return { result: claim(row) };
    })).outcome, 'inconclusive', '早于本次请求的输出不能充作新验证证据');
    assert.equal((await attempt(async (run) => ({ result: claim(await evidence(quote, run.sessionId), '伪造的输出片段不存在') }))).outcome, 'inconclusive');
    assert.equal((await attempt(async (run) => ({ result: claim(await evidence(quote, run.sessionId, 'other')) }))).outcome, 'inconclusive');
    assert.equal((await attempt(async (run) => {
      const row = await evidence(quote, run.sessionId); await repo(E.EvidenceEntity).update({ id: row.id }, { content: 'modified' }); return { result: claim(row) };
    })).outcome, 'inconclusive');
    assert.equal((await attempt(async () => ({ result: null, error: 'tool timeout' }))).outcome, 'inconclusive');
    assert.equal((await attempt(async (run) => ({ result: claim(await evidence('HTTP/1.1 404 Not Found\nIndependent request establishes the candidate resource is absent.', run.sessionId), 'Independent request establishes the candidate resource is absent.', 'refuted') }))).outcome, 'refuted');
    assert.equal((await findings.detail('task', source.id)).finding.status, 'refuted');
    const queued = await findings.requestVerification('task', source.id);
    await repo(E.IntentEntity).update({ id: queued.intentId }, { status: 'rejected', rejectedReason: 'budget' });
    assert.equal((await findings.detail('task', source.id)).finding.status, 'unconfirmed');
    await repo(E.FindingEntity).update({ id: source.id }, { targetIp: '10.0.0.1' });
    await assert.rejects(() => findings.requestVerification('task', source.id), /授权范围/);
    await repo(E.FindingEntity).update({ id: source.id }, { targetIp: target, evidenceIds: [] });
    await assert.rejects(() => findings.requestVerification('task', source.id), /工具证据/);
    const controller = new FindingsController(findings);
    assert.equal((await controller.list('task', 1, 'unconfirmed')).total, 1);
    await assert.rejects(() => controller.list('task', 1, 'invalid'), /未知漏洞状态/);
    // 验证真实 HTTP 路由及输入错误，不依赖前端或模型替身来判断状态码。
    const { Module } = backendRequire('@nestjs/common');
    const { NestFactory } = backendRequire('@nestjs/core');
    class TestModule {}
    Module({ controllers: [FindingsController], providers: [{ provide: FindingsService, useValue: findings }] })(TestModule);
    const app = await createTestApp(TestModule, { logger: false });
    try {
      app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1');
      const url = `${await app.getUrl()}/api/tasks/task/findings`;
      assert.equal((await fetch(`${url}?status=invalid`)).status, 400);
      assert.equal((await fetch(`${url}?page=bad`)).status, 400);
      assert.equal((await fetch(`${await app.getUrl()}/api/tasks/other/findings/${source.id}`)).status, 404);
      assert.equal((await fetch(`${url}/${source.id}/verify`, { method: 'POST' })).status, 400);
      await repo(E.FindingEntity).update({ id: source.id }, { evidenceIds: [baseline.id] });
      assert.equal((await fetch(`${url}/${source.id}/verify`, { method: 'POST' })).status, 400, '原证据不足以重开无法确认的验证');
      const renewed = await evidence('HTTP/1.1 200 OK\nFresh exploration evidence for HTTP requeue');
      await repo(E.FindingEntity).update({ id: source.id }, { evidenceIds: [baseline.id, renewed.id] });
      const queuedResponse = await fetch(`${url}/${source.id}/verify`, { method: 'POST' });
      assert.equal(queuedResponse.status, 201);
      const queuedRecord = await queuedResponse.json();
      assert.equal(queuedRecord.outcome, 'pending');
      const duplicate = await fetch(`${url}/${source.id}/verify`, { method: 'POST' });
      assert.equal((await duplicate.json()).id, queuedRecord.id);
      const page = await (await fetch(`${url}?status=verifying`)).json();
      assert.equal(page.total, 1);
      await repo(E.TaskEntity).update('task', { status: 'stopped', engineStatus: 'stopped', stopReason: 'max_cycles' });
      const { reconcileTerminalVerifications } = require('../apps/api/dist/modules/blackboard/verification-terminal');
      await reconcileTerminalVerifications(db.manager, 'task');
      assert.equal((await repo(E.FindingVerificationEntity).findOneByOrFail({ id: queuedRecord.id })).outcome, 'inconclusive');
      assert.equal((await repo(E.FindingEntity).findOneByOrFail({ id: source.id })).status, 'unconfirmed', '无需 list/detail 即完成终态收尾');
      await reconcileTerminalVerifications(db.manager, 'task');
      assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'finding.verification_reconciled' }), 1, '收尾幂等');
    } finally { await app.close(); }
    assert.ok(await repo(E.AuditLogEntity).countBy({ action: 'finding.verification_finished' }));
    const mergeFacts = [];
    for (const description of ['Index of /', '<title>Index of /</title>']) {
      const id = randomUUID(); mergeFacts.push(id);
      await repo(E.FactEntity).save({ id, taskId: 'other', category: 'vulnerability', subject: 'http://192.168.56.101:80/', predicate: 'directory_listing_enabled', object: description, status: 'observed', observationKind: 'target_state', confidence: 0.8, sourceEvidenceIds: [], createdBy: 'tool', targetIp: target });
    }
    assert.equal(await findings.captureCandidates('other', mergeFacts), 1);
    const merged = await repo(E.FindingEntity).findOneByOrFail({ taskId: 'other' });
    assert.deepEqual(new Set(merged.sourceFactIds), new Set(mergeFacts));
    assert.equal(merged.clueLevel, 'weakness');
    assert.equal((await findings.list('other', 1, undefined, 'actionable')).total, 0);
    assert.equal((await findings.list('other', 1, undefined, 'weakness')).total, 1);
    await assert.rejects(() => findings.list('other', 1, undefined, 'invalid'), /未知线索/);
    assert.equal(await repo(E.FactEntity).countBy({ taskId: 'other' }), 2, '原始事实保留');
    assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'finding.source_merged' }), 1);
    const reportEvidence = await evidence('HTTP 200 Index of /', null, 'other');
    const report = { taskId: 'other', title: '目录可浏览', description: '根目录列出 site/', severity: 'info', targetIp: target, cve: null, cwe: null, evidenceIds: [reportEvidence.id], agentSessionId: null, sourceFactIds: mergeFacts };
    const reported = await findings.createCandidate(report);
    assert.equal(reported.id, merged.id, 'direct report shares identity with its source facts');
    assert.equal((await repo(E.FindingEntity).findOneByOrFail({ id: merged.id })).clueLevel, 'weakness');
    await repo(E.FindingEntity).update(merged.id, { status: 'confirmed' });
    assert.equal((await findings.createCandidate(report)).status, 'confirmed', 'merging does not reset verification state');
    assert.equal(await repo(E.FindingEntity).countBy({ taskId: 'other' }), 1);
    assert((await repo(E.FindingEntity).findOneByOrFail({ id: merged.id })).evidenceIds.includes(reportEvidence.id));
    await assert.rejects(() => findings.createCandidate({ ...report, sourceFactIds: [source.id] }), /来源事实/);
    await assert.rejects(() => findings.createCandidate({ ...report, targetIp: '192.168.56.102' }), /目标不一致/);
    const standalone = { ...report, sourceFactIds: [], title: '独立候选', description: '路径 /private 参数 a 在访客身份下返回内容' };
    const repeated = await Promise.all([findings.createCandidate(standalone), findings.createCandidate({ ...standalone, title: '  独立候选  ' })]);
    assert.equal(repeated[0].id, repeated[1].id, 'concurrent identical reports merge');
    const different = await findings.createCandidate({ ...standalone, description: '路径 /private 参数 a 在管理员身份下返回内容' });
    assert.notEqual(different.id, repeated[0].id, 'different authentication contexts remain distinct');
    console.log('PASS: fact/report identity, evidence union, preserved verification state, concurrent report deduplication and target/task isolation');
    console.log('PASS: migrated verification history, candidate deduplication, concurrent queueing, real Worker finalization, independent quoted evidence, no duplicate confirmation, tamper/scope/session checks, inconclusive versus refuted, rejected-intent reconciliation');
    console.log('PASS: findings HTTP filtering, invalid request 400, cross-task 404, queued verification 201, idempotent duplicate POST and audit');
  } finally { await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
