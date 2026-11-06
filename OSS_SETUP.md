# Memory Constellations 部署指南

本文从干净 clone 开始。示例使用占位配置和虚构消息；不要把现有聊天、私人画像或其他部署的数据库复制进来。

## 1. 环境与下载

- Node.js 18+
- npm、OpenSSL、可编译 `better-sqlite3` 的工具链
- 可选：Python 3.10+，用于 legacy 向量检索及 verified 向量发布/核验

```bash
git clone https://github.com/ClaraShafiq/MemoryConstellations.git
cd MemoryConstellations
cp .env.example .env
cp memory_config.example.json memory_config.json
cp core-prompt.example.txt core-prompt.txt
npm install
```

## 2. 最小配置

用 `openssl rand -hex 32` 生成两个不同值，分别作为加密密钥和 session secret。编辑 `.env`：

```dotenv
SANCTUARY_ENCRYPTION_KEY=replace-with-64-hex-characters
SESSION_SECRET=replace-with-a-different-random-value
LOGIN_PASSWORD=replace-with-a-strong-password

MEMORY_LLM_PROVIDER=openai_compatible
MEMORY_LLM_ENDPOINT=https://provider.example/v1
MEMORY_LLM_MODEL=provider-model-id
MEMORY_LLM_API_KEY=replace-me

# 默认 0：所有 modern 模型调用 fail-closed。按自己的预算显式填写整数。
MEMORY_SCRIBE_DAILY_CALL_LIMIT=0
MEMORY_MAINTENANCE_DAILY_CALL_LIMIT=0
```

`MEMORY_LLM_PROVIDER` 只描述传输协议，目前接受 `gemini` 或 `openai_compatible`；不代表推荐某个供应商。模型名、价格、额度和 API 行为以供应商当日官方资料为准。

编辑 `memory_config.json` 中的 `user`、`ai`、`relationship`、`project`。先保留安全默认值：

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

不要提交 `.env`、`memory_config.json`、`core-prompt.txt`、数据库、token 或登录目录。加密密钥丢失后无法解密原数据。

## 3. 初始化空库

```bash
DB_PATH=./memory_constellations.db npm run setup:llm
```

该命令从空库迁移到 schema v118，把 API key 加密写入指定数据库，并设置为默认模型连接。之后所有启动、维护和发布命令都要使用相同 `DB_PATH`。

## 4. 运行聚焦测试

每条命令使用不同的临时库：

```bash
DB_PATH=/tmp/memory-modern.sqlite SANCTUARY_ENCRYPTION_KEY=$(openssl rand -hex 32) npm run test:memory-modern
DB_PATH=/tmp/memory-lanes.sqlite SANCTUARY_ENCRYPTION_KEY=$(openssl rand -hex 32) npm run test:memory-lanes
DB_PATH=/tmp/memory-extensions.sqlite SANCTUARY_ENCRYPTION_KEY=$(openssl rand -hex 32) npm run test:memory-extensions
npm run test:llm-config
npm run test:contracts
npm run test:ssrf
npm run check:docs
npm run check:privacy
```

如果临时文件已经存在，请换一个文件名，确保验收从空库开始。

## 5. 首次启动与健康检查

```bash
DB_PATH=./memory_constellations.db npm start
```

打开 `http://127.0.0.1:3000/memory.html` 并使用登录密码。另一个终端运行：

```bash
curl http://127.0.0.1:3000/api/health
```

初始响应应包含 `ok: true`、`schema_version: 118`、`chat_read_mode: legacy`、`semantic_maintenance: backfill`、各层计数和 verified 向量 blocker。健康接口不返回记忆正文。

## 6. 接入消息与纠错证据

```bash
curl -X POST http://127.0.0.1:3000/api/messages \
  -H 'content-type: application/json' \
  -d '{"sender":"user","content":"River is testing a local notebook.","timestamp":"2026-11-01 10:00:00","chat_id":1}'

curl -X POST http://127.0.0.1:3000/api/recall \
  -H 'content-type: application/json' \
  -d '{"query":"local notebook","limit":8}'
```

`POST /api/memory/corrections` 只提交带消息 ID 和逐字引文的纠错证据，不直接改 Profile。受控审查通过后才创建 correction Claim 并让旧 Claim 失效。

上述三个集成路由默认按 loopback/受信内网设计。公网开放前必须增加反向代理鉴权、TLS、速率限制和请求大小限制。

## 7. 选择 modern 写入链

先把 `memory_config.json` 的 `pipeline.mode` 改为 `modern`，并重启 Node 服务。modern 模式会停用旧 Scribe、旧 Archivist、Skills、Insight、Flash 和认知融合写入旁路。

然后显式设置非零调用预算，并选择一种客观审查适配器：

- 自定义适配器：实现 `propose({ job, input })`，只返回 allowlist JSON action；`input` 是宿主生成的解密后最小证据快照。
- Codex CLI 适配器：设置 `ALLOW_MEMORY_CODEX_CLI=1` 和 `MEMORY_CODEX_ISOLATED_CWD`。它以只读模式运行；安装、登录和产品行为以 [OpenAI 官方文档](https://developers.openai.com/api/docs/guides/code-generation) 为准。

任何适配器都没有 SQL 或 shell 写库权限。Codex/客观维护者不会生成第一人称 Judgment；非空 Judgment 需要另接 persona writer，且必须消费 assistant 态度 Claim 或审核 seed。

确认配置后启动正式维护链：

```bash
DB_PATH=./memory_constellations.db npm run memory:maintenance:status
DB_PATH=./memory_constellations.db npm run memory:maintenance:start
```

`maintenance: running` 只表示 Scribe、当前车道审查、确定性推进和向量同步可以运行。在线 runner 只租用 priority 100 的实时任务；历史回补不会被顺带消费。暂停命令：

```bash
DB_PATH=./memory_constellations.db npm run memory:maintenance:pause
```

## 8. 可选向量服务与 verified 发布

verified 读侧需要独立 Chroma collection 和远端元数据核验：

```bash
python3 -m venv venv
venv/bin/pip install -r requirements-vector.txt
venv/bin/python -m uvicorn chroma_service:app --host 127.0.0.1 --port 7707
```

若服务不在默认地址，设置 `CHROMA_URL`。保持它在 loopback 或受保护网络中。

先让现代 SQL 发布物和向量回执追平，再检查：

```bash
DB_PATH=./memory_constellations.db npm run memory:release:status
DB_PATH=./memory_constellations.db npm run memory:release:prepare
```

只有 `prepare` 返回 `ready: true` 且 blocker 为空，才执行：

```bash
DB_PATH=./memory_constellations.db npm run memory:release:activate
```

`requested_chat_read_mode=verified` 不保证有效读模式一定是 verified。投影 revision、source hash 或远端回执任一不一致时，消费者自动回落 legacy。显式回滚：

```bash
DB_PATH=./memory_constellations.db npm run memory:release:rollback
```

## 9. 最终验收

不能用测试通过或表计数代替真实验收。至少确认：

1. 一条全新自然消息被 Scribe 拆成正确的原子观察，逐字引文和主体无误。
2. Claim Review、Duty、Classification、Node Review 和证据池完成；拒绝项可恢复而不读 Fragment 正文。
3. 星座候选、Episode、Profile 字段和搜索投影按证据发布。
4. Judgment 证据不足时不生成，失败时保留旧值。
5. `release:prepare` 远端核验通过，激活后 `/api/recall` 返回带 revision/source hash 的现代聊天包。
6. 实际聊天模型在新一轮对话中正确召回；随后演练 `release:rollback`。

## 10. 备份与恢复

暂停维护后，使用 SQLite 在线备份接口，或在确认无写入时完整保存数据库、`-wal`、`-shm` 和加密密钥。恢复演练至少验证迁移版本、解密、`/api/health`、legacy 回滚和一条召回。不要只复制正在写入的主数据库文件。

继续阅读：[架构](docs/MEMORY_ARCHITECTURE.md) · [配置](docs/CONFIGURATION.md) · [迁移](docs/MIGRATIONS.md) · [测试](docs/TESTING.md) · [排障](docs/TROUBLESHOOTING.md)
