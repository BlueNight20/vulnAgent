# SQLite 备份与恢复

更新：2026-11-03。以下命令供操作人员主动执行；开发验证只使用隔离数据库，不操作现有业务库。当前支持一致性备份、校验、新路径恢复及按数量轮换命令。业务数据保留和父任务缺失记录维护已提供设置页及 API，执行前复用这里的完整备份，见 DATA_MAINTENANCE.md。系统未自动安装定时任务。

## 一致性备份

先在项目根目录编译后端：

```powershell
npm run build --workspace @vulnagent/api
npm run db:maintenance --workspace @vulnagent/api -- backup --source "D:\VulnAgentData\vulnagent.sqlite" --directory "D:\VulnAgentBackups"
```

将示例路径换成实际数据库和备份目录。命令不读取 .env，也不猜测数据库位置，必须显式提供文件路径。只支持现存 SQLite 普通文件，不支持 PostgreSQL、内存库、URI 或符号链接源文件。

备份使用 SQLite Online Backup API，可在源库保持打开时捕获已提交数据，包括 WAL 中尚未 checkpoint 的内容。只对新生成的快照切换为独立日志模式，不更改源库的 journal_mode。清单来自完成后的快照，不混用源库后续写入的计数。每个新备份包为单独目录，仅含：

- database.sqlite：完整数据库，包括文本、BLOB 附件、报告副本和密文配置。
- manifest.json：格式版本、UTC 创建时间、字节数、SHA-256、各表行数和外键问题数量。

生成期间使用独立临时目录，文件完成并检查后发布；失败清理本次临时目录，不改写源库。备份不包含主密钥、.env 或其他文件。Unix 新目录为 0700、文件为 0600；Windows 继承目录 ACL，备份目录应由运行账户受控保存。

## 校验

```powershell
npm run db:maintenance --workspace @vulnagent/api -- verify --backup "D:\VulnAgentBackups\backup-实际目录名"
```

核对清单版本、大小、SHA-256、SQLite integrity_check、表计数和外键问题数量。清单中的 foreignKeyViolations 非零代表原数据已有约束问题，备份保留该状态，不宣称自动修复。校验拒绝额外文件、WAL 辅助文件及符号链接文件。

SHA-256 用于发现损坏或不一致，不提供备份来源认证；能同时篡改数据库和清单的人可以重新生成哈希。因此备份目录的访问权限仍然必要。旧备份可能含历史明文配置，本命令不额外加密整份数据库，也不承诺擦除 SQLite 旧页或旧文件。

## 恢复与切换

```powershell
npm run db:maintenance --workspace @vulnagent/api -- restore --backup "D:\VulnAgentBackups\backup-实际目录名" --destination "D:\VulnAgentData\restored.sqlite"
```

恢复只发布到新数据库路径。已有目标文件、同名 -wal / -shm / -journal，或备份包内的目标路径均拒绝；不会覆盖运行中的原库。先校验并复制，再检查复制结果哈希，通过后以不覆盖方式发布，保留原库用于回退。

核查备份时间和任务范围后，停止 API，并在确认外部工具已停止后切换配置：

1. 将 DB_PATH 指向恢复出的新文件。
2. 使用备份对应的原 VA_ENCRYPTION_KEY，或将 VA_ENCRYPTION_KEY_FILE 显式指向原主密钥文件。默认主密钥路径与 DB_PATH 关联，改变数据库路径不会自动复制主密钥。
3. 启动 API，检查迁移、健康状态、任务与附件。应用正常启动对账仍会处理快照中遗留会话和未知请求；先核实远端工具状态，再决定是否继续任务。
4. 保留原数据库和配置，核查完成后再依据保留策略处理。恢复失败或数据不符合预期时，停止 API 并切回原数据库及原主密钥。

恢复数据库不会撤销远端工具副作用，也不会恢复模型供应商的余额。备份本身不包含主密钥，必须另外受控保存；丢失原主密钥时无法凭数据库备份解密旧凭据。

## 备份轮换

先生成新备份并列出旧包清理计划（不删除旧包）：

```powershell
npm run db:maintenance --workspace @vulnagent/api -- rotate --source "D:\VulnAgentData\vulnagent.sqlite" --directory "D:\VulnAgentBackups" --keep 7
```

确认目录和保留数量后，显式执行轮换：

```powershell
npm run db:maintenance --workspace @vulnagent/api -- rotate --source "D:\VulnAgentData\vulnagent.sqlite" --directory "D:\VulnAgentBackups" --keep 7 --apply
```

两种模式均先完成并校验新备份。keep 为 1～10000，按有效清单创建时间至少保留最新 N 包，另外保护本次新包和直接作为源库的备份包。只有符合工具命名、位于指定目录直属层、完整校验通过的独立包可以成为候选；损坏包、未知目录、目录链接、临时包均保留并报告或忽略，不自行清理。

使用 .rotation.lock 排斥并发轮换。执行时在每个包删除前再次校验，先持久化 rotation-history.jsonl 中的请求记录，再改名为本次 .retired-* 目录并清理，完成后补结果记录。日志不可写时不删除该包；新包有外键问题时不清理任何旧包。退出码 0 为正常，2 表示有警告或部分清理未完成，1 为命令失败。返回 created / retained / candidates / removed / skipped / warnings，removed 是已经完成的删除，不能假定整批操作会回滚。

进程中断可能留下锁、.pending-* 或 .retired-* 目录。先核实记录的 PID 已退出且没有其他轮换在运行，再由操作人员检查残留包和日志；系统不会仅因超时就自动删除锁或残留目录。轮换只管理备份副本，不删除任务、证据、报告或历史业务行；没有为用户注册任务计划。需要定期运行时由部署侧配置此命令。

## 本地验证范围

`npm run test:backups` 创建临时迁移数据库，保持 WAL 写连接打开，验证已提交数据、快照冻结、完整随机 BLOB、中文及表情原文、加密配置、清单/大小/哈希/表计数、真实 CLI 和新路径恢复。损坏数据库、被修改清单、已有目标/辅助文件、包内目标、无效源库均拒绝；失败后清理临时产物，原库仍可读写。轮换覆盖预览不删、显式执行、保留数量、源包保护、并发锁、日志故障、未知/损坏包保留和新备份外键问题阻止清理。该测试不对现有业务库进行备份、恢复或清理。
