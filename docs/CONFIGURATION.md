# 配置说明

## `.env`

必需：

- `SANCTUARY_ENCRYPTION_KEY`：64 位十六进制 AES-256-GCM 密钥。
- `SESSION_SECRET`：Web session 随机密钥。
- `LOGIN_PASSWORD`：本地 UI 登录密码。
- 一个实际使用的 LLM 渠道密钥。

可选：

- `DB_PATH`：SQLite 路径；默认 `sanctuary.db`。
- `PORT`：HTTP 端口；默认 3000。
- `MEMORY_SCRIBE_BATCH_SIZE`：现代 Scribe 每批消息上限；默认 60。
- `MEMORY_SCRIBE_MIN_MESSAGES`：现代 Scribe 最小积压；默认 1。
- `ALLOW_MEMORY_CODEX_CLI=1`：显式允许启动 Codex CLI 运行期适配器；仍必须由调用方提供隔离工作目录。

不要把 `.env`、登录状态或密钥写入 `memory_config.json`。

## `memory_config.json`

从 `memory_config.example.json` 复制。`user`、`ai`、`relationship`、`project` 和 `ui` 只描述当前部署的通用角色配置。

`pipeline`：

- `mode=legacy`：运行现有 Archivist/Scribe。
- `mode=modern`：运行原子观察 Scribe 与受控 pipeline scheduler。
- `chat_read_mode` 是部署说明值；权威运行开关存放在数据库 `user_settings.memory_chat_read_mode`。
- `semantic_maintenance` 是部署说明值；权威运行开关存放在 `user_settings.memory_semantic_maintenance_mode`。
- `persona_writer.enabled=false`：默认不生成非空 Judgment。

安装不会自动把数据库设置切到 verified/running。这样迁移表和测试不会误触发消费者切换。

## 模型配置原则

模型名、价格、额度和 API 行为可能变化，本仓库不写死推荐。结构化审查模型必须能稳定返回 JSON；人格写作者必须与所需 companion persona 显式绑定；聊天主模型由集成方选择。部署时查各供应商官方文档。
