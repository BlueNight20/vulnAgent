# VulnAgent 开发计划

- 版本：v0.1
- 更新日期：2026-11-01

当前状态说明（2026-11-03）：下文为历史分阶段计划，不是当前功能状态。完整核心范围仍按 PRD §2～5 核对，当前进度及缺口见 CORE_REQUIREMENTS_AUDIT.md / DELIVERY_CHECKLIST.md。用户已指定单人自用、靶机实测由用户负责；账号/多用户不做，PostgreSQL 仍为可选评估。当前安装/检查使用 npm workspaces；迁移、凭据、真实引擎、验证和报告已接线并有隔离验证。会话日志采用转义文本及完整结构化消息查看，不用 xterm 解释工具控制序列；保留完整 SDK 消息与原始证据。尚未完成的功能不得因旧里程碑通过而被跳过。

---

## 0. 开发原则

1. **小步交付**：每个里程碑都必须可启动、可验证。
2. **真实优先**：未接入的能力必须标注「未实现 / Mock」，禁止用静态假数据冒充后端能力。
3. **契约先行**：`packages/shared` 是前后端唯一类型来源。
4. **SDK 零猜测**：MCP / Pi SDK 用法必须来自官方文档或 `node_modules` 类型定义。
5. **外部零修改**：不修改 blhackbox 仓库与 Compose 项目。

---

## 1. 阶段划分

### 第一阶段：工程骨架与可视化管理台（当前）

| 里程碑 | 内容 | 验收 |
| --- | --- | --- |
| M1 环境检查 | Node/pnpm/Docker 检查，npm 缓存权限问题规避 | 记录环境版本 |
| M2 文档 | PRD / ARCHITECTURE / DATABASE / API / DEVELOPMENT_PLAN | 五份文档完成 |
| M3 Monorepo 骨架 | 根工作区、shared 包、api/web 工程 | `pnpm install` 成功，前后端可启动 |
| M4 后端核心 | 配置校验、SQLite + 17 张表实体、统一异常、审计、WS 网关 | `pnpm --filter api typecheck` 通过 |
| M5 任务与仪表盘 API | 任务 CRUD、状态流转、真实聚合指标 | 接口实测通过 |
| M6 MCP 与设置 API | 服务配置、真实健康检查(tools/list)、工具目录、权限矩阵、AES-GCM 设置 | 未连接时返回 unreachable |
| M7 前端框架 | 布局、侧栏、10 条路由、占位页、顶栏连通指示 | 全导航可点 |
| M8 四页 UI | 仪表盘、任务中心、工作流(Mock)、MCP 管理 | 数据来自真实 API |
| M9 联调测试 | 类型检查、单测、启动验证 | 全绿 |

### 第二阶段：Orchestrator 与 Pi Session（规划）

- Orchestrator Core 状态机、任务队列、去重、超时回收。
- Planner Agent（Pi Session）与 Fact-Intent 黑板。
- `facts` / `intents` / `hints` / `agent_sessions` 的 API 与页面（智能体工作台）。
- Pi Runtime 配置真实接入（OpenAI 兼容 provider）。
- WS 事件扩展为全量执行事件流。

### 第三阶段：MCP Policy Proxy 与工具执行（规划）

- Policy Proxy 中间层：目标白名单校验、角色权限拦截、高风险审批工作流。
- 工具调用执行与原始输出落盘为 evidence。
- 攻击面分析页、证据管理页真实数据。

### 第四阶段：漏洞验证与报告（规划）

- Verifier Worker、双证据复核、CWE/CVE 依据规则。
- 漏洞发现页、报告中心（Markdown / PDF）。
- 权限审计与提权验证（审批后执行）。

### 第五阶段：生产化（规划）

- PostgreSQL 迁移、显式迁移脚本、鉴权多用户、可观测性。

---

## 2. 第二阶段开始前的待办（技术债）

1. TypeORM `synchronize` → 显式迁移。
2. `findings` 证据强关联校验。
3. 前端 xterm.js 日志面板接入 Agent 原始流。
4. MCP 认证头加密存储（当前仅落库，展示时脱敏）。
5. 任务执行引擎状态与实际编排状态解耦（当前 `running` 为占位状态）。

---

## 3. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| blhackbox Gateway 未启动 | MCP 页显示未连接 | 明确提示与排查步骤，不做假在线 |
| Windows npm 缓存权限（EPERM） | 安装失败 | 项目级 `.npmrc` 指定 cache 与 store-dir |
| better-sqlite3 预编译失败 | 后端无法启动 | 回退 `sqlite3` 驱动或使用 Node 24 预编译包 |
| Pi SDK 版本演进 | 接口变化 | 第一阶段不依赖运行时，文档锁定版本 |
| MCP SDK v1→v2 迁移 | 未来升级 | 封装 `McpClientFactory` 单一入口，便于替换 |

---

## 4. 测试策略

| 层级 | 工具 | 范围 |
| --- | --- | --- |
| 类型检查 | `tsc --noEmit` | 三个包 |
| 单元测试 | Vitest | 任务状态机、目标校验、加密工具、MCP 健康检查状态映射 |
| 前后端联调 | 手工 + 脚本 | 创建任务 → 仪表盘计数变化 → MCP 检测失败态/在线态 |
| 冒烟 | PowerShell 脚本 | `pnpm dev` 起服务，`Invoke-RestMethod` 探测 |
