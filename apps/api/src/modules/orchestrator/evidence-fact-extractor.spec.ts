import { describe, expect, it } from 'vitest';
import { extractFacts } from './evidence-fact-extractor';

const IP = '192.168.56.101';

describe('从工具输出提取事实', () => {
  it('显式连接错误保留为探测失败，HTTP 正文中的同样文本不是工具失败', () => {
    for (const text of ['Error: connection refused', 'curl: (28) Operation timed out', 'Error: could not resolve host']) {
      expect(extractFacts('http_repeater', IP, text).map((f) => f.observationKind)).toEqual(['probe_error']);
    }
    expect(extractFacts('http_repeater', IP, 'HTTP/1.1 200 OK\nServer: nginx\n\nError: connection refused').some((f) => f.observationKind === 'probe_error')).toBe(false);
  });
  it('多主机扫描按每个报告头绑定地址，不覆盖为调用的首个 IP', () => {
    const facts = extractFacts('nmap_scan', IP, `Nmap scan report for ${IP}\nHost is up.\n80/tcp open http\nNmap scan report for second (192.168.56.102)\n22/tcp open ssh`);
    expect(facts.find((f) => f.subject === '192.168.56.102:22/tcp')?.targetIp).toBe('192.168.56.102');
    expect(facts.some((f) => f.subject === `${IP}:22/tcp`)).toBe(false);
    expect(facts.some((f) => f.predicate === 'is_alive' && f.targetIp === IP)).toBe(true);
  });

  it('CIDR 调用可由报告头识别主机，无法解析的下一报告不沿用上一主机', () => {
    const facts = extractFacts('nmap_scan', null, `Nmap scan report for ${IP}\n80/tcp open http\nNmap scan report for unresolved-host\n22/tcp open ssh`);
    expect(facts.filter((f) => f.predicate === 'has_open_port')).toHaveLength(1);
    expect(facts[0].targetIp).toBe(IP);
  });

  it('同端口 TCP 与 UDP 使用不同主体，IPv6 主体有明确地址边界', () => {
    const facts = extractFacts('nmap_scan', '::1', '53/tcp open domain\n53/udp open domain');
    expect(facts.some((f) => f.subject === '[::1]:53/tcp')).toBe(true);
    expect(facts.some((f) => f.subject === '[::1]:53/udp')).toBe(true);
  });

  it('解包 JSON stdout，非零退出码不得产生开放端口事实', () => {
    expect(extractFacts('nmap_scan', IP, JSON.stringify({ result: { return_code: 0, stdout: '80/tcp open http' } })).some((f) => f.predicate === 'has_open_port')).toBe(true);
    const failed = extractFacts('nmap_scan', IP, JSON.stringify({ return_code: 2, stdout: '80/tcp open http' }));
    expect(failed).toHaveLength(1);
    expect(failed[0].observationKind).toBe('probe_error');
  });

  it('HTTP 输出显式地址和随后的响应头归属该地址', () => {
    const facts = extractFacts('httpx_probe', IP, 'http://192.168.56.102/ [200]\nServer: nginx/1.24.0');
    expect(facts.every((f) => f.targetIp === '192.168.56.102')).toBe(true);
  });
  it('open|filtered 不得当作已确认开放端口或已识别服务', () => {
    const facts = extractFacts('nmap_scan', IP, '161/udp open|filtered snmp');
    expect(facts).toHaveLength(1);
    expect(facts[0].predicate).toBe('port_filtered');
    expect(facts[0].object).toContain('open|filtered');
    expect(facts.some((f) => f.predicate === 'runs_service' || f.predicate === 'has_open_port')).toBe(false);
  });
  it('解析 nmap 开放端口', () => {
    const output = [
      'PORT   STATE SERVICE VERSION',
      '22/tcp open  ssh     OpenSSH 7.2p2 Ubuntu',
      '80/tcp open  http    Apache httpd 2.4.29',
    ].join('\n');
    const facts = extractFacts('nmap_scan', IP, output);

    const port80 = facts.find((f) => f.subject === `${IP}:80/tcp` && f.predicate === 'has_open_port');
    expect(port80).toBeDefined();
    expect(port80?.observationKind).toBe('target_state');
    expect(port80?.object).toContain('http');
  });

  it('解析 nmap 服务版本', () => {
    const output = '80/tcp open  http    Apache httpd 2.4.29';
    const facts = extractFacts('nmap_scan', IP, output);
    const service = facts.find((f) => f.predicate === 'runs_service');
    expect(service?.object).toContain('Apache');
  });

  it('closed 端口记为 target_negative', () => {
    const output = '22/tcp closed ssh';
    const facts = extractFacts('nmap_scan', IP, output);
    expect(facts[0].observationKind).toBe('target_negative');
    expect(facts[0].predicate).toBe('port_closed');
  });

  it('filtered 端口提示无法判定服务状态', () => {
    const output = '445/tcp filtered microsoft-ds';
    const facts = extractFacts('nmap_scan', IP, output);
    expect(facts[0].observationKind).toBe('target_negative');
    expect(facts[0].object).toContain('无法判定');
  });

  it('解析 gobuster 目录发现', () => {
    const output = [
      '/admin                (Status: 301) [Size: 0]',
      '/user                 (Status: 200) [Size: 1234]',
      '/secret               (Status: 403) [Size: 299]',
    ].join('\n');
    const facts = extractFacts('gobuster_scan', IP, output);
    const paths = facts.filter((f) => f.predicate === 'exposes_path');
    expect(paths).toHaveLength(3);
    expect(paths[0].object).toContain('/admin');
    // 403 表示存在但无权限，归为 target_negative
    const forbidden = paths.find((p) => p.object.includes('/secret'));
    expect(forbidden?.observationKind).toBe('target_negative');
  });

  it('解析 HTTP 状态码', () => {
    const output = 'http://192.168.56.101/ [200] [Apache/2.4.29]';
    const facts = extractFacts('httpx_probe', IP, output);
    expect(facts[0].predicate).toBe('responds_with_status');
    expect(facts[0].object).toBe('HTTP 200');
  });

  it('解析 Server 头', () => {
    const output = 'Server: Apache/2.4.29 (Ubuntu)';
    const facts = extractFacts('http_repeater', IP, output);
    expect(facts.some((f) => f.predicate === 'server_header')).toBe(true);
  });

  it('无结构化信息时不生成任何事实（不推测）', () => {
    const output = 'scan started\nscan finished\nno results';
    expect(extractFacts('nmap_scan', IP, output)).toHaveLength(0);
  });

  it('空输出返回空数组', () => {
    expect(extractFacts('nmap_scan', IP, '')).toHaveLength(0);
  });

  it('无目标 IP 时不生成事实（无法归属）', () => {
    expect(extractFacts('nmap_scan', null, '80/tcp open http')).toHaveLength(0);
  });

  it('相同端口只记录一次', () => {
    const output = ['80/tcp open http Apache', '80/tcp open http Apache'].join('\n');
    const facts = extractFacts('nmap_scan', IP, output);
    const hasOpen = facts.filter((f) => f.predicate === 'has_open_port');
    expect(hasOpen).toHaveLength(1);
  });

  it('忽略非 open/closed/filtered 的中间状态行', () => {
    const output = 'PORT STATE SERVICE';
    expect(extractFacts('nmap_scan', IP, output)).toHaveLength(0);
  });
});
