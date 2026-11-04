# VulnAgent

授权靶机测试管理平台，完整代码实现与本地交付核验已完成；真实靶机实测由用户负责。逐项证据见 [最终交付核验](docs/FINAL_DELIVERY_AUDIT.md)。

当前按用户明确的单人自用需求交付，不以账号登录和多用户隔离作为前置条件。SQLite 仍为已验证后端；PostgreSQL 是否引入按并发写入、图关系查询和部署成本评估，不因单用户就认定无价值，也不在咨询选型时自动迁移。

首次配置、任务操作、验收结果和故障反馈见 [单人使用与靶机验收](docs/USER_ACCEPTANCE.md)。执行引擎默认关闭，须在设置页开启并保存；关闭会暂停运行任务，重新开启后须手动恢复。模型连接测试和 MCP 健康检查仍可显式执行。控制边界与验证见 [执行引擎开关](docs/RUNTIME_CONTROL.md)。

引擎与任务中心共用持久化控制队列，控制 POST 返回 TaskSummary 表示请求接受，实际快照从 GET 获取。终态任务须先重新运行；暂停、等待输入及停滞使用恢复，保留原预算。接口、回滚及中断语义见 [引擎控制说明](docs/ENGINE_CONTROLS.md)。

日志级别与文件开关保存后即时生效，文件默认追加到 API 工作目录的 storage/logs/vulnagent.jsonl，目录可由 LOG_DIR 配置。设置页显示实际输出状态，故障及保留边界见 [运行日志说明](docs/LOGGING.md)。

新任务读取保存的真实模型及默认预算/Worker 数量，填写期间保留草稿；系统全局 Worker 上限与任务自身上限共同约束派发。等待不消耗重试或无进展轮次，时间预算仍执行；详见 [Worker 并发与默认值](docs/WORKER_CAPACITY.md)。

人工提示可指定当前会话或后续任务规划；定向提示不会被其他 Worker / Planner 读取，实际接收后才消费。暂停、重启和未确认模型用量的边界见 [提示投递说明](docs/HINT_DELIVERY.md)。工作流按意图的真实来源会话连线，不将多轮规划都归给最早 Planner。

> VulnAgent 面向**已授权的 VulnHub 实验环境**。目前已接入真实工具执行、编排和文本证据管理。
>
> **全自动模式**：工具调用一律无需人工审批，由模型自行选择侦察、利用与验证工具，不限制工具能力；仅保留两条授权边界——引擎开关（系统设置）与目标授权范围（scope-guard）。事实冲突由引擎按证据强度自动裁决，漏洞评级/CVE/CWE 的人工维护入口已移除。
> 下方部分内容保留第一阶段说明；最新进度与验收限制以 [持续实现记录](docs/IMPLEMENTATION_STATUS.md) 为准。

SQLite 默认关闭自动改表，支持新库建表、匹配旧库接管与迁移前备份，参见 [迁移说明](apps/api/src/database/migrations/README.md)。

SQLite 一致性备份、校验、新路径恢复和按数量轮换已提供 CLI，见 [备份恢复说明](docs/BACKUP_RECOVERY.md)。轮换默认只生成新备份并预览旧包清理，显式 --apply 才执行。设置页已提供手工数据保留及父任务缺失记录维护：先预览、再备份并原子清理，保留审计和防重建 ID；不安装定时任务，见 [数据维护说明](docs/DATA_MAINTENANCE.md)。

新增隔离验证命令：`npm run test:execution`（执行与审批恢复）、`npm run test:migrations`（迁移、CLI 与完整应用启动）。两者均不访问真实靶机。

漏洞发现页已支持候选、独立验证队列、历史和证据跳转，以及有原文依据的描述、评级、CVE/CWE、CVSS 和修复建议维护。修改保留前后字段并检查版本冲突，不改变独立验证结论；证据失效后页面和新报告不再采用相应评级及编号。操作与 API 见 [漏洞维护说明](docs/FINDING_ASSESSMENTS.md)。`npm run test:findings` 与 `npm run test:finding-assessments` 验证数据闭环；真实模型与靶机准确率仍待验收。

Linux 审计与独立验证档案已核对命令工具和审批角色；启动时过滤目录及角色权限，显式拒绝优先，审批后仍重查最新范围与权限。`npm run test:profile-permissions` 验证固定协议下的审批、新调用与独立证据路径；实际远程访问及靶机权限效果不由该协议测试证明，见 [档案权限说明](docs/PROFILE_PERMISSIONS.md)。

权限页支持精确工具、自定义模式及审批要求；权限修改和含原值的审计同事务，提交后才推送结果。第十条迁移约束全局规则唯一，并保留历史重复规则的完整审计、维持原有拒绝语义。`npm run test:permission-updates` 覆盖并发、审计/提交失败及通知时序，见 [权限维护说明](docs/PERMISSION_UPDATES.md)。

---

## 1. 当前阶段范围

| 模块 | 状态 |
| --- | --- |
| 5 份设计文档（`docs/`） | 已完成 |
| NestJS 后端 + SQLite（31 张表） | 已接入 10 条显式迁移 |
| 任务中心（创建/暂停/恢复/停止/重跑） | 已完成 |
| 仪表盘（真实聚合 + 服务真实状态） | 已完成 |
| MCP 管理（真实连接检测 + 工具目录） | 已完成 |
| 工作流（React Flow） | 已接入真实运行记录 |
| 智能体、攻击面、漏洞、证据、设置 | 已接入业务接口 |
| 报告中心 | 已接入快照、Markdown / 中文 PDF、JSON / ZIP 文本和二进制证据包 |
| Orchestrator / Pi Agent 执行引擎 | 代码已接入，靶机实测由用户负责 |
| MCP Policy Proxy 运行时拦截 | 已接入引擎开关、授权范围与参数校验；工具审批已取消 |
| 后端框架与连接 | Nest 11 / Express 5；已验证 HTTP、WebSocket 和隔离 npm ci 后的运行时 |
| 模型 / Worker Token 预算 | 请求前预留、实际结算、未确认占用和本轮 / 历史账本 |

## 2. 环境要求

- Windows 10/11（PowerShell 7 或 Windows PowerShell 5.1）
- Node.js ^22.22.3 / ^24.15.0 / ≥26（当前验证 v24.21.0；与 CLI 配套工具链引擎约束一致）
- npm ≥ 10（已验证 11.19.0）
- 可选：Docker 中已部署的 blhackbox（MCP Gateway `http://localhost:8080/mcp`）

## 3. 安装依赖

```powershell
cd C:\Users\20396\Desktop\11
npm install
```

> **重要（已踩坑，请务必阅读）**
>
> 1. 本项目使用 **npm workspaces** 而非 pnpm 安装依赖。
>    原因：本机安全策略会拒绝遍历 pnpm 创建的 junction（`os error 448 不受信任的装入点`），
>    pnpm 12 即使配置 `node-linker=hoisted` 仍会为 workspace 依赖创建 junction。
>    若你的环境没有该限制，也可以使用 pnpm（`pnpm-workspace.yaml` 已保留）。
> 2. `packages/shared` 通过 `file:../../packages/shared` 引用，依赖其 `dist/` 下的 CJS 产物。
>    因此**后端启动前必须先构建 shared 包**（`npm run dev:api` 与 `npm run build` 已自动执行）。
> 3. 若 `better-sqlite3` 报 `Cannot find module 'bindings'`，说明传递依赖未正确落盘，执行
>    `npm install bindings --workspace @vulnagent/api` 修复。

首次安装时，npm 可能会拦截原生模块的安装脚本，需要批准（否则 SQLite 无法加载）：

```powershell
npm install-scripts approve better-sqlite3
npm install-scripts approve esbuild
npm install-scripts approve @nestjs/core
```

## 4. 配置环境变量

```powershell
Copy-Item .env.example .env
# 生成 32 字节 AES-256-GCM 主密钥并写入 VA_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

关键变量：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 后端端口 | `3001` |
| `DB_PATH` | SQLite 文件路径 | `./storage/vulnagent.sqlite` |
| `VA_ENCRYPTION_KEY` | 密钥加密主密钥（规范 base64，32 字节），优先于文件 | 空 |
| `VA_API_HOST` | API 监听地址；远端部署须显式配置并配套访问控制 | `127.0.0.1` |
| `VA_ENCRYPTION_KEY_FILE` | 持久化主密钥文件，相对 API 工作目录 | SQLite 默认 `DB_PATH.key`；其他数据库须显式配置 |
| `MCP_GATEWAY_URL` | blhackbox MCP Gateway 地址 | `http://localhost:8080/mcp` |
| `MODEL_BASE_URL` / `MODEL_NAME` | OpenAI 兼容模型端点 | `https://api.deepseek.com/v1` / `deepseek-chat` |
| `WORKER_MAX_CONCURRENCY` | Worker 并发上限 | `2` |
| `MODEL_MAX_CONCURRENCY` | 模型请求并发上限 | `2` |
| `PI_RUNTIME_ENABLED` | 未保存数据库设置时的执行开关；数据库设置优先 | `false` |

## 5. 启动

**方式一：一键启动（推荐）**

```powershell
pwsh -File scripts\start.ps1
```

**方式二：手动分别启动（两个终端）**

```powershell
# 终端 1 - 后端（首次会先编译 shared 包）
npm run dev:api

# 终端 2 - 前端
npm run dev:web
```

启动后访问：

| 服务 | 地址 |
| --- | --- |
| 前端控制台 | http://localhost:5173 |
| 后端 API | http://localhost:3001/api |
| 健康检查 | http://localhost:3001/api/health |
| WebSocket | ws://localhost:3001/ws |

前端通过 Vite 代理把 `/api`、`/ws` 转发到后端，无需额外配置 CORS。

## 6. 页面路由

| 路由 | 页面 | 状态 |
| --- | --- | --- |
| `/dashboard` | 仪表盘 | 已实现 |
| `/tasks` | 任务中心 | 已实现 |
| `/workflow` | 工作流 | 已实现（运行记录） |
| `/mcp` | MCP 管理 | 已实现（真实检测） |
| `/agents` | 智能体工作台 | 已实现 |
| `/attack-surface` | 攻击面分析 | 已实现（来源证据与信息缺口） |
| `/vulnerabilities` | 漏洞发现 | 已实现（候选与独立验证历史） |
| `/evidence` | 证据管理 | 已实现（文本与完整性校验） |
| `/reports` | 报告中心 | 占位 |
| `/settings` | 系统设置 | 已实现 |

## 7. 测试与校验

```powershell
# 类型检查（shared + api + web）
npm run typecheck

# 单元测试（后端状态/证据规则、前端工具与页面交互）
npm run test

# 冒烟测试（需后端已启动）
pwsh -File scripts\smoke.ps1
```

## 8. 目录结构

```
.
├─ apps/
│  ├─ api/                 NestJS 后端
│  │  └─ src/
│  │     ├─ config/        环境变量校验与配置
│  │     ├─ common/        异常过滤器、加密、分页
│  │     ├─ database/      TypeORM 实体（30 张表）
│  │     └─ modules/       tasks / dashboard / mcp / settings / workflow / audit / events / health
│  └─ web/                 React 前端
│     └─ src/
│        ├─ components/    ui 基础组件、布局、业务组件
│        ├─ pages/         10 个页面
│        ├─ api/           REST 客户端
│        ├─ hooks/         数据查询与 WebSocket
│        ├─ stores/        Zustand
│        ├─ mock/          工作流 Mock 数据（独立模块）
│        └─ lib/           工具函数与导航配置
├─ packages/shared/        前后端共享枚举、类型、常量、校验
├─ docs/                   PRD / ARCHITECTURE / DATABASE / API / DEVELOPMENT_PLAN
└─ scripts/                dev.mjs / start.ps1 / smoke.ps1
```

## 9. 连接 blhackbox

本项目**不修改** blhackbox 及其 Docker Compose 项目，只通过 MCP 协议（官方 TypeScript SDK，
Streamable HTTP）连接：

```
VulnAgent API  ──StreamableHTTP──▶  http://localhost:8080/mcp (blhackbox MCP Gateway)
```

- 默认只配置 Gateway 统一入口，其余 MCP 服务由网关发现。
- 未启动时，MCP 管理页会显示真实的「未连接」状态与具体错误原因（不会出现假在线）。
- 启动 Gateway（在 blhackbox 项目目录中执行，本仓库不会自动执行）：

```bash
docker compose --profile gateway up -d
```

## 10. 安全约定

- 前端**永远**不接收模型 API Key 明文，接口只返回 `sk-a****9f3c` 掩码。
- API Key 以 AES-256-GCM 加密存入 `system_settings`，主密钥来自环境变量或持久化文件。SQLite 未配置环境主密钥时，首次保存创建 `DB_PATH.key`，并发进程不会覆盖；重启复用。读取旧密文时文件丢失、损坏或主密钥变化会明确失败，不生成替代密钥、不静默回退其他凭据。旧临时主密钥加密的数据无法凭空恢复，须重新填写模型密钥。
- 数据库备份恢复须配套保管原主密钥（单独受控保存）；仅恢复 SQLite 文件不能恢复解密能力。Unix 创建文件权限为 0600、目录为 0700；Windows 继承目录 ACL，应将目录限制为运行账户可访问。不要将主密钥放入证据包或报告。
- MCP 请求头全部加密保存为 `mcp_servers.headersEncrypted`，原 headers 明文字段清空。启动在同一事务中升级旧请求头与旧明文模型密钥，并记录不含凭据的审计；已有密文必须先能解密，否则拒绝升级和启动。网关环境请求头仅用于匹配名称与地址的网关，不共享给其他服务；同名既有配置仍以数据库为准。
- `npm run test:secrets` 使用临时 SQLite、假凭据和本机固定 MCP 协议，验证真实进程重启、并发创建、旧数据原子升级、健康检查/执行器解密、轮换后连接隔离、损坏配置不发请求及传输错误脱敏，不连接外部模型或靶机。
- `npm run test:http-ws` 验证完整应用的任务 HTTP 和真实 WebSocket 推送；`npm run test:clean-install` 在临时目录从锁文件安装依赖并重复关键运行时验证，不复制用户配置和数据库。当前完整/生产依赖审计均为 0 项，Nest CLI 12 / TypeScript 6 及资源监听修正见 [依赖整改记录](docs/DEPENDENCY_STATUS.md)。
- `npm run test:process-e2e` 运行真实后端入口子进程，以 HTTP 驱动规划、并行 Worker、MCP、证据、独立复核、分析和报告，再验证完成后重启及执行中断恢复；只使用本机固定协议，不访问靶机。见 [进程联调说明](docs/PROCESS_ACCEPTANCE.md)。
- 后端不执行任何 docker 命令，不访问 Docker Socket。
- 所有创建任务必须勾选授权确认；目标 IP 与 CIDR 在前后端双重校验。
- 审计日志记录任务流转、MCP 检测、权限变更、设置变更，不记录密钥明文。

## 11. 文档

- [PRD](docs/PRD.md)
- [架构设计](docs/ARCHITECTURE.md)
- [数据库设计](docs/DATABASE.md)
- [API 接口](docs/API.md)
- [开发计划](docs/DEVELOPMENT_PLAN.md)

资产与规划上下文的隔离验证：`npm run test:surface`。真实靶机测试由用户操作，系统完成前以持续实现记录中的未完成项为准。

任务验收与启动链路的隔离验证：`npm run test:goals`。创建任务可选择范围观测、分析与独立复核、指定原文标记；任务详情展示验收进度。修改目标须暂停，新运行和新目标要求新证据。旧任务需明确配置目标后继续。全部测试使用临时数据库和工具替身，靶机实测由用户执行。

报告快照与导出的隔离验证：`npm run test:reports`、`npm run test:attachments`。报告中心导出 Markdown / 中文 PDF、完整 JSON / ZIP 证据包及单条证据；保存 MCP 内嵌图片、音频和 resource.blob 的原始字节，报告保留独立副本。外部 URL、filePath 或 resource_link 仅记录引用，不自动读取。单文件 16 MiB、单次调用二进制合计 32 MiB；报告文本快照及二进制副本各最多 32 MiB，PDF 正文 2 MiB / 500 页，超限明确拒绝。已有报告不随原始证据修改或删除改变，损坏副本阻止导出；独立漏洞验证仍需可核验的文本引用。图片预览需要用户点击，模型只收到附件元数据。字体随 API 构建打包，运行无需 Python 或联网取字体。

工具审批已整体移除（全自动执行）：不再产生 `pending_approval` 记录，审批页面、审批接口与重放链路均已删除。模型对任意已注册 MCP 工具可直接调用。`npm run test:approval-recovery` 中覆盖审批面板的部分不再适用，其余执行恢复语义仍有效。完整剩余工作见 [交付检查清单](docs/DELIVERY_CHECKLIST.md)。

任务生命周期：`npm run test:lifecycle` 验证真实任务接口到编排器的暂停/恢复/停止事件、事务回滚和并发操作。重跑保留历史证据/报告，取消旧排队工作、关闭未完成验证、释放意图去重键并更新验收时间边界。删除入口位于任务详情，需输入任务名称；删除全部所属数据和报告附件，保留审计及最小防重建 ID。运行中、在途工作、未收尾审批/会话或待处理事件会阻止删除/重跑。删除需要 SQLite 显式迁移，开发期 synchronize 不能替代约束安装；跨任务附件关联会阻止删除。`npm run test:data-maintenance` 验证手工保留策略、缺失父任务的遗留记录、完整备份、预览失效、清理回滚及分页；系统不自动定时清理。

假设与证据：工作流增加假设依据面板，证据页能反查事实、假设和漏洞/验证记录。支持或反驳必须给出明确证据 ID、连续原文和解释；读取时重查任务、目标/端口、调用来源、完整性及当前运行边界，重复文本不增加支持计数，冲突保留待验证。Planner / Worker 使用校验视图和明确 ID 建立研究计划，禁止把全部事实连到每个假设。第六条迁移保留旧关联为 legacy，不自动采信旧计数；新增引用需 `npm run test:hypotheses` 验证。引用存在不能证明语义充分，漏洞确认仍走独立验证。

新报告同时冻结假设关系、解释、原文和生成时校验结果；Markdown / PDF 可离线核查，JSON / ZIP 包含结构化关系。旧报告保持原快照，不随当前假设变化重写。

运行边界与取消链路验证：`npm run test:runtime`。使用真实 MCP SDK 与仅监听本机的定时器工具检查超时、取消和连接回收，再用隔离数据库检查 Worker 期限与重试。不会连接靶机。已识别端口扫描默认单批 256 地址 / 1024 端口 / 4096 地址×端口×协议组合；`.env.example` 中 MCP_MAX_SCAN_* 可调整。超限时按工具建议和验收缺口拆批，系统不会静默改写参数。每个 Worker 最多 24 次工具请求、连续 3 次失败后停止，整项任务由 Planner 根据已存证据继续规划。
