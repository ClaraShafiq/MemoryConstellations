#!/bin/bash
# ═══════════════════════════════════════════════════════
# Memory Constellations — 首次部署脚本
# 用法: bash scripts/setup.sh
# ═══════════════════════════════════════════════════════
set -e

echo "🌟 Memory Constellations — 部署脚本"
echo ""

# 1. Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 需要 Node.js v18+  — https://nodejs.org"
    exit 1
fi
NODE_V=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_V" -lt 18 ]; then
    echo "❌ 需要 Node.js v18+, 当前: $(node -v)"
    exit 1
fi
echo "✅ Node.js $(node -v)"

# 2. Copy config templates
for tmpl in .env memory_config.json core-prompt.txt; do
    example="${tmpl}.example"
    if [ "${tmpl}" = "memory_config.json" ]; then example="memory_config.example.json"; fi
    if [ "${tmpl}" = "core-prompt.txt" ]; then example="core-prompt.example.txt"; fi
    if [ ! -f "$tmpl" ]; then
        if [ -f "$example" ]; then
            echo "📋 从 $example 创建 $tmpl ..."
            cp "$example" "$tmpl"
        fi
    fi
done

if [ ! -f .env ] || ! grep -q 'SANCTUARY_ENCRYPTION_KEY=.' .env 2>/dev/null; then
    echo "⚠️  请编辑 .env 填入必填项（SANCTUARY_ENCRYPTION_KEY, SESSION_SECRET, LOGIN_PASSWORD, API_KEY）后重新运行。"
    exit 0
fi

# 3. Install dependencies
echo ""
echo "📦 安装依赖..."
npm install

# 4. Check Python (for ChromaDB embedding)
echo ""
if command -v python3 &> /dev/null; then
    echo "✅ Python3 $(python3 --version)"
else
    echo "⚠️  Python3 未安装。向量检索功能需要 Python3 + ChromaDB。"
    echo "   安装: sudo apt install python3 python3-pip  (或 brew install python3)"
fi

# 5. Install ChromaDB
echo ""
echo "📦 安装 ChromaDB..."
pip3 install chromadb 2>/dev/null || pip install chromadb 2>/dev/null || echo "⚠️  ChromaDB 安装失败，跳过。向量功能将不可用。"

# 6. Initialize database
echo ""
echo "🗄️  初始化数据库..."
node -e "
require('dotenv').config();
const { initDatabase } = require('./database');
initDatabase();
console.log('✅ 数据库初始化完成');
process.exit(0);
"

# 7. Download embedding model (first run will auto-download)
echo ""
echo "🧠 预热 embedding 模型（首次运行会下载 Jina embeddings）..."
node -e "
require('dotenv').config();
const { initDatabase } = require('./database');
const { initSettings } = require('./routes/settings');
initDatabase(); initSettings();
const { getEmbedding } = require('./services/llm');
getEmbedding('hello world').then(() => {
    console.log('✅ Embedding 模型就绪');
    process.exit(0);
}).catch(e => {
    console.log('⚠️  Embedding 预热失败:', e.message, '(首次聊天时会自动重试)');
    process.exit(0);
});
" 2>/dev/null || echo "⚠️  Embedding 预热跳过"

echo ""
echo "══════════════════════════════════════════"
echo "✅ 部署完成！启动服务："
echo "   npm start"
echo ""
echo "   打开浏览器 http://localhost:3000"
echo "   用 .env 中 LOGIN_PASSWORD 登录。"
echo ""
echo "   然后打开 http://localhost:3000/memory.html"
echo "   看看你的记忆星空。"
echo "══════════════════════════════════════════"
