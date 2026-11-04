import { describe, expect, it } from 'vitest';
import { detectDeadEnds, findLooseEnds, inferStage } from './kill-chain';

const fact = (over: Partial<{ category: string; predicate: string; status: 'inferred' | 'observed' | 'verified' | 'refuted'; observationKind: string; id: string; subject: string; object: string }> = {}) => ({
  category: 'service',
  predicate: 'has_open_port',
  status: 'observed' as const,
  observationKind: 'target_state',
  id: 'f1',
  subject: '10.0.0.5:80/tcp',
  object: 'http',
  ...over,
});

describe('攻击链阶段推断', () => {
  it('只有资产存活时处于侦察阶段', () => {
    expect(inferStage([fact({ category: 'asset', predicate: 'is_alive' })])).toBe('recon');
  });

  it('确认服务后进入服务识别阶段', () => {
    expect(inferStage([fact({ category: 'asset', predicate: 'is_alive' }), fact()])).toBe('service-id');
  });

  it('发现技术面线索后进入入口点阶段', () => {
    expect(inferStage([fact(), fact({ category: 'technology', predicate: 'exposes_path' })])).toBe('entry-point');
  });

  it('出现漏洞类或凭据类事实时继续推进', () => {
    expect(inferStage([fact({ category: 'vulnerability', predicate: 'command_injection' })])).toBe('foothold');
    expect(inferStage([fact({ category: 'credential', predicate: 'found_password' })])).toBe('lateral');
    expect(inferStage([fact({ category: 'privilege', predicate: 'is_root' })])).toBe('privilege');
  });

  it('被推翻的与探测失败的事实不参与阶段推进', () => {
    expect(inferStage([
      fact(),
      fact({ category: 'vulnerability', predicate: 'x', status: 'refuted' }),
      fact({ category: 'privilege', predicate: 'y', observationKind: 'probe_error' }),
    ])).toBe('service-id');
  });
});

describe('死路识别', () => {
  it('同一方向多次目标侧失败判定为死路', () => {
    const dead = detectDeadEnds([
      { title: 'FTP 匿名登录验证', status: 'done' },
      { title: 'FTP 弱口令测试（第 1 次）', status: 'failed', failure: '530 Login incorrect' },
      { title: 'FTP 弱口令测试（第 2 次）', status: 'failed', failure: '530 Login incorrect' },
    ]);
    expect(dead).toHaveLength(1);
    expect(dead[0].reason).toContain('2 次');
  });

  it('环境性失败不构成死路', () => {
    const dead = detectDeadEnds([
      { title: '目录枚举（第 1 次）', status: 'failed', failure: '工具二进制缺失 not found' },
      { title: '目录枚举（第 2 次）', status: 'rejected', rejectedReason: 'tool_not_allowed' },
    ]);
    expect(dead).toHaveLength(0);
  });

  it('有成功记录的批量尝试不算死路', () => {
    const dead = detectDeadEnds([
      { title: '端口扫描', status: 'done' },
      { title: '端口扫描', status: 'failed', failure: 'timeout' },
    ]);
    expect(dead).toHaveLength(0);
  });
});

describe('未利用线索', () => {
  it('列出口径：凭据、路径、版本', () => {
    const ends = findLooseEnds([
      { id: 'c1', category: 'credential', subject: '10.0.0.5', predicate: 'found_password', object: 'admin:admin123', status: 'observed' },
      { id: 'p1', category: 'technology', subject: '10.0.0.5 web', predicate: 'exposes_path', object: '/search.php', status: 'observed' },
      { id: 'v1', category: 'service', subject: '10.0.0.5:80/tcp', predicate: 'runs_service', object: 'http 2.4.18', status: 'observed' },
    ], new Set());
    expect(ends.map((e) => e.factId).sort()).toEqual(['c1', 'p1', 'v1']);
  });

  it('已被意图引用或已推翻的线索不再提示', () => {
    const ends = findLooseEnds([
      { id: 'p1', category: 'technology', subject: '10.0.0.5 web', predicate: 'exposes_path', object: '/admin.php', status: 'observed' },
      { id: 'p2', category: 'technology', subject: '10.0.0.5 web', predicate: 'exposes_path', object: '/login.php', status: 'refuted' },
    ], new Set(['p1']));
    expect(ends).toHaveLength(0);
  });
});
