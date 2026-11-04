const backendRequire = require('./backend-require.cjs');
// Real MCP SDK and HTTP transport on loopback only. The tool merely waits and returns text.
const assert = require('node:assert/strict');
const express = backendRequire('express');
const { randomUUID } = require('node:crypto');
const { Server } = backendRequire('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = backendRequire('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = backendRequire('@modelcontextprotocol/sdk/types.js');
const protocol = backendRequire('@modelcontextprotocol/sdk/shared/protocol.js');
const { McpClientFactory } = require('../apps/api/dist/modules/mcp/mcp-client.factory');

async function main() {
  const app = express(); app.use(express.json());
  const sessions = new Map(); const transports = new Set(); const servers = new Set();
  let initializes = 0; let requests = 0; let cancelled = 0;
  const factory = new McpClientFactory();
  const originalTimeout = protocol.DEFAULT_REQUEST_TIMEOUT_MSEC;
  // Shorten the SDK's *default* to prove the factory overrides it without a minute-long test.
  protocol.DEFAULT_REQUEST_TIMEOUT_MSEC = 25;
  app.all('/mcp', async (req, res) => {
    try {
      let transport = sessions.get(req.headers['mcp-session-id']);
      if (!transport && req.method === 'POST' && req.body?.method === 'initialize') {
        initializes++;
        const server = new Server({ name: 'loopback-runtime-fixture', version: '1' }, { capabilities: { tools: {} } }); servers.add(server);
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true, onsessioninitialized(id) { sessions.set(id, transport); } });
        transports.add(transport);
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'wait_fixture', description: 'Local timer, no target access', inputSchema: { type: 'object' } }] }));
        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          requests++;
          if (request.params.arguments?.image) return { content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' }] };
          const delay = Number(request.params.arguments?.delay ?? 0);
          await new Promise((resolve) => {
            const timer = setTimeout(() => { extra.signal.removeEventListener('abort', stop); resolve(); }, delay);
            const stop = () => { cancelled++; clearTimeout(timer); resolve(); };
            extra.signal.addEventListener('abort', stop, { once: true });
            if (extra.signal.aborted) stop();
          });
          return { content: [{ type: 'text', text: `fixture response after ${delay}ms` }] };
        });
        await server.connect(transport);
      }
      if (!transport) { res.status(400).json({ error: 'unknown session' }); return; }
      await transport.handleRequest(req, res, req.body);
    } catch (error) { if (!res.headersSent) res.status(500).json({ error: String(error) }); }
  });
  app.post('/hang', () => { /* Deliberately no initialize response. */ });
  const http = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const endpoint = `http://127.0.0.1:${http.address().port}/mcp`;
  const options = { endpoint, transport: 'streamable-http', timeoutMs: 500, connectTimeoutMs: 1500, toolName: 'wait_fixture', arguments: { delay: 70 } };
  try {
    const first = await factory.callTool(options); assert.equal(first.ok, true, first.error); assert.ok(first.text.includes('70ms'));
    const second = await factory.callTool({ ...options, arguments: { delay: 0 } }); assert.equal(second.ok, true); assert.equal(initializes, 1, 'successful connection is reused');
    const image = await factory.callTool({ ...options, arguments: { image: true } }); assert.equal(image.ok, true); assert.equal(image.text, '', 'binary placeholders must not become textual evidence'); assert.equal(image.raw.content[0].type, 'image'); assert.ok(image.raw.content[0].data.startsWith('iVBOR'));
    const probe = await factory.probe({ endpoint, transport: 'streamable-http', timeoutMs: 1500 }); assert.equal(probe.ok, true); assert.equal(probe.tools[0].name, 'wait_fixture');
    const timeout = await factory.callTool({ ...options, timeoutMs: 30, arguments: { delay: 250 } }); assert.equal(timeout.ok, false); assert.equal(timeout.phase, 'execute'); assert.ok(timeout.error.includes('执行超时'));
    const beforeNew = initializes;
    assert.equal((await factory.callTool({ ...options, arguments: { delay: 0 } })).ok, true); assert.equal(initializes, beforeNew + 1, 'timed-out connection cannot poison later requests');
    const controller = new AbortController();
    const pending = factory.callTool({ ...options, signal: controller.signal, arguments: { delay: 250 } });
    setTimeout(() => controller.abort(), 30);
    const aborted = await pending; assert.equal(aborted.ok, false); assert.equal(aborted.cancelled, true); assert.ok(aborted.error.includes('已取消'));
    await new Promise((resolve) => setTimeout(resolve, 30)); assert.ok(cancelled >= 1, 'SDK cancellation reaches the local server handler');
    const pre = new AbortController(); pre.abort(); const before = requests;
    assert.equal((await factory.callTool({ ...options, signal: pre.signal })).cancelled, true); assert.equal(requests, before, 'pre-aborted call never executes');
    const handshake = await factory.callTool({ ...options, endpoint: endpoint.replace('/mcp', '/hang'), connectTimeoutMs: 30 });
    assert.equal(handshake.ok, false); assert.equal(handshake.phase, 'connect'); assert.ok(handshake.error.includes('握手超时'));
    const deadline = await factory.callTool({ ...options, arguments: { delay: 250 }, deadlineAt: Date.now() + 50 });
    assert.equal(deadline.ok, false); assert.ok(deadline.latencyMs < 300, 'absolute deadline bounds connect + request time');
    const active = factory.callTool({ ...options, arguments: { delay: 250 } });
    await new Promise((resolve) => setTimeout(resolve, 30)); await factory.closeAllSessions(); assert.equal((await active).ok, false, 'shutdown closes in-flight connections too');
    assert.equal(factory.clients.size, 0); assert.equal(factory.pool.size, 0);
    console.log('PASS: real SDK timeout override, real Streamable HTTP, successful pool reuse, timeout disposal, AbortSignal/server cancellation, pre-cancel, handshake phase, absolute deadline and active shutdown');
  } finally {
    protocol.DEFAULT_REQUEST_TIMEOUT_MSEC = originalTimeout;
    await factory.closeAllSessions();
    await Promise.all([...servers].map((s) => s.close().catch(() => {})));
    http.closeAllConnections(); await new Promise((resolve) => http.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
