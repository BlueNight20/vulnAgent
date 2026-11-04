const D = require('better-sqlite3');
const db = new D('c:/Users/20396/Desktop/11/apps/api/storage/vulnagent.sqlite', { readonly: true });
const t = 'c20791e0-c376-4514-a5ed-9c11937bd12c';

const schema = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('orchestrator_runs','agent_sessions')").all();
for (const row of schema) console.log('=== ' + row.name + ' ===\n' + row.sql);

console.log('\n=== runs ===');
console.log(JSON.stringify(db.prepare('SELECT * FROM orchestrator_runs WHERE taskId = ? ORDER BY startedAt DESC LIMIT 5').all(t), null, 1));

console.log('\n=== audit ===');
console.log(JSON.stringify(db.prepare('SELECT action, result, detail, createdAt FROM audit_logs WHERE taskId = ? ORDER BY createdAt DESC LIMIT 12').all(t), null, 1));

console.log('\n=== sessions ===');
console.log(JSON.stringify(db.prepare('SELECT id, role, state, modelName, createdAt FROM agent_sessions WHERE taskId = ? ORDER BY createdAt DESC LIMIT 5').all(t), null, 1));
