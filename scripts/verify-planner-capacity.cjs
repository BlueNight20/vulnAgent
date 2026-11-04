const backendRequire = require('./backend-require.cjs');
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const { DataSource } = backendRequire('typeorm');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const E = require('../apps/api/dist/database/entities');
const { OrchestratorCycleService } = require('../apps/api/dist/modules/orchestrator/orchestrator-cycle.service');
const { IntentsService } = require('../apps/api/dist/modules/blackboard/intents.service');

async function main() {
  const db = await new DataSource(sqliteOptions(':memory:')).initialize();
  try {
    await db.runMigrations();
    const repo = e => db.getRepository(e);
    await repo(E.TaskEntity).save({ id: 'task', name: 'capacity fixture', status: 'running', scope: { cidrs: [] }, workerCount: 2, modelProvider: 'fixture', modelName: 'fixture' });
    const intents = new IntentsService(repo(E.IntentEntity), { broadcast() {} });
    const cycle = Object.create(OrchestratorCycleService.prototype);
    const createdHypotheses = [];
    Object.assign(cycle, {
      tasks: repo(E.TaskEntity), intentRepo: repo(E.IntentEntity), intents,
      orchestrator: { findTask: id => repo(E.TaskEntity).findOneByOrFail({ id }) },
      hypotheses: { create: async input => { createdHypotheses.push(input.title); return { id: input.title }; }, link: async () => {} },
      evaluateWithEvidence: async () => ({ finish: false }), logger: { warn() {}, log() {} },
    });
    const ctx = { cycle: 1, plannerSessionId: null, planningCount: 0 };
    const proposed = Array.from({ length: 71 }, (_, index) => ({ title: `direction-${index}`, objective: `check-${index}`, hypothesis: '', rationale: '', priority: index, workerProfileId: 'recon', suggestedTools: [], expectedEvidence: [], targetIp: null, dedupeKey: `key-${index}`, hypothesisRefs: [`h-${index}`] }));
    const parsed = { analysis: '', goalStatus: 'in_progress', intents: proposed, hypotheses: proposed.map((_, index) => ({ key: `h-${index}`, title: `h-${index}`, description: '', targetIp: null, severity: null })) };
    await cycle.applyPlannerOutput('task', ctx, parsed);
    assert.equal(await repo(E.IntentEntity).countBy({ taskId: 'task', status: 'proposed' }), 3, '71 model directions admit only 3');
    assert.deepEqual(createdHypotheses, ['h-68', 'h-69', 'h-70']);
    assert.equal((await repo(E.AuditLogEntity).findOneByOrFail({ action: 'planner.output_limited' })).detail.received, 71);
    // Simulate an old run that predates the admission limit.
    for (let index = 0; index < 68; index++) await intents.create({ ...proposed[index], taskId: 'task' });
    assert.equal(await repo(E.IntentEntity).countBy({ status: 'proposed' }), 71);
    const reviewed = await repo(E.IntentEntity).findOneByOrFail({ dedupeKey: 'key-0' });
    await cycle.applyPlannerOutput('task', ctx, { ...parsed, intents: [], hypotheses: [], intentReviews: [{ id: reviewed.id, action: 'keep', priority: 100, reason: 'new evidence prioritizes this direction' }] });
    assert.equal(await repo(E.IntentEntity).countBy({ status: 'proposed' }), 4);
    assert.equal((await repo(E.IntentEntity).findOneByOrFail({ id: reviewed.id })).status, 'proposed', 'compaction honors new planner priority');
    assert.equal(await repo(E.IntentEntity).countBy({ rejectedReason: 'queue_capacity' }), 67);
    const deferred = await repo(E.IntentEntity).findOneByOrFail({ dedupeKey: 'key-1' });
    await repo(E.IntentEntity).update(reviewed.id, { status: 'done' });
    await cycle.applyPlannerOutput('task', ctx, { ...parsed, hypotheses: [], intents: [proposed[1]] });
    const reopened = await repo(E.IntentEntity).findOneByOrFail({ dedupeKey: 'key-1' });
    assert.equal(reopened.id, deferred.id);
    assert.equal(reopened.status, 'proposed');
    assert.equal(reopened.attemptCount, deferred.attemptCount);
    assert.equal(await repo(E.IntentEntity).count(), 71, 'reconsideration does not duplicate history');
    assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'intent.capacity_reconsidered' }), 1);
    console.log('PASS: real planner admission of 71, hypothesis integrity, historical backlog compaction after review, audit, bounded reopening with stable identity');
  } finally { await db.destroy(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
