# VulnAgent 数据库设计

- 版本：v0.1（第一阶段）
- 引擎：SQLite（better-sqlite3 驱动，TypeORM），后续支持 PostgreSQL
- 约定：主键使用 `varchar` UUID；所有时间字段为 `datetime`（UTC ISO 字符串）；JSON 字段以 `simple-json` 存储

---

## 1. 实体关系总览

```
tasks 1──N targets
tasks 1──N agent_sessions 1──N worker_tasks
tasks 1──N facts          facts N──1 evidence (source_evidence_ids)
tasks 1──N intents
tasks 1──N hints
tasks 1──N tool_calls     tool_calls N──1 evidence (raw_output_ref)
tasks 1──N evidence
tasks 1──N findings N──M evidence (evidence_ids)
tasks 1──N reports
tasks 1──N model_usage
mcp_servers 1──N mcp_tools
agent_tool_permissions  : agent_role × tool（全局与任务规则共同匹配，显式拒绝优先）
audit_logs               : 全局审计
system_settings          : 全局配置（含加密密钥）
```

**隔离原则**：所有业务表均带 `taskId`，查询必须显式按 `taskId` 过滤；任何记录都可追溯到 `taskId`，涉及 Agent 的记录还可追溯到 `agentSessionId`。

## 2. 表结构

### 2.1 tasks（测试任务）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | UUID |
| name | varchar(120) | 任务名称 |
| description | text nullable | 描述 |
| status | varchar(24) | pending / running / paused / stopped / completed / failed |
| scope | simple-json | 授权范围：`{ cidrs: string[], ports?: string }` |
| authorizationRef | varchar(200) nullable | 授权声明/工单编号 |
| modelProvider | varchar(40) | 例如 `openai-compatible` |
| modelName | varchar(80) | 模型名 |
| tokenBudget | int | Token 预算 |
| timeBudgetMinutes | int | 时间预算（分钟） |
| workerCount | int | Worker 数量（1–8） |
| tokensUsed | int default 0 | 已消耗 Token |
| costUsd | real default 0 | 预估成本 |
| progress | int default 0 | 0–100 |
| currentPhase | varchar(40) nullable | 当前阶段描述 |
| startedAt / finishedAt | datetime nullable | |
| lastError | text nullable | |
| createdAt / updatedAt | datetime | |

索引：`status`、`createdAt`。

### 2.2 targets（授权目标）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| taskId | varchar FK→tasks | 级联删除 |
| ip | varchar(64) | IPv4 / CIDR |
| hostname | varchar(200) nullable | |
| kind | varchar(16) | host / cidr |
| inScope | boolean | 是否在授权范围内 |
| note | text nullable | |

唯一索引：`(taskId, ip)`。

### 2.3 agent_sessions（Pi 会话）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| taskId | varchar FK→tasks | |
| role | varchar(24) | orchestrator / planner / bootstrap / explore / analysis / verifier / reporter |
| sessionKey | varchar(120) | Pi `sessionId` |
| modelName | varchar(80) | |
| status | varchar(20) | idle / running / paused / completed / failed |
| tokenInput / tokenOutput | int | |
| stateCard | simple-json nullable | 状态卡 |
| startedAt / endedAt | datetime nullable | |

### 2.4 worker_tasks（Worker 任务单元）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| taskId | varchar | |
| agentSessionId | varchar nullable FK→agent_sessions | |
| intentId | varchar nullable | 来源意图 |
| parentWorkerTaskId | varchar nullable | 依赖关系 |
| title | varchar(200) | |
| kind | varchar(24) | bootstrap / explore / analysis / verify / report |
| status | varchar(20) | queued / running / succeeded / failed / timeout / cancelled / deduplicated |
| dedupeKey | varchar(200) nullable | 去重键，唯一索引 `(taskId, dedupeKey)` |
| timeoutSeconds | int | |
| attempt | int default 0 | |
| input / output | simple-json nullable | |
| startedAt / endedAt | datetime nullable | |

### 2.5 facts（事实）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| taskId | varchar | |
| agentSessionId | varchar nullable | |
| category | varchar(32) | asset / service / credential / vuln / tech / network |
| subject | varchar(200) | 例如 `192.168.56.101:22` |
| predicate | varchar(120) | 例如 `runs_service` |
| object | text | 事实内容 |
| confidence | real | 0–1 |
| sourceEvidenceIds | simple-json | 证据 ID 数组（可追溯） |
| createdBy | varchar(20) | tool / agent / user |

### 2.6 intents（探索意图）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| taskId | varchar | |
| agentSessionId | varchar nullable | 生成者 |
| title | varchar(200) | |
| rationale | text | 依据（引用事实 ID） |
| factIds | simple-json | |
| targetIp | varchar(64) nullable | |
| suggestedTools | simple-json | 工具名数组 |
| priority | int | 0–100 |
| status | varchar(20) | proposed / dispatched / done / rejected |
| dedupeKey | varchar(200) nullable | |

### 2.7 hints（人工提示）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| taskId | varchar | |
| agentSessionId | varchar nullable | 定向到某个 Session；null 为 Planner 后续任务规划提示 |
| appliedToSessionId | varchar nullable | 实际消费会话；定向必须等于 agentSessionId |
| content | text | |
| status | varchar(20) | pending / consumed / dismissed |
| consumedAt | datetime nullable | 消费时间；入队本身不消费 |
| createdAt | datetime | |

### 2.8 tool_calls（工具调用记录）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| taskId | varchar nullable | 全局检测时为 null |
| agentSessionId | varchar nullable | |
| mcpServerId | varchar nullable | |
| toolName | varchar(120) | |
| arguments | simple-json | 脱敏后的参数 |
| targetIp | varchar(64) nullable | 目标（用于白名单校验） |
| decision | varchar(20) | allow / deny / pending_approval |
| decisionReason | varchar(200) nullable | |
| status | varchar(20) | success / error / denied / timeout |
| latencyMs | int | |
| rawOutputRef | varchar nullable | 关联 evidence.id |
| errorMessage | text nullable | |

### 2.9 evidence（证据）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| taskId | varchar nullable | |
| agentSessionId | varchar nullable | |
| toolCallId | varchar nullable | |
| kind | varchar(24) | command_output / http_response / screenshot / pcap / file / note |
| title | varchar(200) | |
| mimeType | varchar(80) nullable | |
| content | text nullable | 文本内容（截断存储） |
| filePath | varchar(400) nullable | 落盘路径（`storage/evidence/...`） |
| sha256 | varchar(64) nullable | 完整性校验 |
| sizeBytes | int nullable | |
| meta | simple-json nullable | |

### 2.10 findings（漏洞候选/结论）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| taskId | varchar | |
| title | varchar(200) | |
| description | text | |
| severity | varchar(16) | critical / high / medium / low / info |
| cwe | varchar(32) nullable | 仅有可靠依据时填写 |
| cve | varchar(32) nullable | 仅有可靠依据时填写 |
| cvss | real nullable | |
| status | varchar(24) | candidate / verifying / confirmed / unconfirmed |
| source | varchar(32) | tool / agent / manual |
| targetIp | varchar(64) nullable | |
| evidenceIds | simple-json | |
| remediation | text nullable | 修复建议 |

### 2.11 reports（报告）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| taskId | varchar | |
| format | varchar(12) | markdown / pdf |
| title | varchar(200) | |
| content | text nullable | Markdown 正文 |
| filePath | varchar(400) nullable | 历史预留字段；当前导出不读取该路径 |
| status | varchar(16) | draft / generating / ready / failed |
| stats | simple-json nullable | version=1、summary、snapshot、checksum；保存结构化报告与文本证据快照 |
| generatedAt | datetime nullable | |

### 2.12 model_usage（模型用量）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| taskId | varchar nullable | |
| agentSessionId | varchar nullable | |
| provider | varchar(40) | |
| modelName | varchar(80) | |
| inputTokens / outputTokens | int | |
| costUsd | real | |
| latencyMs | int nullable | |
| createdAt | datetime | |

索引：`(createdAt)`、`(taskId)`。

### 2.13 audit_logs（审计）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| actor | varchar(60) | user / system |
| action | varchar(80) | task.create / task.pause / mcp.health_check / settings.update ... |
| entityType | varchar(40) | |
| entityId | varchar(64) nullable | |
| taskId | varchar(64) nullable | |
| result | varchar(16) | success / failure |
| detail | simple-json nullable | 不含密钥明文 |
| createdAt | datetime | |

### 2.14 mcp_servers（MCP 服务）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| name | varchar(80) | 例如 `blhackbox-gateway` |
| endpoint | varchar(300) | 例如 `http://localhost:8080/mcp` |
| transport | varchar(24) | streamable-http / sse |
| enabled | boolean | |
| headers | simple-json nullable | 认证头（脱敏展示） |
| status | varchar(20) | unknown / online / unreachable / error |
| lastCheckedAt | datetime nullable | |
| latencyMs | int nullable | |
| toolCount | int default 0 | |
| lastError | text nullable | |
| source | varchar(16) | env（来自环境变量）/ manual |

### 2.15 mcp_tools（工具目录）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| mcpServerId | varchar FK | |
| name | varchar(140) | |
| description | text nullable | |
| inputSchema | simple-json | JSON Schema |
| riskLevel | varchar(16) | safe / intrusive / destructive |
| syncedAt | datetime | |

唯一索引：`(mcpServerId, name)`。

### 2.16 agent_tool_permissions（Agent 工具权限）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar PK | |
| taskId | varchar nullable | null = 全局默认 |
| agentRole | varchar(24) | planner / explore / verifier ... |
| toolPattern | varchar(140) | 工具名或通配（如 `nmap_*`） |
| allowed | boolean | |
| requireApproval | boolean | 高风险审批 |
| createdAt / updatedAt | datetime | |

唯一索引：`(taskId, agentRole, toolPattern)`。

### 2.17 system_settings（系统设置）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| key | varchar PK | 例如 `model.provider` |
| value | text | 明文值 |
| encrypted | boolean | 为 true 时 value 为 AES-256-GCM 密文 |
| updatedAt | datetime | |

密钥类条目（`model.apiKey`）以 `encrypted=true` 存储，读取接口返回掩码。

## 3. 迁移策略

- 默认 `DB_SYNCHRONIZE=false`，SQLite 启动自动执行六条显式迁移。冻结基线 25 表，独立验证历史增加一表，任务目标增加字段，二进制附件增加两表，删除标记增加一表，假设关联增加原文与来源字段，目前 29 张表。
- 旧库仅在结构签名匹配时接管，改表前生成一致性备份；扩展表已有数据时拒绝删除式回滚。参见 `apps/api/src/database/migrations/README.md`。
- PostgreSQL 尚无可用迁移和完整行为适配，不能只改 DB_TYPE 视为支持。

### 二进制附件表

`evidence_attachments`：id 主键、taskId、evidenceId、filename、mimeType、sha256、sizeBytes、sourceUri、data BLOB、createdAt；evidenceId 外键级联删除，常规查询不选择 data，HTTP 与缓存复用前重算哈希和字节数。

`report_attachments`：reportId / attachmentId 联合主键，以及 taskId、evidenceId、文件元数据和 data BLOB。reportId 外键级联删除；evidenceId 是来源索引，无活动证据外键，原始证据删除不会丢失报告副本。报告快照保存附件元数据，导出时逐项核对副本完整性与快照一致性。文件不落用户路径、不读取外部 URI。

### 任务归属与删除标记

`task_deletions`：taskId 主键、deletedAt；不保存名称、范围或证据，仅用于阻止异步旧回调重新插入已删除任务。23 张所属表由 SQLite 触发器约束非空 taskId 必须存在，插入和更新均检查。任务删除触发器同事务清理全部所属行（包括报告副本），审计行保留并置 taskId=null；全局行和其他任务不受影响。删除标记本身不参与所属行清理。有删除标记时不允许回滚归属迁移；历史孤立记录不自动删除。

### 假设引用与关系版本

`hypothesis_links` 增加 evidenceQuotes（JSON 数组，evidenceId / quote）、assessmentSource（legacy / agent / user）、agentSessionId（可空）。支持/反驳必须有关系解释和有效原文；意图只能建立计划关系，推断/失败/未解决冲突的事实不能作为支持或反驳依据。读取时重新核验来源，冗余计数不作为权威。

同一任务、标题、目标的假设去重；不同目标不合并。完全相同的关系解释和引用幂等，修改说明或原文保留新的关系版本。支持和反驳分别按原始文本 SHA-256 去重，不用关系条数累加可信度；两者同时有效时保留冲突、状态为 proposed。confidence 是有限排序启发值，不是漏洞概率，supported/refuted 是分析解释，不等于独立漏洞确认/排除。

## 4. 数据隔离与可追溯检查清单

当前共有 31 张业务表、10 条迁移。第九条迁移把任务所属表清单扩展至 25 张，包括 model_requests 和 finding_assessments；上文 23 表说明对应第五条迁移时的结构。

维护服务不新增表。保留策略按有效结束时间、终态、截止及最近 N 项筛选；每页最多 100 个任务和 100 组父任务缺失记录，预览不写业务行。HMAC 绑定策略、行数/阻塞状态、十分钟有效期，以及当前连接 total_changes / data_version / schema_version；任何写入（包括同计数修改、其他连接提交或回滚尝试）均可能让预览失效，实例重启也不能复用旧凭据。执行获得 SQLite 写锁后重新生成预览、从独立只读连接生成完整备份，再次核对本进程在途工作，审计和删除同事务提交。任务删除依赖原 25 表清理触发器；孤立记录只清理不存在父任务的 taskId，保留审计并补防重建 ID，taskId=null 全局行保持。跨任务附件关联拒绝清理。详细边界与恢复见 DATA_MAINTENANCE.md。

第十条迁移新增全局权限部分唯一索引 IDX_agent_permission_global_unique，按 agentRole / toolPattern 唯一且仅覆盖 taskId IS NULL。原含 taskId 的复合唯一索引在 SQLite 中不能阻止多个 NULL 全局规则。旧重复组保留最早记录 ID，allowed 仅在全部原规则允许时为 true，requireApproval 任一原值要求时为 true；全组原记录写入 mcp.permission_duplicates_merged 审计后再合并。非布尔原值、审计失败或索引结构漂移会拒绝升级并回滚。down 只删新索引，不删除有效规则或合并审计，也不重新制造重复数据。日常权限编辑的查找、保存及含原值的审计同事务，提交后才推送。

第九条迁移新增 finding_assessments，保存 taskId / findingId / revision、metadata（七项维护字段及 before 修改前值）、note、evidenceQuotes 和 createdAt；按 taskId / findingId / revision 唯一。findings 新增 metadataRevision integer NOT NULL DEFAULT 0，旧发现保留原值及版本 0，不自动补造评级。维护更新使用串行事务及版本 CAS，同步保存新字段、历史和审计；审计失败整体回滚。历史非空或版本非零时拒绝删除式回滚。新历史表安装任务归属约束并加入删除清单，读取和报告均重新校验证据引用。维护历史不修改独立验证状态及原始来源。详见 FINDING_ASSESSMENTS.md。

第八条迁移为 mcp_servers 增加 nullable text 字段 headersEncrypted，保存全部请求头的 AES-256-GCM 密文 JSON。配置升级在应用启动期进行，需要原主密钥；CLI 仅创建字段，不改写凭据。升级先验证所有现存密文，再同事务加密旧 headers / 旧明文模型密钥、清空 headers 并写计数审计。失败整体回滚，有密文时拒绝删除字段回滚。schema 迁移前备份、SQLite 空闲页或 WAL 可能保留升级前的数据；本改动不承诺安全擦除历史明文，维护/留存流程须另行处理。

`model_requests` 保存每次模型请求的 taskId / sessionId / budgetEpoch、状态、模型/供应商名、输入估算、输出上限、预留额度、实际输入/输出/费用及起止时间。实际用量未知允许 null，状态 uncertain；不保存提示词、原始错误或密钥。索引按任务轮次和会话聚合，ModelUsage 使用相同请求 ID 幂等写入，避免 SDK 回调重复计费。

任务增加 budgetEpoch、tokenBaseline、costBaseline；会话增加 tokenAllowance、budgetManaged、budgetEpoch、baselineInput / baselineOutput / baselineCost。旧运行首次使用时仅接管一次已知用量；重跑更新轮次，不清除历史账本。读预算使用基线加本轮账本，reserved 全额占用，uncertain 按预留减已报告部分保留占用。启动将未收尾 reserved 标为 uncertain，不虚构实际消耗。

单数据源的异步 SQLite 写操作必须经 serialTransaction / serialSave 等共用队列，防止其他操作意外加入当前连接的事务、随其回滚丢失。AsyncLocalStorage 只让同一调用链上的嵌套写操作复用当前事务；消息序号分配与插入也在同一队列内完成。

1. 任何 `facts / intents / evidence / findings / tool_calls` 查询必须带 `taskId`。
2. `tool_calls` 与 `evidence` 支持 `taskId = null`（全局 MCP 检测），但不允许其他任务读取。
3. `facts.sourceEvidenceIds` 指向 `evidence.id`，缺证据的事实不得标记为 `confirmed`。
4. `findings.evidenceIds` 至少一条证据才能由 `candidate` 进入 `confirmed`。
