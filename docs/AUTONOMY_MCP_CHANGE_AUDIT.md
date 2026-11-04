# 自动化探索与 MCP 服务中心改造验收记录

本文件记录当前已实现与尚未完成项，不作为整体完成声明。

## 已实现，需最终综合复核

- 工具页只展示 builtin/business；MCP 工具按所选服务器加载。
- 服务中心统计、搜索、筛选、添加抽屉、JSON 导入；HTTP/SSE/stdio 后端检测与执行。
- 请求头与 stdio 配置加密存储；真实 SSE/stdio/HTTP fixture 回归。
- 单批规划上限 3，按剩余队列空间限制新增；并发等待不消耗轮次。
- Worker 完成、积压和周期触发复核；待执行意图 keep/retire 与审计。
- 工具同类替代、短期冷却、任务级相同参数失败抑制。
- 拦截明确的平台维护意图。
- 验证角色 forceRerun 修复；有新证据时重开 inconclusive。
- 停止/失败后验证收尾及启动修复。
- 事实候选的保守资源身份合并、来源事实关联和自动验证排队适配。
- 明确弱点分层；默认页面查看 actionable，保留弱点事实用于探索。
- 模型意图不再采信模型 dedupeKey；服务端按目标、目的、假设与工具计算。
- 显式空工具允许列表不再下发全部工具。

## 未完成或证据不足

- MCP 页面已有 1440×1000 Chromium 渲染验收；较窄窗口布局和真实后端页面联调仍需复核。
- 资源/提示模板已接真实 MCP 分页发现；连接设置/诊断详情、启停与自定义请求头已实现；连接配置编辑已实现，支持保留或替换加密认证/stdio 启动配置。
- 服务编辑、启停、保存与检测的管理 HTTP 集成测试已通过；需最终连同真实传输 fixture 复核。
- 多服务器同名工具现已共用稳定名称映射，Worker 启动前同步目录；需在最终综合回归中复核动态新增服务器。
- 工具恢复目前使用最近 200 条调用和有限能力映射；进一步验证故障分类、在线目录与同会话恢复。
- 队列历史积压已在复评后按 workerCount × 2 收缩；验证和运行中依赖闭包受保护，超限例外写审计。规划次数仅内存与审计，尚未在快照中单独展示。
- 无进展判断已接入证据支撑的去重知识及反证；自由文本语义同义仍仅保守归一化，不宣称完全语义去重。
- 意图身份仍依赖规范化目的与假设文本，历史键迁移与基于新证据的探索重开未完善。
- finding 历史重复行未统一合并；模型直接 report_finding 路径尚未共用合并身份；需保留认证上下文。
- 相关旧审批/人工评级文档与提示词尚未全面同步。
- Web 构建已通过，构建前后 src 中 JS 文件均为 0；图表 chunk 仍有体积告警。
- 最终按原测试场景执行容量、失败恢复、验证收尾的综合回归与能力指标比较。

## 最近验证

`npm run typecheck`、`npm run test` 通过，日志位于 `tmp/goal-typecheck.log`、`tmp/goal-tests.log`。
`test:findings`、`test:migrations` 已在分层改动后通过；后续相关改动需重跑。
`scripts/verify-mcp-sse.cjs`、`scripts/verify-mcp-stdio.cjs`、`scripts/verify-mcp-runtime.cjs` 已分别通过真实本机 fixture 验证。

## 2026-11-04 浏览器验收

`scripts/verify-mcp-ui.mjs` 在真实 Chromium 中以模拟 API 验证：按服务加载工具（不调用全量 MCP 目录）、资源展示、请求头 JSON 校验与提交、测试连接与保存、stdio JSON 导入、工具页只显示内置业务工具。截图：`tmp/ui/mcp-services.png`、`tmp/ui/mcp-add.png`、`tmp/ui/builtin-tools.png`。截图已人工视觉检查并对照用户参考图。该测试不证明真实后端连接行为；真实传输由独立 MCP fixture 脚本验证。

运行时需安装 Playwright，或通过 `PLAYWRIGHT_MODULE` 指向现有模块、`CHROMIUM_EXECUTABLE` 指向浏览器。未向项目新增依赖。前端类型检查与 73 项测试通过，日志 `tmp/goal-ui-tests.log`。

Web 生产构建通过：`tmp/goal-web-build.log`；构建前后 `apps/web/src` 内 JS 文件数均为 0。

## 2026-11-04 MCP 配置编辑与目录一致性

- 新增编辑与已保存凭据连接测试 API；UI 在连接设置提供编辑抽屉。默认保留加密凭据，取消勾选可完整替换；更换传输方式必须重新填写。
- 保存前检测失败时原配置与目录不变；提交配置后清理旧目录并重新发现。更新以事务记录无凭据审计，避免并发配置覆盖。
- 健康检查以事务同步完整工具目录，移除服务已撤下的工具；拒绝把旧连接配置的检测结果写入新配置。
- `scripts/verify-mcp-management.cjs` 通过真实 SQLite + Nest HTTP 验证：创建、编辑、保留/清除认证、stdio 配置保留、失败回滚、非法 DTO、404、旧探测防覆盖、已撤下工具清理。远端 probe 在此脚本使用 fixture 返回值。
- Chromium UI 回归新增编辑并保留凭据用例，通过；真实 Streamable HTTP runtime 脚本通过（`tmp/goal-edit-runtime.log`）。
- 全量类型检查、API 构建、353 项 API 与 73 项 Web 测试通过（`tmp/goal-edit-typecheck.log`、`tmp/goal-edit-build.log`、`tmp/goal-edit-tests.log`）。

## 2026-11-04 探索进展判断

Worker 收尾使用任务内真实证据关联的知识标识集，不再比较事实行数。标识包含目标、资源、谓词、观测值、观测类别和状态，规范化空白/谓词格式；重复行、更换证据 ID、旧知识删除重插不重置停滞计数。有效目标否定、复核及反证计入进展；工具错误、推断、空证据和不属于当前任务的证据不计入。标识集在本次运行内累计，新运行以现有知识为基线。

验证：4 项纯函数用例，以及 `verify-engine-controls.cjs` 中真实数据库 + Worker 收尾测试，覆盖重复行、反证、悬空证据与重插。全量类型检查、357 项 API + 73 项 Web 测试、API 构建通过。引擎控制、任务生命周期、运行开关、Worker 容量脚本通过，日志 `tmp/goal-progress-*.log`。

同步修正旧脚本：引擎事件按每批每任务一条消费；运行开关验证全自动调用而非等待已移除的审批；Worker 桩补目录同步与当前工具构造依赖。未恢复人工审批。

## 2026-11-04 历史意图积压收敛

Planner 复评先更新 keep/retire 与优先级，再收缩历史 proposed 队列。普通探索队列按 workerCount × 2 限制，高优先级方向连同其待执行依赖整体保留；验证意图和已派发任务的待执行依赖受保护。必要依赖超过容量时明确记录 protectedCount，停止增加普通方向，避免破坏验证闭环。

低优先级溢出项标记 queue_capacity，保留事实、假设、依赖与审计历史；后续重新被选中时恢复原行，不重置 attemptCount/maxAttempts，不产生重复意图。只有容量暂缓可以这样恢复，其他拒绝原因不受影响。

验证：`verify-planner-capacity.cjs` 调用真实 applyPlannerOutput 与 SQLite，验证 71 个新方向只入库 3 个及假设关联完整、71 个旧 proposed 复评后保留 4 个、更新后的优先级生效、暂缓项按原 ID 恢复。纯函数覆盖依赖闭包、验证/活动依赖保护与循环依赖。类型检查、API 构建、361 项 API + 73 项 Web 测试、findings 与 Worker 容量集成回归通过。日志 `tmp/goal-queue-*.log`。
