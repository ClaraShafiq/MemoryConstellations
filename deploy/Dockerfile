# Memory Constellations 记忆库 — Docker 镜像
FROM node:20-bookworm

WORKDIR /app

# 先装依赖（利用 Docker 层缓存）
COPY package.json package-lock.json ./
RUN npm install

# 复制源码
COPY . .

EXPOSE 3000

# 启动前初始化数据库，再起服务
CMD ["sh", "-c", "node -e \"require('./database').initDatabase()\" && node index.js"]
