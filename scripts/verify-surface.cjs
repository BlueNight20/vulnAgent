const createTestApp = require('./create-test-app.cjs');
const backendRequire = require('./backend-require.cjs');
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { DataSource } = backendRequire('typeorm');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const { FactsService } = require('../apps/api/dist/modules/blackboard/facts.service');
const { EvidenceIngestionService } = require('../apps/api/dist/modules/blackboard/evidence-ingestion.service');
const { AttackSurfaceService } = require('../apps/api/dist/modules/blackboard/attack-surface.service');
const { AttackSurfaceController } = require('../apps/api/dist/modules/blackboard/attack-surface.controller');
const { PlannerRunnerService } = require('../apps/api/dist/modules/orchestrator/planner-runner.service');
const { IntentsService } = require('../apps/api/dist/modules/blackboard/intents.service');
const { buildWorkerTaskPrompt } = require('../apps/api/dist/modules/worker-skills/prompt-builder');
const { admitIntents } = require('../apps/api/dist/modules/orchestrator/intent-admission');

async function main() {
  const db = await new DataSource(sqliteOptions(':memory:')).initialize();
  try {
    await db.runMigrations();
    const repo = (e) => db.getRepository(e);
    const gateway = { broadcast() {} };
    const facts = new FactsService(repo(E.FactEntity), repo(E.HypothesisLinkEntity), gateway);
    const ingestion = new EvidenceIngestionService(repo(E.EvidenceEntity), facts);
    const service = new AttackSurfaceService(repo(E.FactEntity));
    await repo(E.TaskEntity).save({ id: 'task', name: 'surface fixture', scope: { cidrs: ['192.168.56.0/24'], ports: null }, modelProvider: 'test', modelName: 'test' });
    await repo(E.TargetEntity).save({ id: 'configured', taskId: 'task', ip: '192.168.56.101', kind: 'host', inScope: true });
    const predicted = await facts.create({ taskId: 'task', category: 'service', subject: '192.168.56.101:80/tcp', predicate: 'has_open_port', object: '80/tcp http Apache httpd 2.4.29', status: 'inferred', confidence: 0.4, sourceEvidenceIds: [], createdBy: 'agent', targetIp: '192.168.56.101' });
    const output = 'Nmap scan report for first (192.168.56.101)\nHost is up.\n80/tcp open http Apache httpd 2.4.29\n53/udp open domain\nOS details: Linux 5.x\nNmap scan report for 192.168.56.102\n22/tcp open ssh\nNmap scan report for 10.0.0.1\n443/tcp open https';
    await repo(E.EvidenceEntity).save({ id: 'scan', taskId: 'task', title: 'fixture', kind: 'command_output', content: JSON.stringify({ return_code: 0, stdout: output }),
      sha256: createHash('sha256').update(JSON.stringify({ return_code: 0, stdout: output })).digest('hex'), sizeBytes: Buffer.byteLength(JSON.stringify({ return_code: 0, stdout: output })), meta: { tool: 'nmap_scan', targetIp: '192.168.56.101' } });
    await ingestion.ingest('task', ['scan']);
    const upgraded = await repo(E.FactEntity).findOneByOrFail({ id: predicted.id });
    assert.equal(upgraded.status, 'observed'); assert.equal(upgraded.observationKind, 'target_state', '真实工具确认后不能残留 inference 分类');
    const state = await service.get('task');
    assert.equal(state.assets.length, 3);
    const first = state.assets.find((a) => a.address === '192.168.56.101');
    assert.equal(first.ports.find((p) => p.port === 80).versionObserved, true);
    assert.equal(first.ports.find((p) => p.port === 53).protocol, 'udp');
    assert.ok(first.technologies.some((o) => o.predicate === 'os_fingerprint'));
    const second = state.assets.find((a) => a.address === '192.168.56.102');
    assert.equal(second.inScope, true); assert.equal(second.configured, false);
    assert.ok(second.gaps.some((g) => g.includes('服务版本')));
    assert.equal(state.assets.find((a) => a.address === '10.0.0.1').inScope, false);
    assert.equal(await repo(E.TargetEntity).count(), 1, '被动观测不会增加执行白名单');
    const offered = await new IntentsService(repo(E.IntentEntity), gateway).create({ taskId: 'task', title: '补充服务版本', objective: '补充已有服务的版本证据', workerProfileId: 'service', targetIp: '192.168.56.102', dedupeKey: 'surface-service' });
    const admission = admitIntents([{ ...offered.intent, status: 'proposed' }], { authorizedIps: ['192.168.56.101'], authorizedCidrs: ['192.168.56.0/24'], existingDedupeKeys: new Set(), satisfiedIntentIds: new Set(), allowedTools: new Set(), catalogTools: new Set() });
    assert.equal(admission.accepted.length, 1);
    const graph = new (require('../apps/api/dist/modules/blackboard/hypothesis.service').HypothesisService)(repo(E.HypothesisEntity), repo(E.HypothesisLinkEntity), gateway);
    const planner = new PlannerRunnerService(repo(E.FactEntity), repo(E.HypothesisEntity), repo(E.IntentEntity), repo(E.WorkerTaskEntity), repo(E.AgentSessionEntity), service, new (require('../apps/api/dist/modules/blackboard/task-goals.service').TaskGoalsService)(repo(E.TaskEntity), {}), graph);
    const prompt = await planner.buildPrompt({ taskId: 'task', taskName: 'fixture', targetIps: ['192.168.56.101'], scopeCidrs: ['192.168.56.0/24'], tokenBudget: 10000, tokensUsed: 0, timeBudgetMinutes: 10, elapsedMinutes: 0, availableProfiles: ['service'], availableTools: [], hints: [] });
    assert.ok(prompt.includes('资产与信息缺口'));
    assert.ok(prompt.includes('10.0.0.1 [范围外，仅供观察]'));
    const workerPrompt = buildWorkerTaskPrompt(offered.intent, [], [], [], [], await service.summary('task'));
    assert.ok(workerPrompt.includes('192.168.56.102')); assert.ok(workerPrompt.includes('缺少明确服务版本'));
    const { Module } = backendRequire('@nestjs/common'); const { NestFactory } = backendRequire('@nestjs/core');
    class TestModule {}
    Module({ controllers: [AttackSurfaceController], providers: [{ provide: AttackSurfaceService, useValue: service }] })(TestModule);
    const app = await createTestApp(TestModule, { logger: false });
    try {
      app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1');
      const response = await fetch(`${await app.getUrl()}/api/tasks/task/attack-surface`);
      assert.equal(response.status, 200); assert.equal((await response.json()).assets.length, 3);
      assert.equal((await fetch(`${await app.getUrl()}/api/tasks/missing/attack-surface`)).status, 404);
    } finally { await app.close(); }
    await repo(E.EvidenceEntity).update({ id: 'scan' }, { content: 'tampered' });
    const damaged = await service.get('task');
    assert.ok(damaged.assets.every((a) => a.ports.length === 0));
    console.log('PASS: real migrated DB, JSON/multi-host ingestion, TCP/UDP, version gaps, passive scope separation, no whitelist expansion, CIDR intent admission, Planner/Worker context, HTTP routes and corrupt evidence exclusion');
  } finally { await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
