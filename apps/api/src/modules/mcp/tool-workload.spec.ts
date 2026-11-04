import { describe, expect, it } from 'vitest';
import { checkToolWorkload, targetCount } from './tool-workload';
import { extractTargets } from './scope-guard';

const target = '192.168.56.101';
const check = (args: Record<string, unknown>, ports: string | null = null) => checkToolWorkload('nmap_scan', { target, scan_type: '-sT -Pn', ...args }, ports);
describe('确定性工具工作量与端口范围', () => {
  it('按地址、端口、协议组合限制单批，允许大任务分批', () => {
    expect(check({ ports: '1-1024' }).allow).toBe(true);
    expect(check({ ports: '1-1025' }).kind).toBe('workload_limit');
    expect(check({ target: '192.168.56.0/24', ports: '1-16' }).probes).toBe(4096);
    expect(check({ target: '192.168.56.0/24', ports: '1-17' }).kind).toBe('workload_limit');
    expect(check({ target: '192.168.56.0/24', ports: '1-16', scan_type: '-sT -sU -Pn' }).kind).toBe('workload_limit');
    expect(check({ target: '192.168.56.0/23', scan_type: '-sn -PE' }).kind).toBe('workload_limit');
    expect(check({ target: '192.168.56.0/24', scan_type: '-sn -PE' }).allow).toBe(true);
  });
  it('不会用 ports、-p- 或 top-ports 绕过显式授权', () => {
    expect(check({ ports: '80,443' }, '80,443').allow).toBe(true);
    expect(check({ ports: '22' }, '80,443').kind).toBe('unauthorised_target');
    expect(check({ scan_type: '-sT -Pn -p-' }).kind).toBe('workload_limit');
    expect(check({ scan_type: '-sT -Pn --top-ports 100' }, '80,443').kind).toBe('unauthorised_target');
    expect(check({ scan_type: '-sT -Pn --top-ports=1025' }).kind).toBe('workload_limit');
    expect(check({ top_ports: 1025 }).kind).toBe('workload_limit');
    expect(check({ ports: '80', options: '-p 443' }).kind).toBe('invalid_input');
  });
  it('额外目标文件、命令组合和无法核验的端口格式不得隐式放行', () => {
    for (const scan_type of ['-pT:1-65535', '-p http*', '-p "1-65535', '-iL hosts.txt', '--include-file=hosts.txt', '-Pn; echo test', '-sO', '-PS1-65535']) expect(check({ scan_type }).allow, scan_type).toBe(false);
  });
  it('对 URL、嵌套 request 和目标数组检查默认/显式端口，不解析载荷', () => {
    expect(checkToolWorkload('http_repeater', { request_spec: { url: `http://${target}:8080/a` } }, '80').allow).toBe(false);
    expect(checkToolWorkload('httpx_probe', { urls: [`http://${target}`, `https://${target}`] }, '80').allow).toBe(false);
    expect(checkToolWorkload('http_repeater', { request_spec: { url: `http://${target}`, body: { url: 'http://example.com:9999' } } }, '80').allow).toBe(true);
    expect(checkToolWorkload('http_repeater', { target, request_spec: { port: 443 } }, '80').allow).toBe(false);
  });
  it('地址数量不展开巨大 CIDR，允许操作者配置更大单批', () => {
    expect(targetCount(extractTargets({ target: '0.0.0.0/0' }))).toBe(4294967296);
    expect(check({ target: '0.0.0.0/0', ports: '80' }).allow).toBe(false);
    expect(checkToolWorkload('nmap_scan', { target, ports: '1-2048', scan_type: '-sT -Pn' }, null, { maxHosts: 1, maxPorts: 2048, maxProbes: 2048 }).allow).toBe(true);
  });
  it('有限端口授权不放行隐式主机发现，用户可显式选择跳过或 ICMP', () => {
    expect(check({ ports: '80', scan_type: '-sT' }, '80').allow).toBe(false);
    expect(check({ ports: '80', scan_type: '-sT -Pn' }, '80').allow).toBe(true);
    expect(check({ scan_type: '-sn -PE' }, '80').allow).toBe(true);
  });
});
