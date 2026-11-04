# 漏洞描述、评级与修复建议维护

在漏洞发现页选择发现，点击“编辑维护信息”。可修改标题、描述、严重程度、CVE、CWE、人工 CVSS 和修复建议。填写修改理由与评级依据，并提供 1～10 条证据 ID / 连续原文引用。保存后留下新版本和修改前字段；“查看维护历史”按版本倒序分页展示原文和证据跳转。

至少一条引用必须来自该任务、该发现目标的成功工具观测，引用长度为 8～2000 字符。校验原文包含关系、UTF-8 字节数、SHA-256、调用状态、调用与证据互指、会话及工具名，并拒绝已识别的探测失败。可额外引用同任务的 search_exploits / get_exploit_code / msf_search / msf_module_info / vulnerability_intelligence_dashboard 无目标参考查询；仅有参考查询不能保存。维护允许引用历史观测，不声称它代表目标当前状态。

CVE/CWE 必须符合编号格式且作为完整编号出现在明确引用原文中；编号前缀不能匹配更长的编号。此校验证明来源和字面引用，不自动确认编号真实存在、版本适用性、语义充分性或评分正确。CVSS 为 0～10 的人工分数；请在理由中记录版本、向量、影响及适用条件。本功能没有内置 CVSS 计算器，不自动联网查询。

评级维护不改变 candidate / verifying / confirmed / refuted / unconfirmed。确认或排除仍通过独立验证。原始发现 source 在库中保留；有维护版本的 API / 报告视图显示 manual 来源。维护也不改目标、候选来源证据或验证记录。

并发编辑使用 expectedRevision：版本过期返回 409，界面保留草稿和理由，并刷新服务器详情；核对后点击“重新载入当前版本”才用服务器值覆盖草稿。保存成功后清空本次理由与引用。维护字段、历史和 finding.assessed 审计同事务，任一步失败全部回滚。

每次读取详情、列表、历史和生成新报告都会重新校验引用。依据缺失或损坏、维护历史缺失、当前字段与维护版本不一致时，当前视图将严重程度降为未评级，CVE/CWE/CVSS/修复建议置空，并提示原因。原始维护值和引用仍保留供审阅；标题和描述保留人工文本。已生成报告保存当时版本、引用及校验结果，后续编辑或证据变化不改变旧报告。报告中的原文仅是来源数据，不能把失效记录当作有效评级。

## API

路由以 `/api` 为前缀。`PUT /tasks/:taskId/findings/:id/assessment` 接收完整维护字段：

```json
{
  "expectedRevision": 0,
  "title": "人工核对后的候选标题",
  "description": "根据已保存响应说明观测、影响和未确认部分。",
  "severity": "info",
  "cve": null,
  "cwe": null,
  "cvss": null,
  "remediation": "限制相应访问并复测原请求。",
  "note": "说明修改原因、适用版本及人工评级依据。",
  "evidenceQuotes": [{ "evidenceId": "实际证据 ID", "quote": "复制自该证据的连续原文片段" }]
}
```

severity 为 info / low / medium / high / critical；info 表示未评级。标题 2～200、描述 8～16000、理由 8～4000 字符；修复建议最多 16000 字符；编号最多 32 字符。标题、描述、理由去除首尾空白后也须满足最小长度。nullable 字段传 null 可清空。HTTP 请求还受应用总请求体限制。输入不合法或来源不足返回 400，发现不存在或任务不匹配返回 404，版本冲突返回 409。

成功返回 revision / metadata / previousMetadata / note / evidenceQuotes / valid / issues / createdAt。`GET /tasks/:taskId/findings/:id/assessments?page=1` 返回 items / total，每页 25 条，按 revision 倒序；每条 valid / issues 是读取时的校验结果。详情与列表 FindingDto 增加 metadataRevision、assessment 和 cvss，旧发现版本为 0、assessment 为 null。

## 本地验证

`npm run test:finding-assessments` 使用真实迁移内存 SQLite、Nest HTTP 路由及校验管道和报告服务。覆盖无效评分/编号/空白、引用错配/损坏/目标/任务/会话/调用状态、参考查询不足、同版本并发 200/409、状态隔离、修改前值、清空字段、审计故障回滚、冻结报告、失效降级、迁移回滚保护及任务删除。界面测试覆盖提交、409 草稿保留、显式重载、历史分页、文字转义及任务切换。固定文本不代表真实漏洞，不执行模型、MCP 或靶机请求。
