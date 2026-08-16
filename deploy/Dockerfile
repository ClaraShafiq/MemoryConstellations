# Memory Constellations 记忆库 — Docker 镜像
FROM node:20-bookworm

WORKDIR /app

# 先装依赖（利用 Docker 层缓存）
COPY package.json ./
RUN npm install

# 复制源码
COPY . .

EXPOSE 3000

# 启动前初始化数据库，再起服务（首次运行自动从 example 生成 core-prompt.txt）
CMD ["sh", "-c", "cp -n core-prompt.example.txt core-prompt.txt 2>/dev/null; cp -n memory_config.example.json memory_config.json 2>/dev/null; node -e \"require('./database').initDatabase()\" && node index.js"]
