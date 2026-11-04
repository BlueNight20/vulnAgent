# VulnAgent 第二阶段：真实多智能体运行时

- 状态：已实现并运行
- 目标：构建能自主执行授权渗透测试的多智能体系统（Orchestrator Core + Planner Pi Session + 动态 Worker + Fact-Intent Blackboard），最终完成信息收集、攻击面分析、漏洞发现、验证与提权探索。

---

## 1. 模块依赖

```
settings ─┐
          ├─► model-gateway ──► pi-runtime ──┐
events ───┘                                 ├─► orchestrator ──► agents / workflow
                     blackboard ◄───────────┤
                worker-skills ◄─────────────┤
                        mcp (executor) ◄────┘
                                 ▲
                            tasks（写 task_state_events，无反向依赖）
```

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| `model-gateway` | Pi Models 构建、请求级密钥注入、并发限流、真实 Chat 测试 | settings |
| `pi-runtime` | SessionManager（创建/暂停/恢复/终止）、消息与事件持久化、Token 记账、启动 reconcile | model-gateway |
| `blackboard` | Facts（四态）、Intents、Hints、Evidence、Hypothesis 图、Worker 状态 | — |
| `worker-skills` | 6 个 Worker Profile、技能提示词、工具选择、提示词版本 | mcp 工具目录 |
| `orchestrator` | 状态机、准入、可解释评分、调度、超时回收、预算、Planner/Worker Runner | 以上全部 |
| `agents` | Session REST | pi-runtime |
| `workflow` | 真实图查询 `source: 'live'` | orchestrator |

`tasks` **不直接依赖** orchestrator：`applyAction` 只写 `task_state_events`，由 Orchestrator 每 1.5s 轮询消费。

---

## 2. 数据库（新增 5 张表 + 字段扩展）

| 表 | 用途 |
| --- | --- |
| `agent_session_messages` | 完整 `messageJson`（含 toolCall / toolResult），支持进程重启后重建上下文 |
| `agent_session_events` | 事件时间线（tool_execution_start/end、turn_end、lifecycle） |
| `orchestrator_runs` | 编排运行快照（轮次、活跃 Worker、停止原因） |
| `hypothesis` / `hypothesis_link` | 攻击假设图（关系型）：节点 + 支持/否定/依赖边 |
| `worker_result_cards` | Worker 结构化结果卡 |
| `worker_profile_usage` | 每次 Worker 加载的档案、技能、工具白名单与预算 |
| `task_state_events` | 任务状态事件队列（解耦 tasks 与 orchestrator） |

字段扩展：
- `tasks.engineStatus` / `stopReason`（与用户可见 `status` 解耦）
- `agent_sessions.profileId` / `parentSessionId` / `costUsd` / `state`
- `worker_tasks.leaseExpiresAt` / `maxAttempts` / `tokensSpent` / `evidenceIds` / `resultCardId`
- `facts.status`（inferred/observed/verified/refuted）/ `hypothesisIds`
- `intents.hypothesis` / `objective` / `workerProfileId` / `expectedEvidence` / `dependencies` / `maxAttempts` / `score` / `scoreBreakdown` / `rejectedReason`
- `hints.appliedToSessionId` / `consumedAt`

---

## 3. Orchestrator 状态机

```
idle → planning → executing → planning → ... → completed
         │            │
         ├─ paused ◄──┤（用户暂停，abort 全部 Session）
         ├─ stalled（连续 3 轮无新 observed/verified 事实）
         ├─ needs_input（Planner 显式声明）
         └─ stopped（预算耗尽 / 用户停止 / 最大轮次）
```

- 单任务单运行实例，重复 `start` 幂等返回当前快照
- 每轮 cycle：`预算检查 → 取待执行 Intent → 没有则调用 Planner → 准入 → 评分 → 派发 → 等待 Worker`
- 多个 Worker 同时结束时，只触发一次下一轮（600ms 合并 + `plannerBusy` 互斥）

## 4. Worker 调度

**准入（确定性，纯函数 `admitIntents`）**

1. 状态必须为 `proposed`
2. `dedupeKey` 在任务内未出现
3. `targetIp` 属于任务授权目标
4. `suggestedTools` 全部在角色权限内且真实存在于 MCP 工具目录
5. `dependencies` 已全部完成

**评分（可解释，`exploration-score.ts`）**

| 维度 | 默认权重 | 说明 |
| --- | --- | --- |
| 证据支撑 | 0.25 | 关联事实越多分越高 |
| 新颖度 | 0.30 | 同目标已执行次数越多分越低 |
| 影响面 | 0.25 | 命中 Web/SSH/SMB 等高价值服务加权 |
| 解锁价值 | 0.10 | 被其他 Intent 依赖时加权 |
| 执行成本 | 0.10 | 工具数量与风险越高越降权 |

> 权重为默认经验值，**未经靶机实验标定**，仅用于同一任务内相对排序。Planner 的 `priority` 只产生 ±5% 偏置。

**派发**：`slots = 并发上限 - 运行中`，同时受剩余预算约束。

**回收**：每 5s 扫描租约过期的 `running` Worker → `timeout`；`attempt < maxAttempts` 则回到 `proposed` 重新派发（**dedupeKey 不变**），否则 `failed`。

## 5. Worker 专业能力

| Profile | 角色 | 典型工具 | 技能 |
| --- | --- | --- | --- |
| `recon` | explore | nmap / masscan | 端口扫描、网段拓扑 |
| `web` | explore | gobuster / ffuf / nikto / curl | 目录枚举、配置审计 |
| `service` | explore | nmap / smbclient / rpcclient | 服务指纹 |
| `linux-audit` | analysis | ssh / find | 主机审计、提权面 |
| `vuln-analysis` | analysis | searchsploit / nuclei | 漏洞映射 |
| `verification` | verifier | nuclei / sqlmap / curl | 最小影响验证 |

工具集合 = Profile 模式 ∩ 角色权限 ∩ MCP 工具目录，**目录为空时不注册任何工具**（Agent 会如实说明无法执行）。

## 6. MCP 工具真实执行

```
Worker Agent 的 toolCall
   ↓
McpExecutorService.execute()
   ├─ 目标白名单校验（IP 必须在任务 targets 内）
   ├─ 角色权限校验（agent_tool_permissions）
   ├─ Profile 工具范围校验
   ├─ 高风险工具 → pending_approval（拒绝自动执行）
   ↓
McpClientFactory.callTool()  →  blhackbox MCP Gateway (Streamable HTTP)
   ↓
原始输出 → evidence 表（含 SHA-256）
         → tool_calls 表（决策/耗时/错误）
         → WS 广播 tool.call
   ↓
工具结果文本返回给 Agent
```

## 7. 事实溯源

| 状态 | 允许来源 | 证据要求 | 置信度上限 |
| --- | --- | --- | --- |
| `inferred` | agent | 可无 | 0.5 |
| `observed` | tool | ≥1 条 | — |
| `verified` | tool | ≥1 条 + 复核 | — |
| `refuted` | 任意 | 必须给出推翻依据 | — |

`inferred → verified` 被禁止；Agent 直接产出的结论不能标记为 observed/verified。

## 8. 测试

| 层 | 内容 | 结果 |
| --- | --- | --- |
| 单元 | 状态机、准入、调度、预算、评分、溯源、解析、限流、Profile、图映射 | 87 项通过 |
| 冒烟 | 16 项接口检查（含引擎幂等、真实图、黑板、Hint） | 16/16 通过 |
| 真实链路 | 真实云端模型 → Planner → Worker → 事实 → 图 | 待填入 API Key 后验证 |

---

## 9. 当前边界

- 已接入 blhackbox MCP 真实工具调用，但**需要 Gateway 已启动**（`docker compose --profile gateway up -d`，本仓库不执行）
- 高风险工具（exploit / msf / sqlmap 等）默认拒绝自动执行，等待人工审批流程（后续实现审批 UI）
- 不访问 Docker Socket，不执行宿主机 Shell
