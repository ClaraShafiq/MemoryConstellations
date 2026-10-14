# 数据库迁移约定

迁移集中在 `database.js`，通过 `schema_version` 顺序记录。目标仓库当前最新版本为 v112。

## 规则

- 新迁移使用目标仓库的下一个版本，不复制其他部署的版本号。
- 一个 `ALTER TABLE ... ADD COLUMN` 使用一个版本，避免首条重复导致后续语句被整体跳过。
- 新表用 `CREATE TABLE IF NOT EXISTS`，索引用 `CREATE INDEX IF NOT EXISTS`。
- 控制面表在 critical migration 中一次建齐；失败时中止启动。
- 空库迁移是必须验收项，不能依赖生产数据库已有列。
- 禁止迁移私人数据、真实聊天或模型原始请求。

## v104–v112

| 版本 | 内容 |
|---|---|
| v104 | 消息 pickup 游标 |
| v105 | Scribe 复合游标 ID |
| v106–v107 | frozen observation 合同与状态 |
| v108 | 星座 scope |
| v109 | Claim、证据池、星座、Episode、Saga、Profile、检索与 job 控制表 |
| v110 | legacy/backfill 安全默认设置 |
| v111 | 将未完成的旧任务归入回补车道，实时任务以 priority 100 为边界 |
| v112 | Judgment 队列记录来源车道，保持客观层与人格写作隔离 |

空库验证命令见 [TESTING.md](TESTING.md)。
