# Memory Constellations 部署指南

本文从干净 clone 开始。所有示例都是通用占位信息；不要把真实聊天、私人画像或生产数据库复制进仓库。

## 1. 环境

- Node.js 18 或更高版本
- npm
- 可编译 `better-sqlite3` 的系统工具链
- OpenSSL（生成随机密钥）
- 可选：Python 3 + ChromaDB，仅供 legacy 向量检索

## 2. 下载与最小配置

```bash
git clone https://github.com/ClaraShafiq/MemoryConstellations.git
cd MemoryConstellations
cp .env.example .env
cp memory_config.example.json memory_config.json
cp core-prompt.example.txt core-prompt.txt
npm install
```

用 `openssl rand -hex 32` 生成两个不同值。编辑 `.env`，设置 `SANCTUARY_ENCRYPTION_KEY`、`SESSION_SECRET`、`LOGIN_PASSWORD` 和实际使用的后台模型渠道。不要提交 `.env`；加密密钥丢失后无法解密旧数据。

编辑 `memory_config.json`，至少替换 `user`、`ai`、`relationship` 与 `project` 下的占位内容。保持以下安全默认值：

```json
{
  "pipeline": {
    "mode": "legacy",
    "chat_read_mode": "legacy",
    "semantic_maintenance": "backfill",
    "persona_writer": { "enabled": false, "provider": "", "model": "" }
  }
}
```

## 3. 初始化空库

数据库路径默认为项目根的 `sanctuary.db`，可用 `DB_PATH` 覆盖。推荐为此服务设置独立路径：

```bash
DB_PATH=./memory_constellations.db node -e "require('dotenv').config(); require('./database').initDatabase()"
```

以后启动时使用相同的 `DB_PATH`。迁移会从空库创建 legacy 表并应用目标仓库自己的 v104–v110；它不会读取外部生产数据库。

## 4. 运行聚焦测试

测试只在 `/tmp` 创建虚构数据：

```bash
DB_PATH=/tmp/memory-constellations-test.sqlite \
SANCTUARY_ENCRYPTION_KEY=$(openssl rand -hex 32) \
npm run test:memory-modern

npm run check:docs
npm run check:privacy
```

若临时库已存在，换一个文件名，保证测试从空库开始。

## 5. 首次启动与健康检查

```bash
DB_PATH=./memory_constellations.db npm start
```

打开 `http://localhost:3000/memory.html`，使用 `.env` 的登录密码。另一个终端执行：

```bash
curl http://localhost:3000/api/health
```

应返回 `ok: true`、schema 版本、两个 rollout 模式和各阶段计数，不包含记忆正文。初始模式应为 `legacy` 与 `backfill`。

## 6. 接入消息与召回

```bash
curl -X POST http://localhost:3000/api/messages \
  -H 'content-type: application/json' \
  -d '{"sender":"user","content":"这是一次本地测试消息","timestamp":"2026-01-02 10:00:00","chat_id":1}'

curl -X POST http://localhost:3000/api/recall \
  -H 'content-type: application/json' \
  -d '{"query":"本地测试","limit":8}'
```

这些路由假设运行在 loopback 或受信内网。对公网开放前必须加反向代理鉴权、TLS、速率限制和请求大小限制。

## 7. 验证每一层

`npm run test:memory-modern` 覆盖 Scribe 精确引文、Claim 审查、证据池、星座归属、Episode、三字段 Profile、检索投影，以及 Judgment、CAS 和租约的越权阻断。

运行时用 `/api/health` 观察计数。不要仅凭计数或测试宣布真实链路完成；最终验收需要一条全新自然消息实际走到聊天主模型召回。

## 8. 何时启用现代模式

现代提取由 `pipeline.mode=modern` 控制。语义 job 默认仍因数据库设置 `memory_semantic_maintenance_mode=backfill` 暂停；聊天召回默认读 legacy。

切换前必须备份数据库和密钥、运行隔离库测试、配置结构化审查适配器、配置独立人格写作者，并完成虚构消息和一条新自然消息的端到端验收。结构化 Agent 不得获得 SQL 凭据。回滚时恢复 `backfill` 与 `legacy`；字段历史不会丢失。

## 9. Codex 与其他 agentic IDE

Codex 或类似 IDE 可以作为部署助手。当前安装与登录步骤见 [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) 和 [Codex IDE](https://learn.chatgpt.com/docs/codex/ide) 官方文档。

运行期维护是另一种角色。`services/memoryCodexBackend.js` 提供 Codex CLI 只读提案适配器；`services/memoryCodexExecutor.js` 是唯一写入宿主，只接受 allowlist action。其他 Agent 只有实现相同协议后才能接入。不要提交登录目录、Cookie 或 token；实验性的 `codex app-server` 不作为生产依赖。

## 10. 备份与恢复

停止写入后备份数据库及加密密钥。启用 WAL 时，应使用 SQLite 在线备份接口或正确处理 `-wal`/`-shm`，不要在写入中只复制主文件。恢复演练至少检查 schema、解密、`/api/health` 和 legacy 回滚模式。

继续阅读：[架构](docs/MEMORY_ARCHITECTURE.md) · [配置](docs/CONFIGURATION.md) · [迁移](docs/MIGRATIONS.md) · [测试](docs/TESTING.md) · [排障](docs/TROUBLESHOOTING.md)
