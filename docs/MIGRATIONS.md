# 数据库迁移约定

迁移集中在 `database.js`，由 `schema_version` 顺序记录。公共仓库当前最新版本为 v119。

## 规则

- 只使用公共仓库自己的连续版本，不复制其他部署的迁移编号。
- 一个 `ALTER TABLE ... ADD COLUMN` 占一个版本，避免首条重复导致整组语句被跳过。
- 新表使用 `CREATE TABLE IF NOT EXISTS`；重建带 CHECK 的表时先迁移数据，再重建索引。
- 控制面迁移标记为 critical；失败就停止启动。
- 空库迁移和从前一公共版本升级都必须使用虚构数据验收。
- 迁移只创建协议、索引和安全默认值，不携带聊天、Profile、模型请求或生产状态。
- schema 完成不代表 maintenance 或 verified 自动启用。

## v104–v119

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

## 空库验证

```bash
DB_PATH=/tmp/memory-empty.sqlite \
SANCTUARY_ENCRYPTION_KEY=$(openssl rand -hex 32) \
npm run test:memory-extensions
```

测试应打印 `schema: 119`。如果临时文件已经存在，请换新路径，不要在旧文件上误判“空库迁移通过”。完整测试矩阵见 [TESTING.md](TESTING.md)。
