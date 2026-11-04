const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { McpClientFactory } = require('../apps/api/dist/modules/mcp/mcp-client.factory');
const { configuredCipher } = require('../apps/api/dist/common/crypto/mcp-header-secrets');
async function main() {
  const security = { encryptionKey: Buffer.alloc(32, 7).toString('base64') };
  const config = { get: () => security };
  const factory = new McpClientFactory(config);
  const encrypted = configuredCipher(security).encrypt(JSON.stringify({ command: process.execPath, args: [resolve(__dirname, 'fixture-mcp-stdio.cjs')], env: { MCP_FIXTURE_VALUE: 'stdio works' } }));
  const options = { endpoint: 'stdio://local', transport: 'stdio', stdioConfigEncrypted: encrypted, timeoutMs: 5000 };
  try {
    const probe = await factory.probe(options, true);
    assert.equal(probe.ok, true, JSON.stringify(probe));
    assert.equal(probe.tools[0].name, 'echo');
    assert.equal(probe.tools.length, 2, '读取后续目录分页');
    assert.equal(probe.resources[0].uri, 'fixture://resource');
    assert.equal(probe.prompts[0].name, 'fixture-prompt');
    const result = await factory.callTool({ ...options, toolName: 'echo', arguments: {} });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.text, 'stdio works');
    await factory.closeAllSessions();
    assert.equal(factory.clients.size, 0);
    console.log('PASS: real stdio process discovery, encrypted configuration, environment, invocation and shutdown');
  } finally { await factory.closeAllSessions(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
