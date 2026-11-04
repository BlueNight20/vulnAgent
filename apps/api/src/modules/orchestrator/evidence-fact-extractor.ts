import type { FactCategory, FactObservationKind } from '@vulnagent/shared';
import { isIP } from 'node:net';

/**
 * 从工具原始输出中确定性提取事实（纯函数）。
 *
 * 设计目的：**不依赖模型主动输出结构化 facts**。
 * 模型经常只写摘要而漏掉具体端口/路径，导致黑板长期为空。
 * 这里直接解析 nmap / gobuster / httpx 等常见输出格式，
 * 产生有确凿证据支撑的 observed 事实。
 *
 * 重要：只提取**明确出现在输出中**的条目；识别不到就返回空数组，
 * 绝不推测（避免把「没扫到」写成「不存在」）。
 */

export interface ExtractedFact {
  targetIp?: string;
  category: FactCategory;
  subject: string;
  predicate: string;
  object: string;
  observationKind: FactObservationKind;
  confidence: number;
}

/** nmap 端口行：`80/tcp   open  http    Apache httpd 2.4.29` */
const NMAP_PORT_RE = /^(\d{1,5})\/(tcp|udp)\s+(open|open\|filtered|filtered|closed)\s+(\S+)?\s*(.*)$/i;

/** httpx / 通用 HTTP 状态行：`http://host/ [200] [Apache]` */
const HTTP_LINE_RE = /^(https?:\/\/\S+)\s+\[(\d{3})\]/i;

/** gobuster / ffuf 路径行：`/admin                (Status: 301) [Size: 0]` */
const DIR_LINE_RE = /^(\/\S*)\s+\(Status:\s*(\d{3})\)/i;
const FFUF_LINE_RE = /^(\S+)\s+\[Status:\s*(\d{3})/i;

/** Apache/Nginx 版本：`Server: Apache/2.4.29 (Ubuntu)` */
const SERVER_RE = /server:\s*([^\r\n]+)/i;

export function extractFacts(
  toolName: string,
  targetIp: string | null,
  output: string,
  categoryHint: FactCategory = 'technology',
): ExtractedFact[] {
  if (!output) return [];
  // A transport error is an execution observation, not a successful target response.
  // Anchor at the beginning so error text inside a valid HTTP response remains source data.
  if (/^\s*(?:error:\s*(?:connection refused|connection timed out|network is unreachable|could not resolve host)|curl:\s*\(\d+\))/i.test(output)) {
    return [{ category: 'technology', subject: `工具:${toolName}`, predicate: 'probe_failed_transport', object: '连接或传输失败，本次未获得目标响应', observationKind: 'probe_error', confidence: 0.95 }];
  }
  let stdout: string | null = null;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const payload = parsed && typeof parsed.result === 'object' && parsed.result !== null ? parsed.result as Record<string, unknown> : parsed;
    if (payload && typeof payload === 'object') {
      if (typeof payload.return_code === 'number' && payload.return_code !== 0 && payload.return_code !== 127) {
        return [{ category: 'technology', subject: `工具:${toolName}`, predicate: 'probe_failed', object: `工具返回退出码 ${payload.return_code}，本次执行未正常完成`, observationKind: 'probe_error', confidence: 0.95 }];
      }
      if (typeof payload.stdout === 'string') stdout = payload.stdout;
    }
  } catch { /* 普通工具文本无需 JSON 解包。 */ }
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  // ---- 工具包装器失败：明确是探测失败，与目标状态无关 ----
  // HexStrike 的包装器在二进制缺失时返回 return_code 127 + "xxx: not found"，
  // 这类输出必须记成 probe_error，绝不能写成「目标没有该服务」。
  const wrapperFailed =
    /"return_code":\s*127/.test(output) ||
    /return_code\s*127/.test(output) ||
    /\/bin\/sh:\s*\d*:?\s*\S+:\s*not found/i.test(output) ||
    /failed_with/i.test(output);

  if (wrapperFailed) {
    const missing =
      output.match(/\/bin\/sh:\s*\d*:?\s*([\w.-]+):\s*not found/i)?.[1] ??
      output.match(/([\w.-]+):\s*not found/i)?.[1] ??
      'unknown';
    return [
      {
        category: 'technology',
        subject: `工具:${missing}`,
        predicate: 'probe_failed_binary_missing',
        object: `工具二进制缺失或包装器执行失败（${missing}: not found），本次未获得目标数据`,
        observationKind: 'probe_error',
        confidence: 0.95,
      },
    ];
  }

  let currentTarget = targetIp && isIP(targetIp) ? targetIp : null;
  const push = (fact: ExtractedFact) => {
    if (currentTarget && !fact.targetIp) fact.targetIp = currentTarget;
    const key = `${fact.subject}|${fact.predicate}|${fact.object}`;
    if (seen.has(key)) return;
    seen.add(key);
    facts.push(fact);
  };

  const lines = (stdout ?? output).split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const report = line.match(/^Nmap scan report for (.+)$/i);
    if (report) {
      const address = report[1].match(/\(([^()]+)\)\s*$/)?.[1] ?? report[1].trim();
      currentTarget = isIP(address) ? address : null;
      continue;
    }
    // 头部不能解析出地址时，不把后一主机的结果错误归入前一主机。
    if (!currentTarget && !HTTP_LINE_RE.test(line)) continue;
    if (/^Host is up\b/i.test(line)) {
      push({ category: 'asset', subject: currentTarget!, predicate: 'is_alive', object: line, observationKind: 'target_state', confidence: 0.9 });
      continue;
    }
    const os = line.match(/^OS details:\s*(.+)$/i);
    if (os) {
      push({ category: 'asset', subject: currentTarget!, predicate: 'os_fingerprint', object: os[1], observationKind: 'target_state', confidence: 0.7 });
      continue;
    }

    // ---- 端口与服务 ----
    const portMatch = line.match(NMAP_PORT_RE);
    if (portMatch) {
      const [, port, proto, state, service, version] = portMatch;
      if (Number(port) < 1 || Number(port) > 65535) continue;
      const host = isIP(currentTarget!) === 6 ? `[${currentTarget}]` : currentTarget;
      const subject = `${host}:${port}/${proto.toLowerCase()}`;
      if (state.toLowerCase() === 'open') {
        push({
          category: 'service',
          subject,
          predicate: 'has_open_port',
          object: `${port}/${proto} ${service || 'unknown'}${version ? ` ${version.trim()}` : ''}`.trim(),
          observationKind: 'target_state',
          confidence: 0.92,
        });
        if (service && service !== 'unknown') {
          push({
            category: 'service',
            subject,
            predicate: 'runs_service',
            object: `${service}${version ? ` ${version.trim()}` : ''}`.trim(),
            observationKind: 'target_state',
            confidence: 0.9,
          });
        }
      } else if (state.toLowerCase() === 'closed') {
        push({
          category: 'service',
          subject,
          predicate: 'port_closed',
          object: `${port}/${proto} closed`,
          observationKind: 'target_negative',
          confidence: 0.85,
        });
      } else if (state.toLowerCase() === 'filtered' || state.toLowerCase().includes('filtered')) {
        push({
          category: 'service',
          subject,
          predicate: 'port_filtered',
          object: `${port}/${proto} ${state}（有防火墙或包过滤，无法判定服务状态）`,
          observationKind: 'target_negative',
          confidence: 0.7,
        });
      }
      continue;
    }

    // ---- HTTP 端点与状态码 ----
    const httpMatch = line.match(HTTP_LINE_RE);
    if (httpMatch) {
      const [, url, code] = httpMatch;
      let observedTarget = currentTarget;
      try {
        const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
        if (isIP(hostname)) observedTarget = hostname;
      } catch { continue; }
      if (!observedTarget) continue;
      currentTarget = observedTarget;
      push({
        targetIp: observedTarget,
        category: 'technology',
        subject: url,
        predicate: 'responds_with_status',
        object: `HTTP ${code}`,
        observationKind: 'target_state',
        confidence: 0.9,
      });
      continue;
    }

    // ---- 目录/文件发现 ----
    const dirMatch = line.match(DIR_LINE_RE) ?? line.match(FFUF_LINE_RE);
    if (dirMatch) {
      const [, path, code] = dirMatch;
      const normalized = path.startsWith('/') ? path : `/${path}`;
      // 只记录有意义的响应码
      if (['200', '301', '302', '401', '403', '500'].includes(code)) {
        push({
          category: 'technology',
          subject: `${currentTarget} web`,
          predicate: 'exposes_path',
          object: `${normalized} → HTTP ${code}`,
          observationKind: code === '403' ? 'target_negative' : 'target_state',
          confidence: 0.85,
        });
      }
      continue;
    }

    // ---- 服务版本头 ----
    const serverMatch = line.match(SERVER_RE);
    if (serverMatch) {
      const value = serverMatch[1].trim().slice(0, 120);
      if (value.length > 0) {
        push({
          category: 'asset',
          subject: currentTarget!,
          predicate: 'server_header',
          object: value,
          observationKind: 'target_state',
          confidence: 0.88,
        });
      }
    }
  }

  // 保底：输出里完全没有结构化信息时，不生成任何事实
  void toolName;
  void categoryHint;
  return facts;
}
