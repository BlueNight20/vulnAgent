const createTestApp = require('./create-test-app.cjs');
const backendRequire = require('./backend-require.cjs');
// This regression exercises an explicitly enabled engine; disabled behavior has its own fixture.
process.env.PI_RUNTIME_ENABLED = 'true';
backendRequire('reflect-metadata');
backendRequire('@nestjs/common').Logger.overrideLogger(['error']);
const assert = require('node:assert/strict');
const { DataSource } = backendRequire('typeorm');
const { unzipSync, strFromU8 } = require('fflate');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const { sha256 } = require('../apps/api/dist/modules/blackboard/attachment-utils');
const load = (path, name) => require(`../apps/api/dist/modules/${path}`)[name];
const { createToolStack } = require('../apps/api/dist/modules/tool/tool-stack');
const { ToolCatalogService } = require('../apps/api/dist/modules/tool/tool-catalog.service');
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const png = Buffer.from(pngBase64, 'base64');
const pcap = Buffer.from('d4c3b2a1020004000000000000000000ffff000001000000', 'hex');

async function main() {
  const db = await new DataSource(sqliteOptions(':memory:')).initialize();
  try {
    await db.runMigrations(); const repo = (e) => db.getRepository(e); const gateway = { broadcast() {} };
    const target = '192.168.56.101'; const taskId = 'attachments';
    for (const id of [taskId, 'other']) await repo(E.TaskEntity).save({ id, name: '附件报告夹具', scope: { cidrs: ['192.168.56.0/24'], ports: null }, modelProvider: 'fixture', modelName: 'fixture' });
    await repo(E.McpServerEntity).save({ id: 'fixture', name: 'no remote access', endpoint: 'http://unused.invalid/mcp' });
    await repo(E.McpToolEntity).save({ id: 'capture', mcpServerId: 'fixture', name: 'capture_fixture', riskLevel: 'safe', inputSchema: { type: 'object', required: ['target'], properties: { target: { type: 'string' } } }, syncedAt: new Date() });
    await repo(E.AgentToolPermissionEntity).save({ id: 'permission', taskId, agentRole: 'explore', toolPattern: '*', allowed: true, requireApproval: false });
    let calls = 0; const variants = new Map();
    let raw = { content: [{ type: 'text', text: '已获取测试输出🙂，附件是原始截图和抓包。' }, { type: 'image', mimeType: 'image/png', data: pngBase64 }, { type: 'resource', resource: { uri: 'file:///remote/capture.pcap', mimeType: 'application/vnd.tcpdump.pcap', blob: pcap.toString('base64') } }, { type: 'resource_link', name: 'external', uri: 'https://unfetched.invalid/source' }] };
    const factory = { async callTool(options) { calls++; return { ok: true, text: '', raw: variants.get(options.arguments.variant) ?? raw, latencyMs: 1, isError: false }; } };
    const stack = createToolStack({
      servers: repo(E.McpServerEntity), tools: repo(E.McpToolEntity), targets: repo(E.TargetEntity), tasks: repo(E.TaskEntity),
      permissions: repo(E.AgentToolPermissionEntity), rules: repo(E.InterceptRuleEntity), calls: repo(E.ToolCallEntity),
      factory, events: gateway, audit: { record: async () => ({}) },
    });
    await new ToolCatalogService(repo(E.McpServerEntity), repo(E.McpToolEntity), stack.registry, stack.driver).sync();
    const ctx = { taskId, sessionId: null, role: 'explore', authorizedTargets: [], allowedTools: ['capture_fixture'] };
    const args = { target };
    /** 执行并落库，返回便于断言的扁平常量。 */
    const run = async (input, context = ctx) => {
      const outcome = await stack.invoker.invoke('capture_fixture', input, context);
      const saved = await stack.recorder.record({ taskId, sessionId: null, role: 'explore', outcome, input });
      return { outcome, saved, evidenceId: saved.evidenceId, toolCallId: saved.toolCallId, ok: !outcome.encoded.isError && !saved.storageError, attachments: outcome.result.content.filter((b) => b.type === 'attachment') };
    };
    const firstRun = await run(args);
    const first = firstRun.outcome;
    assert.equal(firstRun.ok, true, first.encoded.text); assert.equal(firstRun.attachments.length, 2); assert.ok(first.encoded.text.startsWith('已获取'));
    const evidence = await repo(E.EvidenceEntity).findOneByOrFail({ id: firstRun.evidenceId }); assert.equal(evidence.sha256, sha256(evidence.content));
    assert.equal(evidence.toolCallId, firstRun.toolCallId); assert.equal((await repo(E.ToolCallEntity).findOneByOrFail({ id: firstRun.toolCallId })).rawOutputRef, evidence.id);
    const stored = await repo(E.EvidenceAttachmentEntity).findBy({ evidenceId: firstRun.evidenceId });
    const image = stored.find((a) => a.mimeType === 'image/png'); const capture = stored.find((a) => a.filename === 'capture.pcap');
    assert.ok(image && capture, '两张附件都必须落库');
    assert.equal(capture.sha256, sha256(pcap));
    assert.ok((await repo(E.EvidenceAttachmentEntity).find()).every((a) => a.data === undefined), 'normal metadata queries must not hydrate BLOBs');
    assert.equal((await stack.invoker.invoke('capture_fixture', args, ctx)).deduplicated, true); assert.equal(calls, 1);
    await stack.invoker.invoke('capture_fixture', { target, variant: 'mixed-second' }, { ...ctx, forceRerun: true });
    // A dedicated image-only result has no fabricated textual observation.
    raw = { content: [{ type: 'image', data: pngBase64, mimeType: 'image/png' }] };
    const binaryOnly = await run({ target, variant: 'binary-only' });
    const binaryRow = await repo(E.EvidenceEntity).findOneByOrFail({ id: binaryOnly.evidenceId });
    // 纯二进制结果不得凭空编造文本观测：证据正文里只能有附件元数据说明。
    assert.ok(!/^\s*\d+\/tcp/.test(binaryRow.content ?? ''), '不得虚构端口观测');
    assert.equal(binaryRow.kind, 'screenshot');
    assert.equal((await stack.invoker.invoke('capture_fixture', { target, variant: 'binary-only' }, ctx)).deduplicated, true);
    const eCount = await repo(E.EvidenceEntity).count(); const aCount = await repo(E.EvidenceAttachmentEntity).count();
    raw = { content: [{ type: 'image', data: pngBase64, mimeType: 'image/png' }, { type: 'image', data: 'malformed!', mimeType: 'image/png' }] };
    const malformed = await run({ target, variant: 'malformed' }); assert.equal(malformed.ok, false); assert.equal(malformed.evidenceId, null);
    assert.equal(await repo(E.EvidenceEntity).count(), eCount); assert.equal(await repo(E.EvidenceAttachmentEntity).count(), aCount, 'no partially saved tool result');
    await db.query("CREATE TRIGGER fail_attachment BEFORE INSERT ON evidence_attachments WHEN NEW.filename = 'failing.bin' BEGIN SELECT RAISE(ABORT, 'injected attachment storage failure'); END");
    raw = { content: [{ type: 'text', text: 'returned response before local failure' }, { type: 'resource', resource: { uri: 'file:///remote/failing.bin', blob: 'AAECAw==', mimeType: 'application/octet-stream' } }] };
    const failed = await run({ target, variant: 'write-failure' }); assert.equal(failed.ok, false); assert.ok(failed.saved.storageError?.includes('不能当作未执行'));
    assert.equal(await repo(E.EvidenceEntity).count(), eCount); assert.equal(await repo(E.EvidenceAttachmentEntity).count(), aCount);
    variants.set('parallel-write-failure', raw); variants.set('parallel-success', { content: [{ type: 'image', data: pngBase64, mimeType: 'image/png' }] });
    const parallel = await Promise.all(['parallel-write-failure', 'parallel-success'].map((variant) => run({ target, variant })));
    assert.equal(parallel[0].ok, false); assert.equal(parallel[1].ok, true);
    assert.equal(await repo(E.EvidenceEntity).count(), eCount + 1); assert.equal(await repo(E.EvidenceAttachmentEntity).count(), aCount + 1);
    await db.query('DROP TRIGGER fail_attachment');
    const findings = new (load('blackboard/findings.service', 'FindingsService'))(repo(E.FindingEntity));
    const goals = new (load('blackboard/task-goals.service', 'TaskGoalsService'))(repo(E.TaskEntity), findings);
    const ReportsService = load('reports/reports.service', 'ReportsService'); const reports = new ReportsService(repo(E.ReportEntity), goals, new (load('blackboard/hypothesis.service', 'HypothesisService'))(repo(E.HypothesisEntity), repo(E.HypothesisLinkEntity), { broadcast() {} }));
    const report = await reports.generate(taskId); assert.equal(report.integrity, 'match'); assert.equal(report.attachments.length, aCount + 1); assert.ok(report.stats.attachmentBytes > 0);
    assert.ok(report.attachments.every((a) => !('data' in a))); assert.ok(report.content.includes('二进制附件清单'));
    const originalExport = await reports.export(taskId, report.id); assert.equal(originalExport.files.find((a) => a.attachmentId === capture.id).data.equals(pcap), true);
    const { EvidenceAttachments1793577603000 } = require('../apps/api/dist/database/migrations/1793577603000-EvidenceAttachments');
    await assert.rejects(() => new EvidenceAttachments1793577603000().down(db.createQueryRunner()), /附件数据非空/);
    const { Module } = backendRequire('@nestjs/common'); const { NestFactory } = backendRequire('@nestjs/core'); const { getRepositoryToken } = backendRequire('@nestjs/typeorm');
    class TestModule {}
    Module({ controllers: [load('blackboard/evidence-attachments.controller', 'EvidenceAttachmentsController'), load('reports/reports.controller', 'ReportsController')], providers: [{ provide: getRepositoryToken(E.EvidenceAttachmentEntity), useValue: repo(E.EvidenceAttachmentEntity) }, { provide: ReportsService, useValue: reports }] })(TestModule);
    const app = await createTestApp(TestModule, { logger: false });
    try {
      await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
      const attachmentBase = `${base}/tasks/${taskId}/evidence/${evidence.id}/attachments`;
      const reportBase = `${base}/tasks/${taskId}/reports/${report.id}`;
      const listing = await fetch(attachmentBase); assert.equal(listing.status, 200); const metadata = await listing.json();
      assert.equal(metadata.items.length, 2); assert.equal(metadata.references[0].uri, 'https://unfetched.invalid/source'); assert.ok(!JSON.stringify(metadata).includes('dataBase64'));
      const preview = await fetch(`${attachmentBase}/${image.id}/preview`); assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'image/png'); assert.ok(Buffer.from(await preview.arrayBuffer()).equals(png));
      assert.equal((await fetch(`${attachmentBase}/${capture.id}/preview`)).status, 409);
      const download = await fetch(`${attachmentBase}/${capture.id}/download`); assert.equal(download.headers.get('content-type'), 'application/octet-stream'); assert.ok(download.headers.get('content-disposition').startsWith('attachment;')); assert.ok(Buffer.from(await download.arrayBuffer()).equals(pcap));
      assert.equal((await fetch(`${base}/tasks/other/evidence/${evidence.id}/attachments/${capture.id}/download`)).status, 404);
      assert.equal((await fetch(`${base}/tasks/${taskId}/evidence/${binaryRow.id}/attachments/${capture.id}/download`)).status, 404);
      assert.equal((await fetch(`${reportBase}/attachments/not-found`)).status, 404);
      const json = await (await fetch(`${reportBase}/download?format=evidence`)).json(); assert.ok(Buffer.from(json.files.find((a) => a.id === capture.id).dataBase64, 'base64').equals(pcap));
      const zip = await fetch(`${reportBase}/download?format=bundle`); assert.equal(zip.status, 200); assert.equal(zip.headers.get('content-type'), 'application/zip');
      const archive = unzipSync(new Uint8Array(await zip.arrayBuffer())); const manifest = JSON.parse(strFromU8(archive['manifest.json']));
      assert.equal(strFromU8(archive['report.md']), report.content);
      assert.ok(Buffer.from(archive[manifest.files.find((f) => f.id === capture.id).path]).equals(pcap));
      assert.equal(strFromU8(archive[`evidence/${evidence.id}.txt`]), evidence.content);
      assert.ok(Object.keys(archive).every((p) => !p.startsWith('/') && !p.includes('..')), 'archive cannot contain source paths');
      if (process.env.ATTACHMENT_PDF_QA_PATH) { const response = await fetch(`${reportBase}/download?format=pdf`); assert.equal(response.status, 200); const fs = require('node:fs'); const path = require('node:path'); fs.mkdirSync(path.dirname(process.env.ATTACHMENT_PDF_QA_PATH), { recursive: true }); fs.writeFileSync(process.env.ATTACHMENT_PDF_QA_PATH, Buffer.from(await response.arrayBuffer())); }
      // Original source changes never rewrite report attachment copies.
      await repo(E.EvidenceAttachmentEntity).update(capture.id, { data: Buffer.from('damaged source') });
      assert.equal((await fetch(`${attachmentBase}/${capture.id}/download`)).status, 409);
      assert.ok(Buffer.from(await (await fetch(`${reportBase}/attachments/${capture.id}`)).arrayBuffer()).equals(pcap));
      const damagedReport = await reports.generate(taskId); assert.equal(damagedReport.stats.invalidAttachmentCount, 1); assert.equal(damagedReport.integrity, 'match');
      const damagedArchive = unzipSync(new Uint8Array(await (await fetch(`${base}/tasks/${taskId}/reports/${damagedReport.id}/download?format=bundle`)).arrayBuffer()));
      assert.ok(Object.keys(damagedArchive).some((p) => p.startsWith('untrusted-attachments/')));
      // Report-side corruption blocks both archive and single-file exports.
      await repo(E.ReportAttachmentEntity).update({ reportId: report.id, attachmentId: capture.id }, { data: Buffer.from('damaged report copy') });
      assert.equal((await reports.detail(taskId, report.id)).integrity, 'mismatch'); assert.equal((await fetch(`${reportBase}/download?format=bundle`)).status, 409);
      assert.equal((await fetch(`${reportBase}/attachments/${capture.id}`)).status, 409);
      await repo(E.ReportAttachmentEntity).update({ reportId: report.id, attachmentId: capture.id }, { data: pcap });
      // 损坏的缓存附件会强制重新调用工具（forceRerun 跳过去重），不会复用坏数据。
      raw = { content: [{ type: 'image', data: pngBase64, mimeType: 'image/png' }] };
      const before = calls; const fresh = await run({ ...args }, { ...ctx, forceRerun: true });
      assert.equal(fresh.ok, true); assert.equal(calls, before + 1);
      // Original parent deletion cascades only its attachments, not report copies.
      await repo(E.EvidenceEntity).delete(evidence.id); assert.equal(await repo(E.EvidenceAttachmentEntity).countBy({ evidenceId: evidence.id }), 0);
      assert.ok(Buffer.from(await (await fetch(`${reportBase}/attachments/${capture.id}`)).arrayBuffer()).equals(pcap));
    } finally { await app.close(); }
    const beforeReportFailure = await repo(E.ReportEntity).count();
    await db.query("CREATE TRIGGER fail_report_attachment BEFORE INSERT ON report_attachments BEGIN SELECT RAISE(ABORT, 'injected report attachment failure'); END");
    await assert.rejects(() => reports.generate(taskId), /injected report attachment failure/); assert.equal(await repo(E.ReportEntity).count(), beforeReportFailure);
    await db.query('DROP TRIGGER fail_report_attachment');
    const binaryAttachments = await repo(E.EvidenceAttachmentEntity).findBy({ evidenceId: binaryOnly.evidenceId });
    assert.ok(binaryAttachments.length >= 1, '纯二进制结果必须落库一个附件');
    await repo(E.EvidenceAttachmentEntity).delete(binaryAttachments[0].id);
    await assert.rejects(() => reports.generate(taskId), /来源附件已丢失/);
    await db.query('INSERT INTO evidence_attachments (id, taskId, evidenceId, filename, mimeType, sha256, sizeBytes, data) VALUES (?, ?, ?, ?, ?, ?, ?, zeroblob(33554433))', ['size-boundary', taskId, binaryOnly.evidenceId, 'large.bin', 'application/octet-stream', '0'.repeat(64), 33554433]);
    await assert.rejects(() => reports.generate(taskId), (error) => error.getStatus() === 413);
    await repo(E.EvidenceAttachmentEntity).delete('size-boundary');
    // Native SQLite serialization retains BLOB bytes, independent of JS object lifetime.
    const Database = db.options.driver; const clone = new Database(db.driver.databaseConnection.serialize());
    try { assert.ok(clone.prepare('SELECT data FROM report_attachments WHERE reportId = ? AND attachmentId = ?').get(report.id, capture.id).data.equals(pcap)); } finally { clone.close(); }
    console.log('PASS: migrated BLOBs, embedded text/image/resource parsing, exact hashes/bytes, atomic persistence and fault rollback, binary-only cache, attachment corruption rerun, scoped HTTP download/preview, JSON/ZIP complete contents, immutable report copies, corruption and loss handling, parent cascade and native SQLite durability');
  } finally { await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
