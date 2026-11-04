const createTestApp = require('./create-test-app.cjs');
const backendRequire = require('./backend-require.cjs');
// Real services + migrations; all target responses are fixed local fixtures.
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { DataSource } = backendRequire('typeorm');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const load = (path, name) => require(`../apps/api/dist/modules/${path}`)[name];
const ReportsService = load('reports/reports.service', 'ReportsService');
const TaskGoalsService = load('blackboard/task-goals.service', 'TaskGoalsService');
const FindingsService = load('blackboard/findings.service', 'FindingsService');
const FactsService = load('blackboard/facts.service', 'FactsService');
const EvidenceIngestionService = load('blackboard/evidence-ingestion.service', 'EvidenceIngestionService');

async function main() {
  const db = await new DataSource(sqliteOptions(':memory:')).initialize();
  try {
    await db.runMigrations(); const repo = (e) => db.getRepository(e); const target = '192.168.56.101';
    const findings = new FindingsService(repo(E.FindingEntity)); const goals = new TaskGoalsService(repo(E.TaskEntity), findings);
    const graph = new (require('../apps/api/dist/modules/blackboard/hypothesis.service').HypothesisService)(repo(E.HypothesisEntity), repo(E.HypothesisLinkEntity), { broadcast() {} });
    const reports = new ReportsService(repo(E.ReportEntity), goals, graph);
    const facts = new FactsService(repo(E.FactEntity), repo(E.HypothesisLinkEntity), { broadcast() {} });
    const ingestion = new EvidenceIngestionService(repo(E.EvidenceEntity), facts);
    const start = new Date(Date.now() - 60000);
    await repo(E.TaskEntity).save({ id: 'task', name: '中文授权测试报告', scope: { cidrs: [], ports: '80' }, modelProvider: 'fixture', modelName: 'fixture', status: 'paused', startedAt: start, goal: { mode: 'recon', targets: [target], ports: '80', protocol: 'tcp', evidenceText: null, configuredAt: start.toISOString() } });
    await repo(E.TaskEntity).save({ id: 'other', name: 'another task', scope: { cidrs: [] }, modelProvider: 'fixture', modelName: 'fixture' });
    await repo(E.TargetEntity).save({ id: 'target', taskId: 'task', ip: target, kind: 'host', inScope: true });
    async function evidence(content, sessionId = null, tool = 'http_repeater') {
      const id = randomUUID(); const call = randomUUID();
      await repo(E.ToolCallEntity).save({ id: call, taskId: 'task', agentSessionId: sessionId, toolName: tool, targetIp: target, arguments: { target, ports: '80' }, status: 'success', rawOutputRef: id, createdAt: new Date() });
      return repo(E.EvidenceEntity).save({ id, taskId: 'task', agentSessionId: sessionId, toolCallId: call, title: '中文原文 <script>alert(1)</script>', kind: 'command_output', content, sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: Buffer.byteLength(content), meta: { targetIp: target, tool }, createdAt: new Date() });
    }
    const scan = await evidence(`Nmap scan report for ${target}\nHost is up.\n80/tcp open http Apache 2.4.29\nNmap done: 1 IP address (1 host up) scanned`, null, 'nmap_scan');
    await ingestion.ingest('task', [scan.id]);
    const baseline = await evidence('HTTP/1.1 200 OK\nCandidate resource needs independent confirmation.\n' + '中文原始证据🙂\n'.repeat(180) + '\n```\n<script>alert(1)</script>\n````');
    const candidate = await facts.create({ taskId: 'task', category: 'vulnerability', subject: `${target}/backup`, predicate: 'candidate_exposure', object: '候选备份暴露，需要复核', status: 'inferred', confidence: 0.5, createdBy: 'agent', targetIp: target, sourceEvidenceIds: [baseline.id] });
    await findings.captureCandidates('task', [candidate.id]);
    const record = await findings.requestVerification('task', candidate.id);
    const sessionId = randomUUID(); const workerId = randomUUID();
    await repo(E.AgentSessionEntity).save({ id: sessionId, taskId: 'task', role: 'verifier', profileId: 'verification', sessionKey: sessionId, modelName: 'fixture', state: 'completed' });
    await repo(E.WorkerTaskEntity).save({ id: workerId, taskId: 'task', sessionId, intentId: record.intentId, title: '独立验证', profileId: 'verification', status: 'succeeded' });
    const quote = 'Independent response contains the expected backup marker';
    const proof = await evidence(`HTTP/1.1 200 OK\n${quote}`, sessionId);
    await findings.recordWorkerResult('task', record.intentId, sessionId, workerId, { outcome: 'confirmed', summary: '独立请求确认候选响应标记', evidenceQuotes: [{ evidenceId: proof.id, quote }] });
    await repo(E.IntentEntity).update(record.intentId, { status: 'done' });
    await repo(E.FindingEntity).update(candidate.id, { remediation: '限制备份资源访问，移除公开副本；完成后复测相同请求。' });
    await repo(E.TaskEntity).update('task', { status: 'completed', engineStatus: 'completed', stopReason: 'goal_reached', finishedAt: new Date() });
    const first = await reports.generate('task');
    assert.equal(first.integrity, 'match'); assert.equal(first.stats.kind, 'final'); assert.equal(first.stats.findingCounts.confirmed, 1);
    assert.ok(first.content.includes('限制备份资源访问')); assert.ok(first.content.includes('已确认')); assert.ok(first.content.includes('执行过程时间线'));
    assert.ok(first.content.includes('原文片段已截取')); assert.ok(!first.content.includes('### 中文原文 <script>'));
    assert.ok(first.evidence.every((e) => !('content' in e)), 'detail exposes evidence metadata, not duplicated full source text');
    const exported = await reports.export('task', first.id);
    assert.equal(exported.snapshot.evidence.find((e) => e.id === baseline.id).content, baseline.content, 'attachment is full text, not excerpt');
    assert.ok(exported.snapshot.surface.assets.find((a) => a.address === target).ports.some((p) => p.port === 80));
    assert.equal(exported.snapshot.findings[0].effectiveStatus, 'confirmed');
    assert.equal(exported.snapshot.findings[0].verifications[0].evidenceQuotes[0].quote, quote);
    assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'report.generated', entityId: first.id }), 1);
    // Existing reports remain immutable when the live source changes.
    await repo(E.EvidenceEntity).update(proof.id, { content: 'damaged' });
    await repo(E.TaskEntity).update('task', { name: 'changed task name' });
    assert.equal((await reports.detail('task', first.id)).content, first.content);
    assert.equal((await reports.export('task', first.id)).snapshot.evidence.find((e) => e.id === proof.id).content, proof.content);
    const second = await reports.generate('task');
    assert.equal(second.stats.kind, 'progress'); assert.equal(second.stats.findingCounts.confirmed, 0); assert.equal(second.stats.findingCounts.unconfirmed, 1);
    assert.ok(second.content.includes('报告降为未确认')); assert.equal((await repo(E.FindingEntity).findOneByOrFail({ id: candidate.id })).status, 'confirmed', 'report does not rewrite live finding history');
    await repo(E.FindingEntity).save({ id: 'abandoned', taskId: 'task', title: '失去工作记录的验证', description: 'pending verification without a live intent', status: 'verifying', severity: 'info', source: 'agent', targetIp: target, evidenceIds: [baseline.id] });
    await repo(E.EvidenceEntity).save({ id: 'binary', taskId: 'task', title: 'external file reference', kind: 'file', filePath: 'C:/outside/private.file', content: null });
    const binary = await reports.generate('task'); assert.ok(!binary.content.includes('C:/outside')); assert.equal(binary.stats.invalidEvidenceCount, 2);
    assert.equal(binary.stats.findingCounts.unconfirmed, 2); assert.ok(binary.content.includes('验证工作已结束或丢失'));
    await assert.rejects(() => reports.detail('other', first.id), /报告不存在/);
    await assert.rejects(() => reports.generate('missing'), /任务不存在/);
    // Summaries are bounded/paginated and must not include evidence snapshots.
    for (let i = 0; i < 25; i++) await repo(E.ReportEntity).save({ id: `legacy-${i}`, taskId: 'task', title: 'legacy', format: 'markdown', status: 'draft', content: 'legacy text', stats: null });
    const list = await reports.list('task', 1); assert.equal(list.items.length, 25); assert.equal(list.total, 28);
    assert.equal((await reports.list('task', 2)).items.length, 3); assert.ok(list.items.every((r) => !('content' in r) && !('snapshot' in (r.stats ?? {}))));
    assert.equal((await reports.detail('task', 'legacy-0')).integrity, 'missing');
    await assert.rejects(() => reports.export('task', 'legacy-0'), /完整性/);

    const { Module } = backendRequire('@nestjs/common'); const { NestFactory } = backendRequire('@nestjs/core');
    class TestModule {}
    Module({ controllers: [load('reports/reports.controller', 'ReportsController')], providers: [{ provide: ReportsService, useValue: reports }] })(TestModule);
    const app = await createTestApp(TestModule, { logger: false });
    try {
      await app.listen(0, '127.0.0.1'); const base = `${await app.getUrl()}/tasks/task/reports`;
      const download = (suffix) => fetch(`${base}/${first.id}/${suffix}`);
      assert.equal((await fetch(`${base}?page=0`)).status, 400); assert.equal((await fetch(`${base}?page=abc`)).status, 400);
      assert.equal((await fetch(`${base}/${first.id}/download?format=invalid`)).status, 400);
      assert.equal((await fetch(`${await app.getUrl()}/tasks/other/reports/${first.id}`)).status, 404);
      const md = await download('download?format=markdown'); assert.equal(md.status, 200); assert.equal(await md.text(), first.content);
      assert.ok(md.headers.get('content-disposition').includes('.md')); assert.equal(md.headers.get('cache-control'), 'no-store');
      const attachment = await download(`evidence/${baseline.id}`); assert.equal(await attachment.text(), baseline.content);
      assert.equal((await download('evidence/binary')).status, 404, 'binary appeared after first snapshot');
      const bundle = await download('download?format=evidence'); const json = await bundle.json();
      assert.equal(json.snapshot.evidence.find((e) => e.id === baseline.id).content, baseline.content);
      assert.equal(json.stats.contentSha256, createHash('sha256').update(first.content).digest('hex'));
      const pdf = await download('download?format=pdf'); assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
      const bytes = Buffer.from(await pdf.arrayBuffer()); assert.equal(bytes.subarray(0, 5).toString(), '%PDF-'); assert.ok(bytes.length > 10000);
      const pageCount = [...bytes.toString('latin1').matchAll(/\/Type \/Page\b/g)].length;
      assert.ok(pageCount >= 3 && pageCount <= 8, 'footers must not create extra blank pages');
      if (process.env.REPORT_PDF_QA_PATH) { const fs = require('node:fs'); const path = require('node:path'); fs.mkdirSync(path.dirname(process.env.REPORT_PDF_QA_PATH), { recursive: true }); fs.writeFileSync(process.env.REPORT_PDF_QA_PATH, bytes); }
      const created = await fetch(base, { method: 'POST' }); assert.equal(created.status, 201);
      // Corrupt content, snapshot and summary independently: each must block exports.
      const original = await repo(E.ReportEntity).findOneByOrFail({ id: first.id });
      await repo(E.ReportEntity).update(first.id, { content: 'altered' });
      assert.equal((await reports.detail('task', first.id)).integrity, 'mismatch'); assert.equal((await download('download?format=markdown')).status, 409);
      await repo(E.ReportEntity).update(first.id, { content: original.content });
      const stats = structuredClone(original.stats); stats.snapshot.task.name = 'tampered';
      const row = await repo(E.ReportEntity).findOneByOrFail({ id: first.id }); row.stats = stats; await repo(E.ReportEntity).save(row);
      await assert.rejects(() => reports.export('task', first.id), /完整性/);
      stats.snapshot.task.name = original.stats.snapshot.task.name; stats.summary.findingCounts.confirmed = 100;
      row.stats = stats; await repo(E.ReportEntity).save(row); await assert.rejects(() => reports.export('task', first.id), /完整性/);
    } finally { await app.close(); }
    await assert.rejects(() => load('reports/report-pdf', 'renderReportPdf')('x'.repeat(2 * 1024 * 1024 + 1), 'large'), (error) => error.getStatus() === 413);
    const count = await repo(E.ReportEntity).count();
    await repo(E.EvidenceEntity).save({ id: 'oversize', taskId: 'task', title: 'size boundary', kind: 'note', content: 'x'.repeat(32 * 1024 * 1024 + 1) });
    await assert.rejects(() => reports.generate('task'), (error) => error.getStatus() === 413);
    assert.equal(await repo(E.ReportEntity).count(), count, 'oversized input cannot leave a ready partial report');
    console.log('PASS: migrated reports, real verification certification, immutable source snapshots, complete attachments, source corruption downgrade, Markdown escaping, timeline/assets/remediation, pagination, legacy isolation, audit, validated HTTP and real offline Chinese PDF');
  } finally { await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
