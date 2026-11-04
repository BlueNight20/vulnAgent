# 依赖整改记录

更新：2026-11-03。当前依赖审计归零；审计结果不代表整个系统安全验收通过。

当前 `npm audit --json` 和 `npm audit --omit=dev --json` 均为 0 项，见 [完整快照](dependency-audit.json) 和 [生产快照](dependency-audit.production.json)。整改起始为 45 项，曾降到 32 项、4 项。本轮实际升级 CLI 与传递依赖、移除不再默认依赖的旧检查器，没有删除审计条目或忽略级别。审计数据库会更新，后续需重新获取结果。

## 本轮升级与兼容性

| 依赖 | 原版本 | 当前版本 |
| --- | --- | --- |
| Vite | 5.4.11 | 7.3.7 |
| Vitest（前后端） | 2.1.8 | 4.1.12 |
| React 插件 | 4.3.4 | 5.2.0 |
| React Router DOM | 6.28.0 | 7.18.5 |
| ECharts / React 包装器 | 5.5.1 / 3.0.2 | 6.1.0 / 3.0.6 |
| PostCSS | 8.4.49 | 8.5.32 |
| TypeORM | 0.3.20 | 0.3.31 |
| Joi | 17.13.3 | 17.13.9 |
| ws（直接依赖） | 8.18.0 | 8.22.1 |
| Zod | 3.24.1 | 4.6.7 |
| Node 类型 | 22.10.2 | 24.19.2 |
| Nest core/common/HTTP/WebSocket/testing | 10.4.15 | 11.2.8 |
| Nest Config / TypeORM 集成 | 3.3.0 / 10.0.2 | 4.0.4 / 11.0.3 |
| Nest CLI / 脚手架 | 10.4.9 / 10.2.3 | 12.0.11 / 12.0.12 |
| TypeScript | 5.6.3 | 6.0.3 |
| Express 类型 | 4.17.21 | 5.0.6 |

项目 Node 引擎约束为 ^22.22.3 / ^24.15.0 / >=26，匹配脚手架工具的要求；当前只实际验证 Windows / Node 24.21.0。没有使用 --force / --legacy-peer-deps 忽略 peer 冲突。运行时框架保持 Nest 11.2.8，CLI 独立升级到 12；官方说明默认 TSC 构建仍支持 CJS，Webpack 检查器改为可选 peer，默认安装不再带入旧 deepmerge / minimatch 3 链。[CLI 12 发布说明](https://github.com/nestjs/nest-cli/releases/tag/12.0.0)

API / shared 编译改用 Node16 模块解析，产物仍为 CJS；API 构建显式 rootDir=src 保持 dist/main.js 与资源路径。移除废弃 baseUrl，类型检查配置允许共享源码路径，显式 Node 类型。全部包统一 TypeScript 6.0.3，未用 ignoreDeprecations 压掉迁移诊断。[TypeScript 6 文档](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)

根 overrides 将 glob 固定到 14.0.3、Nest HTTP 平台的 multer 固定到 2.5.0，覆盖上层包仍固定引用的受影响版本。已执行 npm update 实际替换安装树，未仅修改声明。TypeORM 实体 glob 导入、CLI 构建/资源复制、迁移 CLI 和完整应用已验证兼容。

Nest core 会从自身位置探测可选 HTTP/WebSocket peer。根目录显式声明同版 platform-express 和 websockets，使新安装后不因可选 peer 位于 API 子目录而遗漏事件网关；生产入口显式创建 ExpressAdapter。集成脚本从 API 工作区解析依赖，并使用同样的显式 HTTP 适配器。新增真实 WebSocket 测试覆盖 hello、心跳、审计和任务状态推送，避免只验证 HTTP 健康。

参考官方迁移与兼容性说明：[Vitest 4 迁移](https://v4.vitest.dev/guide/migration.html)、[Vite 7 文档](https://v7.vite.dev/guide/)、[React Router 升级说明](https://reactrouter.com/upgrading/v6)。本项目使用声明式路由和 createBrowserRouter，现有链接、查询参数、证据深链接等交互测试在 7.18.5 下通过。

验证：前后端 313 项单元及界面测试、全项目类型检查、生产构建、19 个隔离服务集成脚本均通过。包含迁移、实体 glob 导入、真实 CLI、完整 AppModule 启动、真实 HTTP/WebSocket、证据/漏洞/报告、任务生命周期、真实 Pi SDK 模型预算、本机 MCP SDK、密钥升级、备份轮换和真实入口子进程的完整链路/中断恢复。`npm run test:clean-install` 在临时目录安装锁文件，并重复迁移、HTTP/WebSocket、模型预算、MCP、密钥、MCP 密钥、备份和完整进程等 8 组运行时验证；锁文件不变，不复制 .env、storage 或用户数据库。该验证使用已编译产物，不替代源码从零构建和跨系统验收。ECharts 6.1.0 SVG 引擎以固定数值数据实际渲染 3278 字节输出；这不是完整浏览器图表视觉验收。图表生产分块仍约 1.15 MB，有构建体积提示。

## 本轮剩余依赖与资源兼容修正

- CLI 12 自带 minimatch 10.2.6 仍受 globparts 放大问题影响，现定向 override 为 11.0.4；其命名 minimatch API 与 CLI 调用方式兼容，实际资源包含/排除/监听测试通过。[上游公告](https://github.com/advisories/GHSA-g3hv-75wg-m249)
- 原 webpack 检查器和 deepmerge 已不在安装树中，未强行把旧函数式调用替换成不兼容导出。
- 验证发现 CLI 12.0.11 在 watchAssets 模式未将 exclude 传递给递归目录监听，已用 scripts/patch-nest-assets.cjs 加入最小安装期修正，按版本和修正前后 SHA-256 严格校验；只允许工作区内依赖文件，重复执行幂等，未审阅文件拒绝改写。postinstall、API prebuild / predev 执行校验；无开发 CLI 的生产安装跳过，不改写全局 CLI。
- test:cli-toolchain 在临时工程使用真实 CLI、Nest DI、TypeScript 和本机 HTTP，验证冷构建、嵌套资源与排除、JSON、旧输出删除、监听启动、TS 修改重启、错误代码不启动新进程、修复后恢复及资源更新/删除重启。资源修正透明保留在版本库脚本中，不改包版本号。

最新验证：328 项单元/界面测试、类型检查、前后端构建及 24 组集成检查通过（23 个业务/服务脚本加 CLI 工具链）。隔离 npm ci 安装 736 包、锁文件不变，13 组隔离运行验证通过，包含 CLI 源码冷构建/监听及完整业务进程。仍不代表全项目源码跨系统从零构建验收。更早的 313 项 / 19 脚本记录对应上一轮 Nest 11 工具链升级；当前图表包体积提示仍在。

执行开关接线后更新：330 项单元/界面测试、类型检查、前后端构建及 24 个服务脚本通过，加 CLI 工具链为 25 类检查；新的隔离 npm ci 仍为 736 包、锁文件不变、审计 0 项，14 组运行验证全部通过，新增 runtime-control。安装仍有传递依赖弃用及非必需脚本未批准提示，没有使用强制安装或额外批准脚本；原生 SQLite 与相关 SDK 的实际运行已验证。

引擎控制统一后更新：340 项单元/界面测试、类型检查、前后端构建和 25 个服务脚本通过；隔离安装扩至 15 组并通过（新增 engine-controls，包含长会话增强的 http-ws），736 包、锁文件不变、审计 0 项。依赖版本未改，验证环境及体积/弃用提示限制不变。

日志接线与 MCP 路由修正后：342 项单元/界面测试、类型检查、生产构建、26 个服务脚本通过；隔离安装 16 组通过，新增 logging 的实际生产入口/重启验证。仍为 736 包、锁文件不变、审计 0 项，无新增依赖；安装提示与图表资源体积限制保留。

参考后端迁移资料：[Nest 11 发布记录](https://github.com/nestjs/nest/releases/tag/v11.0.0)、[Express 5 迁移说明](https://expressjs.com/en/guide/migrating-5/)。保留可复现的功能验证；不能只通过删除审计条目、忽略级别或不检查开发依赖来宣称完成。

最终 Worker / 人工提示 / 工作流收尾验证：348 项单元/界面测试、全项目类型检查、前后端生产构建通过；28 个服务脚本全部通过，加真实 CLI 共 29 类检查。最终编译产物的隔离 npm ci 安装 736 包、锁文件不变、审计 0 项，18 组验证通过（新增 worker-capacity / hints，http-ws 增加真实仪表盘聚合与工作流来源/输入输出）。无新增依赖或版本变更；Windows/Node 环境、图表体积及传递依赖安装提示限制不变。逐项交付证据见 FINAL_DELIVERY_AUDIT.md。
