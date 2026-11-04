// Install the lockfile into a fresh temporary workspace. Never copy .env, storage or user databases.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
async function run(args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', env: { ...process.env, npm_config_cache: path.join(root, '.npmcache') } });
    child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Isolated command failed (${code ?? signal}): ${args.join(' ')}`)));
  });
}
async function main() {
  assert.ok(fs.existsSync(npmCli), 'npm CLI not found');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnagent-clean-install-'));
  try {
    for (const relative of ['package.json', 'package-lock.json', 'apps/api/package.json', 'apps/web/package.json', 'packages/shared/package.json']) {
      const destination = path.join(directory, relative); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(path.join(root, relative), destination);
    }
    for (const relative of ['apps/api/dist', 'packages/shared/dist', 'scripts']) {
      const source = path.join(root, relative); assert.ok(fs.existsSync(source), `Build first: missing ${relative}`);
      fs.cpSync(source, path.join(directory, relative), { recursive: true });
    }
    const originalLock = fs.readFileSync(path.join(directory, 'package-lock.json'));
    console.log('Isolated npm ci: manifests, lockfile and compiled artifacts only; no user configuration.');
    await run([npmCli, 'ci', '--no-fund'], directory);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'package-lock.json')), originalLock, 'npm ci must not alter the lockfile');
    const scripts = ['cli-toolchain', 'migrations', 'http-ws', 'runtime-control', 'engine-controls', 'logging', 'worker-capacity', 'hints', 'model-budget', 'mcp-runtime', 'secrets', 'mcp-secrets', 'backups', 'finding-assessments', 'profile-permissions', 'permission-updates', 'data-maintenance', 'process-e2e'];
    for (const name of scripts) { console.log(`Isolated verification: ${name}`); await run([path.join(directory, `scripts/verify-${name}.cjs`)], directory); }
    console.log('PASS: fresh isolated npm ci, unchanged lockfile, native SQLite/migration CLI, full HTTP/WebSocket startup, real model and MCP SDK, credential upgrade and process recovery');
  } finally {
    const target = path.resolve(directory); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('vulnagent-clean-install-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
