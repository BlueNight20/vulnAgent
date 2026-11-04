const backendRequire = require('./backend-require.cjs');
// This regression exercises an explicitly enabled engine; disabled behavior has its own fixture.
process.env.PI_RUNTIME_ENABLED = 'true';
// Real migrated SQLite, bootstrap, health, policy executor and MCP SDK; fixed loopback protocol only.
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { randomUUID } = require('node:crypto'); const { spawnSync } = require('node:child_process');
const express = backendRequire('express'); const { DataSource } = backendRequire('typeorm');
const { Server } = backendRequire('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = backendRequire('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = backendRequire('@modelcontextprotocol/sdk/types.js');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const { configuredCipher, readStoredHeaders } = require('../apps/api/dist/common/crypto/mcp-header-secrets');
const { upgradeStoredSecrets } = require('../apps/api/dist/modules/mcp/stored-secret-upgrade');
const { McpBootstrapService } = require('../apps/api/dist/modules/mcp/mcp-bootstrap.service');
const { McpClientFactory } = require('../apps/api/dist/modules/mcp/mcp-client.factory');
const { McpHealthService } = require('../apps/api/dist/modules/mcp/mcp-health.service');
const { McpServersService } = require('../apps/api/dist/modules/mcp/mcp-servers.service');
const { createToolStack } = require('../apps/api/dist/modules/tool/tool-stack');
const { ToolCatalogService } = require('../apps/api/dist/modules/tool/tool-catalog.service');
const configuration = require('../apps/api/dist/config/configuration').default;
const headers = { Authorization: 'Bearer fixture-mcp-token', 'X-Unusual-Credential': 'fixture-custom-token' };

async function main() {
  if (process.argv[2] === '--read') {
    const db = await new DataSource(sqliteOptions(process.argv[3])).initialize();
    try { process.stdout.write(JSON.stringify(readStoredHeaders(await db.getRepository(E.McpServerEntity).findOneByOrFail({ id: 'legacy' }), { encryptionKey: '', encryptionKeyFile: process.argv[4] }))); }
    finally { await db.destroy(); } return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnagent-mcp-secrets-'));
  const file = path.join(directory, 'secrets.sqlite'); const security = { encryptionKey: '', encryptionKeyFile: `${file}.key` };
  const oldSpecs = process.env.MCP_SERVERS;
  const db = await new DataSource(sqliteOptions(file)).initialize();
  let http; let factory; const servers = new Set(); const sessions = new Map(); const captures = []; const errors = []; const logs = [];
  let expected = { ...headers }; let initializes = 0; let calls = 0;
  try {
    await db.runMigrations(); const repo = (entity) => db.getRepository(entity);
    const app = express(); app.use(express.json());
    app.all('/mcp', async (req, res) => {
      try {
        captures.push({ authorization: req.headers.authorization, custom: req.headers['x-unusual-credential'] });
        assert.equal(req.headers.authorization, expected.Authorization); assert.equal(req.headers['x-unusual-credential'], expected['X-Unusual-Credential']);
        let transport = sessions.get(req.headers['mcp-session-id']);
        if (!transport && req.method === 'POST' && req.body?.method === 'initialize') {
          initializes++; const server = new Server({ name: 'secret-protocol-fixture', version: '1' }, { capabilities: { tools: {} } }); servers.add(server);
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true, onsessioninitialized(id) { sessions.set(id, transport); } });
          server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'fixture_observe', description: 'Fixed text only', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } }] }));
          server.setRequestHandler(CallToolRequestSchema, async () => { calls++; return { content: [{ type: 'text', text: 'fixed local protocol result; no target was contacted' }] }; });
          await server.connect(transport);
        }
        if (!transport) { res.status(400).end(); return; }
        await transport.handleRequest(req, res, req.body);
      } catch (error) { errors.push(error); if (!res.headersSent) res.status(500).end(); }
    });
    app.all('/reject', (req, res) => { captures.push({ rejected: true }); res.status(401).send(`fixture denied ${req.headers.authorization} ${req.headers['x-unusual-credential']}`); });
    http = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    const endpoint = `http://127.0.0.1:${http.address().port}/mcp`;
    await repo(E.McpServerEntity).save({ id: 'legacy', name: 'legacy-fixture', endpoint, headers });
    await repo(E.SystemSettingEntity).save({ key: 'model.apiKey', value: 'fixture-legacy-model', encrypted: false });
    await db.query("CREATE TRIGGER fail_secret_upgrade BEFORE INSERT ON audit_logs WHEN NEW.action = 'security.secrets_upgraded' BEGIN SELECT RAISE(FAIL, 'injected upgrade audit failure'); END");
    await assert.rejects(upgradeStoredSecrets(db.manager, security), /injected upgrade audit failure/);
    assert.deepEqual((await repo(E.McpServerEntity).findOneByOrFail({ id: 'legacy' })).headers, headers);
    assert.equal((await repo(E.SystemSettingEntity).findOneByOrFail({ key: 'model.apiKey' })).encrypted, false);
    await db.query('DROP TRIGGER fail_secret_upgrade');
    await upgradeStoredSecrets(db.manager, security);
    const encrypted = await repo(E.McpServerEntity).findOneByOrFail({ id: 'legacy' });
    assert.equal(encrypted.headers, null); assert.ok(encrypted.headersEncrypted.startsWith('v1:'));
    assert.ok(!JSON.stringify(encrypted).includes('fixture-mcp-token')); assert.deepEqual(readStoredHeaders(encrypted, security), headers);
    assert.equal((await repo(E.SystemSettingEntity).findOneByOrFail({ key: 'model.apiKey' })).encrypted, true);
    await upgradeStoredSecrets(db.manager, security); assert.equal(await repo(E.AuditLogEntity).countBy({ action: 'security.secrets_upgraded' }), 1);
    const child = spawnSync(process.execPath, [__filename, '--read', file, security.encryptionKeyFile], { encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), headers);

    const cfg = configuration(); cfg.security = security;
    cfg.mcp = { ...cfg.mcp, gatewayName: 'env-gateway', gatewayUrl: endpoint, gatewayHeaders: JSON.stringify(headers), healthTimeoutMs: 1500, healthTimeoutMaxMs: 2000 };
    const config = { get: (key) => cfg[key] };
    process.env.MCP_SERVERS = JSON.stringify([{ name: 'unrelated', endpoint: 'http://unused.invalid/mcp', enabled: false }]);
    const bootstrap = new McpBootstrapService(repo(E.McpServerEntity), repo(E.AgentToolPermissionEntity), config);
    await bootstrap.onApplicationBootstrap();
    assert.equal((await repo(E.McpServerEntity).findOneByOrFail({ name: 'unrelated' })).headersEncrypted, null);
    const imported = await repo(E.McpServerEntity).findOneByOrFail({ name: 'env-gateway' }); assert.equal(imported.headers, null); assert.deepEqual(readStoredHeaders(imported, security), headers);
    factory = new McpClientFactory(config); factory.logger.warn = (message) => logs.push(message);
    const events = { broadcast() {} }; const audit = { record: async () => {} };
    const health = new McpHealthService(repo(E.McpServerEntity), repo(E.McpToolEntity), factory, config, audit, events);
    assert.equal((await health.check('legacy', true)).status, 'online');
    const service = new McpServersService(repo(E.McpServerEntity), repo(E.McpToolEntity), health);
    const dto = await service.findOne('legacy'); assert.equal(dto.headersMasked, '已加密保存请求头'); assert.ok(!JSON.stringify(dto).includes('fixture-custom-token'));
    assert.ok(!JSON.stringify(service.toDto({ ...encrypted, headersEncrypted: null, headers })).includes('fixture-custom-token'));
    await repo(E.TaskEntity).save({ id: 'secret-task', name: 'secret fixture task', modelName: 'fixture', modelProvider: 'fixture', scope: { cidrs: ['192.168.56.0/24'] } });
    await repo(E.AgentToolPermissionEntity).save({ id: 'fixture-permission', taskId: 'secret-task', agentRole: 'explore', toolPattern: 'fixture_observe', allowed: true, requireApproval: false });
    await repo(E.McpToolEntity).update({ name: 'fixture_observe' }, { riskLevel: 'read_only' });
    const stack = createToolStack({
      servers: repo(E.McpServerEntity), tools: repo(E.McpToolEntity), targets: repo(E.TargetEntity), tasks: repo(E.TaskEntity),
      permissions: repo(E.AgentToolPermissionEntity), rules: repo(E.InterceptRuleEntity), calls: repo(E.ToolCallEntity),
      events, audit: { record: async () => ({}) }, factory,
    });
    await new ToolCatalogService(repo(E.McpServerEntity), repo(E.McpToolEntity), stack.registry, stack.driver).sync();
    const ctx = { taskId: 'secret-task', sessionId: null, role: 'explore', allowedTools: [], authorizedTargets: [], forceRerun: true };
    const observe = (context = ctx) => stack.invoker.invoke('fixture_observe', { target: '192.168.56.101' }, context);
    const result = await observe(); assert.equal(result.failureKind, null, result.encoded.text); assert.equal(calls, 1);
    const beforeRotation = initializes;
    expected = { ...headers, Authorization: 'Bearer fixture-rotated-token' };
    await repo(E.McpServerEntity).update('legacy', { headersEncrypted: configuredCipher(security).encrypt(JSON.stringify(expected)) });
    assert.equal((await observe()).failureKind, null); assert.equal(initializes, beforeRotation + 1);
    assert.ok(!Array.from(factory.pool.keys()).join().includes('fixture-rotated-token'));

    // A concurrent health result must not overwrite credentials changed while the probe was in flight.
    let releaseProbe; let probeStarted;
    const started = new Promise((resolve) => { probeStarted = resolve; });
    const heldHealth = new McpHealthService(repo(E.McpServerEntity), repo(E.McpToolEntity), {
      probe: async () => { probeStarted(); await new Promise((resolve) => { releaseProbe = resolve; }); return { ok: false, error: 'fixed held probe failure', latencyMs: 1 }; },
    }, config, audit, events);
    const pendingHealth = heldHealth.check('legacy', true); await started;
    const freshCipher = configuredCipher(security).encrypt(JSON.stringify(expected));
    await repo(E.McpServerEntity).update('legacy', { headersEncrypted: freshCipher }); releaseProbe(); await pendingHealth;
    assert.equal((await repo(E.McpServerEntity).findOneByOrFail({ id: 'legacy' })).headersEncrypted, freshCipher);

    await repo(E.McpServerEntity).update('legacy', { headersEncrypted: 'corrupt' }); const beforeBroken = captures.length;
    const broken = await observe({ ...ctx, forceRerun: true }); assert.equal(broken.encoded.isError === true || broken.failureKind !== null, true); assert.match(broken.encoded.text, /无法解密/); assert.equal(captures.length, beforeBroken);
    assert.equal((await health.check('legacy', true)).status, 'unreachable'); assert.equal(captures.length, beforeBroken);
    await repo(E.SystemSettingEntity).update('model.apiKey', { value: 'fixture-remains-plain-on-failure', encrypted: false });
    await assert.rejects(upgradeStoredSecrets(db.manager, security), /无法解密/); assert.equal((await repo(E.SystemSettingEntity).findOneByOrFail({ key: 'model.apiKey' })).encrypted, false);
    const rejected = await factory.probe({ endpoint: endpoint.replace('/mcp', '/reject'), transport: 'streamable-http', timeoutMs: 1000, headers: expected });
    assert.equal(rejected.ok, false); assert.ok(!JSON.stringify([rejected, logs]).includes('fixture-rotated-token')); assert.ok(!JSON.stringify([rejected, logs]).includes('fixture-custom-token'));
    const { McpHeaderSecrets1793577607000 } = require('../apps/api/dist/database/migrations/1793577607000-McpHeaderSecrets');
    await assert.rejects(new McpHeaderSecrets1793577607000().down(db.createQueryRunner()), /非空/);
    assert.deepEqual(errors, []);
    console.log('PASS: atomic plaintext/model upgrade and audit rollback, ciphertext restart, isolated gateway credentials, masked custom headers, real SDK health and policy execution, key rotation/pool isolation, corrupt-key no-request and no upgrade fallback, error redaction and nonempty migration rollback refusal');
  } finally {
    if (oldSpecs === undefined) delete process.env.MCP_SERVERS; else process.env.MCP_SERVERS = oldSpecs;
    if (factory) await factory.closeAllSessions();
    await Promise.all([...servers].map((server) => server.close().catch(() => {})));
    if (http) { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); }
    await db.destroy(); const target = path.resolve(directory); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('vulnagent-mcp-secrets-')); fs.rmSync(target, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
