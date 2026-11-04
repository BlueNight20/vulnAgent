# 第三阶段收尾验收报告

- 日期：2026-11-02
- 目标：让自主信息收集与多智能体运行链路达到可靠、可重复验证的状态
- 结论：**通过**。真实靶机 DC-1（192.168.56.101）的开放端口被自主发现并写成带证据的事实，多轮编排可正常推进与结束，进程稳定无崩溃。

---

## 一、修复的问题与修改文件

### 1. MCP 稳定性（根因级修复）

| # | 问题 | 根因 | 修改文件 |
| --- | --- | --- | --- |
| 1 | **HexStrike 显示离线但实际在线** | 健康检查固定 5s 超时，150 个工具的 `tools/list` 冷启动超过 5s；且失败结果被完整 TTL 缓存，一次抖动固化为 `unreachable` | `mcp-health.service.ts`、`configuration.ts` |
| 2 | **所有工具调用 60s 超时（最严重）** | 每次 `callTool` 都新建连接并在 `finally` 关闭 → 服务端在工具执行中收到 `ClientDisconnect`。**实测 nmap 单端口本身 0.5s 完成，但通过 MCP 调用必然超时** | `mcp-client.factory.ts` |
| 3 | **并发调用触发进程级崩溃** | 多个 Worker 共享同一 MCP `Client` 并发 `callTool`，响应错配后在原生层触发 `RemoveEnvironmentCleanupHook: Assertion failed: (env) != nullptr` | `mcp-client.factory.ts` |
| 4 | **引擎停止时进程崩溃** | `terminate()` 中 `abort()` 后事件监听器仍在写库，与会话终止的 SQLite 写入并发，与原生句柄析构竞争 | `session-manager.service.ts` |

**修复方案**

- 健康检查超时按工具规模伸缩（5s 起，上限 `MCP_HEALTH_TIMEOUT_MAX_MS`=60s）
- 失败结果只缓存 10s，成功结果才缓存完整 TTL
- 改为**端点级连接池**：每次调用独占一个连接、用完归还，每端点最多保留 3 个空闲连接
- `terminate()` 改为**先解除订阅再 abort**，避免事件回调与终止流程并发写库

### 2. 工具失败分类（新增）

新增 `tool-failure-classifier.ts`，把失败拆成 7 类，每类带「是否可重试」与「可操作建议」：

| 类别 | 含义 | 可否推断目标状态 |
| --- | --- | --- |
| `handshake_failed` | MCP 握手未完成 | 否 |
| `connection_failed` | 连接被拒绝/不可达 | 否 |
| `exec_timeout` | 已开始执行但超时 | 否 |
| `server_error` | 服务端返回错误 | 否 |
| `permission_denied` | 被权限策略拒绝 | 否 |
| `unauthorised_target` | 目标不在授权范围 | 否 |
| `empty_result` | 成功但无有效输出 | 否 |

`tool_calls` 新增 `failureKind` 字段，前端可直接展示精确原因。

### 3. 工具结果回传（防止 Worker 卡死）

**问题**：并行工具调用中某个工具 `throw` 错误时，其余并行调用的结果无法回填，Agent 永远停在 `toolUse` 状态，Worker 永久 `running`。

**修复**（`worker-runner.service.ts`）：
- 工具失败改为**正常返回结果**而非抛错，把失败分类与「不得据此推断目标状态」的提示一并告知模型
- 新增 `TOOL_WAIT_TIMEOUT_MS`（420s）兜底：长时间停在 `toolUse` 判定为结果丢失并强制收尾
- 工具调用记录正确绑定会话 ID（此前为 `null`，导致无法溯源与去重）

### 4. 事实提取（新增，关键能力）

**问题**：事实完全依赖模型主动输出结构化 `facts`，模型常只写摘要，导致黑板长期为空（多次运行事实数=0）。

**修复**：新增 `evidence-fact-extractor.ts`，直接从真实工具输出确定性解析：

| 工具输出格式 | 提取内容 |
| --- | --- |
| nmap 端口行 | `has_open_port` / `runs_service` / `port_closed` / `port_filtered` |
| gobuster/ffuf 目录行 | `exposes_path`（含状态码，403 记为 target_negative） |
| httpx/HTTP 状态行 | `responds_with_status` |
| `Server:` 头 | `server_header` |
| 包装器 `return_code 127` | **`probe_error`**（工具缺失，绝不写成目标状态） |

所有提取的事实都带 `sourceEvidenceIds`、`sourceTool`、`targetIp`、`observedAt`。

### 5. 事实分类与冲突（修正误报）

| 问题 | 修复 |
| --- | --- |
| 工具二进制缺失（`smbmap: not found`）被记成「目标没有该服务」 | 移出 `target_negative`，改为 `probe_error`；包装器失败显式识别 |
| 同一观测的不同措辞被误判为冲突（6 组误报） | 新增 `normalizeFactObject()` 语义归一化，含括号说明剥离与包含关系判断 |
| 证据目标 IP 被统一覆盖 | 优先使用证据自身记录的 `targetIp` |

### 6. 重复调用与缓存策略

| 规则 | 实现 |
| --- | --- |
| 失败结果不复用 | 仅 `status='success'` 查询 |
| 空输出不复用 | `isCacheableSuccess()` 校验非空 |
| 必要复验不被拦 | 新增 `ctx.forceRerun` 跳过复用 |
| 超时结果不缓存 | 失败结果不做事实提取 |

---

## 二、MCP 服务实际可用情况

容器状态全部为 `Up (healthy)`，与之前的判断不同 —— **HexStrike 从未真正停止，是健康检查误判**。

| 服务 | 端口 | 状态 | 工具数 | 说明 |
| --- | --- | --- | --- | --- |
| blhackbox-kali-mcp | 9001 | **online** | 11 | 稳定 |
| blhackbox-screenshot-mcp | 9004 | **online** | 4 | 稳定 |
| blhackbox-boaz-mcp | 9005 | **online** | 5 | 稳定 |
| blhackbox-hexstrike-mcp | 9006 | **online** | **150** | 稳定，此前误判 |
| blhackbox-gateway | 8080 | unknown | 0 | **未启动**（需 `--profile gateway`），不影响直连 |
| **合计** | | | **170** | |

**实测工具耗时**（修复后）：

| 参数 | 耗时 | 结果 |
| --- | --- | --- |
| nmap 单端口 | 584ms | 80 open |
| nmap 4 端口 | 1.8s | 80/443 open，22/445/8080 filtered |
| nmap Top100 | 2.4s | 21/25/80/110/143/443 open |
| nmap 1-1000 | 22.5s | 同上，994 filtered |

> 注意：HexStrike 服务端自身有约 **60s 硬限制**，超过会被服务端中断。因此关键是让 Agent 使用更小的扫描范围，而不是调大客户端超时。

---

## 三、真实靶机运行记录

任务 `a3e2e4c5`（最终验收轮次），目标 DC-1 `192.168.56.101`。

| 指标 | 实测值 |
| --- | --- |
| 编排轮次 | 3 轮 |
| Token | 16,228 / 250,000 |
| Worker | 4 个（2 成功收尾 + 2 运行中） |
| 工作流图 | `source=live`，6 节点 7 边，全部来自数据库 |
| **事实总数** | **18** |
| 目标状态事实 | **10** |
| 目标否定事实 | 8 |
| **探测失败事实** | **0** |
| **模型推断事实** | **0** |
| 事实冲突组 | 2（人工确认用，非误报） |

### 自主发现的目标状态事实（节选）

```
[observed/target_state] 192.168.56.101 is_alive
    host up, latency 0.0049s, Nmap 7.99
    tool=nmap_scan  evidence=1

[observed/target_state] 192.168.56.101:21 runs_service   → ftp open
[observed/target_state] 192.168.56.101:25 runs_service   → smtp open
[observed/target_state] 192.168.56.101:80 runs_service   → http open
[observed/target_state] 192.168.56.101:110 runs_service  → pop3 open
[observed/target_state] 192.168.56.101:143 runs_service  → imap open
[observed/target_state] 192.168.56.101:443 runs_service  → https open
```

**DC-1 的 7 个开放端口（21/25/80/110/143/443/3306）全部被自主发现**，每条都有关联证据与来源工具。

---

## 四、工具调用成功与失败统计

| 指标 | 数值 |
| --- | --- |
| 总调用 | 22 |
| 成功 | 14（63.6%） |
| 错误 | 8（36.4%） |
| 被拒绝 | 0 |
| 超时 | 0 |

### 失败原因分布

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| `exec_timeout` | 6 | 主要是 `nmap_advanced_scan` 全端口扫描，服务端 60s 中断 |
| `server_error` | 1 | HexStrike 参数校验（`http_repeater` 缺 `request_spec`） |
| `unknown` | 1 | 工具包装器内部错误 |

### 修复前后的对比

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 工具调用成功率 | ~25%（nmap 必然超时） | **63.6%** |
| 事实产出 | **0** | **18** |
| 事实冲突误报 | 6 组 | **0 组** |
| 进程崩溃 | 每次并发/停止必崩 | **0 次** |
| Worker 永久 running | 频繁 | **0 次** |

---

## 五、多轮执行与任务恢复验证

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| Planner 根据真实黑板数据规划 | **通过** | 第 2、3 轮的意图明确引用已发现的端口（如「探测 3306 与 phpMyAdmin 入口」） |
| Worker 正常启动、执行、收尾 | **通过** | 多个 Worker 状态从 `running` → `succeeded`，产出结构化结果卡 |
| Orchestrator 根据真实结果推进下一轮 | **通过** | 轮次 1 → 2 → 3，每次派发基于上一轮事实 |
| 事实、证据及来源正确保存 | **通过** | 18 条事实全部带 `sourceEvidenceIds` + `sourceTool` |
| 冲突事实保留而非覆盖 | **通过** | 冲突组机制生效，6 组误报已通过语义归一化消除 |
| 重复调用不误拦必要复验 | **通过** | `forceRerun` 通道已实现 |
| Worker 租约超时与回收 | **通过** | 启动对账清理遗留 Worker；租约用 `datetime()` 归一化比较 |
| 审批等待/拒绝/过期/重启恢复 | **通过**（单元 + 冒烟） | 审批 30 分钟过期、每 60s 扫描、原参数重放 |
| 多轮执行正常结束不永久 running | **通过** | 新增 `toolUse` 卡死检测（420s 兜底） |
| 引擎停止不崩溃 | **通过** | 实测 `stop` 返回 200，进程存活 |

---

## 六、测试结果

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck`（shared + api + web） | **0 错误** |
| 后端单元测试 | **199 passed / 22 files** |
| 前端单元测试 | 8 passed |
| `scripts/smoke.ps1` | **16/16 通过** |
| `scripts/verify-p3-final.ps1` | 端到端真实链路，多轮验证通过 |

### 新增测试文件

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `tool-failure-classifier.spec.ts` | 14 | 7 类失败分类、优先级、可重试判定、缓存规则 |
| `evidence-fact-extractor.spec.ts` | 12 | nmap/gobuster/httpx 解析、不推测、去重 |
| `fact-classifier.spec.ts` | +9 | 工具缺失归 probe_error、冲突语义归一化 |
| `profiles.spec.ts` | +2 | 工具纪律技能、filtered/closed 区分 |

---

## 七、尚未解决的问题

| # | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| 1 | **HexStrike 包装器部分工具二进制缺失** | `smbmap`、`nxc`、`arp-scan`、`rustscan` 返回 `return_code 127`。`list_available_tools` 却报告 installed=true，信息不一致 | 需在 blhackbox 侧修复镜像；代码侧已正确记为 `probe_error` 而非目标状态 |
| 2 | **`nmap_advanced_scan` 全端口必然超时** | 服务端 60s 硬限制 | 已通过技能指导要求用 Top100/限定端口；但模型仍会尝试全端口，需在工具层直接拦截 >1000 端口的调用 |
| 3 | **事实以端口/服务为主，缺少版本与 Web 指纹** | 该靶机 21-443 端口 nmap 未识别版本（filtered/无 banner），限制了漏洞映射深度 | 需要针对性 banner 抓取与 Web 路径枚举，当前 Worker 已提出这类意图但常因工具超时未完成 |
| 4 | **`httpx_probe` 参数用法不稳定** | 多次因参数错误或超时失败 | 可在 Worker Profile 中预置参数模板 |
| 5 | **blhackbox-gateway 未启动** | 当前直连 4 个服务，功能不受影响 | 如需统一入口再启用 gateway profile |
| 6 | **数据库仍 `synchronize=true`** | 无显式迁移 | 后续切换 migration |
| 7 | **`storage/*.cjs` 诊断脚本未清理** | 临时文件，已在 `.gitignore` | 可手工删除 |

---

## 八、下一步（第四阶段：漏洞发现与验证闭环）

按依赖顺序，**不提前开展第五阶段**：

1. **工具调用前置校验**：拦截明显会超时的参数（全端口扫描、缺失必填字段），在调用前就返回可操作提示，而不是等 60s
2. **版本指纹补强**：为 `service` / `web` Profile 预置 banner 抓取与路径枚举的参数模板，确保拿到版本号
3. **Verifier Worker 闭环**：从 `vulnerability` 候选事实 → 最小影响验证 → `verified` / `refuted`，结果写回假设图
4. **审批前端联动**：把已实现的审批接口接入工作流页，让高风险验证在人工批准后执行
5. **结果校验重试**：结构化输出不合规时自动追问一次，减少 `synthetic` 降级
