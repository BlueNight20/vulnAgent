// A tiny real Nest app in a temporary project verifies the installed CLI, compiler and asset matcher.
// It never imports VulnAgent configuration, models, MCP or user storage.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const backendRequire = require('./backend-require.cjs');
const assetPatch = require('./patch-nest-assets.cjs');
assetPatch.main();
assert.throws(() => assetPatch.patchedSource('unreviewed upstream file'), /拒绝改写/);
const cli = path.join(path.dirname(backendRequire.resolve('@nestjs/cli/package.json')), 'bin/nest.js');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnagent-cli-')); const nonce = randomUUID();
  let watch; let current = null; let output = ''; const ready = [];
  try {
    for (const name of ['@nestjs/common', '@nestjs/core', '@nestjs/platform-express', '@types/node', 'reflect-metadata']) {
      const target = path.dirname(backendRequire.resolve(name === 'reflect-metadata' ? name : `${name}/package.json`)); const link = path.join(root, 'node_modules', name);
      fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(target, link, 'junction');
    }
    fs.mkdirSync(path.join(root, 'src/assets/nested'), { recursive: true });
    const write = (name, value) => fs.writeFileSync(path.join(root, name), value);
    write('package.json', JSON.stringify({ name: 'vulnagent-cli-fixture', private: true }));
    write('nest-cli.json', JSON.stringify({ sourceRoot: 'src', compilerOptions: { builder: 'tsc', tsConfigPath: 'tsconfig.json', deleteOutDir: true, assets: [{ include: 'assets/**/*', exclude: 'assets/**/*.skip', watchAssets: true }] } }));
    write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'Node16', moduleResolution: 'Node16', target: 'ES2022', outDir: 'dist', rootDir: 'src', emitDecoratorMetadata: true, experimentalDecorators: true, esModuleInterop: true, resolveJsonModule: true, types: ['node'], strict: true, skipLibCheck: true, noEmitOnError: true }, include: ['src/**/*'] }));
    write('src/fixture.json', JSON.stringify({ label: '中文 JSON 资源🙂' }));
    write('src/value.ts', 'export const value: string = "first";\n');
    write('src/assets/nested/fixture.txt', 'asset-first'); write('src/assets/nested/ignored.skip', 'must not copy');
    write('src/main.ts', `import 'reflect-metadata';
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import metadata from './fixture.json';
import { value } from './value';
@Injectable() class ValueService { read() { return value; } }
@Controller() class FixtureController {
  constructor(private readonly values: ValueService) {}
  @Get('value') read() { const file=join(__dirname,'assets/nested/fixture.txt'); return { value: this.values.read(), json: metadata.label, asset: existsSync(file) ? readFileSync(file,'utf8') : null, nonce: process.env.VA_CLI_FIXTURE_NONCE, pid: process.pid }; }
}
@Module({ controllers: [FixtureController], providers: [ValueService] }) class FixtureModule {}
async function main() { const app=await NestFactory.create(FixtureModule,new ExpressAdapter(),{logger:false}); await app.listen(0,'127.0.0.1'); console.log('VA_CLI_READY '+JSON.stringify({url:await app.getUrl(),pid:process.pid,nonce:process.env.VA_CLI_FIXTURE_NONCE})); }
void main();
`);
    const build = () => { const result = spawnSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8', timeout: 30000 }); assert.equal(result.status, 0, result.stdout + result.stderr); };
    build(); assert.ok(fs.existsSync(path.join(root, 'dist/main.js'))); assert.equal(fs.existsSync(path.join(root, 'dist/src/main.js')), false);
    assert.equal(fs.readFileSync(path.join(root, 'dist/assets/nested/fixture.txt'), 'utf8'), 'asset-first'); assert.equal(fs.existsSync(path.join(root, 'dist/assets/nested/ignored.skip')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'dist/fixture.json'), 'utf8')).label, '中文 JSON 资源🙂');
    write('dist/stale.js', 'obsolete'); build(); assert.equal(fs.existsSync(path.join(root, 'dist/stale.js')), false, 'cold build removes obsolete output');
    let lines = '';
    watch = spawn(process.execPath, [cli, 'start', '--watch', '--no-shell'], { cwd: root, env: { ...process.env, VA_CLI_FIXTURE_NONCE: nonce }, stdio: ['pipe', 'pipe', 'pipe'] });
    const capture = (chunk) => {
      output += String(chunk); if (output.length > 40000) output = output.slice(-40000);
      lines += String(chunk); let end;
      while ((end = lines.indexOf('\n')) >= 0) {
        const line = lines.slice(0, end); lines = lines.slice(end + 1); const marker = line.indexOf('VA_CLI_READY ');
        if (marker >= 0) { const data = JSON.parse(line.slice(marker + 'VA_CLI_READY '.length)); assert.equal(data.nonce, nonce); ready.push(data); current = data; }
      }
    };
    watch.stdout.on('data', capture); watch.stderr.on('data', capture);
    async function waitFor(check, reason, timeout = 25000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await check()) return; if (watch.exitCode !== null || watch.signalCode !== null) throw new Error(`CLI exited while ${reason}: ${output}`); await pause(100); }
      throw new Error(`Timeout ${reason}: ${output}`);
    }
    async function value() {
      if (!current) return null;
      try { const response = await fetch(`${current.url}/value`, { signal: AbortSignal.timeout(1000) }); const data = await response.json(); assert.equal(data.nonce, nonce); return data; }
      catch { return null; }
    }
    await waitFor(async () => (await value())?.value === 'first', 'initial watch application');
    assert.equal((await value()).json, '中文 JSON 资源🙂');
    write('src/value.ts', 'export const value: string = "second";\n');
    await waitFor(async () => (await value())?.value === 'second', 'TypeScript edit/restart');
    const readyBeforeError = ready.length; const previousOutput = output.length;
    write('src/value.ts', 'export const value: string = 123;\n');
    await waitFor(() => /TS2322|not assignable to type/.test(output.slice(previousOutput)), 'type error diagnosis');
    await pause(400); assert.equal(ready.length, readyBeforeError, 'invalid code does not start a new runtime');
    write('src/value.ts', 'export const value: string = "third";\n');
    await waitFor(async () => (await value())?.value === 'third', 'recovery after compile error');
    const beforeAsset = ready.length; write('src/assets/nested/fixture.txt', 'asset-second');
    await waitFor(async () => ready.length > beforeAsset && (await value())?.asset === 'asset-second', 'asset edit/copy/restart');
    const beforeRemoval = ready.length; fs.unlinkSync(path.join(root, 'src/assets/nested/fixture.txt'));
    await waitFor(async () => ready.length > beforeRemoval && !fs.existsSync(path.join(root, 'dist/assets/nested/fixture.txt')) && (await value())?.asset === null, 'asset removal/restart');
    console.log('PASS: installed Nest CLI cold CJS/Node16 build, decorator DI, JSON and nested assets/excludes, obsolete output removal, real loopback watch startup, TypeScript edit/restart, compile-error gating/recovery and asset update/removal/restart; temporary project only');
  } finally {
    // Only the CLI and the latest runtime identified by our nonce are owned by this verifier.
    if (current) { try { process.kill(current.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    if (watch && watch.exitCode === null && watch.signalCode === null) { watch.kill(); await new Promise((resolve) => { watch.once('exit', resolve); setTimeout(resolve, 3000).unref(); }); }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('vulnagent-cli-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
