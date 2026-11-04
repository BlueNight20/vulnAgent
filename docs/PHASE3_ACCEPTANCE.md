# 第三阶段：真实自主执行能力强化 — 验收报告

- 日期：2026-11-01
- 范围：修复影响自主执行的真实缺陷，完善决策闭环、工具执行、审批与真实运行界面
- 结论：**核心闭环已跑通**，8 项能力全部接入真实运行链路

---

## 一、真实运行证据

任务 `d43ed9a2-bbc2-42ad-be34-8c23d4f1debd`，目标 `192.168.56.101`（VulnHub DC-1）。

| 指标 | 实测值 |
| --- | --- |
| 编排轮次 | 推进到第 4 轮 |
| Token 累计 | 17,566 / 150,000 |
| Worker 成功收尾 | **3 个**（recon / service / 重试后的 recon） |
| 结果卡 | **3 张，`synthetic=false`（模型真实输出结构化结果）** |
| 工具调用 | 24 次（成功 7 次） |
| 待审批 | 2 条（审批闭环生效） |

### Worker 结果卡原文（证明不编造事实）

> 本次任务未取得任何目标侧数据。6 次工具调用（httpx、rustscan 全端口、nmap 6 端口、nmap 单端口 80、masscan 2 端口）全部在 MCP 握手层 30 秒超时，另 list_available_tools 被策略拦截。单端口 80 且限定 `--host-timeout 15s` 仍返回握手超时，**证明是工具后端/握手故障而非扫描负载或目标无响应，因此无法据此判断目标存活或端口开放状态**。按纪律停止重试，**未虚构任何事实**：192.168.56.101 的端口清单、服务版本、OS 指纹仍全部未知……需在工具基础设施恢复后重启本侦测任务。

这段输出同时验证了：
- Worker 严格区分「探测失败」与「目标状态」
- 工具纪律生效（连续失败后停止重试）
- 结构化结果卡被正确解析（`synthetic=false`）
- 无进展/阻塞被如实上报

---

## 二、本轮修复的缺陷（按严重度）

### P0 — 影响自主执行正确性

| # | 缺陷 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | **会话永久 running** | `markCompleted()` 在 `agent_end` 回调内调用 `waitForIdle()`，等待自己 → 死锁 | 新增 `skipWaitForIdle` 选项，事件回调内跳过等待；并加日志确认推进结果 |
| 2 | **Worker 永久 running** | `reapExpiredWorkers` 只遍历内存 `contexts`，进程重启后完全失效 | 改为全库扫描；新增 `reconcileOnBoot()` 启动对账 |
| 3 | **租约过期永不触发** | SQLite 存 `YYYY-MM-DD HH:MM:SS.SSS`，用 `LessThan(ISO 字符串)` 比较永远不匹配 | 改用 `datetime(col) < datetime('now')` |
| 4 | **Scope 校验可绕过** | `findOne({taskId, ip})` 缺 `inScope` 条件 | 补条件；同时白名单覆盖全部授权目标、CIDR、主机名 |
| 5 | **端口校验误判** | `Number.isNaN(undefined)` 为 false，单端口与逗号分隔全部被拒 | 重写为分段解析 + `Number.isFinite` |

### P1 — 影响决策质量与效率

| # | 缺陷 | 修复 |
| --- | --- | --- |
| 6 | 无进展检测用累计值，历史事实永远清零计数 | 改用**本轮增量**（`evidenceBaseline` 基线对比） |
| 7 | blocked 状态被静默忽略 | 纳入 `evaluateCompletion`，转为 stalled 并保留原因 |
| 8 | 模型瞬断一次就让任务 stalled | 新增 `isTransientModelError` + 最多 3 次指数退避重试，不计入无进展 |
| 9 | 同一工具相同参数被反复调用 | 新增 `argumentsHash` 指纹，命中已成功记录时直接复用结果 |
| 10 | 工具风险仅按描述判定 | `list_available_tools` 等只读工具被描述里的 payload 词误判为 destructive → 改为只按工具名判定 + 只读白名单 |
| 11 | 并发调用时握手 30s 不够 | 握手超时独立为 `MCP_CONNECT_TIMEOUT_MS`（默认 60s） |

### P2 — 可观测性与可操作性

| # | 改进 |
| --- | --- |
| 12 | 工具执行超时与健康检查超时解耦（`MCP_TOOL_TIMEOUT_MS`，默认 300s） |
| 13 | 错误分类：`-32001` 单独识别为「服务端自身超时」并给出缩小范围的建议 |
| 14 | `engine.stop` 改为先落库再后台终止 Session，避免接口超时 |
| 15 | `messageJson` 双重编码修复，读取时兼容历史数据 |
| 16 | 并发槽位泄漏修复（流式异常时 5 分钟强制释放） |

---

## 三、新增能力

### 3.1 事实溯源与分类

新增 `FactObservationKind`，把事实分为四类，**从源头阻止「探测失败」被当成「目标状态」**：

| 类别 | 含义 | 可作为漏洞证据 |
| --- | --- | --- |
| `target_state` | 目标真实状态（端口开放、服务版本） | 是 |
| `target_negative` | 目标明确否定（拒绝、关闭、过滤） | 是 |
| `probe_error` | 探测过程失败（超时、工具报错） | **否** |
| `inference` | 模型推断（置信度 ≤ 0.5） | **否** |

事实新增溯源字段：`sourceTool`、`targetIp`、`observedAt`、`observationKind`、`conflictGroupId`、`conflictResolved`。

### 3.2 事实冲突检测

- 同 `subject + predicate` 不同 `object` → 建立冲突组，**不覆盖**
- `probe_error` 与 `inference` 不参与冲突判定
- 提供 `GET /tasks/:id/facts/conflicts` 与 `POST /tasks/:id/facts/:factId/resolve`
- 人工采纳后：该条升级 `verified`，同组其余置 `refuted`

### 3.3 真实审批闭环

```
pending_approval → 批准 → 用**原始参数**重放（再次经 Scope + 权限校验）→ 新执行记录
                → 拒绝 → rejected
                → 30 分钟未处理 → expired（每 60s 扫描）
```

- `tool_calls` 新增 `approvedAt` / `approvedBy` / `approvalExpiresAt` / `replayOfId` / `argumentsHash`
- 接口：`GET /approvals`、`POST /approvals/:id/approve`、`POST /approvals/:id/reject`
- 审批动作与执行动作分属两条记录，审计链可区分

### 3.4 任务级完成判定

新增 `evaluateCompletion`（纯函数，12 项测试覆盖），**不依赖模型自称完成**：

- Planner 说 `goal_reached` 必须有 ≥3 条证据支撑，否则继续或判为停滞
- `probe_error` 与 `inference` 事实不计入完成证据
- 有待审批时不结束任务，转 `needs_input`
- 有活跃 Worker 或待执行意图时不因无进展而结束

---

## 四、前端真实数据接入

| 面板 | 数据源 | 展示内容 |
| --- | --- | --- |
| 事实黑板 | `facts` 表 | 四类统计、冲突组、逐条溯源（工具/证据数/置信度） |
| 待审批 | `tool_calls`（pending_approval） | 工具名、风险等级、原始参数、有效期、批准/拒绝 |
| 工具调用记录 | `tool_calls` 表 | 工具、目标、状态、耗时、错误原因 |

工作流页新增「执行明细」与「事实黑板」两个区块，全部读真实数据库，无 Mock。

---

## 五、测试

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck`（shared + api + web） | 0 错误 |
| 后端单元测试 | **163 passed / 20 files** |
| 前端单元测试 | 8 passed |
| `scripts/smoke.ps1` | 16/16 通过 |
| `scripts/verify-p3.ps1` | 端到端真实链路（新建任务 → 观察 → 汇总报告） |

新增测试文件：`fact-classifier`（14 项）、`completion-evaluator`（12 项）、`tool-risk`（5 项）、`lease-expiry`（4 项）、`model-retry`（7 项）、`session-completion`（5 项）、`validation`（10 项）。

---

## 六、仍然存在的限制

| # | 限制 | 影响 | 下一步 |
| --- | --- | --- | --- |
| 1 | **HexStrike MCP 容器已停止**（9006 端口无响应） | 150 个高阶工具不可用，只剩 Kali/Screenshot/BOAZ 共 20 个 | 需要重启该容器；代码侧已能自动发现并同步 |
| 2 | 工具超时仍是主要失败源 | `nmap_advanced_scan` 全端口会被服务端自身时限中断 | 已加提示与纪律约束；可考虑按工具类型设置差异化超时 |
| 3 | 模型输出结构化 JSON 不稳定 | 部分轮次未输出 JSON，结果卡降级为 `synthetic` | 可增加「输出校验失败即追问」的一次重试 |
| 4 | 审批无身份体系 | `approvedBy` 固定为 `local-operator` | 引入多用户后再补 |
| 5 | 事实冲突未与假设图联动 | 冲突解决不影响 hypothesis 状态 | 后续把 `resolveConflict` 接入 hypothesis 复核 |
| 6 | 无漏洞验证闭环 | 无法从候选走到已验证 | 第四阶段：Verifier + 最小影响验证 |
| 7 | oracle 数据库仍是 `synchronize=true` | 无显式迁移 | 后续切 migration |

---

## 七、下一步核心能力

按依赖顺序：

1. **恢复 HexStrike 并完成一次全工具链路验证**（这是当前最大的能力缺口）
2. **Verifier Worker 闭环**：从 `vulnerability` 候选事实 → 最小影响验证 → `verified` / `refuted`
3. **权限提升探索**：凭据获取后进入 `linux-audit` 档案，执行提权面枚举
4. **结果校验重试**：结构化输出不合规时自动追问一次
5. **显式数据库迁移**
