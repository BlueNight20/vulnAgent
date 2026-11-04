<div align="center">

# VulnAgent

**自主渗透测试智能体平台**

多智能体协作 · 攻击链推理 · 证据驱动 · 全自动执行

[![NestJS](https://img.shields.io/badge/NestJS-11.2.8-E0234E?logo=nestjs)](https://nestjs.com)
[![React](https://img.shields.io/badge/React-18.3-61DAFB?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite)](https://www.sqlite.org)

</div>

> [!WARNING]
> **仅限授权测试环境使用。** 本项目面向已获得书面授权的靶场（如 VulnHub）与自有资产。
> 系统不内置任何攻击载荷，通过外部 MCP 工具集执行操作；所有工具调用受目标授权范围约束。
> 使用者须自行确保对目标具有合法授权，并承担由此产生的全部责任。

---

## 这是什么

VulnAgent 不是"一键扫描器"。它把一个渗透测试专家的**思考过程**变成了可执行的系统：

- **Planner** 决定下一步做什么（在哪里卡住、缺哪条信息、哪条线索还没利用）
- **Worker** 执行具体动作（侦察 / Web / 服务 / 分析 / 独立验证）
- **黑板** 沉淀事实、假设、线索与证据，供下一轮决策复用
- **证据链** 保证每个结论都能回溯到原始工具输出

与传统自动化扫描的区别在于**收敛性**：系统会识别死路、跳过重复枚举、把失败转化为知识，而不是无限扩大扫描范围。

---

## 架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Browser  (React 18 + Vite)                     │
│   TanStack Query（服务端状态） · Zustand（本地状态） · React Flow（拓扑） │
└──────────────────────────┬───────────────────────────┬──────────────────┘
                    REST /api/*                  WebSocket /ws
┌──────────────────────────▼───────────────────────────▼──────────────────┐
│                        apps/api  (NestJS 11)                            │
│                                                                         │
│   ┌──────────────────────────────────────────────────────────────────┐  │
│   │                    Orchestrator  编排循环                        │  │
│   │   验收判定 → 预算检查 → 规划 → 准入 → 评分 → 派发                │  │
│   └────────────┬─────────────────────────────────────┬───────────────┘  │
│                │                                     │                  │
│         ┌──────▼──────┐                       ┌──────▼──────┐           │
│         │  Planner    │─── 产出意图 ────────▶ │   Worker    │           │
│         │  (单会话)   │                       │ (多并发)    │           │
│         └─────────────┘                       └──────┬──────┘           │
│                ▲                                     │                  │
│                │              ┌──────────────────────▼───────────────┐  │
│         ┌──────┴──────┐       │        Tool Layer / MCP Proxy        │  │
│         │ Blackboard  │◀──────│  runtime-gate → 拦截规则 → 范围校验  │  │
│         │ 黑板        │       │  参数校验 · 调用记录 · 证据落库       │  │
│         │ 事实/假设   │       └──────────────────┬───────────────────┘  │
│         │ 线索/证据   │                          │                      │
│         └──────┬──────┘                          │                      │
│                │                                 │                      │
│   ┌────────────▼─────────────┐                   │                      │
│   │  独立验证队列            │                   │                      │
│   │  候选 → 复核 → 确认/排除 │                   │                      │
│   └──────────────────────────┘                   │                      │
│                                                  │                      │
│   Model Gateway（预算预留/结算）  ·  SQLite 32 表 ·  审计 ·  事件       │
└──────────────────────────────────────────────────┼──────────────────────┘
                                                   │ Streamable HTTP (MCP)
                                    ┌──────────────▼───────────────┐
                                    │  blhackbox MCP Gateway/Servers│
                                    │  kali · hexstrike · boaz ...  │
                                    │  （外部部署，本项目不修改）    │
                                    └──────────────────────────────┘
```

### 核心设计

| 机制 | 说明 |
|---|---|
| **攻击链推理** | 按 `侦察 → 服务识别 → 入口点 → 立足点 → 横向 → 提权 → 目标验证` 定位当前位置，只补齐通往下一阶段所缺的信息 |
| **死路识别** | 同一方向多次目标侧失败即标注为死路；工具缺失/越权等环境性失败不计入，避免误判 |
| **线索复用** | 主动追踪"已发现但未被利用"的凭据、路径、版本，避免停在原始发现上 |
| **意图去重** | 服务端生成稳定身份键（不含标题措辞），重复意图直接拒绝 |
| **验证隔离** | 验证会话不能产出新候选，切断"验证→新候选→再验证"的自我繁殖 |
| **线索分级** | `actionable`（可利用）/ `weakness`（加固建议）/ `non-finding`（否定性观测，不构成漏洞） |
| **全自动执行** | 工具调用无需人工审批；仅保留引擎开关与授权范围两条边界 |

---

## 快速开始

### 环境要求

| 依赖 | 版本 | 必需 |
|---|---|---|
| Node.js | `^22.22.3` \| `^24.15.0` \| `>=26` | ✅ |
| npm | `>= 10` | ✅ |
| Docker + blhackbox | 最新 | ⚠️ 执行真实测试时必需 |

### 1. 安装

```bash
git clone https://github.com/BlueNight20/vulnAgent.git
cd vulnAgent
npm install
```

> [!IMPORTANT]
> 本项目使用 **npm workspaces**，不要用 pnpm 安装（部分环境的 junction 安全策略会导致失败）。
> 首次安装如遇原生模块脚本被拦截，需显式批准：
>
> ```bash
> npm install-scripts approve better-sqlite3 esbuild @nestjs/core
> ```

### 2. 配置

```bash
# Linux / macOS
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

生成加密主密钥并填入 `VA_ENCRYPTION_KEY`：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> [!CAUTION]
> `VA_ENCRYPTION_KEY` 用于 AES-256-GCM 加密模型 API Key 与 MCP 请求头。
> **丢失后无法解密已有数据**，请单独妥善备份。不要将 `.env` 提交到版本库（已在 `.gitignore` 中）。

### 3. 启动

**方式一：一键启动**

```bash
# Windows PowerShell
pwsh -File scripts/start.ps1 -SkipInstall

# 或跨平台
npm run dev
```

**方式二：分别启动（两个终端）**

```bash
npm run dev:api    # 后端 :3001
npm run dev:web    # 前端 :5173
```

| 服务 | 地址 |
|---|---|
| 前端控制台 | http://localhost:5173 |
| 后端 API | http://localhost:3001/api |
| 健康检查 | http://localhost:3001/api/health |
| WebSocket | ws://localhost:3001/ws |

### 4. 首次使用

启动后按顺序完成三件事，否则任务无法运行：

1. **连接 MCP 工具集** — 到「MCP 管理」页检测连接，确认工具目录非空
   ```bash
   # blhackbox 目录中执行
   docker compose up -d
   ```
2. **填写模型密钥** — 到「系统设置」页填写 OpenAI 兼容模型 API Key（加密入库，前端只回显掩码）
3. **开启执行引擎** — 引擎默认关闭，须在设置页开启并保存

---

## 目录结构

```
vulnAgent/
├─ apps/
│  ├─ api/                        NestJS 后端
│  │  └─ src/
│  │     ├─ config/               环境校验与配置
│  │     ├─ common/               加密、异常过滤、分页工具
│  │     ├─ database/
│  │     │  ├─ entities/          32 张业务表（TypeORM）
│  │     │  └─ migrations/        14 条显式迁移
│  │     └─ modules/
│  │        ├─ orchestrator/      ★ 编排核心：循环、评分、准入、调度
│  │        │  ├─ kill-chain.ts         攻击链阶段推断 / 死路 / 线索
│  │        │  ├─ intent-identity.ts    意图稳定身份键
│  │        │  ├─ planner-capacity.ts   规划批量与队列压缩
│  │        │  ├─ tool-recovery.ts      工具失败替代策略
│  │        │  └─ planner-runner / worker-runner / worker-scheduler
│  │        ├─ blackboard/        ★ 黑板：事实、假设、意图、证据、漏洞
│  │        ├─ tool/              ★ 工具层：Invoker、Hook 链、拦截规则
│  │        ├─ mcp/               MCP 连接、目录、健康检查、Scope
│  │        ├─ pi-runtime/        Agent 会话运行时
│  │        ├─ model-gateway/     模型调用与 Token 预算
│  │        ├─ worker-skills/     角色档案与提示词构建
│  │        ├─ tasks/             任务生命周期
│  │        ├─ reports/           报告快照与导出
│  │        └─ dashboard/ workflow/ settings/ audit/ events/ health/
│  │
│  └─ web/                        React 前端
│     └─ src/
│        ├─ pages/                15 个页面
│        ├─ components/           UI 基础组件 / 布局 / 业务面板
│        ├─ features/workflow/    React Flow 执行拓扑
│        ├─ api/                  REST 客户端
│        └─ hooks/ stores/ lib/
│
├─ packages/
│  └─ shared/                     前后端共享枚举、类型、常量
│
├─ docs/                          设计与验收文档
├─ scripts/                       启动脚本与 30+ 隔离验证脚本
└─ .env.example                   环境变量模板
```

---

## 页面一览

| 路由 | 页面 | 说明 |
|---|---|---|
| `/dashboard` | 仪表盘 | 真实聚合指标与服务状态 |
| `/tasks` | 任务中心 | 创建 / 暂停 / 恢复 / 停止 / 重跑 |
| `/workflow` | 工作流 | 执行拓扑、事实黑板、工具调用 |
| `/agents` | 智能体工作台 | 会话列表与消息流 |
| `/attack-surface` | 攻击面分析 | 资产聚合与信息缺口 |
| `/vulnerabilities` | 漏洞发现 | 候选、独立验证历史、证据链 |
| `/evidence` | 证据管理 | 原文与完整性校验 |
| `/reports` | 报告中心 | Markdown / PDF / JSON / ZIP |
| `/tools` `/mcp` | 工具与 MCP | 目录、连接检测、权限 |
| `/commands` | 工具执行 | 手动调用记录 |
| `/intercept` | 拦截规则 | 平台级策略 |
| `/settings` | 系统设置 | 模型、引擎、日志、预算 |

---

## 测试

```bash
npm run typecheck    # 全仓类型检查（shared + api + web）
npm run test         # 单元测试（后端 47 个 + 前端 22 个测试文件）
```

隔离验证脚本（使用临时数据库和本机固定协议，**不访问真实靶机**）：

```bash
npm run test:findings          # 漏洞候选、去重、独立验证闭环
npm run test:goals             # 任务验收与目标判定
npm run test:runtime           # MCP 超时、取消、连接回收
npm run test:process-e2e       # 真实后端子进程端到端
npm run test:migrations        # 迁移与 CLI
npm run test:secrets           # 密钥加密与轮换
npm run test:planner-capacity  # 规划批量与队列压缩
```

完整列表见 `package.json` 的 `scripts` 段。

---

## 安全约定

- 模型 API Key 与 MCP 请求头以 **AES-256-GCM** 加密入库，前端永不接收明文
- 主密钥来自环境变量或持久化文件，丢失或损坏时明确失败，**不静默回退**
- 后端不执行任何 docker 命令，不访问 Docker Socket
- 所有任务创建须勾选授权确认；目标 IP / CIDR 前后端双重校验
- 工具调用受授权范围约束，范围外目标一律阻断
- 审计日志记录任务流转与配置变更，不记录密钥明文
- 数据库备份须配套保管原主密钥，仅恢复 SQLite 文件无法恢复解密能力

---

## 文档

| 文档 | 内容 |
|---|---|
| [PRD](docs/PRD.md) | 产品需求 |
| [架构设计](docs/ARCHITECTURE.md) | 模块划分与数据流 |
| [数据库设计](docs/DATABASE.md) | 表结构与关系 |
| [API 接口](docs/API.md) | REST 接口约定 |
| [开发计划](docs/DEVELOPMENT_PLAN.md) | 阶段规划 |
| [单人使用与靶机验收](docs/USER_ACCEPTANCE.md) | 首次配置与操作 |
| [执行引擎开关](docs/RUNTIME_CONTROL.md) | 引擎控制边界 |
| [Worker 并发与默认值](docs/WORKER_CAPACITY.md) | 并发与预算 |
| [最终交付核验](docs/FINAL_DELIVERY_AUDIT.md) | 逐项交付证据 |

---

## License

本项目未附带开源许可证。如需二次分发或商用，请先联系作者。

---

<details>
<summary><b>附录：实现细节与验收记录</b>（点击展开）</summary>

### 当前阶段范围

| 模块 | 状态 |
| --- | --- |
| NestJS 后端 + SQLite（32 张表） | 已接入 14 条显式迁移 |
| 任务中心（创建/暂停/恢复/停止/重跑） | 已完成 |
| 仪表盘（真实聚合 + 服务真实状态） | 已完成 |
| MCP 管理（真实连接检测 + 工具目录） | 已完成 |
| 工作流（React Flow） | 已接入真实运行记录 |
| 智能体、攻击面、漏洞、证据、设置 | 已接入业务接口 |
| 报告中心 | 快照、Markdown / 中文 PDF、JSON / ZIP 证据包 |
| Orchestrator / Pi Agent 执行引擎 | 代码已接入，靶机实测由用户负责 |
| MCP Policy Proxy 运行时拦截 | 引擎开关、授权范围与参数校验；工具审批已取消 |
| 模型 / Worker Token 预算 | 请求前预留、实际结算、未确认占用和本轮/历史账本 |

### 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 后端端口 | `3001` |
| `DB_PATH` | SQLite 文件路径 | `./storage/vulnagent.sqlite` |
| `VA_ENCRYPTION_KEY` | 密钥加密主密钥（base64，32 字节） | 空 |
| `VA_API_HOST` | API 监听地址 | `127.0.0.1` |
| `VA_ENCRYPTION_KEY_FILE` | 持久化主密钥文件 | `DB_PATH.key` |
| `MCP_GATEWAY_URL` | MCP Gateway 地址 | `http://localhost:8080/mcp` |
| `MODEL_BASE_URL` / `MODEL_NAME` | OpenAI 兼容模型端点 | `https://api.deepseek.com/v1` |
| `WORKER_MAX_CONCURRENCY` | Worker 并发上限 | `2` |
| `MODEL_MAX_CONCURRENCY` | 模型请求并发上限 | `2` |
| `PI_RUNTIME_ENABLED` | 未保存数据库设置时的执行开关 | `false` |

### 实现笔记

**安装注意**

1. 项目使用 npm workspaces。部分环境的安全策略会拒绝遍历 pnpm 创建的 junction（`os error 448`），因此不建议 pnpm（`pnpm-workspace.yaml` 已保留但非默认）。
2. `packages/shared` 依赖其 `dist/` 下的 CJS 产物，后端启动前须先构建（`npm run dev:api` 与 `npm run build` 已自动执行）。
3. 若 `better-sqlite3` 报 `Cannot find module 'bindings'`，执行 `npm install bindings --workspace @vulnagent/api`。

**执行引擎**

引擎默认关闭，须在设置页开启并保存；关闭会暂停运行任务，重新开启后须手动恢复。引擎与任务中心共用持久化控制队列，控制 POST 返回 TaskSummary 表示请求接受，实际快照从 GET 获取。终态任务须先重新运行；暂停、等待输入及停滞使用恢复，保留原预算。详见 [引擎控制说明](docs/ENGINE_CONTROLS.md)。

**日志**

日志级别与文件开关保存后即时生效，文件默认追加到 API 工作目录的 `storage/logs/vulnagent.jsonl`，目录可由 `LOG_DIR` 配置。见 [运行日志说明](docs/LOGGING.md)。

**提示投递**

人工提示可指定当前会话或后续任务规划；定向提示不会被其他 Worker / Planner 读取，实际接收后才消费。见 [提示投递说明](docs/HINT_DELIVERY.md)。

**数据维护**

SQLite 默认关闭自动改表，支持新库建表、匹配旧库接管与迁移前备份，见 [迁移说明](apps/api/src/database/migrations/README.md)。一致性备份、校验、恢复和按数量轮换已提供 CLI，见 [备份恢复说明](docs/BACKUP_RECOVERY.md)。设置页提供手工数据保留与父任务缺失记录维护：先预览、再备份并原子清理，不安装定时任务，见 [数据维护说明](docs/DATA_MAINTENANCE.md)。

**漏洞与验证**

漏洞发现页支持候选、独立验证队列、历史和证据跳转。确认或排除必须经过独立验证，版本匹配不能直接确认漏洞。`npm run test:findings` 验证数据闭环；真实模型与靶机准确率仍待验收。

**假设与证据**

工作流提供假设依据面板，证据页可反查事实、假设和漏洞/验证记录。支持或反驳必须给出明确证据 ID、连续原文和解释；重复文本不增加支持计数，冲突保留待验证。`npm run test:hypotheses` 验证引用规则。

**报告**

Markdown / PDF 可离线核查，JSON / ZIP 包含结构化关系。单文件 16 MiB、单次调用二进制合计 32 MiB；报告文本快照及二进制副本各最多 32 MiB，PDF 正文 2 MiB / 500 页。字体随 API 构建打包，运行无需 Python 或联网取字体。见 `npm run test:reports` / `test:attachments`。

**运行边界**

已识别端口扫描默认单批 256 地址 / 1024 端口 / 4096 地址×端口×协议组合；`.env.example` 中 `MCP_MAX_SCAN_*` 可调整。超限时按工具建议和验收缺口拆批，系统不会静默改写参数。每个 Worker 最多 24 次工具请求、连续 3 次失败后停止，整项任务由 Planner 根据已存证据继续规划。

**任务生命周期**

重跑保留历史证据/报告，取消旧排队工作、关闭未完成验证、释放意图去重键。删除入口位于任务详情，需输入任务名称；删除全部所属数据和报告附件，保留审计及最小防重建 ID。`npm run test:lifecycle` 验证暂停/恢复/停止事件、事务回滚和并发操作。

</details>
