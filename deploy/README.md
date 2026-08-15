# 部署到 AstrBot + SnowLuma 的说明

记忆库（Memory Constellations）是**独立的 Node.js 服务**，不是 AstrBot 插件。
要接入 AstrBot，需要两件事一起做：

1. **记忆库跑成一个 Docker 容器**（独立服务，监听 3000 端口）
2. **（可选）ChromaDB 跑一个容器**（向量/语义检索，监听 7707 端口）
3. **AstrBot 装一个桥接插件**（把聊天消息转发给记忆库）

---

## 第一步：把记忆库加进 docker-compose

把 `docker-compose.memory.yml` 里的 `memory-constellations` 服务，合并到你的 `docker-compose.yml` 的 `services:` 下面（和 `astrbot`、`snowluma` 平级）。

改好后：

```bash
# 生成两个随机密钥
openssl rand -hex 32   # 填到 SANCTUARY_ENCRYPTION_KEY
openssl rand -hex 32   # 填到 SESSION_SECRET

docker compose up -d --build
```

启动后记忆库在 `http://localhost:3000`，Web 星图在 `http://localhost:3000/memory.html`（登录密码是 `LOGIN_PASSWORD`）。

---

## 第二步：装 AstrBot 桥接插件

桥接插件的文件在 `deploy/astrbot-plugin/` 目录（`metadata.yaml` + `main.py` + `requirements.txt`）。

**AstrBot 的「从 GitHub 导入插件」要求 `metadata.yaml` 在仓库根目录**，所以这个插件需要放在一个**独立的 GitHub 仓库**（不能放在记忆库仓库的子目录里）。

做法（二选一）：

1. 新建一个 GitHub 仓库，把 `deploy/astrbot-plugin/` 里的三个文件上传到仓库根目录，然后在 AstrBot 里粘贴这个仓库地址导入；
2. 或者手动：把 `main.py` 复制到 AstrBot 的插件目录，`requirements.txt` 里的 `aiohttp` 用 `pip install aiohttp` 装上。

导入后，在插件的环境变量里设置（或直接改 `main.py` 顶部）：

```
MEMORY_API_BASE=http://memory-constellations:3000
```

（`memory-constellations` 是 docker-compose 里的容器名，AstrBot 容器内能通过这个名字访问它。）

---

## 完事后的效果

- AstrBot 收到的用户消息 → 自动 POST 给记忆库 → Scribe 提取记忆碎片
- AstrBot 的回复 → 也 POST 给记忆库 → 记住机器人说过的话
- 记忆库 Web 星图（`memory.html`）能看到星座生长

记忆库**不负责回复**，回复还是 AstrBot 自己的 LLM。

---

## 备注

- 记忆库的**向量检索需要 ChromaDB 服务**（`chroma_service.py`，端口 7707），已随仓库提供（`deploy/Dockerfile.chroma` + compose 里的 `chroma` 服务）。记忆库通过 `CHROMA_URL` 环境变量连 chroma 容器（compose 里已配好 `CHROMA_URL=http://chroma:7707`）。没有 ChromaDB 时记忆库仍能跑、能提取碎片，只是「向量语义检索」降级为「关键词检索」。
- `deploy/astrbot-plugin/main.py` 里的 `on_decorating_result` 是 AstrBot 的 LLM 生命周期钩子，如果 AstrBot 版本不同导致报错，删掉这个函数、只留 `on_user_message` 也能用（只是不记机器人回复）。
