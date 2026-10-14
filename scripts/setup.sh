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

missing_config=""
for config_name in SANCTUARY_ENCRYPTION_KEY SESSION_SECRET LOGIN_PASSWORD MEMORY_LLM_PROVIDER MEMORY_LLM_ENDPOINT MEMORY_LLM_MODEL MEMORY_LLM_API_KEY; do
    if [ ! -f .env ] || ! grep -q "^${config_name}=." .env 2>/dev/null; then
        missing_config="${missing_config} ${config_name}"
    fi
done
if [ -n "$missing_config" ]; then
    echo "⚠️  请编辑 .env 填入以下必填项后重新运行：${missing_config}"
    exit 0
fi

# 3. Install dependencies
echo ""
echo "📦 安装依赖..."
npm install

# 4. Check optional Python runtime
echo ""
if command -v python3 &> /dev/null; then
    echo "✅ Python3 $(python3 --version)"
else
    echo "ℹ️  Python3 未安装；只有启用 legacy 本地向量路径时才需要。"
fi

# 5. Initialize database
echo ""
echo "🗄️  初始化数据库..."
node -e "
require('dotenv').config();
const { initDatabase } = require('./database');
initDatabase();
console.log('✅ 数据库初始化完成');
process.exit(0);
"

# 6. Save the explicitly configured default model connection
echo ""
echo "🔌 保存记忆管线模型连接..."
node scripts/setup_llm.js

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
