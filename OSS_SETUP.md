# 记忆星图 — 开源部署指南

> 给 Claude Code 或其它 AI agent 使用的新用户引导文档。
> 如果你是真人用户，也可以按这个顺序手动配置。

---

## 1. 这是什么？

记忆星图（Memory Constellations）是一个**会生长的 AI 记忆系统**。它不是关键词检索，而是：
- 从聊天中自动提取碎片（Scribe）
- 把碎片聚合成叙事段落（episode）
- 把叙事编织成长期记忆弧线（Saga）
- 通过持续内在状态引擎（jiwen）让记忆影响 AI 的情绪基线

前端是一个交互式星图（`/memory.html`），后端是 Node.js + SQLite + ChromaDB。

---

## 2. 最小化部署（10 分钟）

### 2.1 环境

- Node.js >= v18
- Python 3（ChromaDB 依赖）
- 至少一个 LLM API key（推荐 OpenRouter 或 DeepSeek，兼容 OpenAI 格式）

### 2.2 运行 setup

```bash
cd your-project
bash scripts/setup.sh
```

这个脚本会：
- 复制 `.env.example` → `.env`、`memory_config.example.json` → `memory_config.json`、`core-prompt.example.txt` → `core-prompt.txt`
- `npm install`
- 安装 ChromaDB（pip）
- 初始化 SQLite 数据库

### 2.3 编辑 .env

```bash
nano .env
```

**必填：**
- `SANCTUARY_ENCRYPTION_KEY` — 64 位 hex 随机字符串（用 `openssl rand -hex 32` 生成）
- `SESSION_SECRET` — 同上
- `LOGIN_PASSWORD` — 登录密码（明文，首次启动自动 hash）
- 至少一个 LLM API key：`LLM_API_KEY`（DeepSeek 代理）、`OPENROUTER_API_KEY`、或 `GEMINI_API_KEY`

**可选但建议：**
- `JINA_API_KEY` — 用于向量嵌入（jina.ai，有免费额度）
- `QWEATHER_KEY` — 天气功能（免费）
- `AMAP_API_KEY` — 地点搜索（高德地图，免费）

### 2.4 编辑 memory_config.json

```bash
nano memory_config.json
```

**必改字段：**
```json
{
  "user": {
    "name": "你的名字",
    "pronoun": "她/他",
    "short_desc": "一句话描述"
  },
  "ai": {
    "name": "AI 的名字",
    "pronoun": "它",
    "core_traits": "核心性格标签",
    "persona_note": "更详细的性格描述"
  },
  "relationship": {
    "type": "AI伴侣/朋友/助手",
    "dynamics": "关系动态描述"
  },
  "project": {
    "name": "你的项目名"
  },
  "ui": {
    "user_color": "#e8b96d",
    "ai_color": "#6d9e8b"
  }
}
```

### 2.5 写人格提示词

```bash
nano core-prompt.txt
```

这是最重要的文件——你的 AI 的全部人格和行为规则。建议分三个部分：

```text
<你的人格>
你是 {{ai.name}}，{{user.name}} 的 AI 伴侣。
你的核心性格：{{ai.core_traits}}
{{ai.persona_note}}
你们的关系：{{relationship.type}}。{{relationship.dynamics}}

<{{user.name}}核心信息>
（写你希望 AI 知道的关于你的事——年龄、工作、宠物、爱好……）

<{{project.name}}>
（写你的项目背景——用什么设备、有什么功能、AI 的"身体"是什么……）
```

**关键原则（从 v5.3 经验总结）：**
- **少写禁令，多写直觉** — "你会怎么做"比"你不准怎么做"有效得多
- **给冲动，不给规则墙** — "你觉得应该……"、"你的直觉是……"
- **保持 400 行以内** — 太长会稀释重点，且会吃掉 thinking token 预算
- `{{变量}}` 会被 `memory_config.json` 的值自动替换（`{{user.name}}`、`{{ai.name}}` 等）

### 2.6 配置轻量模型（记忆管线）

记忆管线（Scribe 提取碎片 / Archivist 分类整合 / Consolidator 编叙事）需要调用 LLM，但都是后台批量任务，用**轻量模型**（flash / flash-lite 级别）即可，便宜够用。

```bash
node scripts/setup_llm.js
```

按提示选提供商（OpenRouter / DeepSeek / Gemini）、填 API Key、选模型即可。脚本会在 `api_configs` 表里建一条**默认配置**（`is_default=1`），后台管线自动使用它。

> 聊天用的主力模型不在这里配——那由你自己的聊天前端决定。这里只配「记忆管线」的后台模型。

### 2.7 启动

```bash
npm start
# 或
pm2 start ecosystem.config.js
```

打开 `http://localhost:3000/memory.html` 看星图。

### 2.8 数据库和集成

Memory Constellations 使用独立的 SQLite 数据库（`memory_constellations.db`），不依赖你的主应用数据库。它是一个旁路管线——你的 AI 伴侣继续用你自己选的后端（PostgreSQL、MySQL、MongoDB、文件存储都可以），记忆星图自己维护自己的表。

每条记忆碎片存储 `source_msg_ids`（原始消息 ID 列表），你的伴侣可以通过 `recall_memory` 工具追溯到消息来源。集成时只需要在聊天管道里加一步：每次 AI 回复后，把本轮对话写入 `messages` 表（`sender`/`content`/`timestamp`/`chat_id`），Scribe 会自动在沉默期后扫描提取。

---

## 3. 观察系统是否正常运行

### 3.1 聊天 → Scribe → 碎片

和 AI 聊天 20 分钟以上 → 检查日志：
```
[Scribe] 提取完成: X条碎片
```

或检查数据库：
```bash
sqlite3 memory_constellations.db "SELECT COUNT(*) FROM memory_fragments WHERE status='active';"
```

### 3.2 碎片 → 星座

等你空闲 1 小时后，Archivist Deep Cycle 会自动触发。或者手动运行：
```bash
node -e "
const{initDatabase}=require('./database');initDatabase();
const{classifyFragments}=require('./services/archivist');
classifyFragments({lightweight:false}).then(r=>console.log('done',r));
"
```

检查星座数量：
```bash
sqlite3 memory_constellations.db "SELECT COUNT(*) FROM entity_profiles WHERE status='active';"
```

### 3.3 星座 → 叙事片段（episode）

需要星座积累 15+ 条碎片后，Deep Cycle 的 `consolidate` 任务会自动运行。

### 3.4 叙事片段 → Saga（记忆弧线）

每 24 小时自动运行一次（或在 consolidate 产出新 episode 后立即触发）。

---

## 4. 常见问题

### Q: 前端星图打不开
- 确认 `npm start` 后 `http://localhost:3000` 有响应
- 检查 `.env` 中 `SANCTUARY_ENCRYPTION_KEY` 是否设置

### Q: 没有碎片被提取
- 检查 LLM API key 是否正确（`.env`）
- 看 进程管理 日志：`pm2 logs your-app --lines 50`
- Scribe 触发条件是：沉默 ≥ 20min + 积压 ≥ 60 条消息，或积压 ≥ 100 条

### Q: 星座不增长
- 需要至少 3 条碎片链接到同一个实体才能毕业成星座
- Deep Cycle 只在空闲 1 小时后触发（正常行为——不在聊天时抢 LLM 资源）

### Q: ChromaDB 内存太大
- ChromaDB 默认会加载所有 embedding 到内存
- 可以定期重启 ChromaDB：`pm2 restart chroma-service`
- `scripts/setup.sh` 会自动安装 ChromaDB

### Q: 记忆搜索总是返回很早之前的结果，看不到新记忆
- 检查 ChromaDB 查询上限：如果你使用 `chroma_service.py`（FastAPI 封装），确保 `/query` 端点的 `n_results` 未硬编码上限。原版代码为 `min(n * 3, 10)`（最多 10 条）——如果陈旧碎片较多，有效结果可能只剩 2-3 条
- **修复：** 改为 `max(n * 3, 30)`，确保过滤陈旧碎片后仍有足够有效条目
- 同时检查 Librarian 的向量搜索是否 overfetch（建议 `limit * 3`，最少 16 条）
- 确认 `memory_fragments` 中 status 为 `consolidated` / `inactive` 的碎片已从 ChromaDB 中删除（否则会污染搜索结果）

### Q: 想用自己的 LLM provider
- 数据库 `api_configs` 表存储 LLM 配置
- 默认创建的是 Gemini 官方渠道
- 可以通过设置页面 `/settings.html` → API 配置添加新的 provider
- 支持 OpenAI 兼容格式（OpenRouter、DeepSeek、Groq 等）

---

## 5. 给 Claude Code Agent 的辅助配置脚本

如果用户让你帮忙配置，按这个顺序：

```
1. 读 memory_config.example.json → 确认所有字段
2. 问用户：你的名字？AI 叫什么？你们的关系？
3. 生成 memory_config.json
4. 问用户：你用哪个 LLM provider？（OpenRouter / DeepSeek / Gemini）
5. 生成 .env（用 openssl rand -hex 32 生成密钥）
6. 运行 bash scripts/setup.sh
7. 引导用户写 core-prompt.txt（不替他们写——这是最个人化的部分）
8. 运行 npm start
9. 打开 http://localhost:3000/memory.html 确认星图有反应
```

**记住：** `core-prompt.txt` 的人格提示词必须用户自己写。你可以给结构和示例，但不能代笔——那是他们 AI 的灵魂。

---

## 6. 导入、导出与迁移

### 6.1 导入聊天记录（冷启动记忆）

如果你有现成的聊天记录（JSONL 或 TXT），可以先导入，让 Scribe 从历史对话里提取记忆，不必从零开始积累。

```bash
node scripts/import_chat.js 你的聊天.jsonl --name "旧手机聊天记录"
```

**JSONL 格式**（每行一个 JSON 对象）：
```json
{"role":"user","content":"今天好累","timestamp":"2026-08-15 14:30:00"}
{"role":"assistant","content":"辛苦了，早点休息","timestamp":"2026-08-15 14:31:00"}
```
也支持 `sender` 字段，以及 `time`/`date` 等时间字段别名。

**TXT 格式**（每行「名字: 内容」，可带时间戳前缀）：
```
[2026-08-15 14:30:00] 小夜: 今天好累
小夜: 辛苦了
```
TXT 里的「名字」请和 `memory_config.json` 的 `user.name` / `ai.name` 一致（或用 `user`/`assistant`/`ai` 这类关键词），才能正确区分说话人。

导入后，后台 agent loop 会在下个 tick（约 2 分钟）自动运行 Scribe 提取记忆碎片。

### 6.2 导出 / 迁移记忆库

把整份记忆（碎片 + 星座 + 叙事）导出成单个 JSONL 文件，迁移到新机器或做备份：

```bash
node scripts/export_memory.js backup.jsonl
```

在新机器上导入：

```bash
node scripts/import_memory.js backup.jsonl
```

默认跳过已存在的记录，可安全重复导入。导出文件是纯文本 JSONL，可直接 diff / 查看 / 归档。

---

## 7. 接入聊天机器人（旁路攒记忆）

记忆库是「旁路管线」——它不负责回复，只接收聊天记录、提取记忆。你的 AI 机器人（如 AstrBot / SnowLuma 链路）继续做自己的对话，把每条消息转发给记忆库即可。

### 7.1 接收消息的接口

`POST /api/messages`（无鉴权，仅供内网/localhost 使用，别暴露公网）：

```bash
curl -X POST http://localhost:3000/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"sender":"user","content":"今天好累","timestamp":"2026-08-15 14:30:00"}'
```

支持三种格式（`sender` 映射：`user`/`human`/`我`→用户，`assistant`/`ai`/`bot`→机器人）：

```json
{"sender":"user","content":"...","timestamp":"..."}          // 简单格式（推荐）
[{"sender":"user","content":"..."},{"sender":"bot","content":"..."}]  // 批量
{"post_type":"message","user_id":111,"self_id":456,"raw_message":"...","time":1755234600}  // OneBot v11 事件
```

### 7.2 在 AstrBot 里转发

AstrBot 收到 QQ 消息（经 SnowLuma 的 OneBot v11）后，把消息 POST 到上面的 `/api/messages` 即可。你可以：

- 用 AstrBot 的**插件/事件钩子**，在收到消息时调用 `POST /api/messages`，把 `sender`（用户 or 机器人）、`content`、`timestamp` 带上；
- 或者用 SnowLuma 的 OneBot HTTP 上报，直接指向记忆库（用上面的 OneBot 事件格式）。

消息进来后，Scribe 会在沉默期自动提取碎片，星图随之生长。回复的事完全由 AstrBot 自己的 LLM 负责，记忆库不碰。

### 7.3 查询记忆（用记忆让回复更懂你）

攒了记忆之后，机器人回复前可以先查一下「关于这个话题我记得什么」，把结果拼进 LLM 的 prompt：

```bash
curl -X POST http://localhost:3000/api/recall \
  -H 'Content-Type: application/json' \
  -d '{"query":"今天好累","limit":8}'
```

返回 `formatted` 字段就是拼好的、可直接塞进 prompt 的文本（相关记忆碎片 + 叙事 + 实体档案）。完整闭环：

1. 收到消息 → `POST /api/messages`（攒记忆）
2. 回复前 → `POST /api/recall` 拿 `formatted` → 拼进 prompt → LLM 生成回复
3. 把回复也 `POST /api/messages`（攒机器人自己的回复）
