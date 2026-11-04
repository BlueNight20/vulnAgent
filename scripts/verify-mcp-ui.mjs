import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';

// Use an installed Playwright, optionally supplied by the local test runtime.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve('tmp/ui');
process.chdir(resolve('apps/web'));
const server = await createServer({ root: process.cwd(), configFile: resolve('vite.config.ts'), server: { host: '127.0.0.1', port: 5199, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const servers = ['Browser MCP', 'Network MCP'].map((name, i) => ({ id: `server-${i}`, name, endpoint: `http://127.0.0.1:${8931+i}/mcp`, transport: 'streamable-http', enabled: true, status: 'online', toolCount: 85, latencyMs: 12, lastCheckedAt: new Date().toISOString() }));
  const requests = [];
  const payloads = [];
  await page.routeWebSocket('**/ws', socket => { socket.onMessage(() => {}); });
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(path);
    let body = { items: [] };
    if (path === '/api/mcp/servers' && request.method() === 'POST') {
      payloads.push(request.postDataJSON());
      const created = { ...servers[0], ...request.postDataJSON(), id: `created-${servers.length}` };
      servers.push(created); body = created;
    } else if (/\/api\/mcp\/servers\/[^/]+$/.test(path) && request.method() === 'PUT') {
      const entry = servers.find(s => s.id === path.split('/').at(-1));
      Object.assign(entry, request.postDataJSON()); body = entry;
      payloads.push(request.postDataJSON());
    } else if (path === '/api/mcp/servers') body = { items: servers };
    else if (path === '/api/mcp/servers/test') body = { ok: true, toolCount: 3, latencyMs: 8 };
    else if (/\/servers\/[^/]+\/tools$/.test(path)) body = { items: [{ id: path, name: path.includes('server-1') ? 'network_probe' : 'browser_navigate', serverName: 'Fixture MCP', description: '自动化探测工具', paramCount: 1, riskLevel: 'safe', inputSchema: { type: 'object' }, syncedAt: new Date().toISOString() }] };
    else if (path.endsWith('/capabilities')) body = { resources: [{ name: '探测结果', uri: 'fixture://results' }], prompts: [{ name: '验证工作流' }] };
    else if (path === '/api/intercept/tools') body = { tools: [{ name: 'record_fact', source: 'business', risk: 'safe' }, { name: 'remote_hidden', source: 'mcp', risk: 'safe' }] };
    else if (path === '/api/intercept/rules') body = { rules: [] };
    await route.fulfill({ json: body });
  });
  await mkdir(output, { recursive: true });
  await page.goto('http://127.0.0.1:5199/mcp');
  await page.getByRole('button', { name: 'Network MCP', exact: true }).click({ timeout: 15000 }).catch(async error => { console.error({ errors, requests, body: await page.locator('body').innerText() }); throw error; });
  await page.getByText('network_probe', { exact: true }).waitFor();
  assert(!requests.includes('/api/mcp/tools'), 'must never fetch the combined external tool directory');
  await page.screenshot({ path: resolve(output, 'mcp-services.png'), fullPage: true });
  await page.getByRole('tab', { name: '资源', exact: true }).click();
  await page.getByText('探测结果', { exact: true }).waitFor();
  await page.getByRole('button', { name: '添加服务', exact: true }).click();
  await page.getByLabel('服务名称').fill('New MCP');
  await page.getByLabel('服务地址').fill('http://localhost:9000/mcp');
  await page.getByText('高级连接设置', { exact: true }).click();
  await page.getByLabel('自定义请求头（JSON 对象）').fill('{invalid');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '请求头需要' }).waitFor();
  await page.getByLabel('自定义请求头（JSON 对象）').fill(JSON.stringify({ 'X-API-Key': 'fixture-key' }));
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
  await page.screenshot({ path: resolve(output, 'mcp-add.png'), fullPage: true });
  await page.getByRole('button', { name: '保存服务', exact: true }).click();
  await page.getByRole('button', { name: 'New MCP', exact: true }).waitFor();
  assert.equal(payloads[0].headers['X-API-Key'], 'fixture-key');
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await page.getByRole('button', { name: '编辑连接配置', exact: true }).click();
  await page.getByLabel('服务名称').fill('Edited MCP');
  await page.getByRole('button', { name: '保存服务', exact: true }).click();
  await page.getByRole('button', { name: 'Edited MCP', exact: true }).waitFor();
  assert.equal(payloads[1].preserveCredentials, true);
  await page.getByRole('button', { name: '导入配置', exact: true }).click();
  await page.getByLabel('MCP JSON 配置').fill(JSON.stringify({ mcpServers: { 'Imported MCP': { command: 'node', args: ['fixture.js'] } } }));
  await page.getByRole('button', { name: '检测并导入', exact: true }).click();
  await page.getByText(/已添加 ·/).waitFor();
  assert.equal(payloads[2].transport, 'stdio');
  assert.deepEqual(payloads[2].args, ['fixture.js']);
  await page.goto('http://127.0.0.1:5199/tools');
  await page.getByText('record_fact', { exact: true }).waitFor();
  assert.equal(await page.getByText('remote_hidden', { exact: true }).count(), 0);
  await page.screenshot({ path: resolve(output, 'builtin-tools.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: service-scoped discovery, resources, headers validation, test/save/edit, stdio import, built-in-only tools; screenshots tmp/ui');
} finally {
  await browser?.close();
  await server.close();
}
