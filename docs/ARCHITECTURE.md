# VulnAgent 架构设计文档

- 文档版本：v0.1（第一阶段）
- 更新日期：2026-11-01

## 当前实现说明（2026-11-03）

下文的第一阶段图和边界是历史设计，当前已接入 Orchestrator、真实 Pi Session、Planner / Worker、MCP 运行时策略、证据/附件、独立验证及冻结报告。当前采用单人自用、单 API 实例、SQLite 显式迁移，不以账号/多用户为交付前提。实际模块与验证见 CORE_REQUIREMENTS_AUDIT.md / IMPLEMENTATION_STATUS.md。

当前链路为管理台 → 任务/持久化控制事件 → Orchestrator → Planner/Worker → 模型网关与 MCP 执行器 → 原始证据 → 事实/假设/候选 → 独立验证 → 目标验收与报告。角色工具权限、授权范围、参数、审批、预算和实际执行开关共同约束派发。工作流图从真实执行记录生成；会话采用分页文本/结构化消息查看，不用终端控件解释工具返回的控制序列。

数据库为 31 张业务表、10 条显式迁移，自动同步默认关闭；迁移、清理、唯一约束与备份已有 SQLite 专用实现，因此 PostgreSQL 适配需要修改与验证，不能只更换驱动。密钥持久化与备份分离，恢复须使用原主密钥。默认 API 仅监听本机。运行开关、恢复及用户实测边界见 RUNTIME_CONTROL.md / USER_ACCEPTANCE.md / BACKUP_RECOVERY.md。

---

## 1. 总体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                          Browser (React SPA)                     │
│  React 18 + TS + Vite + Tailwind + shadcn 风格组件 + React Flow   │
│  Zustand（本地 UI 状态） + TanStack Query（服务端状态）            │
└───────────────┬───────────────────────────┬──────────────────────┘
                │ REST /api/*               │ WebSocket /ws
┌───────────────▼───────────────────────────▼──────────────────────┐
│                       apps/api (NestJS)                          │
│  ┌───────────┬──────────┬──────────┬──────────┬───────────────┐  │
│  │ tasks     │ dashboard│ mcp      │ settings │ events(WS)    │  │
│  └───────────┴──────────┴────┬─────┴──────────┴───────────────┘  │
│                             │ McpHealthService                  │
│                        TypeORM + better-sqlite3                  │
└─────────────────────────────┼────────────────────────────────────┘
                              │ Streamable HTTP (MCP 1.32.2 JDK)
                  ┌───────────▼────────────┐
                  │ blhackbox MCP Gateway  │  http://localhost:8080/mcp
                  │  (外部已部署，不复刻)   │
                  └───────────┬────────────┘
                              │
        kali / wire / screenshot / boaz / hexstrike MCP 服务

后续阶段（不在第一阶段）：
  Orchestrator Core ──► Planner (Pi Session) ──► Workers (Pi Sessions)
                     └─► MCP Policy Proxy ──► blhackbox
```

## 2. 仓库结构

```
vulnagent/
├─ apps/
│  ├─ api/                 NestJS 后端
│  │  └─ src/
│  │     ├─ main.ts
│  │     ├─ app.module.ts
│  │     ├─ config/        配置与校验
│  │     ├─ common/        过滤器、管道、加密、分页
│  │     ├─ database/      实体、数据源、初始化
│  │     ├─ modules/
│  │     │  ├─ tasks/      任务与目标
│  │     │  ├─ dashboard/  聚合指标
│  │     │  ├─ mcp/        服务、目录、健康检查、权限、调用记录
│  │     │  ├─ settings/   系统设置与密钥
│  │     │  ├─ audit/      审计日志
│  │     │  └─ events/     WebSocket 网关
│  │     └─ test/          单元测试
│  └─ web/                 React 前端
│     └─ src/
│        ├─ main.tsx / App.tsx / router.tsx
│        ├─ layouts/       AppLayout / Sidebar / Topbar / PageHeader
│        ├─ components/ui  基础组件（Button/Table/Badge/Drawer/...）
│        ├─ pages/         10 个页面
│        ├─ api/           HTTP 客户端与各资源 API
│        ├─ hooks/         Query hooks、WebSocket hook
│        ├─ stores/        Zustand
│        └─ mock/          工作流 Mock 数据（独立模块）
├─ packages/shared/        共享枚举、类型、DTO、常量
├─ docs/
├─ scripts/                PowerShell 启动脚本
├─ .env.example
└─ README.md
```

## 3. 后端设计

### 3.1 模块职责

| 模块 | 职责 |
| --- | --- |
| `ConfigModule` | 读取 `.env`，Joi 校验；输出结构化配置对象 |
| `DatabaseModule` | TypeORM + better-sqlite3，`synchronize` 由环境变量控制（开发开、生产关） |
| `TasksModule` | 任务 CRUD、授权目标管理、状态流转（pause/resume/stop/rerun）、审计 |
| `DashboardModule` | 指标聚合、服务状态汇总（真实检查） |
| `McpModule` | MCP 服务配置、真实健康检查、工具目录同步、权限矩阵、调用记录 |
| `SettingsModule` | 模型 Provider 配置、Pi Runtime 配置、密钥加密存储与掩码 |
| `AuditModule` | 统一审计写入服务 |
| `EventsModule` | 原生 ws 网关，向客户端推送状态/检测结果事件 |

### 3.2 状态机（任务）

```
pending ──start──► running ──pause──► paused ──resume──► running
   ▲                  │  ▲                                    │
   │                  │  └────────────────────────────────────┘
   │                  ├──stop──► stopped ──rerun──► pending
   │                  └──finish──► completed / failed
   └──rerun（任意终态）
```

第一阶段：状态流转是真实的（落库 + 审计 + WS 推送），但**不会真正启动 Agent 执行**，任务进入 running 后由用户手动停止/标记（界面明确提示「执行引擎未接入」）。

### 3.3 MCP 健康检查

- 使用 `@modelcontextprotocol/sdk@1.32.2`：
  - `import { Client } from '@modelcontextprotocol/sdk/client/index.js'`
  - `import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'`
- 流程：`new StreamableHTTPClientTransport(new URL(endpoint))` → `client.connect(transport)` → `client.listTools()` → `finally client.close()`。
- 超时：Promise.race + AbortSignal（默认 5000ms，可配）。
- 结果持久化到 `mcp_servers`：`status`、`lastCheckedAt`、`latencyMs`、`toolCount`、`lastError`。
- 缓存：同一服务 30 秒内重复检测返回缓存（`cacheTtlMs` 可配）。
- **未连接时绝不返回在线**：状态为 `unreachable`，并携带真实错误消息。

### 3.4 MCP Policy Proxy（第一阶段边界）

第一阶段实现：
- 目标白名单（来自任务授权范围）
- 工具权限矩阵配置与持久化（`agent_tool_permissions`）
- 工具调用记录表结构与查询接口（`tool_calls`）

第一阶段**未实现**：实际运行时拦截。文档与界面均显式标注「仅配置，尚未形成执行拦截」。

## 4. 前端设计

### 4.1 技术要点

- 路由：React Router v6，`createBrowserRouter`。
- 服务端状态：TanStack Query（staleTime 5s，重试 1 次）。
- 本地状态：Zustand（侧栏折叠、任务筛选、抽屉状态）。
- 图表：ECharts（`echarts` + `echarts-for-react`）。
- 画布：`@xyflow/react`（React Flow v12，`xyflow` 官方新包名）。
- 术语终端：xterm.js 第一阶段仅安装，用于第二阶段 Agent 原始日志区。

### 4.2 数据流

```
Page ──useQuery──► api client (fetch) ──► /api/* ──► NestJS
  ▲                                              │
  └──── WebSocket 事件（useWebSocket）◄──────────┘
```

- 顶栏显示 API 状态与 WebSocket 状态（真实连接结果）。
- API 不可达时页面显示真实错误态（不显示假数据）。

### 4.3 视觉规范

| 元素 | 规范 |
| --- | --- |
| 侧栏 | 232px 宽，深蓝 `#0B1F3A → #102A4C`，分组标题 12px 字距 0.08em |
| 主区 | `#F5F7FA` 背景，内容最大宽 1680px |
| 主色 | `#2563EB`，hover `#1D4ED8` |
| 成功 | `#16A34A`；待验证 `#F59E0B`；风险 `#DC2626`；信息 `#0891B2` |
| 文本 | `#0F172A` / `#475569` / `#94A3B8` |
| 字体 | Inter，正文 13px，标题 22px/600 |
| 圆角 | 卡片 8px，按钮 6px，表格无圆角 |
| 动效 | 150–200ms，克制，不做弹跳 |

## 5. 安全设计

1. **密钥**：`VA_ENCRYPTION_KEY`（32 字节 base64）作为主密钥；API Key 以 AES-256-GCM 加密存入 `system_settings`（或独立表），接口返回 `sk-****1234`。
2. **进程权限**：后端只做 HTTP 探测，不执行 docker 命令，不访问 Docker Socket。
3. **目标约束**：任务创建时校验 IP/CIDR 格式，落库；后续 Policy Proxy 以此为准。
4. **CORS**：仅允许 `WEB_ORIGIN`（默认 `http://localhost:5173`）。
5. **日志**：审计日志记录操作者、动作、对象、结果，不记录密钥明文。

## 6. 已核实的 SDK 事实

> 以下内容来自官方仓库 README / 示例源码，实施时以 `node_modules` 类型定义为准。

### MCP TypeScript SDK v1.x（1.32.2）

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080/mcp'));
const client = new Client({ name: 'vulnagent', version: '0.1.0' });
await client.connect(transport);
const { tools } = await client.listTools();       // tools[].name / description / inputSchema
const result = await client.callTool({ name: 'x', arguments: {} });
await client.close();
```

- 协议：支持 MCP `2025-11-25` 规范。
- `zod` 为必需 peer dependency。

### Pi Agent SDK（`@earendil-works/pi-agent-core` 1.4.0 + `@earendil-works/pi-ai` 1.4.0）

- 核心类 `Agent`（**无 `createAgent`**，**无独立 session 模块**，会话 = 一个 `Agent` 实例 + `sessionId`）。
- `new Agent({ initialState: { systemPrompt, model, tools }, streamFn, sessionId, getApiKey, beforeToolCall, afterToolCall })`
- `agent.subscribe(cb)` 事件：`agent_start`、`agent_end`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`。
- 方法：`prompt()`、`continue()`、`steer()`、`followUp()`、`abort()`、`waitForIdle()`、`reset()`。
- 模型：`createModels()`、`models.setProvider(...)`、`models.getModel(provider, id)`、`models.streamSimple`。
- 工具：`AgentTool`（`name/label/description/parameters(TypeBox)/execute(toolCallId, params, signal, onUpdate)`）。

第一阶段不运行 Agent，仅记录契约，避免编造接口。

## 7. 扩展性设计

- **数据库方言（历史意图，当前尚未达成）**：PostgreSQL 需要另行适配实体/迁移、SQL、事务锁、备份维护及原生验证；目前不能只更换驱动与连接配置。
- **Worker 并发**：`WORKER_MAX_CONCURRENCY`（默认 2）、`MODEL_MAX_CONCURRENCY`（默认 2）进入配置，第二阶段由 Orchestrator 读取。
- **MCP 多服务**：`mcp_servers` 表支持任意数量服务，第一阶段默认只有 Gateway。
