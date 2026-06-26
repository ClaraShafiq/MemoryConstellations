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
cd Project_Sanctuary
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
- 至少一个 LLM API key：`MIMO_API_KEY`（DeepSeek 代理）、`OPENROUTER_API_KEY`、或 `GEMINI_API_KEY`

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

### 2.6 启动

```bash
npm start
# 或
pm2 start ecosystem.config.js
```

打开 `http://localhost:3000/memory.html` 看星图。

---

## 3. 观察系统是否正常运行

### 3.1 聊天 → Scribe → 碎片

和 AI 聊天 20 分钟以上 → 检查日志：
```
[Scribe] 提取完成: X条碎片
```

或检查数据库：
```bash
sqlite3 sanctuary.db "SELECT COUNT(*) FROM memory_fragments WHERE status='active';"
```

### 3.2 碎片 → 星座

等 Clara（你）空闲 1 小时后，Archivist Deep Cycle 会运行。或者手动触发：
```bash
node -e "
const{initDatabase}=require('./database');initDatabase();
const{classifyFragments}=require('./services/archivist');
classifyFragments({lightweight:false}).then(r=>console.log('done',r));
"
```

检查星座数量：
```bash
sqlite3 sanctuary.db "SELECT COUNT(*) FROM entity_profiles WHERE status='active';"
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
- 看 PM2 日志：`pm2 logs sanctuary --lines 50`
- Scribe 触发条件是：沉默 ≥ 20min + 积压 ≥ 60 条消息，或积压 ≥ 100 条

### Q: 星座不增长
- 需要至少 3 条碎片链接到同一个实体才能毕业成星座
- Deep Cycle 只在空闲 1 小时后触发（正常行为——不在聊天时抢 LLM 资源）

### Q: ChromaDB 内存太大
- ChromaDB 默认会加载所有 embedding 到内存
- 可以定期重启 ChromaDB：`pm2 restart chroma-service`
- `scripts/setup.sh` 会自动安装 ChromaDB

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
