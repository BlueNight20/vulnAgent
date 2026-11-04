import { describe, expect, it } from 'vitest';
import {
  argumentFingerprint,
  checkScope,
  extractTargets,
  ipInCidr,
  type ScopePolicy,
} from './scope-guard';

const policy: ScopePolicy = {
  allowedIps: ['192.168.56.101'],
  allowedCidrs: ['192.168.56.0/24'],
  allowedHostnames: ['lab.local'],
};

describe('Scope 目标提取', () => {
  it('提取单个 IP', () => {
    const targets = extractTargets({ target: '192.168.56.101' });
    expect(targets).toEqual([{ raw: '192.168.56.101', kind: 'ip', normalized: '192.168.56.101' }]);
  });

  it('提取数组中的多个目标', () => {
    const targets = extractTargets({ targets: ['192.168.56.101', '192.168.56.102'] });
    expect(targets.map((t) => t.normalized)).toEqual(['192.168.56.101', '192.168.56.102']);
  });

  it('提取非白名单字段名中的 IP（防绕过）', () => {
    const targets = extractTargets({ destination_range: '10.0.0.5' });
    expect(targets.map((t) => t.normalized)).toEqual(['10.0.0.5']);
  });

  it('提取 CIDR', () => {
    const targets = extractTargets({ subnet: '192.168.56.0/24' });
    expect(targets[0]).toMatchObject({ kind: 'cidr', normalized: '192.168.56.0/24' });
  });

  it('从 URL 中提取主机', () => {
    expect(extractTargets({ url: 'http://192.168.56.101:80/admin' })[0]).toMatchObject({
      kind: 'ip',
      normalized: '192.168.56.101',
    });
    expect(extractTargets({ url: 'https://lab.local/app' })[0]).toMatchObject({
      kind: 'hostname',
      normalized: 'lab.local',
    });
  });

  it('域名也能被识别', () => {
    const targets = extractTargets({ host: 'evil.example.com' });
    expect(targets[0]).toMatchObject({ kind: 'hostname', normalized: 'evil.example.com' });
  });

  it('跳过端口与选项类字段', () => {
    expect(extractTargets({ ports: '1-1000', scan_type: '-sT' })).toEqual([]);
  });

  it('递归处理嵌套对象', () => {
    const targets = extractTargets({ config: { host: '192.168.56.101' } });
    expect(targets).toHaveLength(1);
  });
});

describe('Scope 校验', () => {
  it('授权 IP 放行', () => {
    const verdict = checkScope(extractTargets({ target: '192.168.56.101' }), policy);
    expect(verdict.allow).toBe(true);
  });

  it('授权网段内的其他 IP 也放行', () => {
    expect(checkScope(extractTargets({ target: '192.168.56.200' }), policy).allow).toBe(true);
  });

  it('网段外 IP 被拒绝', () => {
    const verdict = checkScope(extractTargets({ target: '10.0.0.5' }), policy);
    expect(verdict.allow).toBe(false);
    expect(verdict.violations[0].normalized).toBe('10.0.0.5');
  });

  it('多目标中任一越界即拒绝（不只看第一个）', () => {
    const verdict = checkScope(
      extractTargets({ targets: ['192.168.56.101', '10.0.0.5'] }),
      policy,
    );
    expect(verdict.allow).toBe(false);
    expect(verdict.violations).toHaveLength(1);
  });

  it('请求网段超出授权网段时拒绝', () => {
    expect(checkScope(extractTargets({ subnet: '192.168.0.0/16' }), policy).allow).toBe(false);
    expect(checkScope(extractTargets({ subnet: '192.168.56.0/25' }), policy).allow).toBe(true);
  });

  it('未授权域名被拒绝', () => {
    expect(checkScope(extractTargets({ host: 'evil.com' }), policy).allow).toBe(false);
  });

  it('授权域名的子域放行', () => {
    expect(checkScope(extractTargets({ host: 'api.lab.local' }), policy).allow).toBe(true);
  });

  it('无目标时标记 noTarget 而不是静默放行', () => {
    const verdict = checkScope([], policy);
    expect(verdict.noTarget).toBe(true);
  });

  it('数组参数里的越界目标不会被忽略', () => {
    const verdict = checkScope(extractTargets({ targets: ['10.1.1.1'] }), policy);
    expect(verdict.allow).toBe(false);
  });
});

describe('CIDR 计算', () => {
  it('/24 网段判断', () => {
    expect(ipInCidr('192.168.56.10', '192.168.56.0/24')).toBe(true);
    expect(ipInCidr('192.168.57.10', '192.168.56.0/24')).toBe(false);
  });

  it('/32 精确匹配', () => {
    expect(ipInCidr('192.168.56.101', '192.168.56.101/32')).toBe(true);
    expect(ipInCidr('192.168.56.102', '192.168.56.101/32')).toBe(false);
  });

  it('/0 匹配所有', () => {
    expect(ipInCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
  });

  it('非法 CIDR 返回 false', () => {
    expect(ipInCidr('192.168.56.1', 'not-a-cidr')).toBe(false);
  });
});

describe('参数指纹', () => {
  it('相同参数生成相同指纹', () => {
    expect(argumentFingerprint('nmap_scan', { target: 'a', ports: '80' })).toBe(
      argumentFingerprint('nmap_scan', { ports: '80', target: 'a' }),
    );
  });

  it('不同工具或不同参数指纹不同', () => {
    expect(argumentFingerprint('nmap_scan', { target: 'a' })).not.toBe(
      argumentFingerprint('nikto_scan', { target: 'a' }),
    );
    expect(argumentFingerprint('nmap_scan', { target: 'a' })).not.toBe(
      argumentFingerprint('nmap_scan', { target: 'b' }),
    );
  });
});
