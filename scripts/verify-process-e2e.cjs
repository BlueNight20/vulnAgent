// Production main.js in a separate process, HTTP-only control, fixed model/MCP protocols on loopback.
// No target services, scans, shells, real models or real credentials are used.
const backendRequire = require('./backend-require.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const http = require('node:http'); const { spawn } = require('node:child_process'); const { once } = require('node:events');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const express = backendRequire('express'); const Database = backendRequire('better-sqlite3');
const { Server } = backendRequire('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = backendRequire('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = backendRequire('@modelcontextprotocol/sdk/types.js');
const target = '192.0.2.10'; const marker = 'E2E_FIXED_PROTOCOL_FINDING';
const portText = (port) => `Starting Nmap (fixed protocol fixture)\nNmap scan report for ${target}\nHost is up.\nPORT STATE SERVICE VERSION\n${port}/tcp open http fixture-http 1.0\nNmap done: 1 IP address (1 host up) scanned in 0.01 seconds\n${marker}\n`;
const verifyText = `HTTP/1.1 200 OK\n${marker}: repeated fixed fixture value; not an actual target observation.`;
const intent = (port) => ({ title: `E2E_RECON_${port}`, hypothesis: '固定协议链路核验', objective: `取得 ${target} ${port}/tcp 的固定协议原文`, rationale: '验证真实服务调度与证据回写', workerProfileId: 'recon', suggestedTools: ['nmap_scan'], expectedEvidence: ['固定原文'], targetIp: target, priority: 60, dedupeKey: `e2e-recon-${port}` });
const analysisIntent = { ...intent(80), title: 'E2E_ANALYSIS_FIXED', objective: '基于已取得证据完成结构化分析，标明其为固定协议数据', workerProfileId: 'vuln-analysis', suggestedTools: [], dedupeKey: 'e2e-analysis' };
async function listen(server) { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function until(test, label, limit = 45000) {
  const end = Date.now() + limit;
  while (Date.now() < end) { const value = await test(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnagent-process-e2e-'));
  const cwd = path.join(directory, 'app', 'api'); fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(directory, 'application.sqlite'); const key = randomBytes(32).toString('base64');
  const captures = []; const calls = []; const errors = []; const evidenceIds = new Set(); const reconFinished = new Set();
  const servers = new Set(); const transports = new Map(); const heldResponses = new Set();
  let modelServer; let mcpServer; let child; let output = ''; let activeTools = 0; let peakTools = 0;
  try {
    modelServer = http.createServer(async (req, res) => {
      try {
        assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer fixture-e2e-not-a-real-key');
        let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
        const system = body.messages.filter((m) => ['system', 'developer'].includes(m.role)).map((m) => JSON.stringify(m.content)).join('\n');
        const serialized = JSON.stringify(body.messages); const toolMessages = body.messages.filter((m) => m.role === 'tool');
        const kind = system.includes('漏洞验证 Worker') ? 'verification' : system.includes('漏洞分析 Worker') ? 'analysis' : system.includes('侦察 Worker') ? 'recon' : 'planner';
        captures.push({ kind, body }); assert.equal(body.model, 'process-fixture');
        if (serialized.includes('E2E_INTERRUPTION_FIXED')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '固定的未完成模型流' }, finish_reason: null }] })}\n\n`);
          heldResponses.add(res); res.on('close', () => heldResponses.delete(res)); return;
        }
        let result; let tool;
        if (kind === 'planner') {
          result = { analysis: '固定协议数据规划，不代表真实目标', goalStatus: 'in_progress', hypotheses: [], intents: reconFinished.size ? [analysisIntent] : [intent(80), intent(81)] };
        } else if (kind === 'analysis') {
          const used = [...evidenceIds].filter((id) => serialized.includes(id)); assert.ok(used.length, 'analysis must actually receive prior evidence');
          result = { summary: '已基于当前证据完成固定协议数据分析，不对真实靶机下结论', usedEvidenceIds: used, facts: [], hypotheses: [], nextIntents: [], openQuestions: [], nextSteps: [] };
        } else if (!toolMessages.length) {
          const port = kind === 'recon' ? Number(serialized.match(/E2E_RECON_(80|81)/)?.[1]) : 80;
          assert.ok([80, 81].includes(port));
          tool = kind === 'recon' ? { name: 'nmap_scan', arguments: { target, ports: String(port), scan_type: '-sT -Pn' } } : { name: 'http_repeater', arguments: { target, url: `http://${target}:80/`, method: 'GET' } };
        } else {
          const text = JSON.stringify(toolMessages[toolMessages.length - 1].content);
          const id = text.match(/证据ID[:：]\s*([a-f0-9-]{36})/)?.[1]; assert.ok(id, `tool result has no evidence ID: ${text.slice(0, 600)}`); evidenceIds.add(id);
          const port = kind === 'recon' ? Number(serialized.match(/E2E_RECON_(80|81)/)?.[1]) : 80;
          if (kind === 'recon') reconFinished.add(port);
          result = { summary: '固定协议工具结果已读取，不代表真实目标观测', usedEvidenceIds: [], facts: kind === 'recon' && port === 80 ? [{ category: 'vulnerability', subject: target, predicate: 'fixture_protocol_value', object: marker, confidence: 0.4, evidenceIndex: 0 }] : [], hypotheses: [], nextIntents: [], openQuestions: [], nextSteps: [],
            verification: kind === 'verification' ? { outcome: 'confirmed', summary: '新的固定协议调用独立重复取得标记；仅供系统链路测试', evidenceQuotes: [{ evidenceId: id, quote: marker }] } : null };
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const emit = (choices, usage) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: body.model, choices, ...(usage ? { usage } : {}) })}\n\n`);
        if (tool) {
          emit([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, finish_reason: null }]);
          emit([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]);
        } else {
          emit([{ index: 0, delta: { role: 'assistant', content: `\n\x60\x60\x60json\n${JSON.stringify(result)}\n\x60\x60\x60` }, finish_reason: null }]);
          emit([{ index: 0, delta: {}, finish_reason: 'stop' }]);
        }
        emit([], { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }); res.end('data: [DONE]\n\n');
      } catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end('fixed model protocol fixture failed'); }
    });
    const modelPort = await listen(modelServer);
    const mcp = express(); mcp.use(express.json());
    mcp.all('/mcp', async (req, res) => {
      try {
        let transport = transports.get(req.headers['mcp-session-id']);
        if (!transport && req.method === 'POST' && req.body?.method === 'initialize') {
          const server = new Server({ name: 'fixed-e2e-protocol-no-target', version: '1' }, { capabilities: { tools: {} } }); servers.add(server);
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true, onsessioninitialized(id) { transports.set(id, transport); } });
          server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
            { name: 'nmap_scan', description: 'Fixed protocol text only; does not run a scan or access any target', inputSchema: { type: 'object', required: ['target', 'ports'], properties: { target: { type: 'string' }, ports: { type: 'string' }, scan_type: { type: 'string' } } } },
            { name: 'http_repeater', description: 'Fixed protocol text only; no HTTP target request is sent', inputSchema: { type: 'object', required: ['target', 'url'], properties: { target: { type: 'string' }, url: { type: 'string' }, method: { type: 'string' } } } },
            { name: 'search_exploits', description: 'Unused fixed protocol catalogue entry', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
          ] }));
          server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params; assert.ok(['nmap_scan', 'http_repeater'].includes(name)); assert.equal(args.target, target);
            if (name === 'nmap_scan') assert.ok(['80', '81'].includes(args.ports));
            calls.push({ name, args }); activeTools++; peakTools = Math.max(peakTools, activeTools);
            try { await new Promise((resolve) => setTimeout(resolve, 250)); return { content: [{ type: 'text', text: name === 'nmap_scan' ? portText(args.ports) : verifyText }] }; }
            finally { activeTools--; }
          });
          await server.connect(transport);
        }
        if (!transport) { res.status(400).end(); return; } await transport.handleRequest(req, res, req.body);
      } catch (error) { errors.push(error); if (!res.headersSent) res.status(500); res.end(); }
    });
    mcpServer = http.createServer(mcp); const mcpPort = await listen(mcpServer);
    const reservation = http.createServer(); const apiPort = await listen(reservation); await new Promise((resolve) => reservation.close(resolve));
    const base = `http://127.0.0.1:${apiPort}/api`;
    const env = { ...process.env, PORT: String(apiPort), VA_API_HOST: '127.0.0.1', DB_TYPE: 'sqlite', DB_PATH: file, DB_SYNCHRONIZE: 'false', DB_LOGGING: 'false', VA_ENCRYPTION_KEY: key,
      MCP_SERVERS: '[]', MCP_GATEWAY_NAME: 'e2e-fixed-protocol', MCP_GATEWAY_URL: `http://127.0.0.1:${mcpPort}/mcp`, MCP_GATEWAY_ENABLED: 'true', MCP_GATEWAY_HEADERS: '', MCP_TOOL_TIMEOUT_MS: '5000', MCP_CONNECT_TIMEOUT_MS: '5000',
      MODEL_API_KEY: 'fixture-e2e-not-a-real-key', MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, MODEL_NAME: 'process-fixture', MODEL_PROVIDER: 'openai-compatible', MODEL_MAX_TOKENS: '1600',
      PI_RUNTIME_ENABLED: 'true', MODEL_MAX_CONCURRENCY: '3', WORKER_MAX_CONCURRENCY: '3', LOG_TO_FILE: 'false' };
    async function start() {
      child = spawn(process.execPath, [path.resolve(__dirname, '../apps/api/dist/main.js')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (bytes) => { output = (output + bytes).slice(-100000); }); child.stderr.on('data', (bytes) => { output = (output + bytes).slice(-100000); });
      await until(async () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error(`API exited: ${output.slice(-6000)}`); try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } }, 'production API startup', 20000);
    }
    async function stop() { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } child = null; }
    async function json(url, method = 'GET', body) { const response = await fetch(`${base}${url}`, { method, signal: AbortSignal.timeout(5000), ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }); assert.ok(response.ok, `${method} ${url}: ${response.status} ${await response.clone().text()}`); return response.json(); }
    await start();
    const services = await json('/mcp/servers'); assert.equal(services.items.length, 1);
    const check = await json(`/mcp/servers/${services.items[0].id}/check`, 'POST'); assert.equal(check.status, 'online');
    const task = await json('/tasks', 'POST', { name: 'E2E 固定协议流程，非真实靶机', targets: [{ ip: target }], scope: { cidrs: ['192.0.2.0/24'], ports: '80-81' }, authorized: true,
      modelProvider: 'openai-compatible', modelName: 'process-fixture', tokenBudget: 200000, timeBudgetMinutes: 5, workerCount: 2, autoStart: false,
      goal: { mode: 'assessment', targets: [target], ports: '80-81', protocol: 'tcp' } });
    await json(`/tasks/${task.id}/engine/start`, 'POST');
    const finished = await until(async () => { const current = await json(`/tasks/${task.id}`); if (['failed', 'stopped'].includes(current.status) || ['stalled', 'needs_input'].includes(current.engineStatus)) throw new Error(`Task stopped early: ${JSON.stringify(current)}\n${output.slice(-7000)}`); return current.status === 'completed' ? current : false; }, 'complete planning/execution/verification flow');
    assert.equal((await json(`/tasks/${task.id}/engine`)).stopReason, 'goal_reached'); assert.equal((await json(`/tasks/${task.id}/goal`)).complete, true);
    const findings = await json(`/tasks/${task.id}/findings`); assert.equal(findings.total, 1); assert.equal(findings.items[0].status, 'confirmed');
    const detail = await json(`/tasks/${task.id}/findings/${findings.items[0].id}`); assert.equal(detail.verifications[0].outcome, 'confirmed');
    assert.ok(!detail.verifications[0].evidenceIds.some((id) => detail.verifications[0].baselineEvidenceIds.includes(id)));
    const report = await json(`/tasks/${task.id}/reports`, 'POST'); const exported = await json(`/tasks/${task.id}/reports/${report.id}/download?format=evidence`);
    assert.ok(JSON.stringify(exported).includes(marker)); assert.ok(JSON.stringify(exported).includes('confirmed'));
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const evidence = db.prepare('SELECT * FROM evidence WHERE taskId=?').all(task.id); assert.equal(evidence.length, 3);
      for (const row of evidence) assert.equal(createHash('sha256').update(row.content).digest('hex'), row.sha256);
      const workers = db.prepare('SELECT * FROM worker_tasks WHERE taskId=?').all(task.id); assert.ok(workers.every((worker) => worker.status === 'succeeded')); assert.ok(workers.some((worker) => worker.profileId === 'vuln-analysis'));
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE taskId=? AND role=?').get(task.id, 'planner').n >= 2);
    } finally { db.close(); }
    assert.equal(calls.length, 3); assert.ok(peakTools >= 2, 'two actual Worker tools must overlap');
    assert.ok(captures.filter((row) => row.kind === 'planner').some((row) => [...evidenceIds].some((id) => JSON.stringify(row.body.messages).includes(id))), 'subsequent Planner must read actual prior evidence');
    const beforeRestart = captures.length; await stop(); await start();
    assert.equal((await json(`/tasks/${task.id}`)).status, 'completed'); assert.equal((await json(`/tasks/${task.id}/findings`)).items[0].status, 'confirmed');
    assert.equal(captures.length, beforeRestart, 'completed tasks must not be replayed at restart'); assert.equal(calls.length, 3);
    const interrupted = await json('/tasks', 'POST', { name: 'E2E_INTERRUPTION_FIXED', targets: [{ ip: target }], scope: { cidrs: ['192.0.2.0/24'], ports: '80-81' }, authorized: true,
      modelProvider: 'openai-compatible', modelName: 'process-fixture', tokenBudget: 100000, timeBudgetMinutes: 5, workerCount: 1, autoStart: true,
      goal: { mode: 'evidence', targets: [target], protocol: 'tcp', evidenceText: 'INTERRUPTED_NO_EVIDENCE' } });
    await until(() => heldResponses.size > 0, 'active incomplete production model stream', 10000);
    const pending = await json(`/tasks/${interrupted.id}/model-budget`); assert.ok(pending.items.some((row) => row.state === 'reserved'));
    const beforeCrash = captures.length; await stop(); await start();
    const recovered = await json(`/tasks/${interrupted.id}`); assert.equal(recovered.status, 'paused'); assert.match(recovered.lastError, /进程重启/);
    assert.equal((await json(`/tasks/${interrupted.id}/engine`)).stopReason, 'needs_input');
    const recoveredBudget = await json(`/tasks/${interrupted.id}/model-budget`); assert.equal(recoveredBudget.knownTokens, 0); assert.ok(recoveredBudget.committedTokens > 0); assert.ok(recoveredBudget.items.some((row) => row.state === 'uncertain'));
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(captures.length, beforeCrash, 'interrupted task must wait for explicit user recovery'); assert.equal(calls.length, 3);
    const reopened = new Database(file, { readonly: true, fileMustExist: true });
    try {
      assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM evidence WHERE taskId=?').get(interrupted.id).n, 0);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE taskId=? AND action='engine.recovered'").get(interrupted.id).n, 1);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE taskId=? AND state='failed'").get(interrupted.id).n, 1);
    } finally { reopened.close(); }
    assert.deepEqual(errors, []); await stop();
    console.log('PASS: production process HTTP create/start, SDK Planner/parallel Workers, MCP policy and evidence ingestion, independent verification/analysis, goal/report, completed restart without replay, actual in-flight process kill and uncertain-budget/manual-recovery state; fixed loopback protocols only');
  } catch (error) { console.error(output.slice(-10000)); throw error; }
  finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    for (const response of heldResponses) response.destroy();
    await Promise.all([...servers].map((server) => server.close().catch(() => {})));
    for (const server of [modelServer, mcpServer]) if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    const absolute = path.resolve(directory); assert.equal(path.dirname(absolute), path.resolve(os.tmpdir())); assert.ok(path.basename(absolute).startsWith('vulnagent-process-e2e-')); fs.rmSync(absolute, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
