# VulnAgent 产品需求文档（PRD）

- 文档版本：v0.1（第一阶段）
- 状态：第一阶段实施中
- 更新日期：2026-11-01

当前范围说明（2026-11-03）：§2～5 仍是完整核心需求；§6～7 为最初第一阶段历史范围与验收，不代表当前只交付 Mock/占位页。用户现已授权完成代码，限定单人自用，真实靶机实测由用户操作；账号/多用户不作为交付项，PostgreSQL 咨询不自动变成迁移要求。当前工具链采用 npm workspaces，安装/类型检查/测试/构建命令见 README，替代历史 pnpm 命令。实现证据与未完成项见 CORE_REQUIREMENTS_AUDIT.md / DELIVERY_CHECKLIST.md，不能仅凭阶段一验收宣布完整系统完成。

---

## 1. 产品定位

VulnAgent 是一套**自主渗透测试管理平台**，面向已授权的 VulnHub 实验环境。

它不是聊天机器人，也不是简单的 MCP 工具调用面板，而是一个以**多智能体动态协作**为核心、能够持续执行授权靶机安全测试的 Web 系统：

- 由 Orchestrator Core（确定性程序）负责调度、并发控制、权限与状态维护；
- 由 Planner Agent（Pi Session + 云端模型）根据真实事实生成探索意图；
- 由多个独立 Worker Session 并行执行任务；
- 所有工具调用经由 MCP Policy Proxy 校验授权范围并留痕；
- 最终产出可追溯证据链与结构化报告。

## 2. 目标与非目标

### 2.1 目标

1. 接收用户指定的靶机 IP 和授权测试范围。
2. 自动进行初始信息收集。
3. 根据实际发现动态生成探索任务。
4. 多 Pi Session 并行执行任务。
5. 通过 MCP 调用本地已部署的 blhackbox 工具。
6. 根据工具真实返回结果持续调整探索计划。
7. 对漏洞候选进行证据复核和受控验证。
8. 在授权范围内完成权限审计与提权验证（需审批）。
9. 自动保存完整执行记录与证据。
10. 生成结构化渗透测试报告。

### 2.2 非目标

- 不复制、不修改 blhackbox 及其 Docker Compose 项目。
- 不重复开发 Nmap / Metasploit 等工具适配器（由 blhackbox 的 MCP 提供）。
- 不提供宿主机 Docker Socket 访问能力，不提供任意宿主机 Shell。
- 不面向未授权目标提供任何能力。

## 3. 用户与场景

| 角色 | 场景 |
| --- | --- |
| 安全工程师 | 在 VulnHub 靶机上验证测试方法论，观察 Agent 决策过程 |
| 红队人员 | 在授权范围内进行自动化信息收集、漏洞验证与取证 |
| 教学/研究 | 以可追溯的工作流与证据链演示多智能体渗透测试过程 |

## 4. 合规与安全边界（强约束）

1. **仅限授权目标**：创建任务必须填写授权声明与授权范围（IP/CIDR），后端落库保存。
2. **目标白名单**：MCP Policy Proxy 维护目标 IP 白名单，校验工具调用参数中的目标地址。
3. **身份权限**：不同 Worker 角色拥有不同工具权限矩阵。
4. **高风险操作审批**：可能改变目标状态的操作（如写入、提权、横向）需要人工审批。
5. **完整审计**：每次工具调用记录参数、原始输出摘要、Agent Session、任务 ID。
6. **密钥隔离**：云端模型 API Key 仅存后端，AES-256-GCM 加密落库，接口仅返回掩码。

## 5. 页面结构与功能需求

左侧导航固定四组十页，全部简体中文：

### 5.1 工作台

- **仪表盘** `/dashboard`
  - 测试任务总数、正在运行任务数
  - 漏洞候选数量、已验证漏洞数量
  - Token 使用量与预估成本
  - 系统服务运行状态（MCP Gateway / API / 数据库，真实健康检查）
  - 最近测试任务列表
- **任务中心** `/tasks`
  - 创建测试任务：授权靶机 IP、测试范围、云模型、Token 预算、时间预算、Worker 数量
  - 历史任务列表、筛选与搜索
  - 暂停、恢复、停止、重新运行

### 5.2 智能体控制

- **工作流** `/workflow`：React Flow 展示 Orchestrator / Planner / Worker，节点状态、依赖分支、节点输入输出、证据反馈关系、Worker 动态创建与结束
- **智能体工作台** `/agents`：Pi Session 列表与切换、会话消息、工具调用记录、Token 消耗、状态卡、人工 Hint、暂停恢复

### 5.3 安全分析

- **攻击面分析** `/attack-surface`：资产、IP、开放端口、服务与版本、技术指纹、资产关联
- **漏洞发现** `/vulnerabilities`：候选漏洞、描述、严重程度、CWE/CVE（仅有可靠依据时）、来源、验证状态、证据
- **证据管理** `/evidence`：工具输出、命令记录、HTTP 响应、截图、PCAP、验证结果、事实来源追溯
- **报告中心** `/reports`：Markdown / PDF 报告、漏洞详情、测试过程、证据附件、修复建议

### 5.4 系统管理

- **MCP 管理** `/mcp`：服务总览、工具目录、工具详情与参数 Schema、Agent 工具权限、调用记录、连接配置、连通性检测、健康状态
- **系统设置** `/settings`：云模型 Provider、API Key、模型选择、Pi Runtime、Worker 并发、Token 预算、工具权限、日志

## 6. 第一阶段（当前）范围

### 6.1 交付

| 编号 | 交付项 | 说明 |
| --- | --- | --- |
| A | 环境与目录检查 | Windows / Node / pnpm / Docker 检查 |
| B | 五份文档 | PRD、ARCHITECTURE、DATABASE、API、DEVELOPMENT_PLAN |
| C | 可运行前后端工程 | pnpm monorepo：apps/web、apps/api、packages/shared |
| D | 导航 + 四页 UI | 仪表盘、任务中心、工作流、MCP 管理 |
| E | 工作流 Mock | 独立 mock 模块 + 显著「Mock 数据」标识 |
| F | MCP 连接能力 | 连接配置、真实健康检查（tools/list）、工具目录 |
| G | Windows 可运行 | PowerShell 启动脚本、README |

### 6.2 明确不在第一阶段

- 真实渗透测试执行（不启动任何针对靶机的扫描）。
- Pi Agent Session 的实际运行与 Orchestrator 调度。
- MCP Policy Proxy 的实际拦截执行（第一阶段仅落库配置与权限矩阵）。
- 其余六个页面的业务功能（仅占位页，标注「待实现」）。

## 7. 验收标准

1. `pnpm install` + `pnpm dev` 可在 Windows 启动前后端。
2. 前后端类型检查 `pnpm typecheck` 零错误。
3. 单元测试 `pnpm test` 通过。
4. 导航全部可点击并落到独立路由，无 404。
5. 仪表盘/任务中心数据来自真实 API（创建任务后用真实请求可见）。
6. MCP 页在 Gateway 未启动时显示「未连接」及真实错误原因；启动后点击「重新检测」可变为在线并读取工具数。
7. 工作流页有醒目的 Mock 标识，不误导为真实运行状态。
8. 页面视觉符合：深蓝侧栏 + 浅色工作区 + 蓝色主色，简体中文。

## 8. 术语表

| 术语 | 含义 |
| --- | --- |
| Orchestrator Core | 确定性编排程序，负责任务、并发、状态、权限 |
| Planner Agent | Pi Session，读取事实黑板书生成 Intent |
| Worker | 执行具体任务单元的角色，分 Bootstrap / Explore / Analysis / Verifier / Reporter |
| Fact | 由工具输出或模型推理得出、可追溯到证据的结论 |
| Intent | 待执行的探索意图（下一步要做什么） |
| Evidence | 工具输出、HTTP 响应、截图、PCAP 等原始证据 |
| Finding | 漏洞候选/结论，含验证状态 |
| MCP Policy Proxy | 位于 Agent 与 blhackbox 之间的策略代理 |
