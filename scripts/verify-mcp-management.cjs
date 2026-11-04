const backendRequire = require('./backend-require.cjs');
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const { DataSource } = backendRequire('typeorm');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const E = require('../apps/api/dist/database/entities');
const { AuditService } = require('../apps/api/dist/modules/audit/audit.service');
const { McpServersService } = require('../apps/api/dist/modules/mcp/mcp-servers.service');
const { McpHealthService } = require('../apps/api/dist/modules/mcp/mcp-health.service');
const { configuredCipher, readStoredHeaders } = require('../apps/api/dist/common/crypto/mcp-header-secrets');
const { McpCallExecutor } = require('../apps/api/dist/modules/tool/mcp-call.executor');
async function main() {
  const db = await new DataSource(sqliteOptions(':memory:')).initialize();
  try {
    await db.runMigrations();
    const servers = db.getRepository(E.McpServerEntity), tools = db.getRepository(E.McpToolEntity);
    const audit = new AuditService(db.getRepository(E.AuditLogEntity), { broadcast() {} });
    let checked = 0, invoked = 0;
    const service = new McpServersService(servers, tools, { check: async () => { checked++; } }, {}, {}, audit);
    await servers.save({ id: 'server', name: 'fixture', endpoint: 'http://localhost/mcp', transport: 'streamable-http', enabled: true, status: 'online' });
    assert.equal((await service.setEnabled('server', false)).enabled, false);
    await service.setEnabled('server', false);
    assert.equal(await db.getRepository(E.AuditLogEntity).countBy({ action: 'mcp.server_disabled' }), 1);
    const executor = new McpCallExecutor(servers, tools, { callTool: async () => { invoked++; } });
    await assert.rejects(() => executor.call('server', 'echo', {}), /已停用/);
    assert.equal(invoked, 0, '停用后不发送新的远端调用');
    assert.equal((await service.setEnabled('server', true)).enabled, true);
    assert.equal(checked, 1);
    assert.equal((await service.diagnostics('server')).items.length, 2);
    await assert.rejects(() => service.setEnabled('missing', false), /不存在/);
    const security = { encryptionKey: Buffer.alloc(32, 7).toString('base64') };
    const config = { get: key => key === 'security' ? security : { healthCacheTtlMs: 60000, healthTimeoutMs: 1000, healthTimeoutMaxMs: 5000 } };
    let fail = false;
    const probes = [];
    const factory = { probe: async connection => {
      probes.push(connection);
      return fail ? { ok: false, error: 'fixture unavailable', latencyMs: 1 } : { ok: true, latencyMs: 1, tools: [{ name: 'new_tool', description: 'current tool', inputSchema: { type: 'object' } }] };
    } };
    const health = new McpHealthService(servers, tools, factory, config, audit, { broadcast() {} });
    const editable = new McpServersService(servers, tools, health, factory, config, audit);
    await servers.update('server', { headersEncrypted: configuredCipher(security).encrypt(JSON.stringify({ Authorization: 'Bearer fixture-secret' })) });
    await tools.save({ id: 'old', mcpServerId: 'server', name: 'retired_tool', inputSchema: { type: 'object' }, riskLevel: 'safe', syncedAt: new Date() });
    const input = { name: 'renamed', endpoint: 'http://localhost/new-mcp', transport: 'streamable-http', preserveCredentials: true };
    const updated = await editable.update('server', input);
    assert.equal(updated.endpoint, input.endpoint);
    assert.equal(updated.status, 'online');
    assert.equal(updated.toolCount, 1);
    assert.equal(probes[0].headers.Authorization, 'Bearer fixture-secret');
    assert.equal(readStoredHeaders(await servers.findOneByOrFail({ id: 'server' }), security).Authorization, 'Bearer fixture-secret');
    assert.equal(await tools.countBy({ name: 'retired_tool' }), 0);
    assert.equal(await tools.countBy({ name: 'new_tool' }), 1);
    assert(!JSON.stringify(updated).includes('fixture-secret'));
    fail = true;
    await assert.rejects(() => editable.update('server', { ...input, endpoint: 'http://localhost/broken' }), /连接失败/);
    assert.equal((await editable.findOne('server')).endpoint, input.endpoint);
    assert.equal(await tools.countBy({ name: 'new_tool' }), 1);
    fail = false;
    await assert.rejects(() => editable.update('server', { ...input, transport: 'stdio' }), /更换传输/);
    const oldSnapshot = await servers.findOneByOrFail({ id: 'server' });
    await servers.update('server', { endpoint: 'http://localhost/newer' });
    const stale = await health.persist(oldSnapshot, { status: 'online', checkedAt: new Date().toISOString(), toolCount: 1 }, { ok: true, tools: [{ name: 'stale_tool' }] });
    assert.equal(stale, false, 'old connection probes cannot restore stale catalog');
    assert.equal(await tools.countBy({ name: 'stale_tool' }), 0);
    await tools.save({ id: 'removed', mcpServerId: 'server', name: 'removed_tool', inputSchema: { type: 'object' }, riskLevel: 'safe', syncedAt: new Date() });
    await health.refresh('server');
    assert.equal(await tools.countBy({ name: 'removed_tool' }), 0, 'normal rediscovery removes withdrawn tools');
    await editable.update('server', { ...input, endpoint: 'http://localhost/without-auth', preserveCredentials: false });
    assert.equal(readStoredHeaders(await servers.findOneByOrFail({ id: 'server' }), security), null);
    await editable.update('server', { name: 'stdio-fixture', endpoint: 'stdio://local', transport: 'stdio', command: 'node', args: ['fixture.js'], env: { API_KEY: 'stdio-secret' } });
    const stdioBefore = await servers.findOneByOrFail({ id: 'server' });
    await editable.update('server', { name: 'stdio-renamed', endpoint: 'stdio://local', transport: 'stdio', preserveCredentials: true });
    const stdioAfter = await servers.findOneByOrFail({ id: 'server' });
    assert.equal(configuredCipher(security).decrypt(stdioAfter.stdioConfigEncrypted), configuredCipher(security).decrypt(stdioBefore.stdioConfigEncrypted));
    assert(!JSON.stringify(await editable.findOne('server')).includes('stdio-secret'));
    const { Module, ValidationPipe } = backendRequire('@nestjs/common');
    const { NestFactory } = backendRequire('@nestjs/core');
    const { McpController } = require('../apps/api/dist/modules/mcp/mcp.controller');
    const { McpPermissionsService } = require('../apps/api/dist/modules/mcp/mcp-permissions.service');
    const { McpCallsService } = require('../apps/api/dist/modules/mcp/mcp-calls.service');
    class TestModule {}
    Module({ controllers: [McpController], providers: [
      { provide: McpServersService, useValue: editable }, { provide: McpHealthService, useValue: health },
      { provide: McpPermissionsService, useValue: {} }, { provide: McpCallsService, useValue: {} },
    ] })(TestModule);
    const app = await NestFactory.create(TestModule, { logger: false });
    try {
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      const request = (path, method, body) => fetch(`${base}/mcp/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = { name: 'http-edited', endpoint: 'stdio://local', transport: 'stdio', preserveCredentials: true };
      let response = await request('servers/server/test', 'POST', payload);
      assert.equal(response.status, 201);
      assert.equal((await response.json()).ok, true);
      response = await request('servers/server', 'PUT', payload);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).name, 'http-edited');
      response = await request('servers/server', 'PUT', { ...payload, preserveCredentials: 'yes' });
      assert.equal(response.status, 400, 'HTTP DTO rejects malformed preservation flag');
      response = await request('servers/missing', 'PUT', payload);
      assert.equal(response.status, 404);
      response = await request('servers', 'POST', { name: 'http-created', endpoint: 'http://localhost/fixture', transport: 'streamable-http' });
      assert.equal(response.status, 201);
      assert.equal((await response.json()).status, 'online');
      console.log('PASS: HTTP create, edit, saved-credential test, DTO validation and missing-server status');
    } finally { await app.close(); }
    const history = JSON.stringify(await db.getRepository(E.AuditLogEntity).find());
    assert(!history.includes('fixture-secret'), 'credential values are never included in audit');
    console.log('PASS: encrypted edit, failed-edit rollback, transport validation, catalog replacement and stale-probe guard');
    console.log('PASS: persisted enable/disable, idempotent audit, disabled execution gate, recheck on enable and diagnostics');
  } finally { await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
