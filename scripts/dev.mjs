#!/usr/bin/env node
/**
 * 同时启动后端（NestJS）与前端（Vite）的开发脚本，跨平台（Windows PowerShell / cmd / bash）。
 * 任一进程退出时，另一个进程也会被终止。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!existsSync(join(root, 'node_modules'))) {
  console.error('[VulnAgent] 未检测到 node_modules，请先执行：npm install');
  process.exit(1);
}
if (!existsSync(join(root, '.env'))) {
  console.warn('[VulnAgent] 未找到 .env，将使用默认配置。建议复制 .env.example 为 .env 后按需修改。');
}

const services = [
  { name: 'api', color: '\x1b[36m', args: ['run', 'dev', '--workspace', '@vulnagent/api'] },
  { name: 'web', color: '\x1b[35m', args: ['run', 'dev', '--workspace', '@vulnagent/web'] },
];

const children = [];

for (const svc of services) {
  const child = spawn(npmCmd, svc.args, {
    cwd: root,
    shell: process.platform === 'win32',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  const prefix = `${svc.color}[${svc.name}]\x1b[0m `;
  const pipe = (stream, target) => {
    stream.on('data', (chunk) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) target.write(prefix + line + '\n');
      }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    console.log(`${prefix}进程退出，code=${code}`);
    shutdown(code ?? 0);
  });
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    }
  }
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
