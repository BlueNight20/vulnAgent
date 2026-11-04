import { createHash } from 'node:crypto';

export function findingIdentity(input: { subject: string; predicate: string; object: string; targetIp: string | null }) {
  let resource = input.subject.trim();
  try {
    const url = new URL(resource.includes('://') ? resource : `http://${resource}`);
    if (url.hostname && /[.:]/.test(url.hostname)) resource = url.toString();
  } catch { /* 无结构化资源时保留原文，避免错误合并。 */ }
  const predicate = input.predicate.trim().toLowerCase().replace(/[\s-]+/g, '_');
  // 仅对语义明确、资源绑定的配置项忽略模型的不同描述；其他漏洞保留现象区别。
  const stableConfiguration = ['directory_listing_enabled', 'missing_security_headers'].includes(predicate);
  const headerNames = [...new Set(input.object.match(/(?:x-frame-options|content-security-policy|strict-transport-security|x-content-type-options|referrer-policy|permissions-policy)/gi)?.map((h) => h.toLowerCase()) ?? [])].sort();
  const detail = predicate === 'missing_security_headers' ? headerNames.join(',') || input.object.trim()
    : stableConfiguration ? '' : input.object.trim();
  return createHash('sha256').update(JSON.stringify([input.targetIp, resource, predicate, detail])).digest('hex');
}

export function findingTitle(subject: string, predicate: string): string {
  const labels: Record<string, string> = { directory_listing_enabled: '目录索引开放', missing_security_headers: '安全响应头缺失' };
  return `${subject} · ${labels[predicate] ?? predicate.replace(/_/g, ' ')}`.slice(0, 200);
}

/** 仅将明确的配置弱点分层，未知漏洞仍保留验证机会。 */
export function findingClueLevel(predicate: string, description = ''): 'actionable' | 'weakness' {
  const known = /missing_security_headers|directory_listing_enabled|version_disclosure|安全响应头缺失|缺少安全响应头|目录索引|目录列表|版本泄露/i;
  const impact = /凭据泄露|源码泄露|敏感文件|认证绕过|任意文件|命令执行|credential leak|source code expos|authentication bypass/i;
  return known.test(`${predicate} ${description}`) && !impact.test(description) ? 'weakness' : 'actionable';
}
