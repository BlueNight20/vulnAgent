import { ConsoleLogger, ServiceUnavailableException, type LoggerService } from '@nestjs/common';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import type { LoggingStatus, RuntimeSettings } from '@vulnagent/shared';

export interface PreparedLogging { apply(): void; dispose(): void }
export interface LoggingControl {
  prepare(settings: Pick<RuntimeSettings, 'logLevel' | 'logToFile'>, secrets?: string[]): PreparedLogging;
  readonly status: LoggingStatus;
}
const ranks: Record<string, number> = { debug: 0, verbose: 0, info: 1, log: 1, warn: 2, error: 3, fatal: 3 };

/** A single process logger, with transactional configuration and bounded JSONL entries. */
export class RuntimeLogger implements LoggerService, LoggingControl {
  private console = new ConsoleLogger({ colors: false, logLevels: ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] });
  private level: string;
  private fd: number | null = null;
  private activeFile: string | null = null;
  private lastError: string | null = null;
  private secrets: string[] = [];
  private directory: string;

  constructor(directory: string, level = 'info') { this.directory = resolve(directory); this.level = level in ranks ? level : 'info'; }
  get status(): LoggingStatus { return { level: this.level, fileEnabled: this.fd !== null, directory: this.directory, activeFile: this.activeFile, lastError: this.lastError }; }

  prepare(settings: Pick<RuntimeSettings, 'logLevel' | 'logToFile'>, secrets: string[] = []): PreparedLogging {
    if (!['debug', 'info', 'warn', 'error'].includes(settings.logLevel)) throw new ServiceUnavailableException('日志级别配置无效');
    let fd: number | null = null;
    const file = settings.logToFile ? join(this.directory, 'vulnagent.jsonl') : null;
    if (file) {
      try {
        mkdirSync(this.directory, { recursive: true });
        try { if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('not a regular file'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        fd = openSync(file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
        if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
      } catch {
        if (fd !== null) this.closeFd(fd);
        throw new ServiceUnavailableException('日志目录或文件不可写；日志配置未提交，请检查 LOG_DIR 与目录权限');
      }
    }
    let finished = false;
    return {
      apply: () => {
        if (finished) return; finished = true;
        const previous = this.fd; this.fd = fd; this.activeFile = file; this.level = settings.logLevel; this.lastError = null;
        this.secrets = [...new Set([...this.secrets, ...secrets.filter(Boolean)])].slice(-64);
        if (previous !== null) this.closeFd(previous);
      },
      dispose: () => { if (!finished) { finished = true; if (fd !== null) this.closeFd(fd); } },
    };
  }

  log(message: unknown, ...args: unknown[]) { this.emit('log', message, args); }
  warn(message: unknown, ...args: unknown[]) { this.emit('warn', message, args); }
  error(message: unknown, ...args: unknown[]) { this.emit('error', message, args); }
  debug(message: unknown, ...args: unknown[]) { this.emit('debug', message, args); }
  verbose(message: unknown, ...args: unknown[]) { this.emit('verbose', message, args); }
  fatal(message: unknown, ...args: unknown[]) { this.emit('fatal', message, args); }
  close(): void { if (this.fd !== null) this.closeFd(this.fd); this.fd = null; this.activeFile = null; }

  private redact(value: unknown): string {
    let text = typeof value === 'string' ? value : inspect(value, { depth: 4, maxArrayLength: 20, maxStringLength: 8192, breakLength: Infinity });
    for (const secret of this.secrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/\b(Bearer|Basic)\s+[^\s"',;}]+/gi, '$1 [REDACTED]')
      .replace(/((?:api[_-]?key|authorization|password)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]').slice(0, 8192);
  }

  private emit(level: 'log' | 'warn' | 'error' | 'debug' | 'verbose' | 'fatal', message: unknown, args: unknown[]): void {
    if (ranks[level] < ranks[this.level]) return;
    const safeMessage = this.redact(message); const safeArgs = args.slice(0, 8).map((arg) => this.redact(arg));
    this.console[level](safeMessage, ...safeArgs);
    if (this.fd === null) return;
    try {
      const bytes = Buffer.from(JSON.stringify({ timestamp: new Date().toISOString(), level: level === 'log' ? 'info' : level, message: safeMessage, details: safeArgs }) + '\n');
      let offset = 0; while (offset < bytes.length) { const written = writeSync(this.fd, bytes, offset, bytes.length - offset); if (!written) throw new Error('empty write'); offset += written; }
    } catch {
      this.close(); this.lastError = '文件日志写入失败，已停止写入；检查磁盘和目录后重新保存配置';
      this.console.error(this.lastError, 'RuntimeLogger');
    }
  }
  private closeFd(fd: number): void { try { closeSync(fd); } catch { /* A failed close cannot roll back a committed setting. */ } }
}
