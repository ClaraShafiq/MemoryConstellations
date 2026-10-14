# 配置说明

## `.env`

必需：

- `SANCTUARY_ENCRYPTION_KEY`：64 位十六进制 AES-256-GCM 密钥。
- `SESSION_SECRET`：Web session 随机密钥。
- `LOGIN_PASSWORD`：本地 UI 登录密码。
- 一组完整的记忆管线模型连接：
  - `MEMORY_LLM_PROVIDER`：请求协议，只接受 `gemini` 或 `openai_compatible`。
  - `MEMORY_LLM_ENDPOINT`：所选渠道提供的完整 API endpoint。
  - `MEMORY_LLM_MODEL`：该渠道实际提供的模型标识。
  - `MEMORY_LLM_API_KEY`：该渠道的密钥。

可选：

- `DB_PATH`：SQLite 路径；默认 `sanctuary.db`。
- `PORT`：HTTP 端口；默认 3000。
- `TZ`：部署使用的 IANA 时区（例如 `Europe/Paris`）；未设置时使用系统时区，无法识别时回退到 `UTC`。服务端定时任务、后端时间格式化和星图页面均从这一处读取。
- `MEMORY_SCRIBE_BATCH_SIZE`：现代 Scribe 每批消息上限；默认 60。
- `MEMORY_SCRIBE_MIN_MESSAGES`：现代 Scribe 最小积压；默认 1。
- 现代 Scribe 连续失败的 60→30→15 缩批与一小时冷却是安全合同，不由部署配置关闭；受控人工重试可显式传 `forceRetry`。
- `ALLOW_MEMORY_CODEX_CLI=1`：显式允许启动 Codex CLI 运行期适配器；仍必须由调用方提供隔离工作目录。
- `MEMORY_LLM_NAME`：写入 `api_configs` 的本地名称；默认 `memory-pipeline`。
- `HTTPS_PROXY` / `HTTP_PROXY`：可选出站代理；没有设置时直连。`NO_PROXY` 可列出不走代理的主机。

不要把 `.env`、登录状态或密钥写入 `memory_config.json`。

填写 `.env` 后运行：

```bash
DB_PATH=./memory_constellations.db npm run setup:llm
```

该命令只把一条默认连接写入指定数据库，API key 会先加密。也可不写环境变量，直接运行命令后交互输入。不要在 Issue、日志或命令截图中公开 key。

## 运行期合同

星图 UI 与服务端共同使用 `shared/memoryRoutes.js` 中的路由合同。增加或修改由星图调用的 `/api/memory` 端点时，同时更新该合同，不要在前端重新手写路径。

## `memory_config.json`

从 `memory_config.example.json` 复制。`user`、`ai`、`relationship`、`project` 和 `ui` 只描述当前部署的通用角色配置。

`pipeline`：

- `mode=legacy`：运行现有 Archivist/Scribe。
- `mode=modern`：运行原子观察 Scribe 与受控 pipeline scheduler。
- `chat_read_mode` 是部署说明值；权威运行开关存放在数据库 `user_settings.memory_chat_read_mode`。
- `semantic_maintenance` 是部署说明值；权威运行开关存放在 `user_settings.memory_semantic_maintenance_mode`。
- `persona_writer.enabled=false`：默认不生成非空 Judgment。

安装不会自动把数据库设置切到 verified/running。这样迁移表和测试不会误触发消费者切换。

`running` 只开启正式维护 runner；该 runner 默认只消费实时车道。`verified` 独立控制聊天读侧。历史回补必须显式选择 backfill 车道，不能通过启动在线 runner 顺带消费。

## 模型配置原则

模型名、价格、额度和 API 行为可能变化，本仓库不写死推荐，也不会按维护者数据库中的私有 ID 选择模型。legacy Scribe/Archivist 使用 `api_configs.is_default=1` 的连接；modern 适配器可以另行配置，但必须维持相同安全合同。

Scribe 模型必须遵守原子观察和精确引文合同；结构化审查模型/维护 Agent 必须能稳定返回闭集 JSON action；人格写作者必须与所需 companion persona 显式绑定并独占非空第一人称 Judgment；聊天主模型由集成方选择。所有实现都必须遵守证据、版本、租约、闭集和唯一写入者合同。
