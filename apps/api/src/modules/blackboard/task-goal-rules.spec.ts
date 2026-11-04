import { describe, expect, it } from 'vitest';
import type { TaskGoal } from '@vulnagent/shared';
import { configureGoal, evaluateGoal, portSet, proofsCoverRange, type GoalProof } from './task-goal-rules';

const ip = '192.168.56.101';
const goal = (over: Partial<TaskGoal> = {}): TaskGoal => ({ mode: 'recon', targets: [ip], ports: '80,443', protocol: 'tcp', evidenceText: null, configuredAt: '2026-11-02T00:00:00Z', ...over });
const proof = (over: Partial<GoalProof> = {}): GoalProof => ({ id: 'e', targetIp: ip, toolName: 'nmap_scan', args: { target: ip, ports: '80,443', scan_type: '-sT -Pn' }, text: '80/tcp open http\n443/tcp closed https', ...over });
const passed = (g: TaskGoal, proofs: GoalProof[]) => evaluateGoal(g, [], proofs, [], false);

describe('任务目标的实际证据验收', () => {
  it('网段与端口分批可以合并验收，重复批次不能填补遗漏地址或端口', () => {
    const g = goal({ targets: ['192.168.56.0/30'] });
    const batch = (target: string, ports: string, count = 2) => proof({ id: `${target}:${ports}`, targetIp: null, args: { target, ports, scan_type: '-sT -Pn' }, text: `Nmap done: ${count} IP addresses (0 hosts up) scanned` });
    const rows = [batch('192.168.56.0/31', '80'), batch('192.168.56.2/31', '80'), batch('192.168.56.0/31', '443')];
    expect(passed(g, rows).complete).toBe(false);
    expect(passed(g, [...rows, rows[2]]).complete).toBe(false);
    expect(passed(g, [...rows, batch('192.168.56.2/31', '443')]).complete).toBe(true);
    expect(passed(g, [...rows, batch('192.168.56.2/31', '443', 1)]).complete).toBe(false);
    expect(passed(g, rows).checks[0].label).toContain('尚缺 443');
    expect(proofsCoverRange(rows, '192.168.56.0/30')).toBe(true);
    expect(proofsCoverRange([rows[0], rows[0]], '192.168.56.0/30')).toBe(false);
  });
  it('网段的逐 IP 完成记录可以覆盖地址，但缺失地址不能被相邻范围替代', () => {
    const g = goal({ targets: ['192.168.56.0/31'], ports: '80' });
    const row = (target: string) => proof({ args: { target, ports: '80', scan_type: '-sT -Pn' }, text: 'Nmap done: 1 IP address (0 hosts up) scanned' });
    expect(passed(g, [row('192.168.56.0'), row('192.168.56.1')]).complete).toBe(true);
    expect(passed(g, [row('192.168.56.0'), row('192.168.56.2')]).complete).toBe(false);
  });
  it('未配置的旧任务不自动推断目标', () => { expect(evaluateGoal(null, [], [], [], false).configured).toBe(false); });
  it('不同端口均有当前观测才满足，开放与关闭都属于明确观测', () => {
    expect(passed(goal(), [proof()]).complete).toBe(true);
    expect(passed(goal(), [proof({ text: '80/tcp open http' })]).complete).toBe(false);
  });
  it('重复端口结果或无结构化内容不能凑足覆盖', () => {
    expect(passed(goal(), [proof({ text: '80/tcp open http\n80/tcp open http\n80/tcp open http' })]).complete).toBe(false);
    expect(passed(goal(), [proof({ text: 'three useful facts' })]).complete).toBe(false);
  });
  it('只有对应协议的端口可以满足目标', () => {
    expect(passed(goal(), [proof({ text: '80/udp open domain\n443/udp open domain' })]).complete).toBe(false);
    expect(passed(goal({ protocol: 'udp' }), [proof({ text: '80/udp open domain\n443/udp open domain' })]).complete).toBe(true);
    const p = proof({ args: { target: ip, ports: '80,443', flags: '-sU -Pn' }, text: `Nmap scan report for ${ip}\nNot shown: 2 closed udp ports\nNmap done: 1 IP address (1 host up) scanned` });
    expect(passed(goal(), [p]).complete).toBe(false);
    expect(passed(goal({ protocol: 'udp' }), [p]).complete).toBe(true);
  });
  it('HTTP 内容中看似扫描结果的文本不能证明端口覆盖', () => {
    expect(passed(goal(), [proof({ toolName: 'http_repeater' })]).complete).toBe(false);
  });
  it('完成的 Nmap 范围扫描可以解释压缩的 closed/filtered 结果', () => {
    const p = proof({ args: { target: ip, ports: '1-1000', scan_type: '-sT -Pn' }, text: `Nmap scan report for ${ip}\nHost is up.\nNot shown: 1000 filtered tcp ports\nNmap done: 1 IP address (1 host up) scanned in 3 seconds` });
    expect(passed(goal({ ports: '1-1000' }), [p]).complete).toBe(true);
    expect(passed(goal({ ports: '1-1000' }), [{ ...p, text: p.text.replace('Nmap done:', 'interrupted:') }]).complete).toBe(false);
  });
  it('主机发现和 Top ports 不冒充指定全范围扫描', () => {
    const p = proof({ args: { target: ip, ports: '1-1000', scan_type: '-sn' }, text: `Nmap scan report for ${ip}\nHost is up.\nNmap done: 1 IP address (1 host up) scanned in 1 seconds` });
    expect(passed(goal({ ports: '1-1000' }), [p]).complete).toBe(false);
    expect(passed(goal({ ports: '1-1000' }), [{ ...p, args: { ...p.args, scan_type: '--top-ports 100' } }]).complete).toBe(false);
  });
  it('参数端口与额外 flag 冲突时不采信整段覆盖，同集合不同顺序可接受', () => {
    const p = proof({ text: `Nmap scan report for ${ip}\nNot shown: 2 closed tcp ports\nNmap done: 1 IP address (1 host up) scanned in 1 seconds` });
    expect(passed(goal(), [{ ...p, args: { ...p.args, scan_type: '-sT -p 22' } }]).complete).toBe(false);
    expect(passed(goal(), [{ ...p, args: { ...p.args, scan_type: '-sT -p 443,80' } }]).complete).toBe(true);
  });
  it('CIDR 完成需要同范围、正确的扫描地址数量与端口配置', () => {
    const p = proof({ targetIp: null, args: { target: '192.168.56.0/24', ports: '80,443' }, text: 'Nmap done: 256 IP addresses (0 hosts up) scanned in 3 seconds' });
    expect(passed(goal({ targets: ['192.168.56.0/24'] }), [p]).complete).toBe(true);
    expect(passed(goal({ targets: ['192.168.56.0/24'] }), [{ ...p, text: 'Nmap done: 16 IP addresses (0 hosts up) scanned in 1 seconds' }]).complete).toBe(false);
    expect(passed(goal({ targets: ['192.168.56.0/24'] }), [p]).notes.join(' ')).toContain('不等于');
  });
  it('指定标记按目标归属，不能用另一主机的输出满足', () => {
    const g = goal({ mode: 'evidence', ports: null, evidenceText: 'FLAG-EXAMPLE-123' });
    expect(passed(g, [proof({ toolName: 'http_repeater', text: 'FLAG-EXAMPLE-123' })]).complete).toBe(true);
    expect(passed(g, [proof({ text: `Nmap scan report for ${ip}\nno flag here\nNmap scan report for 192.168.56.102\nFLAG-EXAMPLE-123` })]).complete).toBe(false);
    expect(passed(g, [proof({ toolName: 'httpx_probe', text: 'http://192.168.56.102/ [200]\nFLAG-EXAMPLE-123' })]).complete).toBe(false);
  });
  it('存在未完成工作、未分析或未复核候选都不能完成综合目标', () => {
    const g = goal({ mode: 'assessment' });
    expect(evaluateGoal(g, [], [proof()], [], false).complete).toBe(false);
    expect(evaluateGoal(g, [], [proof()], [{ id: 'v', title: '候选', passed: false }], false, [ip]).complete).toBe(false);
    expect(evaluateGoal(g, [], [proof()], [], false, [ip]).complete).toBe(true);
    expect(evaluateGoal(g, [], [proof()], [], true, [ip]).complete).toBe(false);
  });
  it('目标范围和端口必须是任务授权范围的子集', () => {
    const configure = (g: TaskGoal) => configureGoal(g, [ip], { cidrs: [], ports: '80,443' });
    expect(configure(goal()).configuredAt).toBeTruthy();
    expect(() => configure(goal({ targets: ['10.0.0.1'] }))).toThrow('授权范围');
    expect(() => configure(goal({ ports: '22' }))).toThrow('端口');
    expect(() => configure(goal({ mode: 'evidence', evidenceText: 'short' }))).toThrow('8 到');
  });
  it('URL 目标按 HTTP 响应验收，且只接受同主机同端口', () => {
    const url = 'http://challenge.qsnctf.com:56718/';
    const g = goal({ targets: [url], ports: null });
    const hit = proof({ id: 'h', targetIp: null, toolName: 'httpx_probe', args: { target: url }, text: 'http://challenge.qsnctf.com:56718/ [200]' });
    expect(passed(g, [hit]).complete).toBe(true);
    expect(passed(g, [{ ...hit, text: 'http://challenge.qsnctf.com:56718/ [403]' }]).complete).toBe(true);
    expect(passed(g, [{ ...hit, text: 'http://challenge.qsnctf.com:8080/ [200]' }]).complete).toBe(false);
    expect(passed(g, [{ ...hit, text: 'http://other.example.com:56718/ [200]' }]).complete).toBe(false);
    expect(passed(g, [hit]).checks[0].label).toContain('状态 200');
  });
  it('URL 与域名目标可以进入验收目标，跨主机仍被拒绝', () => {
    const url = 'http://challenge.qsnctf.com:56718/';
    const configure = (g: TaskGoal) => configureGoal(g, [url], { cidrs: [], ports: null });
    expect(configure(goal({ targets: [url], ports: null })).targets).toEqual([url]);
    expect(configure(goal({ targets: ['challenge.qsnctf.com'], ports: null })).targets).toEqual(['challenge.qsnctf.com']);
    expect(() => configure(goal({ targets: ['http://evil.example.com/'], ports: null }))).toThrow('授权范围');
  });
  it('端口范围计算有界、去重且拒绝非法输入', () => {
    expect([...portSet('80,80,81-82')]).toEqual([80, 81, 82]); expect(portSet('1-65535').size).toBe(65535); expect(portSet('1-99999999').size).toBe(0);
  });
});
