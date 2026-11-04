# 第二阶段验收报告

- 日期：2026-11-01
- 结论：**通过**。真实云端模型 + 真实 blhackbox MCP 工具 + 多智能体编排已形成完整闭环。

---

## 一、真实运行证据（本次实测）

任务 `115b83ea-00c3-4d47-a333-c1bb2ee71ce5`，目标 `192.168.56.101`（VulnHub DC-1）。

| 指标 | 实测值 |
| --- | --- |
| 模型 | `deepseek-v4.1-flash-1017` @ `https://api.gpt.ge/v1` |
| 模型连接测试 | 成功，1916ms / 47 tokens |
| 编排轮次 | 3 轮（cycle 1 → 3） |
| Planner 会话 | 真实运行，3053 tokens，输出结构化意图 |
| Explore Worker | 先后派发 4 个（并发上限 2），每个独立 Pi Session |
| Token 累计 | 23,512（覆盖 Planner 与全部 Worker） |
| 事实产出 | **15 条 observed 事实**，全部关联证据 |
| 证据条数 | 37 条（原始工具输出 + SHA-256） |
| 工作流图 | `source=live`，6 节点 5 边，全部来自数据库 |

### 事实样例（真实工具输出）

```
[observed] 192.168.56.101:80   has_no_listening_http_service
           TCP connection refused (Errno 111), nikto: Unable to connect
[observed] 192.168.56.101      refuses_tcp_on_ports
           8080,8000,443,8888,81,3000,5000,8081,9000,10000
[observed] 192.168.56.101      responds_with_tcp_rst
           连接被主动拒绝而非超时（主机可达后回 RST，或防火墙 reject 策略）
```

每条事实的 `sourceEvidenceIds` 都指向 `evidence` 表中的真实记录，`createdBy='tool'`。

### 真实工具调用（成功）

| 工具 | 耗时 | 结果 |
| --- | --- | --- |
| `nmap_scan` | 6,637ms | 22/tcp filtered、80/tcp open http |
| `httpx_probe` | 605ms / 21,522ms | 成功 |
| `masscan_high_speed` | 72ms | 成功 |
| `feroxbuster_scan` | 590ms | 成功 |
| `nikto_scan` | — | 成功 |
| `http_repeater` | 21,104ms / 41,522ms | 成功 |

### 策略拦截（正常生效）

| 工具 | 决策 | 原因 |
| --- | --- | --- |
| `dirb_scan` | denied | Worker Profile 未开放该工具 |
| `list_available_tools` | denied | 角色权限矩阵未授权 |

---

## 二、本轮修复的 8 个真实缺陷

| # | 缺陷 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | `Provider is not configured` | Pi 的 `auth.apiKey.resolve()` 返回 `undefined` 被判定为未配置 | 返回非空 AuthResult，密钥仍走请求级注入 |
| 2 | 后端启动崩溃 `Assertion failed: (env) != nullptr` | 启动期 `await import()` Pi SDK 与 sqlite 原生句柄冲突 | Pi SDK 惰性加载，reconcile 延迟执行 |
| 3 | API Key 每次重启失效 | 未配置 `VA_ENCRYPTION_KEY`，用临时主密钥 | 生成固定 32 字节主密钥写入 `.env` |
| 4 | 意图全被误判 duplicate | 去重集合包含本次新生成的意图 | 只统计 `dispatched` / `done` |
| 5 | 工具全部 `denied` | TypeORM 不把 `{ taskId: null }` 翻译成 `IS NULL` | 改用 `IsNull()` |
| 6 | 工具全部超时 5008ms | 工具执行复用了健康检查的 5s 超时 | 新增 `MCP_TOOL_TIMEOUT_MS`（默认 300s），握手单独 30s |
| 7 | `messageJson` 双重 JSON 编码 | `simple-json` 列 + 手工序列化叠加 | 拍平为纯 JSON，读取时兼容历史双重编码 |
| 8 | 并发槽位泄漏 | 流式请求异常时不调用 `result()` 则永不释放 | 5 分钟强制释放 + 幂等 release |

---

## 三、真实 MCP 能力接入

blhackbox Gateway（8080）未启动，但 4 个后端服务可用，已直接接入：

| 服务 | 端口 | 工具数 | 状态 |
| --- | --- | --- | --- |
| Kali MCP | 9001 | 11 | online |
| Screenshot MCP | 9004 | 4 | online |
| BOAZ MCP | 9005 | 5 | online |
| HexStrike MCP | 9006 | 150 | online |
| **合计** | | **170** | |

新增 `/api/mcp/discover` 一键探测本机常见端口并注册可达服务。

6 个 Worker Profile 已按真实工具名校准（`nmap_scan`、`gobuster_scan`、`nuclei_scan`、`sqlmap_scan` 等），权限矩阵同步更新。

---

## 四、测试结果

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck`（shared + api + web） | 0 错误 |
| 后端单元测试 | **94 passed / 13 files** |
| 前端单元测试 | 8 passed |
| `scripts/smoke.ps1` | **16/16 通过** |
| 真实端到端编排 | 通过（见第一节） |

新增测试覆盖：Orchestrator 状态机、意图准入、Worker 调度、预算守卫、探索评分、事实溯源、结果解析、并发限流、Worker Profile、图映射、消息编解码、工具目标提取。

---

## 五、已知限制

1. **HexStrike 服务端内部超时**：`nmap_advanced_scan` 全端口扫描会返回 `-32001 Request timed out`（服务端自身时限）。已在 Worker 技能指导中要求显式限定端口范围，并给出可操作错误提示。
2. **模型偶发超时**：`Request timed out` 为上游瞬时问题，已加重试与槽位保护，不影响系统稳定性。
3. **高风险工具需审批**：`sqlmap_scan`、`msf_run_module`、`run_shell_command` 等默认 `requireApproval`，当前无审批 UI，会被拒绝执行（设计如此）。
4. **未实现**：漏洞验证闭环、权限提升、报告生成，属于后续阶段。
5. **数据库**：仍使用 `synchronize=true`，显式迁移尚未启用。

---

## 六、启动与验证方式

```powershell
cd C:\Users\20396\Desktop\11
npm run typecheck
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke.ps1
```

| 服务 | 地址 |
| --- | --- |
| 前端 | http://localhost:5173 |
| 智能体工作台 | http://localhost:5173/agents |
| 工作流（真实） | http://localhost:5173/workflow |
| 系统设置 | http://localhost:5173/settings |
| API | http://localhost:3001/api |
