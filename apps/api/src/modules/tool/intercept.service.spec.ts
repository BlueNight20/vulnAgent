import { describe, expect, it, vi } from 'vitest';
import { InterceptService, type RuleInput } from './intercept.service';

/** 规则形状（避免在单测里引用 TypeORM 实体；实体由迁移与类型检查保证）。 */
interface RuleRow {
  id: string; name: string; enabled: boolean; priority: number;
  matchTarget: 'tool_name' | 'tool_input'; matchType: 'string' | 'regex'; pattern: string;
  action: 'allow' | 'deny' | 'ask'; message: string | null;
  timeoutEnabled: boolean; timeoutSeconds: number | null; timeoutAction: 'deny' | 'allow' | null;
  createdAt: Date; updatedAt: Date;
}

function service(seed: Partial<RuleRow>[] = []) {
  const rows: RuleRow[] = seed.map((row, index) => ({
    id: `r${index}`, enabled: true, priority: 0, matchTarget: 'tool_name', matchType: 'string',
    pattern: '', action: 'deny', message: null, timeoutEnabled: false, timeoutSeconds: null,
    timeoutAction: null, createdAt: new Date(), updatedAt: new Date(), name: `规则${index}`, ...row,
  }));
  const repo = {
    find: async (options?: { where?: { enabled?: boolean } }) => {
      const list = options?.where?.enabled ? rows.filter((r) => r.enabled) : rows;
      return [...list].sort((a, b) => b.priority - a.priority);
    },
    findOneBy: async ({ id }: { id: string }) => rows.find((r) => r.id === id) ?? null,
    create: (value: Partial<RuleRow>) => value as RuleRow,
    save: async (value: RuleRow) => value,
    delete: async () => ({ affected: 1 }),
  };
  const audit = { record: vi.fn(async () => ({})) };
  return { svc: new InterceptService(repo as never, audit as never), audit };
}

const base = (over: Partial<RuleInput> = {}): RuleInput => ({ name: '规则', pattern: 'rm -rf', action: 'deny', ...over });

describe('拦截规则匹配', () => {
  it('优先级高者先命中，首个命中即生效', async () => {
    const { svc } = service([
      { name: '低', priority: 1, pattern: 'nmap', action: 'allow' },
      { name: '高', priority: 9, pattern: 'nmap', action: 'deny', message: '禁止扫描' },
    ]);
    const hit = await svc.match('nmap_scan', {});
    expect(hit?.rule.name).toBe('高');
    expect(hit?.action).toBe('deny');
  });

  it('按工具名或入参文本匹配', async () => {
    const { svc } = service([
      { name: '按工具', matchTarget: 'tool_name', pattern: 'shell', action: 'deny' },
      { name: '按入参', matchTarget: 'tool_input', pattern: 'rm -rf', action: 'ask', priority: 5 },
    ]);
    expect((await svc.match('shell_exec', { cmd: 'ls' }))?.rule.name).toBe('按工具');
    expect((await svc.match('shell_exec', { cmd: 'rm -rf /' }))?.rule.name).toBe('按入参');
    expect(await svc.match('http_get', { url: 'https://x' })).toBeNull();
  });

  it('正则规则按工具名时大小写不敏感', async () => {
    const { svc } = service([{ name: '正则', matchType: 'regex', pattern: '^nmap', action: 'deny' }]);
    expect((await svc.match('NMAP_SCAN', {}))?.rule.name).toBe('正则');
  });

  it('无效正则按不匹配处理，不误拦', async () => {
    const { svc } = service([{ name: '坏正则', matchType: 'regex', pattern: '([', action: 'deny' }]);
    expect(await svc.match('anything', {})).toBeNull();
  });

  it('停用规则不参与匹配', async () => {
    const { svc } = service([{ name: '停用', enabled: false, pattern: 'nmap', action: 'deny' }]);
    expect(await svc.match('nmap_scan', {})).toBeNull();
  });
});

describe('拦截规则维护', () => {
  it('ask 之外的策略不保留超时配置', async () => {
    const { svc } = service();
    const saved = await svc.create(base({ action: 'deny', timeoutEnabled: true, timeoutSeconds: 30, timeoutAction: 'allow' }));
    expect(saved.timeoutEnabled).toBe(false);
    expect(saved.timeoutSeconds).toBeNull();
    expect(saved.timeoutAction).toBeNull();
  });

  it('ask 启用超时但配置不完整时拒绝保存', async () => {
    const { svc } = service();
    await expect(svc.create(base({ action: 'ask', timeoutEnabled: true, timeoutSeconds: null }))).rejects.toThrow(/大于 0 的秒数/);
    await expect(svc.create(base({ action: 'ask', timeoutEnabled: true, timeoutSeconds: 30, timeoutAction: null }))).rejects.toThrow(/超时后动作/);
  });

  it('非法正则与空模式在保存时拒绝', async () => {
    const { svc } = service();
    await expect(svc.create(base({ matchType: 'regex', pattern: '(' }))).rejects.toThrow(/正则表达式无法编译/);
    await expect(svc.create(base({ pattern: '' }))).rejects.toThrow(/匹配模式不能为空/);
  });

  it('修改、切换与删除都写入审计', async () => {
    const { svc, audit } = service([{ name: '原规则', priority: 1, pattern: 'a', action: 'deny' }]);
    await svc.update('r0', base({ name: '新规则', pattern: 'b', priority: 5 }));
    await svc.toggle('r0', false);
    await svc.remove('r0');
    expect(audit.record).toHaveBeenCalledTimes(3);
    const actions = audit.record.mock.calls.map((call) => (call[0] as { action: string }).action);
    expect(actions).toEqual(['intercept.rule_updated', 'intercept.rule_toggled', 'intercept.rule_deleted']);
  });

  it('操作不存在的规则返回不存在', async () => {
    const { svc } = service();
    await expect(svc.update('missing', base())).rejects.toThrow(/不存在/);
    await expect(svc.remove('missing')).rejects.toThrow(/不存在/);
  });
});
