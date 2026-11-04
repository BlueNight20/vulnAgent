# 最终交付核验

日期：2026-11-03。核验范围保持用户授权的完整代码实现，以 PRD §2～5 为核心，包含后续已接入的维护、预算及恢复能力。用户已明确单人自用、真实靶机实测由用户操作；账号/多用户不做，PostgreSQL 咨询不等于迁移授权。不是按历史第一阶段 Mock 验收缩小范围。

## 核心要求与当前证据

| 要求 | 已检查的实现 | 执行证据及范围 |
| --- | --- | --- |
| PRD 2.1.1 目标和授权范围 | TasksService、目标校验、scope-guard、MCP 执行器 | execution / surface / worker-limits：真实迁移库、HTTP、IP/CIDR/端口、缓存前重检；不访问靶机 |
| 2.1.2 初始信息收集 | Bootstrap / recon 档案、目录交集、目标准备和 Worker 调度 | goals / profile-permissions / process-e2e：真实入口及 SDK 使用固定协议工具 |
| 2.1.3 动态探索 | Planner、意图准入/评分、黑板与假设关系 | hypotheses / surface / goals / process-e2e：后续规划确实读入前轮证据并派发新意图 |
| 2.1.4 并行 Session | SessionManager、原子 Worker 占位、任务/全局上限、模型并发 | worker-capacity / model-budget / process-e2e：竞争服务、等待/释放、动态上限、双 Worker 请求实际重叠 |
| 2.1.5 blhackbox MCP | McpClientFactory、tools/list、Schema、执行器 | mcp-runtime / execution / mcp-secrets：真实 MCP SDK 和本机协议服务，握手、目录、执行、取消；不启动/修改 blhackbox |
| 2.1.6 根据真实返回调整 | 原始证据→事实→Planner/后续 Worker，失败不冒充阴性结果 | approval-results / surface / process-e2e：先落库后规划、失败保留、重复不重发远端 |
| 2.1.7 候选复核和验证 | FindingsService、独立 verifier、新调用/会话、精确原文 | findings / finding-assessments / hypotheses：独立来源、无法确认/排除、原文失效、版本冲突，不把人工评级当验证 |
| 2.1.8 权限审计和受控提权验证 | Linux 审计档案、verifier 角色、权限交集、审批后重新检查 | profile-permissions / permission-updates / execution：实际审批与独立证据链；真实远程身份/权限由用户实测 |
| 2.1.9 完整记录和证据 | 会话完整 JSON、调用、原文/哈希、附件 BLOB、关系追溯 | execution / http-ws / attachments / hypotheses：完整长文本、625 条游标、二进制和反向来源；会话 UI 可展开完整 JSON |
| 2.1.10 结构化报告 | 冻结快照、中文 PDF、Markdown、JSON、ZIP 附件 | reports / attachments / finding-assessments / process-e2e：引用/哈希、导出、旧报告不受后续维护影响 |
| PRD 4.1～4.4 范围、角色、审批 | 任务授权、工具目录/角色规则、显式拒绝、实时重检 | execution / worker-limits / profile-permissions / permission-updates / approval-recovery：不因旧审批放行最新不允许的操作 |
| 4.5 审计 | 调用/任务/生命周期/权限/维护业务事务与审计、提交后通知 | engine-controls / permission-updates / data-maintenance / hints：故障回滚、旧结果不覆盖新运行、推送失败保留已提交数据 |
| 4.6 密钥 | AES-GCM、持久主密钥、MCP 全请求头加密/掩码、旧配置升级 | secrets / mcp-secrets：独立进程/并发创建、重启解密、坏主密钥拒绝请求、不回退其他凭据 |

## 十页与操作

实际 router.tsx 和 NAV_GROUPS 十页均为业务页面。router.spec.tsx 使用实际 RouterProvider、AppLayout 和各页面，点击全部侧栏并检查正确标题，无 404；只替换 API 固定返回及顶栏网络状态，不能当作用户浏览器视觉验收。

| 页面 | 额外行为证据 |
| --- | --- |
| 仪表盘 | http-ws：真实 HTTP 查询持久任务/候选/确认数量、Token/成本、最近任务、正数与空日趋势，API/DB 状态实查；MCP 状态来自实际检测的保存结果 |
| 任务中心 | http-ws / engine-controls / task-lifecycle；create-task-drawer 交互验证最新保存模型/预算/数量、错误重试和草稿保护 |
| 工作流 | http-ws：多轮 Planner 精确来源、Worker 后续分支、前置关系、输入/输出及证据反馈；graph-mapper 与引擎操作交互测试 |
| 智能体工作台 | hints：真实 SDK 定向投递和接收；消息游标/完整结构/失败显示/人工暂停恢复交互；不自动转投重启后的新会话 |
| 攻击面分析 | surface 原生入库与 API；资产/端口/服务/指纹及范围状态交互 |
| 漏洞发现 | findings / finding-assessments 与验证/维护/历史交互测试 |
| 证据管理 | execution / attachments / hypotheses；原文、附件、关系、失效及下载交互 |
| 报告中心 | reports / attachments；Markdown/PDF/JSON/ZIP、冻结、附件和错误交互 |
| MCP 管理 | mcp-runtime / mcp-secrets / permission-updates；工具 Schema、权限编辑/审批要求、调用和只读连接配置交互 |
| 系统设置 | runtime-control / logging / secrets / worker-capacity / model-budget；引擎开关、模型/密钥、默认值、并发、日志及手工维护交互 |

MCP 连接页当前只读，环境配置仅导入新名称，同名已有记录保留数据库值，不承诺修改环境变量会覆盖旧连接。模型附件目前向模型提供元数据，不宣称理解图片/PCAP；图为实际执行工作流及关联数据，不宣称完整攻击知识图谱。

## 工程、恢复与交付文档

| 项目 | 证据 |
| --- | --- |
| 五份设计文档 | PRD / ARCHITECTURE / DATABASE / API / DEVELOPMENT_PLAN 均存在；当前说明明确完整核心范围、历史计划、npm 及单人边界 |
| 显式迁移与数据完整性 | migrations / task-lifecycle / permission-updates：31 业务表、10 迁移、25 任务所属表，结构漂移拒绝、清理回滚、删除后防重建 |
| 预算、重试、超时、恢复 | model-budget / worker-limits / worker-capacity / runtime-control / engine-controls：预留/结算、未知占用、不盲目重放、旧循环隔离、终态保护和有界重试 |
| 真实入口与进程退出 | process-e2e：生产 main.js 子进程、真实 SDK、并行 Worker、复核/验收/报告、完成后重启不重放；真实中断未完模型流并保留未确认占用和人工恢复状态 |
| 备份/恢复/维护 | backups / data-maintenance：一致性备份、新路径恢复、哈希、轮换、截止与最近 N 项保护、写锁重校验、完整备份后原子清理、审计回滚 |
| Windows 安装/构建/开发 | package.json、scripts/start.ps1 / dev.mjs、README；真实 CLI 冷构建/监听/DI/资源与错误恢复，隔离 npm ci；未启动或切换原应用 |
| 使用、靶机操作和反馈 | USER_ACCEPTANCE、ENGINE_CONTROLS、RUNTIME_CONTROL、WORKER_CAPACITY、HINT_DELIVERY、LOGGING、BACKUP_RECOVERY、DATA_MAINTENANCE、PROCESS_ACCEPTANCE |

## 验证结论

代码实现及本地交付核验完成。当前 276 项 API + 72 项界面测试（共 348 项）通过，全项目类型检查、前后端生产构建通过。最后的工作流 Planner 消息预览修改后再次构建 API，28 个服务脚本全部顺序通过；随后基于最终编译产物执行隔离 npm ci：736 包、锁文件不变、审计 0 项，18 组验证通过，包含真实 CLI、增强仪表盘/工作流 HTTP、人工提示和完整生产进程链路。Web 的最终构建包含本轮提示目标选择及完整消息 UI。

服务脚本完整清单：approval-recovery、approval-results、attachments、backups、data-maintenance、engine-controls、execution、finding-assessments、findings、goals、hints、http-ws、hypotheses、logging、mcp-runtime、mcp-secrets、migrations、model-budget、permission-updates、process-e2e、profile-permissions、reports、runtime-control、secrets、surface、task-lifecycle、worker-capacity、worker-limits。均位于 scripts/verify-*.cjs。CLI 工具链另计，共 29 类本地检查；隔离安装选取其中 18 组，不称为全部服务回归。

可复现入口为 npm test、npm run typecheck、npm run build、npm run test:clean-install；单项原生脚本须先构建 API。隔离安装只复制清单/锁文件/已编译 API 与共享包/验证脚本，不复制 .env 或原业务库，也不代表整个前端源码在全新系统中完成视觉验收。安装传递依赖弃用/非必需脚本未批准提示及 ECharts 分块体积提示保留，不影响已通过的功能检查。

真实工具目录兼容性、实际模型决策质量、漏洞发现效果、远程取消/权限结果由用户在授权环境验证。开发侧固定协议证明代码链路与状态/数据约束，不证明渗透成功率。当前原应用进程和原业务库/.env 未由开发侧切换；用户需按 USER_ACCEPTANCE 启动新版本后实测。
