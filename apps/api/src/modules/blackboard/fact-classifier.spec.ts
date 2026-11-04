import { describe, expect, it } from 'vitest';
import { arbitrateConflict, classifyClue, classifyFact, isConflict, isEvidenceBackedKind } from './fact-classifier';

describe('事实观测类别判定', () => {
  it('无证据时归为模型推断，置信度不超过 0.5', () => {
    const result = classifyFact({ object: '可能存在弱口令', hasEvidence: false, rawConfidence: 0.95 });
    expect(result.kind).toBe('inference');
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });

  it('工具超时报错归为 probe_error，不能当作目标状态', () => {
    const result = classifyFact({
      object: 'Request timed out after 30s',
      hasEvidence: true,
      rawConfidence: 0.9,
    });
    expect(result.kind).toBe('probe_error');
    expect(result.confidence).toBeLessThanOrEqual(0.4);
  });

  it(' nikto 无法连接归为 probe_error（而非“没有 Web 服务”）', () => {
    const result = classifyFact({
      object: 'nikto: Unable to connect to target',
      hasEvidence: true,
    });
    expect(result.kind).toBe('probe_error');
    expect(isEvidenceBackedKind(result.kind)).toBe(false);
  });

  it('Connection refused 归为 target_negative', () => {
    const result = classifyFact({
      object: 'TCP connection refused (Errno 111)',
      hasEvidence: true,
    });
    expect(result.kind).toBe('target_negative');
    expect(isEvidenceBackedKind(result.kind)).toBe(true);
  });

  it('端口开放信息归为 target_state', () => {
    const result = classifyFact({ object: '80/tcp open http', hasEvidence: true });
    expect(result.kind).toBe('target_state');
  });

  it('服务版本信息归为 target_state', () => {
    const result = classifyFact({
      object: 'Server: Apache/2.4.29 (Ubuntu)',
      hasEvidence: true,
    });
    expect(result.kind).toBe('target_state');
  });

  it('失败优先于状态信号', () => {
    const result = classifyFact({
      object: 'port 80 open but scan aborted: timeout',
      hasEvidence: true,
    });
    expect(result.kind).toBe('probe_error');
  });

  it('工具二进制缺失归为 probe_error，不是「目标没有该服务」', () => {
    // 真实场景：HexStrike 包装器缺 smbmap，返回 /bin/sh: smbmap: not found
    const result = classifyFact({
      object: '工具包装器:smbmap_scan failed_with_binary_missing：/bin/sh: 1: smbmap: not found（return_code 127）',
      hasEvidence: true,
    });
    expect(result.kind).toBe('probe_error');
    expect(isEvidenceBackedKind(result.kind)).toBe(false);
  });

  it('return_code 127 归为 probe_error', () => {
    const result = classifyFact({ object: 'return_code 127, command failed', hasEvidence: true });
    expect(result.kind).toBe('probe_error');
  });

  it('裸 not found 不再被当成目标否定（避免工具缺失误判）', () => {
    const result = classifyFact({ object: 'nxc: not found', hasEvidence: true });
    expect(result.kind).toBe('probe_error');
  });

  it('HTTP 404 仍归为目标否定', () => {
    const result = classifyFact({ object: 'GET /missing -> HTTP 404', hasEvidence: true });
    expect(result.kind).toBe('target_negative');
  });

  it('probe_error 不可作为漏洞证据', () => {
    expect(isEvidenceBackedKind('probe_error')).toBe(false);
    expect(isEvidenceBackedKind('inference')).toBe(false);
    expect(isEvidenceBackedKind('target_state')).toBe(true);
  });
});

describe('事实冲突判定', () => {
  it('相同对象不构成冲突', () => {
    expect(
      isConflict(
        { object: '80/tcp open', kind: 'target_state' },
        { object: '80/tcp open', kind: 'target_state' },
      ),
    ).toBe(false);
  });

  it('open 与 closed 构成冲突', () => {
    expect(
      isConflict(
        { object: '80/tcp open http', kind: 'target_state' },
        { object: '80/tcp closed', kind: 'target_negative' },
      ),
    ).toBe(true);
  });

  it('probe_error 不参与冲突判定', () => {
    expect(
      isConflict(
        { object: '80/tcp open', kind: 'target_state' },
        { object: 'scan timeout', kind: 'probe_error' },
      ),
    ).toBe(false);
  });

  it('模型推断不参与冲突判定', () => {
    expect(
      isConflict(
        { object: '80/tcp open', kind: 'target_state' },
        { object: '80可能关闭', kind: 'inference' },
      ),
    ).toBe(false);
  });

  it('同一观测的不同措辞不算冲突（真实误报场景）', () => {
    // nmap 结果被两个 Worker 分别写成不同措辞
    expect(
      isConflict(
        { object: 'ftp (open, 服务名来自 nmap 默认端口映射，版本未知)', kind: 'target_state' },
        { object: 'ftp (port open, version unknown)', kind: 'target_state' },
      ),
    ).toBe(false);
  });

  it('服务名相同但描述不同不算冲突', () => {
    expect(
      isConflict(
        { object: 'http (open, 版本/Server 头未知)', kind: 'target_state' },
        { object: 'http (port open, version unknown)', kind: 'target_state' },
      ),
    ).toBe(false);
  });

  it('真实冲突仍然被识别：open vs closed', () => {
    expect(
      isConflict(
        { object: '80/tcp open http', kind: 'target_state' },
        { object: '80/tcp closed', kind: 'target_negative' },
      ),
    ).toBe(true);
  });

  it('归一化后包含关系不算冲突', () => {
    expect(
      isConflict(
        { object: 'ftp open', kind: 'target_state' },
        { object: 'ftp', kind: 'target_state' },
      ),
    ).toBe(false);
  });

  it('大小写与空白差异不算冲突', () => {
    expect(
      isConflict(
        { object: '  Apache 2.4  ', kind: 'target_state' },
        { object: 'apache 2.4', kind: 'target_state' },
      ),
    ).toBe(false);
  });
});

describe('线索等级判定', () => {
  it('命令执行、注入、凭据泄露属于可利用线索', () => {
    expect(classifyClue({ predicate: 'command_injection', object: '参数直接执行系统命令' }).level).toBe('actionable');
    expect(classifyClue({ predicate: 'found_password', object: '配置文件中发现数据库口令' }).level).toBe('actionable');
  });

  it('安全响应头缺失、目录索引属于加固建议', () => {
    expect(classifyClue({ predicate: 'missing_security_headers', object: 'X-Frame-Options 缺失' }).level).toBe('weakness');
    expect(classifyClue({ predicate: 'directory_listing_enabled', object: '目录索引开启' }).level).toBe('weakness');
  });

  it('登录被拒、爆破无结果是否定性观测，不构成漏洞', () => {
    expect(classifyClue({ predicate: 'anonymous_login_denied', object: '530 Login incorrect' }).level).toBe('non-finding');
    expect(classifyClue({ predicate: 'bounded_bruteforce_result', object: 'No valid accounts found' }).level).toBe('non-finding');
  });
});

describe('冲突自动裁决', () => {
  const base = { status: 'observed' as const, observationKind: 'target_state' as const, confidence: 0.8, evidenceCount: 1 };

  it('目标状态优先于目标否定', () => {
    const verdict = arbitrateConflict([
      { id: 'open', ...base },
      { id: 'closed', ...base, status: 'verified', observationKind: 'target_negative' },
    ]);
    expect(verdict?.winnerId).toBe('open');
    expect(verdict?.loserIds).toEqual(['closed']);
  });

  it('同类观测下证据条数更多者胜出', () => {
    const verdict = arbitrateConflict([
      { id: 'a', ...base, evidenceCount: 1 },
      { id: 'b', ...base, evidenceCount: 3 },
    ]);
    expect(verdict?.winnerId).toBe('b');
  });

  it('已裁决的冲突不再重复裁决', () => {
    expect(arbitrateConflict([{ id: 'a', ...base }, { id: 'b', ...base, status: 'refuted' }])).toBeNull();
  });

  it('少于两个有效取值时不裁决', () => {
    expect(arbitrateConflict([{ id: 'a', ...base }])).toBeNull();
  });
});
