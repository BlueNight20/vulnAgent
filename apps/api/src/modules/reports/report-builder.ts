import type { ReportSnapshot, ReportStats } from '@vulnagent/shared';

const statuses: Record<string, string> = { candidate: '候选', verifying: '验证中', confirmed: '已确认', refuted: '已排除', unconfirmed: '未确认' };
/** All dynamic strings remain literal Markdown text, including tool-controlled content. */
export const literal = (value: unknown): string => String(value ?? '未记录').replace(/[\r\n\t]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
function block(value: string): string {
  let longest = 2;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${value.replace(/\u0000/g, '')}\n${fence}`;
}

export function reportMarkdown(snapshot: ReportSnapshot, stats: Pick<ReportStats, 'kind' | 'findingCounts' | 'evidenceCount' | 'invalidEvidenceCount' | 'unmetChecks' | 'attachmentCount' | 'attachmentBytes'>): string {
  const s = snapshot; const t = s.task; const lines: string[] = [];
  const item = (label: string, value: unknown) => lines.push(`- ${label}：${literal(value)}`);
  lines.push(`# ${literal(t.name)} - ${stats.kind === 'final' ? '验收报告' : '阶段报告'}`, '', '## 测试摘要', '');
  item('快照时间（UTC）', s.capturedAt); item('任务 ID', t.id); item('任务状态', `${t.status} / ${s.engineStatus}`); item('停止原因', s.stopReason ?? '未记录');
  item('开始 / 结束时间', `${t.startedAt ?? '未启动'} / ${t.finishedAt ?? '未结束'}`);
  item('使用 Token / 预算', `${t.tokensUsed} / ${t.tokenBudget}`); item('时间预算（分钟）', t.timeBudgetMinutes);
  if (t.tokensCommitted) item('模型在途 / 未确认额度占用', `${t.tokensCommitted} tokens；该值不是已确认供应商用量，仍从可用额度扣除`);
  item('验收', s.acceptance.complete ? '所有验收项已满足' : `未满足 ${stats.unmetChecks} 项${s.acceptance.configured ? '' : '，尚未配置验收目标'}`);
  item('发现汇总', Object.entries(stats.findingCounts).map(([key, count]) => `${statuses[key]} ${count}`).join('；'));
  item('证据数量 / 无效来源数量', `${stats.evidenceCount} / ${stats.invalidEvidenceCount}`);
  item('二进制附件 / 字节数', `${stats.attachmentCount ?? 0} / ${stats.attachmentBytes ?? 0}`);
  lines.push('', '没有发现漏洞、没有响应或端口被过滤，均不能证明目标没有漏洞或服务。结论描述生成时已存储的观测，报告不会额外执行扫描。', '', '## 授权范围与验收', '');
  item('授权记录', t.authorizationRef ?? '未填写'); item('配置目标', t.targetIps.join(', ')); item('允许网段', t.scope.cidrs.join(', ') || '未额外配置'); item('允许端口', t.scope.ports ?? '未额外限制');
  if (s.acceptance.goal) { item('验收类型', s.acceptance.goal.mode); item('验收目标', s.acceptance.goal.targets.join(', ')); item('协议与端口', `${s.acceptance.goal.protocol} / ${s.acceptance.goal.ports ?? '原文标记'}`); if (s.acceptance.goal.evidenceText) item('原文标记', s.acceptance.goal.evidenceText); }
  for (const check of s.acceptance.checks) item(check.passed ? '已满足' : '未满足', `${check.label}${check.evidenceIds.length ? `；证据 ${check.evidenceIds.join(', ')}` : ''}`);
  for (const note of s.acceptance.notes) item('验收说明', note);
  lines.push('', '## 限制与未完成项', '');
  for (const warning of s.warnings) item('限制', warning);
  if (t.lastError) item('任务错误', t.lastError);
  for (const check of s.acceptance.checks.filter((c) => !c.passed)) item('待完成', check.label);
  lines.push('', '## 资产与服务观测', '');
  for (const asset of s.surface.assets) {
    lines.push(`### ${literal(asset.address)}`, ''); item('范围', asset.inScope ? '授权范围内' : '范围外观测，不构成执行授权'); item('存活', asset.aliveObserved ? '有存活观测' : '未知');
    for (const port of asset.ports) item('端口', `${port.port}/${port.protocol} ${port.states.join('|')}；${port.services.join(' / ') || '服务未识别'}；证据 ${[...new Set(port.observations.flatMap((o) => o.evidenceIds))].join(', ')}`);
    for (const observation of [...asset.technologies, ...asset.endpoints]) item('观测', `${observation.subject} ${observation.predicate}: ${observation.value}；证据 ${observation.evidenceIds.join(', ')}`);
    for (const gap of asset.gaps) item('信息缺口', gap);
  }
  if (!s.surface.assets.length) lines.push('没有资产观测。');
  lines.push('', '## 漏洞与候选详情', '');
  for (const entry of s.findings) {
    const f = entry.finding;
    lines.push(`### ${literal(f.title)} [${statuses[entry.effectiveStatus]}]`, '');
    item('发现 ID', f.id); item('目标', f.targetIp ?? '未知'); item('严重程度', f.severity); item('来源 / 存储状态', `${f.source} / ${f.status}`);
    if (entry.validationNote) item('验证限制', entry.validationNote);
    item('CVE / CWE / CVSS', `${f.cve ?? '未提供'} / ${f.cwe ?? '未提供'} / ${f.cvss ?? '未评级'}`);
    lines.push('', block(f.description), ''); item('候选来源证据', f.evidenceIds.join(', ') || '无');
      lines.push('', '修复建议：', '', block(f.remediation || '尚无针对该发现的修复建议。请在独立复核确认影响后制定修复与回归步骤；候选不得直接当作已确认漏洞。'), '');
      if (f.assessment) {
        item('人工维护版本 / 依据校验', `${f.assessment.revision} / ${f.assessment.valid ? '通过' : '失效，评级及编号不采用'}`);
        lines.push('', block(f.assessment.note), '');
        for (const issue of f.assessment.issues) item('维护依据限制', issue);
        for (const quote of f.assessment.evidenceQuotes) { item('维护引用', quote.evidenceId); lines.push('', block(quote.quote), ''); }
      }
    for (const record of entry.verifications) {
      item('验证记录', `${record.id} / ${record.outcome} / ${record.updatedAt}`); lines.push('', block(record.summary), '');
      item('候选基线', record.baselineEvidenceIds.join(', ') || '无'); item('验证证据', record.evidenceIds.join(', ') || '无');
      for (const quote of record.evidenceQuotes) { item('原文引用', quote.evidenceId); lines.push('', block(quote.quote), ''); }
    }
  }
  if (!s.findings.length) lines.push('没有漏洞候选记录；此结果不构成无漏洞证明。');
  if (s.hypotheses?.length) {
    lines.push('', '## 假设与依据快照', '', '以下冻结生成时的研究关系与来源校验；支持或反驳是分析解释，不能替代独立漏洞验证。相同原文按哈希去重，失效关系保留供核查。', '');
    for (const view of s.hypotheses) {
      const h = view.hypothesis;
      lines.push(`### ${literal(h.title)}`, '');
      item('假设 ID / 目标', `${h.id} / ${h.targetIp ?? '未绑定'}`);
      item('分析状态', h.conflicted ? '支持与反驳冲突，待验证' : h.status);
      item('支持 / 反驳来源 / 无效旧关联', `${h.supportCount} / ${h.contradictCount} / ${h.invalidLinkCount ?? 0}`);
      lines.push('', block(h.description), '');
      for (const relation of view.links) {
        item('关系', `${relation.id}；${relation.linkType} → ${relation.targetType}:${relation.targetId}`);
        item('来源 / 校验', `${relation.assessmentSource ?? 'legacy'} / ${relation.validation ?? '未知'}${relation.invalidReason ? `；${relation.invalidReason}` : ''}`);
        if (relation.note) { item('关系解释', ''); lines.push('', block(relation.note), ''); }
        for (const q of relation.evidenceQuotes ?? []) { item('引用证据', q.evidenceId); lines.push('', block(q.quote), ''); }
      }
    }
  }
  lines.push('', '## 分析结果卡', '');
  for (const card of s.analysis) {
    item('结果卡', `${card.id}；Worker ${card.workerId}；会话 ${card.sessionId ?? '无'}`);
    item('执行状态', `${card.profileId ?? '未知'} / ${card.workerStatus}；创建 ${card.workerCreatedAt ?? '未知'}；${card.synthetic ? '兜底卡，不能替代分析' : '结构化结果'}`);
    item('引用证据', card.evidenceIds.join(', ') || '无'); lines.push('', block(card.summary), '');
  }
  if (!s.analysis.length) lines.push('没有分析结果卡。');
  lines.push('', '## 执行过程时间线', '');
  for (const event of s.timeline) { item(event.at, `${event.kind} ${event.label} [${event.status}] ID=${event.id}${event.evidenceIds.length ? `；证据 ${event.evidenceIds.join(', ')}` : ''}`); if (event.detail) lines.push('', block(event.detail), ''); }
  if (!s.timeline.length) lines.push('没有执行记录。');
  lines.push('', '## 证据索引与附件', '', '以下保存生成时的证据快照。页面可下载单条文本、二进制附件或完整 JSON / ZIP 证据包；原文片段仅用于阅读，完整内容见附件。索引保留校验失败记录，失败记录不作为可信观测来源。', '');
  for (const evidence of s.evidence) {
    lines.push(`### ${literal(evidence.id)}`, ''); item('标题 / 类型', `${evidence.title} / ${evidence.kind}`); item('工具 / 目标', `${evidence.tool ?? '未知'} / ${evidence.targetIp ?? '未知'}`);
    item('创建时间', evidence.createdAt); item('工具调用 / 会话', `${evidence.toolCallId ?? '无'} / ${evidence.sessionId ?? '无'}`); item('完整性 / 成功调用来源', `${evidence.integrity} / ${evidence.provenanceValid ? '有效' : '无效或缺失'}`);
    item('记录 SHA-256', evidence.sha256 ?? '缺失'); item('计算 SHA-256', evidence.computedSha256 ?? '无文本'); item('记录 / 实际字节', `${evidence.sizeBytes ?? '未知'} / ${evidence.computedSizeBytes ?? '无文本'}`);
    if (evidence.content !== null) { lines.push('', block(evidence.content.slice(0, 1200)), ''); if (evidence.content.length > 1200) lines.push('原文片段已截取前 1200 字符，完整内容见附件。', ''); }
    else lines.push(s.attachments?.some((a) => a.evidenceId === evidence.id) ? '该证据没有文本，二进制快照见下方附件清单。' : '未保存文本或内嵌附件；仅有外部路径或 URI 时不自动获取内容。', '');
    for (const reference of evidence.references ?? []) item('未下载的外部引用', `${reference.name}：${reference.uri}`);
  }
  lines.push('', '## 二进制附件清单', '');
  for (const attachment of s.attachments ?? []) {
    lines.push(`### ${literal(attachment.filename)}`, ''); item('附件 / 来源证据', `${attachment.id} / ${attachment.evidenceId}`);
    item('类型 / 原始字节数', `${attachment.mimeType} / ${attachment.sizeBytes}`); item('来源校验', attachment.integrity);
    item('来源记录 SHA-256', attachment.sha256); item('快照实际 SHA-256', attachment.computedSha256); item('快照字节数', attachment.computedSizeBytes);
    if (attachment.sourceUri) item('来源 URI（未额外访问）', attachment.sourceUri);
    if (attachment.integrity !== 'match') lines.push('', '来源数据已不符合原始校验值，快照保留生成时的现存字节供核查；ZIP 中放在 untrusted-attachments。', '');
  }
  if (!s.attachments?.length) lines.push('没有已保存的二进制附件。');
  return lines.join('\n') + '\n';
}
