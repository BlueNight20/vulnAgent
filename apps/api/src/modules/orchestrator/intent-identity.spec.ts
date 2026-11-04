import { describe, expect, it } from 'vitest';
import { intentIdentity } from './intent-identity';
const base = { title: '验证标题', objective: '验证 http://target/a?user=1 的访问控制', hypothesis: '匿名访问', workerProfileId: 'web', targetIp: 'target', suggestedTools: ['http_repeater'] };
describe('服务端意图身份', () => {
  it('改变展示标题和工具顺序不会重新创建同一意图', () => {
    expect(intentIdentity(base)).toBe(intentIdentity({ ...base, title: '换一种表述' }));
    expect(intentIdentity({ ...base, suggestedTools: ['a', 'b'] })).toBe(intentIdentity({ ...base, suggestedTools: ['b', 'a', 'a'] }));
  });
  it('资源、认证假设、验证方法和新依据均保持独立', () => {
    for (const patch of [{ objective: '验证 http://target/b 的访问控制' }, { hypothesis: '普通用户身份访问' }, { suggestedTools: ['another_tool'] }, { factIds: ['new-evidence-fact'] }]) {
      expect(intentIdentity({ ...base, ...patch })).not.toBe(intentIdentity(base));
    }
  });
});
