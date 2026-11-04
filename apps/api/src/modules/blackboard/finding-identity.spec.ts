import { describe, expect, it } from 'vitest';
import { findingIdentity, findingClueLevel } from './finding-identity';
const fact = { targetIp: '192.168.1.1', subject: 'http://example.test:80/', predicate: 'directory_listing_enabled', object: 'Index of /' };
describe('漏洞身份', () => {
  it('保留目录索引线索，但有敏感数据影响时提升为漏洞候选', () => {
    expect(findingClueLevel('directory_listing_enabled', 'Index of /')).toBe('weakness');
    expect(findingClueLevel('directory_listing_enabled', '目录索引导致源码泄露')).toBe('actionable');
    expect(findingClueLevel('unknown_vulnerability')).toBe('actionable');
  });
  it('相同目录的不同输出描述合并', () => {
    expect(findingIdentity(fact)).toBe(findingIdentity({ ...fact, subject: 'http://example.test/', object: '<title>Index of /</title>' }));
  });
  it('端口、虚拟主机、路径和参数保持区分', () => {
    for (const subject of ['http://example.test:8080/', 'http://other.test/', 'http://example.test/Admin', 'http://example.test/?user=1']) {
      expect(findingIdentity({ ...fact, subject })).not.toBe(findingIdentity(fact));
    }
  });
  it('未知漏洞的不同现象不按 IP 粗暴合并', () => {
    expect(findingIdentity({ ...fact, predicate: 'injection', object: 'parameter a' })).not.toBe(findingIdentity({ ...fact, predicate: 'injection', object: 'parameter b' }));
  });
});
