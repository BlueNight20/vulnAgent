# 数据库迁移

默认 `DB_SYNCHRONIZE=false`。应用启动时自动执行 SQLite 迁移；CLI 使用同一迁移集，不启动模型或工具。

当前基线包含 25 张业务表。`baseline-sqlite.json` 是冻结 SQL 与落库结构签名；后续扩展必须新增迁移，不要重新生成或修改已部署的基线。数据库文件路径仍相对 API 进程工作目录解析。

第二条迁移 `FindingVerification1793577601000` 新增独立验证历史表。第三条 `TaskGoal1793577602000` 增加任务目标；第四条 `EvidenceAttachments1793577603000` 新增 evidence_attachments 和 report_attachments，当前共有 28 张业务表。扩展表或目标有数据时拒绝删除式回滚。原 25 表基线未重新生成。

第五条 `TaskOwnership1793577604000` 新增最小删除 ID 表 task_deletions（当前共 29 表），为 23 张任务所属表安装插入/更新归属约束，并在任务删除时原子清理所属数据、将历史审计 taskId 置空。全局 taskId=null 行保留。防重建触发器阻止旧回调重新保存已删除任务；有删除 ID 时拒绝回滚本迁移。此迁移不自动清理升级前已存在的孤立记录。新增所属表必须通过后续迁移扩展约束与清理清单。

第六条 `HypothesisQuotes1793577605000` 为 hypothesis_links 增加 evidenceQuotes、assessmentSource 和 agentSessionId。旧行默认 legacy / 空引用，保留研究历史，但不能靠旧链接数量支持或反驳假设。存在新引用、来源或会话字段时拒绝回滚。表数量仍为 29；迁移不猜测旧关联应当引用哪段原文。

第七条 `ModelTokenBudget1793577606000` 新增 model_requests 请求账本（当前 30 表），为任务增加预算轮次及旧用量基线，为会话增加额度、轮次和基线。旧记录延迟接管，迁移不重算历史。任务所属约束和删除清单扩展到 24 表；存在预算记录或已接管的预算字段时拒绝回滚。冻结结构为 model-requests-sqlite.json，不重新生成旧基线。

第八条 `McpHeaderSecrets1793577607000` 为 mcp_servers 增加 headersEncrypted text，表数量仍为 30。有任何密文时拒绝删字段回滚。CLI 只改结构；应用启动在原主密钥可用时，将旧 headers 和旧明文模型密钥在同一事务中升级并写审计，原明文字段清空。必须配套保管主密钥；无法解密时明确停止，不降级为无凭据连接或替换密钥。升级前备份可能含旧明文，历史备份/WAL/空闲页不在此迁移中安全擦除。

第九条 `FindingAssessments1793577608000` 新增 finding_assessments，冻结结构见 finding-assessments-sqlite.json；为 findings 增加 metadataRevision（整数，默认 0）。当前 31 表、25 张任务所属表。旧记录保持不变；维护记录或非零版本存在时拒绝删字段/删历史回滚。任务删除同时清理维护记录，晚到写入由归属约束拒绝。`npm run test:finding-assessments` 验证历史、并发冲突、审计失败回滚和来源失效后的页面/报告视图。

第十条 `GlobalPermissionUnique1793577609000` 为 agent_tool_permissions 建立 taskId IS NULL 的 agentRole / toolPattern 部分唯一索引，补足 SQLite 复合 UNIQUE 对 NULL 的限制。表数仍为 31，所属表仍为 25。历史重复组保持原有效拒绝/审批语义，全部原值先写审计再合并；不能解析的布尔值或审计失败会整体回滚。已有同名错误索引拒绝接管。回滚只移除索引，保留合并后的规则与完整审计。验证命令为 `npm run test:permission-updates`；不要重新生成前九条迁移。

第十一条 `InterceptRules1793577610000` 新增 intercept_rules 工具调用拦截规则表（当前 32 表），冻结结构见 intercept-rules-sqlite.json。规则按 priority 降序、首个命中生效，动作为 allow / deny / ask；仅 ask 使用 timeout* 字段。表为全局策略，不属于任务所属表，删除任务不清理规则。历史数据不受影响：空表即"无额外拦截"。生成快照用 `node apps/api/scripts/generate-intercept-snapshot.cjs`（仅新增迁移时执行一次，生成后不再改动）。

删除接口会检查约束已安装；仅开启 synchronize 的开发库不能执行关联删除。测试 `npm run test:lifecycle` 覆盖所有当前所属表、其他任务/全局隔离、子表删除故障回滚、晚到插入/更新与任务防重建。

在项目根目录执行：

```powershell
npm run build --workspace @vulnagent/api
npm run db:show --workspace @vulnagent/api
npm run db:migrate --workspace @vulnagent/api
```

旧 `.env` 如果显式设置 `DB_SYNCHRONIZE=true`，应用保留该开发配置并显示告警。要使用迁移，先改为 `false`。CLI 始终关闭自动同步。

- 空库：执行冻结 SQL，登记版本。
- 与基线匹配的既有库：仅登记版本，不重建业务表或修改业务数据。
- 缺表、字段或约束/索引不匹配：拒绝自动改表，事务回滚；应分析差异并补专门的升级迁移。

既有库存在待执行迁移时，在数据库同目录生成 `数据库文件.before-migrate-时间戳.sqlite`。通过同步 `VACUUM INTO` 创建一致性备份，先于迁移执行；备份失败阻止迁移。正常启动且无待执行迁移时不重复备份。备份包含敏感业务数据，应按原数据库权限和保留策略管理。

基线不提供删表回滚；`db:revert` 会明确拒绝。需要恢复时，停止相关 API 进程，用通过完整性和数据检查的备份恢复。不要将运行中 WAL 数据库的普通文件复制当作一致性备份。

PostgreSQL 尚无迁移集；SQLite CLI 遇到 `DB_TYPE=postgres` 会明确报错，不能将 SQLite 验证当作 PostgreSQL 已支持的证据。

```powershell
npm run test:migrations
# 在当前数据库的只读一致性副本上额外验证，不迁移原数据库：
node scripts/verify-migrations.cjs --check-live
```

测试覆盖空库、旧数据保留、备份完整性、结构差异拒绝、CLI、完整 Nest 启动与健康 HTTP。临时数据库及备份在关闭连接后清理。
