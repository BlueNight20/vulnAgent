# VulnAgent API 接口文档

- 版本：v0.1，更新：2026-11-03；当前单人 SQLite 版本
- Base URL：`http://localhost:3001/api`
- 内容类型：`application/json; charset=utf-8`
- 前端开发环境通过 Vite 代理 `/api` → `http://localhost:3001`

## 0. 通用约定

### 0.1 成功响应

直接返回资源对象或数组，列表接口返回 `{ items, total }`。

### 0.2 错误响应

```json
{ "statusCode": 400, "code": "VALIDATION_ERROR", "message": "目标 IP 格式不合法", "path": "/api/tasks", "timestamp": "2026-11-01T09:00:00.000Z" }
```

错误码：`VALIDATION_ERROR`、`NOT_FOUND`、`CONFLICT`、`INTEGRATION_UNAVAILABLE`、`INTERNAL_ERROR`。

### 0.3 分页

`?page=1&pageSize=20`（pageSize ≤ 100）。

---

## 1. 健康检查

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 进程存活、版本、数据库连通、运行时长 |

```json
{ "status": "ok", "version": "0.1.0", "uptimeSeconds": 128, "database": "connected", "timestamp": "..." }
```

---

## 2. 仪表盘

### GET `/api/dashboard/summary`

真实聚合（来自 tasks / findings / model_usage 表）。

```json
{
  "tasks": { "total": 3, "running": 1, "paused": 0, "completed": 1, "failed": 0 },
  "findings": { "candidate": 4, "verifying": 1, "confirmed": 2, "unconfirmed": 1 },
  "usage": { "tokens": 182340, "costUsd": 1.42 },
  "services": [
    { "name": "MCP Gateway", "kind": "mcp", "status": "unreachable", "latencyMs": null, "detail": "connect ECONNREFUSED 127.0.0.1:8080", "checkedAt": "..." },
    { "name": "API 服务", "kind": "api", "status": "online", "latencyMs": 2, "detail": "uptime 128s", "checkedAt": "..." },
    { "name": "数据库", "kind": "database", "status": "online", "latencyMs": 1, "detail": "SQLite", "checkedAt": "..." }
  ],
  "recentTasks": [ { "id": "...", "name": "...", "targetIps": ["192.168.56.101"], "status": "running", "progress": 35, "updatedAt": "..." } ]
}
```

### GET `/api/dashboard/usage-trend?days=7`

```json
{ "points": [ { "date": "2026-10-26", "tokens": 12000, "costUsd": 0.08 } ] }
```

---

## 3. 任务中心

### POST `/api/tasks`

请求：

```json
{
  "name": "VulnHub DC-1 信息收集",
  "description": "授权实验环境信息收集",
  "targets": [{ "ip": "192.168.56.101", "note": "DC-1" }],
  "scope": { "cidrs": ["192.168.56.0/24"], "ports": "1-1000" },
  "authorizationRef": "LAB-AUTH-2026-001",
  "authorized": true,
  "modelProvider": "openai-compatible",
  "modelName": "deepseek-chat",
  "tokenBudget": 200000,
  "timeBudgetMinutes": 60,
  "workerCount": 2,
  "autoStart": false,
  "goal": { "mode": "recon", "targets": ["192.168.56.101"], "ports": "80", "protocol": "tcp", "evidenceText": null }
}
```

校验：`authorized` 必须为 true；`targets[].ip` 必须为合法 IPv4/CIDR；`workerCount` 1–8；`tokenBudget` ≥ 1000。

任务、目标、可选自动启动事件与 task.create 审计在同一事务提交，响应详情也在事务内生成。子表、审计或提交失败不留下任务或自动启动请求，提交后才通知；WebSocket 断开不撤销已提交的创建。

### GET `/api/tasks?status=&keyword=&page=&pageSize=`

返回 `{ items: Task[], total: number, stats: { [status]: number } }`。

### GET `/api/tasks/:id`

返回任务详情（含 targets）。

### POST `/api/tasks/:id/pause` · `resume` · `stop` · `rerun`

真实状态流转并写审计日志；非法流转返回 409。

任务控制通过持久化事件驱动真实引擎，响应不代表远端进程已完成取消。`autoStart=true` 请求启动，执行引擎关闭时返回 409 且不创建任务；false 可保存待启动任务。直接引擎接口为 GET `/api/tasks/:taskId/engine` 及 POST 同路径下的 `/start`、`/pause`、`/resume`、`/stop`。关闭引擎时启动/恢复返回 409；关闭事件尚未收尾时也拒绝恢复。详见 RUNTIME_CONTROL.md。

引擎 POST 控制现与任务中心共用持久化请求队列，成功返回 201 + TaskSummary（接受控制请求）；实际 EngineSnapshot 从 GET 获取。start 仅用于 pending / idle，resume 支持 paused 或 running 的 needs_input / stalled，终态须先重新运行。任一路径的未消费控制都会阻止另一接口的冲突请求。内部任务/运行记录/审计同事务，提交后才改变会话；完整行为见 [ENGINE_CONTROLS.md](ENGINE_CONTROLS.md)。

### DELETE `/api/tasks/:id`

原子删除任务及全部所属数据，保留删除审计和防重建 ID；在途工作、未处理事件、未知审批或跨任务附件级联风险返回 409，须先核实并收尾。

---

## 4. 工作流

### GET `/api/workflows/:taskId/graph`

图由真实任务、引擎快照、会话、意图及 Worker 记录生成，不生成演示执行结果。响应包含：

```json
{ "source": "live", "taskId": "...", "taskName": "...", "taskStatus": "pending", "engine": {}, "nodes": [], "edges": [], "generatedAt": "..." }
```

若 `taskId` 不存在返回 404。该图展示执行关系，不等同完整资产攻击路径知识图谱。

---

## 5. MCP 管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/mcp/servers` | 服务列表（含 `envConfigured` 标记） |
| POST | `/api/mcp/servers/:id/check` | 触发真实健康检查（connect + tools/list），写库 + 审计 + WS 推送 |
| GET | `/api/mcp/servers/:id/tools` | 工具目录（来自 `mcp_tools`，含 JSON Schema） |
| POST | `/api/mcp/servers/:id/sync` | 重新同步工具目录（等同 check 并落库） |
| GET | `/api/mcp/permissions?taskId=` | 权限矩阵（角色 × 工具） |
| PUT | `/api/mcp/permissions` | 按 taskId / agentRole / toolPattern 更新权限，原值审计同事务，成功 200；任务不存在 404、空模式或无效参数 400 |
| GET | `/api/mcp/calls?page=&pageSize=&taskId=` | 实际 MCP 调用记录 |

执行和审批重放共同匹配当前任务与全局规则：显式拒绝优先，无匹配默认拒绝；批准不绕过当前范围、Schema、角色权限及预算。Worker 启动时也按目录与角色权限过滤工具。档案角色及审批路径说明见 [PROFILE_PERMISSIONS.md](PROFILE_PERMISSIONS.md)。

toolPattern 去除首尾空白；省略 requireApproval 时保留既有值，新规则默认 false。taskId 省略或 null 表示全局。并发修改在单数据源中串行，按提交顺序生效，每次保留原值审计；全局/任务规则分别存储。审计失败、提交失败均回滚且不推送成功；提交后的 WebSocket 故障不改变成功状态，可重新 GET 确认。详见 [PERMISSION_UPDATES.md](PERMISSION_UPDATES.md)。

健康检查响应：

```json
{
  "serverId": "…",
  "name": "blhackbox-gateway",
  "endpoint": "http://localhost:8080/mcp",
  "status": "unreachable",
  "latencyMs": 5003,
  "toolCount": 0,
  "lastError": "请求超时（5000ms）",
  "checkedAt": "2026-11-01T09:10:00.000Z",
  "cached": false
}
```

状态枚举：`online` / `unreachable` / `error` / `unknown`。前端**只能**依据该接口渲染在线状态。

---

## 6. 系统设置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/settings` | 返回配置（密钥字段为掩码 `sk-****abcd`） |
| PUT | `/api/settings` | 原子更新配置与审计；省略 apiKey、空值或短掩码（含 ****）表示不修改 |
| POST | `/api/settings/model/test` | 使用已保存配置显式测试模型连接，不启动任务；引擎关闭时仍可执行 |
| GET | `/api/settings/models` | 模型目录 |

`PUT /api/settings` 可提交 `{"runtime":{"piRuntimeEnabled":false}}`。数据库值优先于环境默认值；关闭与运行任务暂停、旧启动/恢复请求失效及审计同事务，开启不自动恢复。任务模型/工具请求在派发前再次检查开关。已发出的远端操作不保证停止。完整语义与故障处理见 [RUNTIME_CONTROL.md](RUNTIME_CONTROL.md)。

日志配置使用 runtime.logLevel（debug / info / warn / error）和 logToFile（boolean），保存后实际生效。生产入口返回 loggingStatus：level / fileEnabled / directory / activeFile / lastError，区分配置和故障后的实际输出。文件不可写时更新返回 503 并回滚；审计/提交故障同样不切换日志。目录来自 LOG_DIR，不是此接口的可编辑字段。文件追加、错误恢复与验证见 [LOGGING.md](LOGGING.md)。

runtime.workerMaxConcurrency 为跨任务全局 Worker 上限，1～8，含 queued / running 分配；任务 workerCount 是单任务上限。降低上限不终止已有分配，新派发读取最新值。默认 Token / 时间 / Worker 数量用于新任务表单初始化，API 创建仍须显式提交；默认值边界与任务一致。EngineSnapshot 增加 globalWorkerLimit / globalWorkersActive / waitingForWorkerCapacity，说明见 WORKER_CAPACITY.md。智能体单会话恢复要求任务引擎在运行，且非 Planner 会话仍有 running Worker 分配，旧会话不绕过并发门禁。

---

## 7. WebSocket

- 地址：`ws://localhost:3001/ws`（前端通过 Vite 代理 `/ws`）
- 协议：JSON 文本帧，`{ "type": string, "payload": any, "ts": number }`
- 客户端可发送 `{ "type": "ping" }`，服务端回 `{ "type": "pong" }`。
- 服务端推送事件：

| type | 说明 |
| --- | --- |
| `hello` | 连接建立，携带 `clientId` |
| `task.updated` | 任务状态变更 |
| `mcp.health` | MCP 健康检查结果 |
| `audit.appended` | 新审计记录 |

### 会话消息查询

`GET /api/agents/sessions/:id/messages?afterSeq=0` 按 seq 升序返回最多 300 条，游标条件在数据库查询中应用。响应为 `{items,total,nextAfterSeq}`：total 为该会话全部消息数，nextAfterSeq 为下一页游标，无后续消息时为 null。重复读取同一游标不会消费记录；新消息可在后续刷新时出现。afterSeq 须为非负安全整数，无效返回 400，会话不存在返回 404。

智能体页支持“加载后续消息”，保留已加载页，并在运行期间刷新。列表 content 是文本预览（最多 8000 字符），完整结构化消息保存在 messageJson；Worker 收尾读取最新 assistant 的完整文本，不受列表页数或预览长度限制。工具原始证据仍通过证据接口查看和导出。

智能体页及工作流页显示引擎操作失败原因，操作期间禁止重复或相互冲突的按钮请求；失败不会自动重试，完成后重新读取实际状态。暂停状态使用恢复接口，会话控制错误和消息读取错误同样显示。

---

## 8. 历史阶段预留接口

本节保留最初规划路径，不能据此判定当前状态。漏洞验证、资产、验收与报告的实际接口见第 9–12 节。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/tasks/:id/engine/start` | 启动真实 Orchestrator |
| GET | `/api/tasks/:id/facts` | 事实黑板 |
| GET | `/api/tasks/:id/intents` | 意图列表 |
| POST | `/api/tasks/:id/hints` | 人工 Hint |
| GET | `/api/agents/sessions` | Pi Session 列表 |
| GET | `/api/attack-surface` | 攻击面资产 |
| GET | `/api/findings` | 漏洞列表 |
| GET | `/api/evidence` | 证据列表 |
| POST | `/api/reports/generate` | 生成报告 |

## 人工提示与工作流（当前接口）

`POST /api/tasks/:taskId/hints` 接收 `{content, sessionId?, broadcast?}`，成功 201 + HintDto。content 为 1～2000 字符非空文本；不指定 sessionId 或 broadcast=true 为供 Planner 后续规划使用的任务提示，不向所有 Agent 同时广播。指定 sessionId 仅投递该任务的该会话；不存在/跨任务 404，终态任务/会话 409，无效输入 400。保存与 hint.create 审计同事务。

`GET /api/tasks/:taskId/hints` 返回最近 100 条 `{items}`，无任务 404。pending 表示尚未接收（包括已排队），consumed 的 appliedToSessionId / consumedAt 记录实际会话与时间。定向提示由 SDK 产生 user 消息时，同事务写完整消息和消费状态；消息 messageJson.hintId 关联提示。任务提示在 Planner 本轮结构化结果被接纳后消费。保存和消费均不证明模型已采纳。暂停、租约、接收失败和重启规则见 HINT_DELIVERY.md。

`GET /api/workflows/:taskId/graph` 的来源为 live。Planner → Worker 来源为 intent.agentSessionId，Worker 来源的后续意图显示依赖边；不再猜测最早 Planner 为来源。已完成前置意图按开始时间边界关联，证据反馈按实际会话计数。Planner detail.input / output 为最近 user / assistant 的文本预览及消息 ID（最多 8000 字符）；完整 messageJson 从会话消息接口读取。Worker 输入/输出取实际保存的 Worker 记录。

## 9. 漏洞候选与独立验证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tasks/:taskId/findings?page=1&status=candidate` | 每页 25 条；状态支持 candidate / verifying / confirmed / refuted / unconfirmed |
| POST | `/api/tasks/:taskId/findings/refresh` | 从历史漏洞类事实同步候选，返回 created 数量 |
| GET | `/api/tasks/:taskId/findings/:id` | 返回 finding 与 verifications 验证历史；跨任务返回 404 |
| POST | `/api/tasks/:taskId/findings/:id/verify` | 冻结候选来源并创建 verification 意图与验证记录；重复请求返回同一待执行记录 |
| PUT | `/api/tasks/:taskId/findings/:id/assessment` | 完整维护描述、评级、编号、人工 CVSS 和修复建议；expectedRevision / 理由 / 原文引用必填，版本冲突 409，不改验证状态 |
| GET | `/api/tasks/:taskId/findings/:id/assessments?page=1` | 每页 25 条版本历史，保留修改前值，并重校验证据引用 |

维护字段、约束和请求示例见 [FINDING_ASSESSMENTS.md](FINDING_ASSESSMENTS.md)。详情/列表返回 metadataRevision、assessment 和 cvss；维护依据失效后评级及编号等不再作为当前有效值，新报告保留失效说明，旧报告不变。

运行中的 Worker 自动为有可信来源的新候选入队一次；无法确认不会无界自动重试。页面可再次安排验证。验证意图经过现有调度、预算、工具权限与审批；暂停或停止的任务不会因为入队事件自动恢复。

验证历史 outcome 为 pending / confirmed / refuted / inconclusive。模型输出使用 verification 对象，包含 outcome、summary、evidenceQuotes（evidenceId 与连续原文 quote）。验证 Worker 工具调用强制重跑，工具结果包含稳定证据 ID。

确认或排除需要来源可追溯且完整性正确的候选证据，以及属于本次 verifier 会话和 Worker 的新成功调用证据、匹配的目标和原文引用。响应内容允许相同，独立性以新会话、新调用及创建时间判断。无依据、损坏、跨任务、旧会话、旧时间戳或无法匹配原文的引用会降为 inconclusive。该校验约束来源与独立性，具体漏洞语义仍由验证 Worker 根据方法和响应判断，真实靶机准确率需另行验收。

确认/排除会写入黑板复核事实；结果提示供 Planner 后续规划。调度拒绝、超时或收尾中断会对账为无法确认。候选、入队及结果有持久化审计。CVE/CWE/CVSS 不凭空推断；自动候选的初始严重程度暂未评级。

## 10. 资产与服务聚合

`GET /api/tasks/:taskId/attack-surface` 返回 assets、excludedFacts、gaps；任务不存在返回 404。

资产区分 configured、inScope、aliveObserved 与 host/cidr；端口保留协议、全部观测状态、服务字符串及证据/时间，不将过滤或缺失结果等同关闭。同号 TCP/UDP 分开；旧事实未注明协议且存在歧义时显示 unknown。服务版本缺失、相反观测和探测错误形成信息缺口。端点保留完整主体 URL。

只有 observed/verified、目标状态类且关联本任务完整性正确的非空证据才能构成服务/指纹观测；模型推断、工具失败、已推翻、目标归属冲突和损坏证据不构成确认状态。范围外观测可以显示，但不会新增授权目标。Planner 与 Worker 使用同一聚合摘要，摘要截断会明确标记。

Nmap 报告按每个主机头绑定地址，支持 IPv6、TCP/UDP、存活和 OS 指纹；支持常见 JSON stdout 包装。非零退出码不产出成功探测状态。新的端口事实主体包含传输协议，旧版主体仍可读取。CIDR 内主机的意图准入与执行层使用一致的范围规则。

## 11. 任务验收目标

- `GET /api/tasks/:taskId/goal`：返回 goal、configured、complete、checks（逐项 passed / evidenceIds）与限制说明 notes。
- `PUT /api/tasks/:taskId/goal`：保存 `{ mode, targets, ports, protocol, evidenceText }`。mode 为 recon / assessment / evidence，protocol 为 tcp / udp；targets 必须是授权范围内的 IPv4 / CIDR。recon / assessment 必须指定授权范围内端口；evidence 必须指定 8–2000 字符的精确标记。
- 创建任务可传同结构 goal；省略时默认 assessment、创建目标、TCP、范围端口或 1-1000。旧任务保持 goal=null，需要用户明确配置后继续。

recon 逐目标检查指定端口的真实观测；assessment 还要求当前运行的成功 vuln-analysis 结果卡引用有效证据，范围内所有漏洞候选有当前运行的确认或排除结果。evidence 检查目标绑定的成功工具原文包含标记。全部模式还要求没有未完成意图、Worker 和待审批调用。

证据必须关联本任务成功调用、反向引用一致、内容及 SHA-256/字节数完整，时间不早于本次启动及目标配置。模型添加事实不能直接补齐扫描覆盖。网段使用明确端口参数与完整 Nmap 流程记录；未响应、过滤或没有候选不代表不存在服务或漏洞。

运行中须先暂停才能修改目标；已结束须先重跑。保存目标不会自动启动。修改目标或重新启动后，旧运行工具缓存不能替代新证据；相同运行内仅复用完整性正确的成功结果。创建时 autoStart=true 会同事务写入持久化启动请求，由编排器消费，并尊重消费前暂停。

## 12. 报告快照与导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tasks/:taskId/reports?page=1` | 25 条/页，只返回摘要，不读取或返回完整证据正文 |
| POST | `/api/tasks/:taskId/reports` | 从本任务已有数据生成并保存报告快照，不执行工具或调用模型 |
| GET | `/api/tasks/:taskId/reports/:id` | 返回 Markdown、摘要、完整性及证据附件元数据 |
| GET | `/api/tasks/:taskId/reports/:id/download?format=markdown` | 导出完整 Markdown；format 还支持 pdf / evidence / bundle（ZIP） |
| GET | `/api/tasks/:taskId/reports/:id/evidence/:evidenceId` | 下载生成时的单条文本证据，内容不随原库变化 |

`evidence` 格式为 JSON 包，包含任务、验收、资产、漏洞及验证历史、分析卡、时间线、完整文本证据与校验值，以及 files 数组中的二进制附件 dataBase64。`bundle` 是包含 report.md、manifest.json、evidence 文本和 attachments 原始文件的 ZIP；生成时已有损坏的来源副本明确标为不可信并放入 untrusted-attachments。Markdown 包含最多 1200 字符/证据的片段并明确标记截取，附件保留全文。仅有路径或外部 URL 的记录只列引用，不自动读取。

只有已正常完成且验收全部满足、没有失去可验证依据的确认结论时标为 final；其他为 progress。确认和排除会重查基线与新证据的哈希、字节、成功调用、目标、verifier 会话、Worker 和原文引用；未通过时在报告中降为未确认，原始存储状态和验证历史保留。验证工作丢失或已失败也按未确认展示。报告评估验收使用同批快照行，避免从后续运行重新读取进度。

报告正文、结构化快照与摘要保留 SHA-256 校验；内容损坏的历史报告仍可查看异常状态，导出返回 409。校验用于检测完整性，不是数字签名。跨任务或不存在返回 404，非法格式/页码 400。超出 32 MiB 完整快照上限时返回 413，不保存截断报告；PDF 正文上限 2 MiB、最多 500 页，超限时可使用完整 Markdown 和证据包。PDF 使用随构建打包的 OFL 中文字体离线生成；字体不含字符显示为 [U+编码]，原字符仍保留在 Markdown/附件中。

## 13. 执行工作量、失败与取消

工具结果的 failureKind 增加 invalid_input / workload_limit / retry_limit / cancelled，返回 suggestion 说明可执行调整。拒绝和失败会保存调用原因，不生成成功目标证据。审批等待仍为 pending_approval，不计入连续失败。

已识别 Nmap / Masscan / RustScan 调用按明确数字端口、目标、TCP/UDP 模式计算逻辑组合数；默认单批限制见 `.env.example` 的 MCP_MAX_SCAN_HOSTS / PORTS / PROBES。无法核验的端口、额外目标来源或矛盾选择器拒绝执行，不修改原参数。有限端口授权下不能使用默认/top-ports 扩大范围；明确 URL、嵌套 port 也受端口范围约束。工作量估算不是报文数或耗时预测，其他工具的字典规模等尚未纳入同一估算。

同会话同工具/参数失败两次后拒绝原样重试；改变有依据的参数或新建独立验证会话可以继续。每个 Worker 最多 24 次请求、连续 3 次失败后停止，Profile 超时是绝对期限。失败记录与验收的尚缺端口/地址供后续 Planner 重新规划；CIDR 可以合并多批完整 Nmap 流程覆盖，不展开整个网段。

MCP SDK 显式使用配置的请求超时和 AbortSignal，区分连接/执行阶段；暂停、终止及 Worker 边界通过取消信号传递，失败连接不复用。远端取消不等于已确认终止，不自动重放未知副作用。暂停任务保留句柄且不回收租约，恢复后仍受墙钟预算和绝对执行期限限制。

## 14. 二进制证据附件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tasks/:taskId/evidence/:evidenceId/attachments` | items 元数据、哈希/字节完整性、missingIds、外部 references 与未支持块 |
| GET | `/api/tasks/:taskId/evidence/:evidenceId/attachments/:id/download` | 校验后下载原始字节；损坏 409，跨任务/证据 404 |
| GET | `/api/tasks/:taskId/evidence/:evidenceId/attachments/:id/preview` | 仅校验通过的 PNG/JPEG/GIF/WebP；其他类型或尺寸超限 409 |
| GET | `/api/tasks/:taskId/reports/:id/attachments/:attachmentId` | 下载冻结报告副本，独立于原始证据；损坏 409 |

仅接收 MCP 内嵌 image/audio.data、resource.blob 的规范 Base64；最多 32 文件、单文件 16 MiB、每次调用合计 32 MiB。任一文件无效时整次证据保存失败，不保存部分成功证据。报告二进制副本总量另限 32 MiB。预览最多每边 8192 像素、总面积 3200 万像素，SVG 不内联。下载设置 no-store、nosniff 和限制性 CSP。二进制只作附件，不自动生成已观测事实或独立验证引用；模型上下文仅含元数据。

## 15. 中断审批核实

`GET /api/approvals?taskId=...` 和 `GET /api/approvals/:id` 增加 executionState（pending / running / needs_review / resolved）和 replayOfId。running 只代表当前 API 进程中活跃的请求，不能证明远端进程状态；已批准但本进程没有活跃请求的未收尾记录需要核实，不能再次批准执行。

`POST /api/approvals/:id/reconcile` 请求：`{ "reason": "已检查远端进程停止，保留为未确认结果。", "remoteStopped": true }`。reason 去空格后至少 10 字、原长度最多 2000；remoteStopped 必须为布尔 true。仅允许已批准且尚未收尾的原记录；任务必须暂停或停止，当前进程仍执行时拒绝。关闭后 status=error、failureKind=unknown，保留原批准人、时间、领取标记，新增核实说明。关闭、审计与持久化结果事件同一事务，重复/并发请求仅一个成功。事件不会自动恢复任务，不代表成功或未执行，不生成证据；不存在 404，其余状态/输入错误 400。

## 16. 任务生命周期与关联删除

`POST /api/tasks/:id/pause|resume|stop|rerun` 的状态变更、审计与持久化事件同事务提交。上一项生命周期事件未消费时返回 409，避免连续操作越过未完成收尾；引擎同时消费当前事件名 task.pause/resume/stop 和旧别名 task.paused/resumed/stopped。

`rerun` 回到 pending / idle，清空本轮预算消耗、进度和错误，更新目标验收时间边界；旧 proposed/dispatched 意图归档为 rejected，所有旧意图去重键标为 archived:ID，旧排队 Worker 取消、待消费提示 dismissed、未完成独立验证 inconclusive。证据、事实、漏洞、会话及报告历史保留，新一轮可生成相同计划；旧成功证据不能直接满足新一轮验收/缓存时间边界。重跑事件携带 retiredRunId，晚消费不能误删新上下文。

`DELETE /api/tasks/:id` 成功返回 `{ "deleted": true }`，不存在 404。运行中的任务、当前进程在途工具/编排工作、待审批或待核实调用、未结束会话/Worker、待消费事件均返回 409；应停止并等待收尾，审批先拒绝或核实。重跑也检查在途工作、审批、会话/Worker 与待消费事件。删除需要 SQLite 任务归属迁移已安装，否则明确拒绝。

删除及审计同事务：清理该任务的全部会话消息/事件、工具权限/调用、Worker/结果卡/Profile 记录、事实/意图/提示/假设/关联、目标、漏洞/验证、证据及二进制、报告及副本、模型用量、编排运行与状态事件。其他任务和 taskId=null 全局记录保留；原审计 taskId 置空，审计实体 ID 保留。最小 task_deletions 记录阻止已删除 ID 被旧 save() 回调重建；所属表拒绝向不存在任务插入或更新记录。任一清理步骤失败则整体回滚。删除完成广播 task.deleted，载荷 `{ taskId }`。

## 17. 假设依据与证据反查

`GET /api/tasks/:taskId/hypotheses` 和 `GET .../hypotheses/:id` 返回经当前来源校验的视图，不直接使用旧冗余状态/计数。hypothesis 增加 conflicted、invalidLinkCount；factIds、evidenceIds、intentIds 填充有效明确关联。支持/反驳按原始文本哈希分别去重，相同来源以事实、证据多条关系出现也只计一次；两种方向同时有效时 conflicted=true、status=proposed，不用多数票消除冲突。confidence 是有限排序信号，不是漏洞概率。

detail.links 增加 evidenceQuotes、assessmentSource、agentSessionId、validation（valid / invalid / legacy / stale）、invalidReason 和 counted。旧无原文的支持/反驳仅作历史，不计入当前判断。损坏、跨任务、错误目标/参数/端口、失败调用、会话不匹配和早于当前运行/目标配置的引用均不计数。宽范围证据需引用明确包含此目标字面量的原文，或引用对应目标的有来源事实；IP 前缀不能匹配其他主机。

`POST /api/tasks/:taskId/hypotheses/:id/links`：

```json
{
  "linkType": "supports",
  "targetType": "evidence",
  "targetId": "明确证据ID",
  "note": "说明原文为何支持这个目标上的具体假设",
  "evidenceQuotes": [{ "evidenceId": "明确证据ID", "quote": "真实原始输出中的连续原文，8到2000字符" }]
}
```

linkType 支持 supports / contradicts / depends_on / refines，targetType 支持 fact / evidence / intent。支持/反驳要求至少 8 字说明、1～10 条明确原文；事实必须是有目标观测来源的 observed/verified 且无未解决冲突，原文来自该事实的证据。意图只是计划，不能充当支持/反驳依据。完全相同请求幂等，修改解释或引用保存新关系版本；人工关系和审计同事务。有效引用只验证来源与边界，不自动证明解释在语义上充分，也不直接修改漏洞验证状态。

Worker 的 hypotheses 支持 hypothesisId（引用已有节点）、targetIp、evidenceQuotes、factIds、rationale；不再自动关联全部新事实。proposed 不添加支持关系，坏引用记录到结果卡未解决问题。Planner 新节点可用唯一 key，意图 hypothesisRefs 可引用本批 key 或已有节点 ID；重复 key 不猜测匹配。计划关系为 depends_on，不计入支持。Profile 提示词版本为 v4。

`GET /api/tasks/:taskId/evidence/:evidenceId/relations` 返回 `{ facts, hypotheses, findings }`。facts 为精确证据 ID 关联的事实摘要；hypotheses 为节点及与此证据有关的关系（包括失效历史及原因）；findings 包含候选来源或独立验证使用此证据的漏洞记录及 verificationIds。JSON 数组按完整 ID 匹配，不按子字符串搜索；跨任务或证据不存在返回 404。关联不等于验证通过。

新生成报告的 ReportSnapshot.hypotheses 冻结节点、关系、原文、解释与生成时校验结果，Markdown / PDF 增加“假设与依据快照”章节，JSON / ZIP 保留结构化关系。捕获使用生成报告的同一数据库事务，后续重跑、关系版本和原文变化不会改动旧报告。该字段为可选扩展，旧版报告仍按原快照校验，不凭空补入当前关系。

## 模型请求预算账本

`GET /api/tasks/:taskId/model-budget?page=1&history=false`：每页 25 条，默认仅当前运行；history=true 包含历史运行。无任务返回 404，非法 page/history 返回 400。

返回 tokenBudget、usableTokens（预算的 90%）、knownTokens（本轮已报告用量）、committedTokens（在途及未确认占用）、remainingTokens、total、note、items。每条请求包含 id、sessionId、currentRun、state、modelName、inputEstimate、maxOutputTokens、reservedTokens、committedTokens、inputTokens / outputTokens / costUsd（未知为 null）、errorMessage 和起止时间；不返回提示词、密钥或原始供应商错误。state 为 reserved / settled / uncertain / cancelled。

任务摘要增加 tokensCommitted；会话增加 tokenAllowance（null 表示共用任务余额）、budgetManaged 和 tokensCommitted。Planner 与 Worker 共用任务余额，Worker 另受自身额度约束。输入按序列化上下文预估，输出上限取配置、供应商上限、上下文窗口及剩余额度的最小值。缓存 Token 计入输入；供应商报告实际超额时完整记账并阻止后续自动调用，不截断账本以制造达标。临时并发占额会等待释放，不直接停止任务，也不长期占用全局模型并发槽。

取消、缺失用量或进程退出时保留未确认占用，已报告部分保留为已知最低用量，同会话不自动重发模型请求。迟到完整用量可幂等结算。任务重新运行使用新预算轮次，旧请求迟到结算只更新旧账本。任务详情支持查看本轮/历史请求；报告区分已报告用量与未确认占用，在途模型请求阻止自动宣告目标完成。

SDK 在派发工具前检查额度，MCP 执行器再独立检查，拒绝时记录 budget_exceeded，不发出远端请求。人工已批准调用的显式重放不受 Worker 自动调用额度门禁限制，仍检查当前授权范围、参数、权限和单次审批领取。输入估算并非精确分词，供应商也可能忽略输出上限，因此此机制不承诺绝对账单封顶。

## 凭据存储与展示

模型密钥和 MCP 请求头共用配置的持久化主密钥，环境 VA_ENCRYPTION_KEY 优先，否则使用 VA_ENCRYPTION_KEY_FILE（SQLite 默认 DB_PATH.key）。接口不返回主密钥、原始模型密钥或 headersEncrypted。模型密钥无法解密时明确返回服务不可用，不回退其他环境凭据；启动验证现存密文失败会阻止应用启动，须先恢复原主密钥。

MCP 服务 DTO 的 headersMasked 对密文显示“已加密保存请求头”，兼容旧明文时所有值均为 ****，不再仅隐藏固定名称列表。健康检查与工具执行共用工厂解密；解密失败返回失败且未发远端请求。传输错误及工厂日志隐藏已知请求头值（包含 Bearer / Basic 凭据本体）。成功工具证据仍按原始返回内容保存，这不替代对证据的访问控制。

## 手工数据保留与遗留记录维护

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/maintenance/preview` | 200，按 before / keepLatest / includeOrphans / page 预览，返回有时效的 digest；不写业务行或创建备份 |
| POST | `/api/maintenance/apply` | 200，提交相同策略、expiresAt / digest 及 confirmation="清理这些数据"；重校验、完整备份后在同一事务中清理及审计 |

before 为 UTC ISO 时间且不能在未来；keepLatest 为 0～1000 整数，page 为 1～100000 整数，includeOrphans 为布尔值，四项必填。预览 tasks / orphans 每类每页最多 100 项，含 taskId / name / finishedAt / rows / blockedReason；另返回 taskCandidates / orphanCandidates / backupAvailable / warnings。仅选择 stopped / completed / failed、有效结束时间早于截止且不在最近 N 项保护中的任务；孤立记录仅指 taskId 非空且父任务不存在的组。阻塞项保留。

apply 返回 deletedTasks / cleanedOrphanTasks / backup（path / sha256 / bytes）/ auditId。确认文字或策略格式错误 400，无可清理项 400；过期、数据库写入/条件变化、服务重启、内存库或工作未收尾 409。备份、审计或清理失败不提交业务修改；已生成的安全备份保留，路径写入后端日志。文件 I/O 或数据库故障返回 500。清理完成后通知为尽力推送，失败不改变已提交结果。完整操作和限制见 DATA_MAINTENANCE.md。

启动升级审计 action=security.secrets_upgraded，仅含 modelCount / headerCount，不含原文或密文。启动先验证现存密文，再同事务加密旧请求头和模型密钥；升级幂等，审计失败回滚全部数据修改。环境网关凭据仅应用于匹配网关名称和 URL 的新配置，不复制到其他 MCP 服务，也不覆盖同名已有记录。更换请求凭据后连接池按头部摘要隔离，新凭据不会复用旧凭据连接。
