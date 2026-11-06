# 配置说明

## `.env`

必需：

- `SANCTUARY_ENCRYPTION_KEY`：64 位十六进制 AES-256-GCM 密钥。
- `SESSION_SECRET`：Web session 随机密钥。
- `LOGIN_PASSWORD`：本地 UI 登录密码。
- `MEMORY_LLM_PROVIDER`：`gemini` 或 `openai_compatible` 请求协议。
- `MEMORY_LLM_ENDPOINT`、`MEMORY_LLM_MODEL`、`MEMORY_LLM_API_KEY`：部署者自己的模型连接。

常用可选项：

- `DB_PATH`：SQLite 路径，默认 `sanctuary.db`。
- `PORT`：HTTP 端口，默认 3000。
- `TZ`：IANA 时区；无法识别时回退 UTC。
- `CHROMA_URL`：向量服务地址，默认 `http://127.0.0.1:7707`。
- `MEMORY_SCRIBE_BATCH_SIZE`：Scribe 正常批量上限，默认 60。
- `MEMORY_SCRIBE_MIN_MESSAGES`：Scribe 最小积压，默认 1。
- `MEMORY_DAILY_MODEL_CALL_LIMIT`：所有角色的每日调用兜底上限。
- `MEMORY_SCRIBE_DAILY_CALL_LIMIT`：Scribe 独立上限。
- `MEMORY_MAINTENANCE_DAILY_CALL_LIMIT`：客观维护 Agent 独立上限。
- `ALLOW_MEMORY_CODEX_CLI=1`：显式允许 Codex CLI 运行期适配器。
- `MEMORY_CODEX_ISOLATED_CWD`：Codex CLI 的隔离只读工作目录；启用适配器时必需。
- `MEMORY_CODEX_EXECUTABLE`：可选 Codex 可执行文件名，默认 `codex`。
- `MEMORY_LLM_NAME`：保存到 `api_configs` 的本地连接名。
- `HTTPS_PROXY / HTTP_PROXY / NO_PROXY`：可选出站代理设置。

模型调用预算默认是 0。未显式设置正整数时，Scribe 或维护 Agent 的 live 调用会以 `memory_model_calls_disabled` 失败，不会偷偷使用额度。项目不提供固定价格或额度估计。

填好后运行：

```bash
DB_PATH=./memory_constellations.db npm run setup:llm
```

API key 会加密保存。不要在 Issue、日志、截图或提交中公开 `.env`、key、Cookie 或登录目录。

## `memory_config.json`

从 `memory_config.example.json` 复制。`user`、`ai`、`relationship`、`project` 和 `ui` 是每个部署自己的角色配置；公共仓库只提供占位例子。

`pipeline`：

- `mode=legacy`：启用旧 Archivist/Scribe 调度。
- `mode=modern`：启用原子观察和受控维护 runner，并停止旧语义写入旁路。
- `chat_read_mode` 与 `semantic_maintenance` 只是配置文件中的部署说明；权威值在数据库 `user_settings`，通过仓库命令切换。
- `persona_writer` 描述部署方的人格写作者集成意图；公共仓库不会因填了模型名就自动授予 Judgment 写权限。

安装不会自动切到 modern、running 或 verified。维护链使用：

```bash
DB_PATH=./memory_constellations.db npm run memory:maintenance:status
DB_PATH=./memory_constellations.db npm run memory:maintenance:start
DB_PATH=./memory_constellations.db npm run memory:maintenance:pause
```

聊天读侧使用：

```bash
DB_PATH=./memory_constellations.db npm run memory:release:status
DB_PATH=./memory_constellations.db npm run memory:release:prepare
DB_PATH=./memory_constellations.db npm run memory:release:activate
DB_PATH=./memory_constellations.db npm run memory:release:rollback
```

统一健康与确定性修复：

```bash
DB_PATH=./memory_constellations.db npm run memory:health:check
DB_PATH=./memory_constellations.db npm run memory:health:verify
DB_PATH=./memory_constellations.db npm run memory:health:repair
DB_PATH=./memory_constellations.db npm run memory:health:repair -- --execute
```

`check` 不访问远端；`verify` 还检查 verified 专用向量 collection。修复默认 dry-run，执行模式只从正式发布物重建派生索引，不调用模型。requested=verified 但 release 不再 ready 时，读取会 blocked；不会自动降级到 legacy，必须显式 rollback。

## 模型与适配器合同

Scribe 必须输出原子观察、合法主体、闭集 domain/时间状态和逐字引文。结构化维护者必须实现 `propose({ job, input })` 并返回 allowlist action。人格写作者必须独占非空第一人称 Judgment。聊天主模型只消费发布后的聊天包。

`input` 是宿主从正式表生成的最小只读快照，不包含任意 SQL 能力。无论模型或 IDE 如何替换，都不能绕过证据指纹、revision/CAS、租约、预算、producer role 和唯一写入者校验。

## 可插拔角色上下文

`services/worldContext.js` 暴露 `setWorldContextProvider(fn)`。集成方可以按用途返回公共或私有角色上下文，但私人 persona 应保留在部署环境，不进入仓库、fixture 或错误日志。未设置 provider 时使用中性的 user/assistant 边界说明。

## HTTP 边界

星图 UI 与服务端共同使用 `shared/memoryRoutes.js`。新增 `/api/memory` UI 端点时要同步更新该合同。

`/api/messages`、`/api/recall`、`/api/memory/corrections` 是 loopback/受信集成接口，不自带面向公网的 API token 方案。公网部署必须在外层补 TLS、鉴权、速率和请求大小限制。
