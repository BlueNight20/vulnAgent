const createTestApp = require('./create-test-app.cjs');
const backendRequire = require('./backend-require.cjs');
// 真实迁移/服务/Worker 收尾与本机 HTTP；所有证据是固定文本，不执行扫描或调用模型。
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { DataSource } = backendRequire('typeorm');
const { Module, ValidationPipe } = backendRequire('@nestjs/common');
const { NestFactory } = backendRequire('@nestjs/core');
const { getRepositoryToken } = backendRequire('@nestjs/typeorm');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const load = (module, name) => require(`../apps/api/dist/modules/${module}`)[name];
const HypothesisService = load('blackboard/hypothesis.service', 'HypothesisService');
const FactsService = load('blackboard/facts.service', 'FactsService');
const IntentsService = load('blackboard/intents.service', 'IntentsService');
const FindingsService = load('blackboard/findings.service', 'FindingsService');
const WorkerStateService = load('blackboard/worker-state.service', 'WorkerStateService');
const BlackboardController = load('blackboard/blackboard.controller', 'BlackboardController');

async function main() {
  const db = await new DataSource(sqliteOptions(':memory:')).initialize(); let app;
  try {
    await db.runMigrations(); const repo = (entity) => db.getRepository(entity);
    const gateway = { broadcast() {} }; const audit = { record: async () => {} };
    const graph = new HypothesisService(repo(E.HypothesisEntity), repo(E.HypothesisLinkEntity), gateway);
    const facts = new FactsService(repo(E.FactEntity), repo(E.HypothesisLinkEntity), gateway);
    const intents = new IntentsService(repo(E.IntentEntity), gateway);
    const findings = new FindingsService(repo(E.FindingEntity));
    const workers = new WorkerStateService(repo(E.WorkerTaskEntity), repo(E.WorkerResultCardEntity), gateway);
    const old = new Date(Date.now() - 60000); const a = '192.168.56.101'; const b = '192.168.56.102';
    for (const id of ['task', 'other']) await repo(E.TaskEntity).save({ id, name: id, status: 'running', scope: { cidrs: ['192.168.56.0/24'] }, modelProvider: 'fixture', modelName: 'fixture', startedAt: old });
    for (const [id, taskId] of [['session', 'task'], ['other-session', 'other']]) await repo(E.AgentSessionEntity).save({ id, taskId, role: 'explore', modelName: 'fixture', sessionKey: id, state: 'completed' });
    async function evidence(text, target = a, taskId = 'task', args = { target }, sessionId = 'session') {
      const id = randomUUID(); const callId = randomUUID();
      await repo(E.ToolCallEntity).save({ id: callId, taskId, agentSessionId: sessionId, toolName: 'fixture_request', arguments: args, targetIp: target, status: 'success', rawOutputRef: id, createdAt: new Date() });
      return repo(E.EvidenceEntity).save({ id, taskId, agentSessionId: sessionId, toolCallId: callId, kind: 'http_response', title: 'fixture response', content: text, sha256: createHash('sha256').update(text).digest('hex'), sizeBytes: Buffer.byteLength(text), meta: { targetIp: target, tool: 'fixture_request' }, createdAt: new Date() });
    }
    const proof = await evidence('HTTP/1.1 200 OK\nfixture backup resource is publicly readable.');
    const denial = await evidence('HTTP/1.1 403 Forbidden\nfixture backup resource requires authentication.');
    const wrongHost = await evidence('HTTP/1.1 200 OK\nfixture response belongs to a different host.', b);
    const otherProof = await evidence(proof.content, a, 'other', { target: a }, 'other-session');
    const wrongSession = await evidence('fixture proof with cross-task session metadata', a, 'task', { target: a }, 'other-session');
    const observed = await facts.create({ taskId: 'task', category: 'service', subject: '/backup', predicate: 'response', object: 'readable', createdBy: 'tool', targetIp: a, sourceEvidenceIds: [proof.id], observationKind: 'target_state', confidence: 0.8 });
    const separateHost = await facts.create({ taskId: 'task', category: 'service', subject: '/backup', predicate: 'response', object: 'readable', createdBy: 'tool', targetIp: b, sourceEvidenceIds: [wrongHost.id], observationKind: 'target_state', confidence: 0.8 });
    assert.notEqual(observed.id, separateHost.id, 'same textual triple on different hosts must not merge');
    const inference = await facts.create({ taskId: 'task', category: 'service', subject: '/inference', predicate: 'maybe', object: 'readable', createdBy: 'agent', targetIp: a, confidence: 0.4 });
    const h = await graph.create({ taskId: 'task', title: '备份公开', description: '分析备份资源是否公开可读，需独立复核', targetIp: a });
    const copies = await Promise.all([graph.create({ taskId: 'task', title: '备份公开', description: 'same', targetIp: a }), new HypothesisService(repo(E.HypothesisEntity), repo(E.HypothesisLinkEntity), gateway).create({ taskId: 'task', title: '备份公开', description: 'same', targetIp: a })]);
    assert.ok(copies.every((copy) => copy.id === h.id));
    assert.notEqual((await graph.create({ taskId: 'task', title: h.title, description: 'different host hypothesis', targetIp: b })).id, h.id);
    const otherH = await graph.create({ taskId: 'other', title: 'other task', description: 'other scope', targetIp: a });
    await assert.rejects(graph.create({ taskId: 'task', title: 'outside', description: 'outside', targetIp: '203.0.113.1' }), /授权/);
    await assert.rejects(graph.link(otherH.id, 'supports', 'evidence', proof.id, 'task', '明确分析解释与原文'), /假设不存在/);
    const quote = { evidenceId: proof.id, quote: 'fixture backup resource is publicly readable.' };
    const note = '该响应中的公开资源内容直接支持此备份可读的分析假设';
    const link = (type = 'supports', targetType = 'evidence', targetId = proof.id, quotes = [quote]) => graph.link(h.id, type, targetType, targetId, 'task', note, { evidenceQuotes: quotes });
    await assert.rejects(link('supports', 'evidence', proof.id, []), /原文/);
    await assert.rejects(link('supports', 'evidence', otherProof.id, [{ evidenceId: otherProof.id, quote: proof.content }]), /不存在|此任务/);
    await assert.rejects(link('supports', 'evidence', wrongHost.id, [{ evidenceId: wrongHost.id, quote: wrongHost.content }]), /目标/);
    await assert.rejects(link('supports', 'evidence', wrongSession.id, [{ evidenceId: wrongSession.id, quote: wrongSession.content }]), /会话/);
    await assert.rejects(link('supports', 'evidence', proof.id, [{ evidenceId: proof.id, quote: 'fabricated output not in response' }]), /连续原文/);
    await assert.rejects(link('supports', 'fact', inference.id), /推断/);
    await assert.rejects(link('supports', 'fact', observed.id, [{ evidenceId: denial.id, quote: denial.content }]), /来源/);
    await Promise.all([link(), link()]);
    assert.equal((await graph.detail('task', h.id)).hypothesis.supportCount, 1);
    await link('supports', 'fact', observed.id);
    assert.equal((await graph.detail('task', h.id)).hypothesis.supportCount, 1, 'same raw source linked as fact and evidence counts once');
    const sameBytes = await evidence(proof.content);
    await link('supports', 'evidence', sameBytes.id, [{ evidenceId: sameBytes.id, quote: quote.quote }]);
    assert.equal((await graph.detail('task', h.id)).hypothesis.supportCount, 1, 'same bytes from another call cannot inflate support');
    await link('contradicts', 'evidence', denial.id, [{ evidenceId: denial.id, quote: 'fixture backup resource requires authentication.' }]);
    let detail = await graph.detail('task', h.id);
    assert.equal(detail.hypothesis.conflicted, true); assert.equal(detail.hypothesis.status, 'proposed');
    assert.deepEqual([detail.hypothesis.supportCount, detail.hypothesis.contradictCount], [1, 1]);
    assert.ok(detail.hypothesis.factIds.includes(observed.id)); assert.ok(detail.hypothesis.evidenceIds.includes(proof.id));
    // 即使数据库中的冗余状态被旧版本标为 supported，读取和 Planner 也按当前原文重算。
    await repo(E.HypothesisEntity).update(h.id, { status: 'supported', supportCount: 999, confidence: 0.99 });
    assert.equal((await graph.list('task')).find((x) => x.id === h.id).status, 'proposed');
    await repo(E.EvidenceEntity).update(proof.id, { content: 'corrupted bytes' });
    assert.ok((await graph.detail('task', h.id)).links.some((l) => l.validation === 'invalid' && /完整性/.test(l.invalidReason)));
    await repo(E.EvidenceEntity).update(proof.id, { content: proof.content });
    await repo(E.ToolCallEntity).update(proof.toolCallId, { arguments: { target: b } });
    assert.ok((await graph.detail('task', h.id)).links.some((l) => l.validation === 'invalid' && /工具参数/.test(l.invalidReason)));
    await repo(E.ToolCallEntity).update(proof.toolCallId, { arguments: { target: a } });
    await repo(E.TaskEntity).update('task', { startedAt: new Date(Date.now() + 1000) });
    assert.equal((await graph.detail('task', h.id)).hypothesis.supportCount, 0);
    assert.ok((await graph.detail('task', h.id)).links.some((l) => l.validation === 'stale'));
    await repo(E.TaskEntity).update('task', { startedAt: old });
    await repo(E.HypothesisLinkEntity).save({ id: 'legacy-link', taskId: 'task', hypothesisId: h.id, linkType: 'supports', targetType: 'fact', targetId: observed.id });
    assert.equal((await graph.detail('task', h.id)).links.find((l) => l.id === 'legacy-link').validation, 'legacy');
    await repo(E.TaskEntity).update('task', { scope: { cidrs: [] } });
    assert.equal((await graph.detail('task', h.id)).hypothesis.supportCount, 0);
    await repo(E.TaskEntity).update('task', { scope: { cidrs: ['192.168.56.0/24'] } });

    // CIDR / 多目标原始参数，不能把缺目标标记的任意行当成某主机的直接依据。
    const batch = await evidence(`${a} fixture response for host A\n${b} fixture response for host B`, null, 'task', { target: '192.168.56.0/24' });
    await assert.rejects(link('supports', 'evidence', batch.id, [{ evidenceId: batch.id, quote: 'fixture response for host B' }]), /宽范围/);
    await link('supports', 'evidence', batch.id, [{ evidenceId: batch.id, quote: `${a} fixture response for host A` }]);
    const prefixHypothesis = await graph.create({ taskId: 'task', title: 'IP前缀不能误配', description: '检查明确主机字面量边界', targetIp: '192.168.56.10' });
    await assert.rejects(graph.link(prefixHypothesis.id, 'supports', 'evidence', batch.id, 'task', note, { evidenceQuotes: [{ evidenceId: batch.id, quote: `${a} fixture response for host A` }] }), /宽范围/);
    const multi = await evidence(`${a} fixture response for host A\n${b} fixture response for host B`, a, 'task', { targets: [a, b] });
    await assert.rejects(link('supports', 'evidence', multi.id, [{ evidenceId: multi.id, quote: `${b} fixture response for host B` }]), /宽范围/);
    const hypothesisB = (await graph.list('task')).find((x) => x.title === h.title && x.targetIp === b);
    await graph.link(hypothesisB.id, 'supports', 'evidence', multi.id, 'task', note, { evidenceQuotes: [{ evidenceId: multi.id, quote: `${b} fixture response for host B` }] });
    const httpsProof = await evidence('HTTP/1.1 200 OK\nfixture TLS resource evidence for port 443', a, 'task', { target: `https://${a}:443/` });
    const portHypothesis = await graph.create({ taskId: 'task', title: '端口范围校验', description: '明确证据只能在当前端口授权范围内计入判断', targetIp: a });
    await graph.link(portHypothesis.id, 'supports', 'evidence', httpsProof.id, 'task', note, { evidenceQuotes: [{ evidenceId: httpsProof.id, quote: 'fixture TLS resource evidence for port 443' }] });
    await repo(E.TaskEntity).update('task', { scope: { cidrs: ['192.168.56.0/24'], ports: '80' } });
    assert.equal((await graph.detail('task', portHypothesis.id)).hypothesis.supportCount, 0);
    assert.ok((await graph.detail('task', portHypothesis.id)).links.some((l) => /端口/.test(l.invalidReason)));
    await repo(E.TaskEntity).update('task', { scope: { cidrs: ['192.168.56.0/24'] } });

    // 真实 Worker 收尾：只连明确引用，不再把两条模型事实连到所有假设。
    const intent = (await intents.create({ taskId: 'task', title: 'analyze fixed response', objective: 'analyze fixture', targetIp: a, dedupeKey: 'worker-graph', workerProfileId: 'recon' })).intent;
    await repo(E.WorkerTaskEntity).save({ id: 'worker', taskId: 'task', sessionId: 'session', intentId: intent.id, title: 'fixture worker', profileId: 'recon', status: 'running' });
    const parseWorkerResult = load('orchestrator/result-parser', 'parseWorkerResult');
    const parsed = parseWorkerResult(JSON.stringify({ summary: '固定数据分析', facts: [{ category: 'service', subject: 'model-only', predicate: 'guess', object: 'inference', evidenceIndex: 0 }], hypotheses: [
      { title: '仅待验证', description: '这里仅是待验证的研究问题，不宣称有证据', status: 'proposed' },
      { title: '明确引用假设', description: note, status: 'supported', evidenceQuotes: [quote], factIds: [observed.id] },
      { title: '无原文声明', description: '仅有模型声明，没有提供明确原文依据', status: 'supported' },
    ], nextIntents: [] }));
    const runner = Object.create(load('orchestrator/worker-runner.service', 'WorkerRunnerService').prototype);
    Object.assign(runner, { finalized: new Set(), lastResults: new Map([['session', parsed]]), logger: { debug() {}, warn() {}, error(message) { throw new Error(message); } }, sessions: { findOne: async () => ({ id: 'session', state: 'completed', tokenInput: 0, tokenOutput: 0, startedAt: old.toISOString() }), store: { latestAssistant: async () => null } }, evidence: repo(E.EvidenceEntity), facts, hypotheses: graph, findings, intents, workers, ingestion: new (load('blackboard/evidence-ingestion.service', 'EvidenceIngestionService'))(repo(E.EvidenceEntity), facts) });
    await runner.finalize('session', { taskId: 'task', intent, workerTaskId: 'worker' }, [proof.id], null);
    const results = await graph.list('task');
    const proposed = results.find((x) => x.title === '仅待验证'); const explicit = results.find((x) => x.title === '明确引用假设'); const unsupported = results.find((x) => x.title === '无原文声明');
    assert.equal(proposed.status, 'proposed'); assert.equal(proposed.supportCount, 0); assert.equal(proposed.factIds.length, 0);
    assert.equal(explicit.supportCount, 1); assert.equal(explicit.status, 'supported');
    assert.deepEqual(explicit.factIds, [observed.id]);
    assert.equal(unsupported.supportCount, 0); assert.equal(unsupported.status, 'proposed');
    const card = await repo(E.WorkerResultCardEntity).findOneByOrFail({ workerTaskId: 'worker' });
    assert.deepEqual(card.supportedHypothesisIds, [explicit.id]); assert.ok(card.openQuestions.some((q) => q.includes('缺少明确证据原文')));
    // 明确事实关系只是研究线索；新建与三元组合并路径都维护关联，拒绝跨目标/任务。
    const linkedFact = await facts.create({ taskId: 'task', category: 'service', subject: 'linked', predicate: 'guess', object: 'inferred', createdBy: 'agent', targetIp: a, confidence: 0.4, hypothesisIds: [h.id] });
    await facts.create({ taskId: 'task', category: 'service', subject: 'linked', predicate: 'guess', object: 'inferred', createdBy: 'agent', targetIp: a, confidence: 0.4, hypothesisIds: [explicit.id] });
    assert.ok((await graph.detail('task', explicit.id)).hypothesis.factIds.includes(linkedFact.id));
    await assert.rejects(facts.create({ taskId: 'task', category: 'service', subject: 'bad', predicate: 'bad', object: 'bad', createdBy: 'agent', confidence: 0.4, targetIp: b, hypothesisIds: [h.id] }), /目标不一致/);

    // 真实 Planner 输出应用：本批 key 精确映射，重复 key 不猜测；规划摘要读取重校验视图。
    const cycle = Object.create(load('orchestrator/orchestrator-cycle.service', 'OrchestratorCycleService').prototype);
    const warnings = [];
    Object.assign(cycle, { hypotheses: graph, intents, logger: { warn(message) { warnings.push(message); } }, evaluateWithEvidence: async () => ({ finish: false }) });
    const planned = load('orchestrator/result-parser', 'parsePlannerResult')(JSON.stringify({ hypotheses: [
      { key: 'new', title: '规划假设', description: '明确提出的研究问题，尚无直接证据', targetIp: a, status: 'supported' },
      { key: 'ambiguous', title: '歧义一', description: '第一个问题', targetIp: a }, { key: 'ambiguous', title: '歧义二', description: '第二个问题', targetIp: a },
    ], intents: [{ title: '规划验证意图', targetIp: a, workerProfileId: 'verification', dedupeKey: 'planned', hypothesisRefs: ['new', 'ambiguous'] }] }));
    await cycle.applyPlannerOutput('task', { plannerSessionId: 'session', cycle: 2 }, planned);
    const plannedHypothesis = (await graph.list('task')).find((x) => x.title === '规划假设');
    assert.equal(plannedHypothesis.status, 'proposed'); assert.equal(plannedHypothesis.supportCount, 0);
    const plannedIntent = await repo(E.IntentEntity).findOneByOrFail({ taskId: 'task', dedupeKey: 'planned' });
    assert.deepEqual(plannedHypothesis.intentIds, [plannedIntent.id]);
    assert.equal(await repo(E.HypothesisLinkEntity).countBy({ taskId: 'task', targetType: 'intent', targetId: plannedIntent.id }), 1);
    assert.ok(warnings.some((w) => w.includes('重复')));
    const planner = new (load('orchestrator/planner-runner.service', 'PlannerRunnerService'))(repo(E.FactEntity), repo(E.HypothesisEntity), repo(E.IntentEntity), repo(E.WorkerTaskEntity), repo(E.AgentSessionEntity), { summary: async () => '' }, { summary: async () => '' }, graph);
    const prompt = await planner.buildPrompt({ taskId: 'task', taskName: 'graph fixture', targetIps: [a], scopeCidrs: [], tokenBudget: 10000, tokensUsed: 0, timeBudgetMinutes: 10, elapsedMinutes: 0, availableProfiles: ['verification'], availableTools: [], hints: [] });
    assert.ok(prompt.includes(`ID=${h.id}`)); assert.ok(prompt.includes('依据冲突')); assert.ok(prompt.includes('假设解释，不代表漏洞确认'));
    assert.ok(!prompt.includes('有效支持/反驳来源=999'));
    const auditHypothesis = await graph.create({ taskId: 'task', title: '核实关联审计', description: '说明引用与审计必须同事务保存', targetIp: a });
    await db.query("CREATE TRIGGER fail_graph_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'hypothesis.link' BEGIN SELECT RAISE(FAIL, 'injected graph audit failure'); END");
    await assert.rejects(graph.link(auditHypothesis.id, 'supports', 'fact', observed.id, 'task', note, { evidenceQuotes: [quote] }), /graph audit/);
    assert.equal(await repo(E.HypothesisLinkEntity).countBy({ hypothesisId: auditHypothesis.id }), 0);
    assert.ok(!(await repo(E.FactEntity).findOneByOrFail({ id: observed.id })).hypothesisIds.includes(auditHypothesis.id));
    await db.query('DROP TRIGGER fail_graph_audit');
    const beforeVersions = await repo(E.HypothesisLinkEntity).countBy({ hypothesisId: h.id, targetType: 'evidence', targetId: proof.id, linkType: 'supports' });
    await graph.link(h.id, 'supports', 'evidence', proof.id, 'task', `${note}；补充说明并保留上一版解释`, { evidenceQuotes: [quote] });
    assert.equal(await repo(E.HypothesisLinkEntity).countBy({ hypothesisId: h.id, targetType: 'evidence', targetId: proof.id, linkType: 'supports' }), beforeVersions + 1);
    assert.equal((await graph.detail('task', h.id)).hypothesis.supportCount, 2, 'new explanation does not add a source; only the separate batch payload adds a second hash');
    // 模拟升级前的跨任务坏边，带有本任务证据 ID 的 quote；反向查询的 OR 不能越过任务条件。
    await repo(E.HypothesisLinkEntity).save({ id: 'foreign-legacy-edge', taskId: 'other', hypothesisId: otherH.id, linkType: 'supports', targetType: 'evidence', targetId: otherProof.id, evidenceQuotes: [quote], assessmentSource: 'legacy' });
    for (const [id, taskId, sourceIds] of [['baseline-finding', 'task', [proof.id]], ['verification-finding', 'task', [denial.id]], ['prefix-finding', 'task', [`prefix-${proof.id}`]], ['foreign-finding', 'other', [proof.id]]]) {
      await repo(E.FindingEntity).save({ id, taskId, title: id, description: 'fixed relationship fixture', severity: 'low', status: 'candidate', evidenceIds: sourceIds });
    }
    await repo(E.FindingVerificationEntity).save({ id: 'reverse-verification', taskId: 'task', findingId: 'verification-finding', intentId: plannedIntent.id, outcome: 'inconclusive', baselineEvidenceIds: [denial.id], evidenceIds: [proof.id] });

    class TestModule {}
    Module({ controllers: [BlackboardController], providers: [
      { provide: getRepositoryToken(E.TaskEntity), useValue: repo(E.TaskEntity) }, { provide: getRepositoryToken(E.EvidenceEntity), useValue: repo(E.EvidenceEntity) },
      { provide: FactsService, useValue: facts }, { provide: IntentsService, useValue: intents }, { provide: load('blackboard/hints.service', 'HintsService'), useValue: {} },
      { provide: HypothesisService, useValue: graph }, { provide: WorkerStateService, useValue: workers }, { provide: load('audit/audit.service', 'AuditService'), useValue: audit },
    ] })(TestModule);
    app = await createTestApp(TestModule, { logger: false }); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    const url = `${base}/tasks/task/hypotheses/${h.id}/links`;
    const post = (input) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal((await post({ linkType: 'bogus', targetType: 'evidence', targetId: proof.id })).status, 400);
    assert.equal((await post({ linkType: 'supports', targetType: 'evidence', targetId: proof.id, note, evidenceQuotes: [{ evidenceId: proof.id, quote: 'short' }] })).status, 400);
    assert.equal((await post({ linkType: 'supports', targetType: 'evidence', targetId: proof.id, note, evidenceQuotes: [quote] })).status, 201);
    assert.equal((await fetch(`${base}/tasks/other/hypotheses/${h.id}`)).status, 404);
    assert.equal((await fetch(`${base}/tasks/other/evidence/${proof.id}/relations`)).status, 404);
    const reverse = await (await fetch(`${base}/tasks/task/evidence/${proof.id}/relations`)).json();
    assert.ok(reverse.facts.some((f) => f.id === observed.id)); assert.ok(!reverse.facts.some((f) => f.id === separateHost.id));
    assert.ok(reverse.hypotheses.some((v) => v.hypothesis.id === h.id)); assert.ok(!reverse.hypotheses.some((v) => v.hypothesis.id === otherH.id));
    assert.ok(reverse.hypotheses.every((v) => v.links.every((l) => l.targetId === observed.id || l.targetId === proof.id || l.evidenceQuotes.some((q) => q.evidenceId === proof.id))));
    assert.deepEqual(reverse.findings.map((f) => f.id).sort(), ['baseline-finding', 'verification-finding']);
    assert.deepEqual(reverse.findings.find((f) => f.id === 'verification-finding').verificationIds, ['reverse-verification']);
    const goals = new (load('blackboard/task-goals.service', 'TaskGoalsService'))(repo(E.TaskEntity), findings);
    const reports = new (load('reports/reports.service', 'ReportsService'))(repo(E.ReportEntity), goals, graph);
    const report = await reports.generate('task'); const frozen = await reports.export('task', report.id);
    const frozenText = JSON.stringify(frozen.snapshot.hypotheses);
    assert.ok(frozen.snapshot.hypotheses.some((v) => v.hypothesis.id === h.id && v.hypothesis.conflicted));
    assert.ok(report.content.includes('假设与依据快照')); assert.ok(report.content.includes(quote.quote));
    await repo(E.HypothesisEntity).update(h.id, { description: '后续修改，不得改变旧报告' });
    await repo(E.HypothesisLinkEntity).update('legacy-link', { note: '后续修改关系说明' });
    assert.equal(JSON.stringify((await reports.export('task', report.id)).snapshot.hypotheses), frozenText);
    if (process.env.HYPOTHESIS_PDF_QA_PATH) {
      // 小型中文报告专门验证新章节分页，仍由真实报告快照服务和运行时 PDF 渲染器生成。
      await repo(E.TaskEntity).save({ id: 'pdf-task', name: '假设依据与原文报告', status: 'stopped', scope: { cidrs: ['192.168.56.0/24'] }, modelProvider: 'fixture', modelName: 'fixture', startedAt: old });
      await repo(E.AgentSessionEntity).save({ id: 'pdf-session', taskId: 'pdf-task', role: 'explore', modelName: 'fixture', sessionKey: 'pdf-session', state: 'completed' });
      const pdfH = await graph.create({ taskId: 'pdf-task', title: '备份资源访问控制', description: '两次观测得到不同响应，保留原文及解释，等待独立验证。', targetIp: a });
      for (const [direction, text] of [['supports', `HTTP/1.1 200 OK\n${a} 备份资源返回测试内容。`], ['contradicts', `HTTP/1.1 403 Forbidden\n${a} 访问备份资源需要认证。`]]) {
        const source = await evidence(text, a, 'pdf-task', { target: a }, 'pdf-session');
        await graph.link(pdfH.id, direction, 'evidence', source.id, 'pdf-task', direction === 'supports' ? '此响应提供公开可读的研究线索，但仍需复核访问条件。' : '此响应与先前观测冲突，需要核查认证状态和请求差异。', { evidenceQuotes: [{ evidenceId: source.id, quote: text }] });
      }
      const qa = await reports.generate('pdf-task');
      const bytes = await load('reports/report-pdf', 'renderReportPdf')(qa.content, '假设依据报告');
      require('node:fs').writeFileSync(process.env.HYPOTHESIS_PDF_QA_PATH, bytes);
    }
    const { HypothesisQuotes1793577605000 } = require('../apps/api/dist/database/migrations/1793577605000-HypothesisQuotes');
    await assert.rejects(new HypothesisQuotes1793577605000().down(db.createQueryRunner()), /引用数据非空/);
    console.log('PASS: scoped exact quoted relations, target-aware fact/hypothesis deduplication, conflicts and source hash deduplication, corruption/args/scope/freshness recertification, legacy isolation, CIDR source targets, real Worker finalization without blanket links, explicit fact merge relationships, scoped reverse evidence HTTP and migration rollback protection');
  } finally { if (app) await app.close(); await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
