const backendRequire = require('./backend-require.cjs');
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { DataSource } = backendRequire('typeorm');
const { Module, ValidationPipe } = backendRequire('@nestjs/common');
const createTestApp = require('./create-test-app.cjs');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const load = (path, name) => require(`../apps/api/dist/modules/${path}`)[name];
const FindingsService = load('blackboard/findings.service', 'FindingsService');
const FindingsController = load('blackboard/findings.controller', 'FindingsController');
const ReportsService = load('reports/reports.service', 'ReportsService');
const TaskGoalsService = load('blackboard/task-goals.service', 'TaskGoalsService');
const HypothesisService = load('blackboard/hypothesis.service', 'HypothesisService');

async function main() {
  // Only migrated in-memory storage and HTTP loopback; no model, MCP or target connection.
  const db = await new DataSource(sqliteOptions(':memory:')).initialize();
  let app;
  try {
    await db.runMigrations(); const repo = (entity) => db.getRepository(entity); const target = '192.0.2.10';
    for (const id of ['task', 'other']) await repo(E.TaskEntity).save({ id, name: '人工维护集成夹具', scope: { cidrs: [] }, modelProvider: 'fixture', modelName: 'fixture', status: 'paused' });
    await repo(E.TargetEntity).save({ id: 'target', taskId: 'task', ip: target, kind: 'host', inScope: true });
    const findings = new FindingsService(repo(E.FindingEntity));
    const reports = new ReportsService(repo(E.ReportEntity), new TaskGoalsService(repo(E.TaskEntity), findings), new HypothesisService(repo(E.HypothesisEntity), repo(E.HypothesisLinkEntity), { broadcast() {} }));
    async function evidence(content, overrides = {}, callOverrides = {}) {
      const id = randomUUID(); const call = randomUUID();
      await repo(E.ToolCallEntity).save({ id: call, taskId: 'task', agentSessionId: null, toolName: 'http_repeater', targetIp: target, arguments: { target }, status: 'success', rawOutputRef: id, ...callOverrides });
      return repo(E.EvidenceEntity).save({ id, taskId: 'task', agentSessionId: null, toolCallId: call, title: '固定原文', kind: 'http_response', content, sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: Buffer.byteLength(content), meta: { tool: 'http_repeater', targetIp: target }, ...overrides });
    }
    const text = 'HTTP/1.1 200 OK\nObserved fixture backup marker; CVE-2026-12345 CWE-200. 中文🙂';
    const proof = await evidence(text);
    const referenceText = 'Fixture advisory references CVE-2026-12345 and CWE-200 for manual review.';
    const reference = await evidence(referenceText, { meta: { tool: 'search_exploits' } }, { toolName: 'search_exploits', targetIp: null, arguments: { query: 'fixture' } });
    await repo(E.FindingEntity).save({ id: 'finding', taskId: 'task', title: '初始候选', description: '原始发现，等待独立验证', severity: 'info', source: 'agent', status: 'candidate', targetIp: target, evidenceIds: [proof.id] });
    assert.equal((await findings.detail('task', 'finding')).finding.assessment, null);
    const originalReport = await reports.generate('task');
    class TestModule {}
    Module({ controllers: [FindingsController], providers: [{ provide: FindingsService, useValue: findings }] })(TestModule);
    app = await createTestApp(TestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0, '127.0.0.1'); const base = `${await app.getUrl()}/tasks/task/findings/finding`;
    const payload = { expectedRevision: 0, title: '人工核对的资源暴露', description: '根据固定协议原文评估，仅为本地测试数据。', severity: 'high', cve: 'cve-2026-12345', cwe: 'cwe-200', cvss: 7.5, remediation: '限制资源访问并由操作者复测。', note: '人工核对适用性；CVSS 版本、向量及理由由操作者填写。', evidenceQuotes: [{ evidenceId: proof.id, quote: text }] };
    const put = (body, url = base) => fetch(`${url}/assessment`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    async function invalid(body, status = 400) { const response = await put(body); assert.equal(response.status, status, await response.text()); }
    for (const patch of [{ cvss: 10.1 }, { cvss: '7.5' }, { severity: 'severe' }, { expectedRevision: -1 }, { evidenceQuotes: [] }, { evidenceQuotes: [null] }, { note: '        ' }, { title: '  ' }, { description: '        ' }, { cve: 'CVE-bad' }, { cve: 'CVE-2026-1234' }, { cwe: 'CWE-20' }, { cve: 'CVE-2026-99999' }]) await invalid({ ...payload, ...patch });
    await invalid({ ...payload, evidenceQuotes: [{ evidenceId: reference.id, quote: referenceText }] });
    await invalid({ ...payload, evidenceQuotes: [{ evidenceId: proof.id, quote: 'not present in actual response' }] });
    const badFixtures = [
      await evidence(text, { sha256: 'bad' }), await evidence(text, { sizeBytes: 1 }),
      await evidence(text, { agentSessionId: 'different-session' }), await evidence(text, { taskId: 'other' }),
      await evidence(text, {}, { status: 'failed' }), await evidence(text, {}, { targetIp: '192.0.2.11', arguments: { target: '192.0.2.11' } }),
      await evidence(text, { meta: { tool: 'unrelated_tool', targetIp: target } }), await evidence(text, {}, { rawOutputRef: 'wrong-evidence' }),
      await evidence('Error: connection refused CVE-2026-12345 CWE-200'),
    ];
    for (const row of badFixtures) await invalid({ ...payload, evidenceQuotes: [{ evidenceId: row.id, quote: row.content }] });
    const cross = await put(payload, `${await app.getUrl()}/tasks/other/findings/finding`); assert.equal(cross.status, 404);
    assert.equal(await repo(E.FindingAssessmentEntity).count(), 0);
    // Two clients use the same revision: exactly one edit is committed.
    const concurrent = await Promise.all([put({ ...payload, status: 'confirmed' }), put(payload)]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
    const first = await concurrent.find((r) => r.status === 200).json();
    assert.equal(first.revision, 1); assert.equal(first.valid, true); assert.equal(first.metadata.cve, 'CVE-2026-12345');
    assert.equal(first.previousMetadata.title, '初始候选');
    let current = await findings.detail('task', 'finding');
    assert.equal(current.finding.status, 'candidate', 'metadata edit must not confirm the candidate');
    assert.deepEqual(current.finding.evidenceIds, [proof.id]); assert.equal(current.finding.source, 'manual');
    assert.equal((await repo(E.FindingEntity).findOneByOrFail({ id: 'finding' })).source, 'agent', 'original provenance remains persisted');
    assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'finding.assessed' }), 1);
    const assessedReport = await reports.generate('task');
    const frozen = await reports.export('task', assessedReport.id);
    assert.equal(frozen.snapshot.findings[0].finding.assessment.revision, 1);
    assert.equal(frozen.snapshot.findings[0].finding.cvss, 7.5);
    assert.ok(assessedReport.content.includes(payload.note));
    assert.equal((await reports.detail('task', originalReport.id)).content, originalReport.content);
    // Audit failure must roll back metadata, history and revision together.
    await db.query("CREATE TRIGGER fixture_assessment_audit BEFORE INSERT ON audit_logs WHEN NEW.action='finding.assessed' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
    await invalid({ ...payload, expectedRevision: 1, title: '必须回滚的修改' }, 500);
    assert.equal((await findings.detail('task', 'finding')).finding.metadataRevision, 1);
    assert.equal(await repo(E.FindingAssessmentEntity).count(), 1);
    await db.query('DROP TRIGGER fixture_assessment_audit');
    const clear = await put({ ...payload, expectedRevision: 1, cve: null, cwe: null, cvss: null, remediation: null, evidenceQuotes: [{ evidenceId: proof.id, quote: 'Observed fixture backup marker;' }, { evidenceId: reference.id, quote: referenceText }] });
    assert.equal(clear.status, 200, await clear.clone().text());
    assert.equal((await clear.json()).previousMetadata.cve, 'CVE-2026-12345');
    let history = await (await fetch(`${base}/assessments`)).json();
    assert.equal(history.total, 2); assert.deepEqual(history.items.map((r) => r.revision), [2, 1]);
    assert.equal((await fetch(`${base}/assessments?page=bad`)).status, 400);
    await assert.rejects(() => new (require('../apps/api/dist/database/migrations/1793577608000-FindingAssessments').FindingAssessments1793577608000)().down(db.createQueryRunner()), /维护历史非空/);
    // Restore nonempty assessed fields, then corrupt their source. Read paths must fail closed.
    const third = await put({ ...payload, expectedRevision: 2 }); assert.equal(third.status, 200);
    await repo(E.EvidenceEntity).update(proof.id, { content: 'damaged' });
    current = await (await fetch(base)).json();
    assert.equal(current.finding.assessment.valid, false);
    assert.equal(current.finding.severity, 'info');
    for (const field of ['cve', 'cwe', 'cvss', 'remediation']) assert.equal(current.finding[field], null);
    assert.equal(current.finding.assessment.metadata.cve, 'CVE-2026-12345', 'history retains the original assessment');
    const tampered = await reports.export('task', (await reports.generate('task')).id);
    assert.equal(tampered.snapshot.findings[0].finding.assessment.valid, false);
    assert.equal(tampered.snapshot.findings[0].finding.cve, null);
    assert.ok(tampered.snapshot.warnings.some((w) => w.includes('维护')));
    assert.equal((await reports.export('task', assessedReport.id)).snapshot.findings[0].finding.assessment.valid, true, 'old report remains frozen');
    history = await findings.assessments('task', 'finding'); assert.ok(history.items.every((r) => !r.valid));
    await repo(E.TaskEntity).delete('task');
    assert.equal(await repo(E.FindingAssessmentEntity).count(), 0, 'task deletion includes assessment history');
    assert.equal(await repo(E.TaskEntity).countBy({ id: 'other' }), 1);
    console.log('PASS: real HTTP metadata validation, exact target/source/quote checks, CAS 409, status isolation, immutable before/after history, audit rollback, report freezing and invalid-source suppression, migration rollback protection and task cleanup');
  } finally { if (app) await app.close(); await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
