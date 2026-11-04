const backendRequire = require('./backend-require.cjs');
const assert = require('node:assert/strict');
const express = backendRequire('express');
const { Server } = backendRequire('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = backendRequire('@modelcontextprotocol/sdk/server/sse.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = backendRequire('@modelcontextprotocol/sdk/types.js');
const { McpClientFactory } = require('../apps/api/dist/modules/mcp/mcp-client.factory');

async function main() {
  const app = express(); app.use(express.json());
  const transports = new Map(); const servers = new Set();
  app.use((req, res, next) => req.headers.authorization === 'Bearer fixture-token' ? next() : res.status(401).end());
  app.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    const server = new Server({ name: 'sse-fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'fixture', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'SSE executed' }] }));
    transports.set(transport.sessionId, transport); servers.add(server);
    res.on('close', () => transports.delete(transport.sessionId));
    await server.connect(transport);
  });
  app.post('/messages', async (req, res) => {
    const transport = transports.get(req.query.sessionId);
    if (!transport) return res.status(404).end();
    await transport.handlePostMessage(req, res, req.body);
  });
  const http = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const factory = new McpClientFactory();
  const options = { endpoint: `http://127.0.0.1:${http.address().port}/sse`, transport: 'sse', headers: { Authorization: 'Bearer fixture-token' }, timeoutMs: 2000 };
  try {
    const probe = await factory.probe(options);
    assert.equal(probe.ok, true, JSON.stringify(probe));
    assert.equal(probe.tools[0].name, 'echo');
    for (let i = 0; i < 2; i++) {
      const result = await factory.callTool({ ...options, toolName: 'echo', arguments: {} });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.text, 'SSE executed');
    }
    const rejected = await factory.probe({ ...options, headers: null });
    assert.equal(rejected.ok, false);
    console.log('PASS: authenticated real SSE discovery, tool calls, connection reuse and missing-token rejection');
  } finally {
    await factory.closeAllSessions();
    await Promise.all([...servers].map((server) => server.close()));
    http.closeAllConnections(); await new Promise((resolve) => http.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
