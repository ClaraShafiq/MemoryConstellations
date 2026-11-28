# 数据库迁移约定

迁移集中在 `database.js`，由 `schema_version` 顺序记录。公共仓库当前最新版本为 v125。

## 规则

- 只使用公共仓库自己的连续版本，不复制其他部署的迁移编号。
- 一个 `ALTER TABLE ... ADD COLUMN` 占一个版本，避免首条重复导致整组语句被跳过。
- 新表使用 `CREATE TABLE IF NOT EXISTS`；重建带 CHECK 的表时先迁移数据，再重建索引。
- 控制面迁移标记为 critical；失败就停止启动。
- 空库迁移和从前一公共版本升级都必须使用虚构数据验收。
- 迁移只创建协议、索引和安全默认值，不携带聊天、Profile、模型请求或生产状态。
- schema 完成不代表 maintenance 或 verified 自动启用。

## v104–v125

| 版本 | 内容 |
|---|---|
| v104 | 消息 pickup 游标 |
| v105 | Scribe 复合游标 ID |
| v106–v107 | frozen observation 合同与状态 |
| v108 | 星座 scope |
| v109 | Claim、证据池、星座、Episode、Saga、Profile、检索和 job 控制表 |
| v110 | legacy 读取和 backfill 暂停的安全默认设置 |
| v111 | 实时/回补 job 车道，以 priority 100 为实时边界 |
| v112 | Judgment 队列保存来源车道 |
| v113 | Claim 主体类型 `user/assistant/third_party/unknown` |
| v114 | Claim active/superseded 生命周期 |
| v115 | 人工锁定 Claim 的恢复保护 |
| v116 | 来源 speaker 统一为 `user/assistant` |
| v117 | Claim Recovery、星座发现、纠错收件箱、Judgment seed、模型预算、向量回执和 release gate |
| v118 | 检索投影正式支持 Saga |
| v119 | 派生状态健康记录与 status-aware legacy FTS 触发器 |
| v120 | 向量 receipt 有限恢复状态；纠错来源快照与幂等反馈标记 |
| v121 | Claim 独立 A/B 审核表、前台租约与后台冷却状态；旧单审任务迁移为两个 pass |
| v122 | Recovery 记录并保护已通过的兄弟 Claim |
| v123 | Recovery 持久记录争议 Claim 闭集 |
| v124 | Recovery 合同版本，确保合同变化可以形成新案件 |
| v125 | Fragment 成为权威观察；回填旧 Claim 证据锚账本，重建下游外键并物理删除 Claim/Review/Duty/Recovery 表 |

v125 保留旧 Claim ID 作为 `memory_fragment_evidence_refs.evidence_id`，因此既有 Episode/Profile 的
`claim_ids`、input hash 与发布历史无需重写。新碎片使用 `1000000000 + fragment_id` 作为兼容证据 ID；
这是协议适配值，不是恢复 Claim 实体。新写入直接产生 active/quoted Fragment 并排入
`fragment_classification`。

## 空库验证

```bash
DB_PATH=/tmp/memory-empty.sqlite \
SANCTUARY_ENCRYPTION_KEY=$(openssl rand -hex 32) \
npm run test:memory-extensions
```

测试应打印 `schema: 125`。记忆测试会在未提供 `DB_PATH` 时自动创建隔离临时库；显式提供路径时仍不得指向个人或生产数据库。`test:memory-v125-upgrade` 会构造带旧 Claim、Episode/Profile 发布和固定 input hash 的 v124 库，验证原地拔表后证据 ID、逐字来源和发布历史保持不变。完整测试矩阵见 [TESTING.md](TESTING.md)。
