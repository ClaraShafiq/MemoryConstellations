// scripts/import_chat.js — 导入聊天记录到记忆库
//
// 用法：
//   node scripts/import_chat.js <文件.jsonl|文件.txt> [选项]
//
// 选项：
//   --name "会话名"    新会话的名字（默认 "导入 <文件名> <日期>"）
//   --chat-id <N>      写入到已有的 chat（不新建）
//   --dry-run          只解析不写入，打印前几行预览
//
// 支持格式（与 services/chatParser.js 一致）：
//   JSON 数组 / JSONL（每行一个 JSON）/ TXT（每行「名字: 内容」）
//
// 导入后，后台 agent loop（2 分钟一次 tick）会自动触发 Scribe 扫描这批消息、
// 提取记忆碎片，无需手动操作。

const fs = require('fs');
const path = require('path');
const { initDatabase, getDb } = require('../database');
const { USER, AI } = require('../services/nameResolver');
const { parseAny } = require('../services/chatParser');
const { fillTimestamps, importMessages } = require('../services/chatImport');

// ── 参数解析 ──
function parseArgs(argv) {
    const args = { file: null, name: null, chatId: null, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--name' || a === '-n') args.name = argv[++i];
        else if (a === '--chat-id') args.chatId = parseInt(argv[++i], 10);
        else if (a === '--dry-run') args.dryRun = true;
        else if (!args.file) args.file = a;
    }
    return args;
}

// ── 主流程 ──
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.file) {
        console.log('用法: node scripts/import_chat.js <文件.jsonl|文件.txt> [--name "会话名"] [--chat-id N] [--dry-run]');
        process.exit(1);
    }
    if (!fs.existsSync(args.file)) {
        console.error(`❌ 文件不存在: ${args.file}`);
        process.exit(1);
    }

    initDatabase();

    const raw = fs.readFileSync(args.file, 'utf8');
    const msgs = fillTimestamps(parseAny(raw));
    if (msgs.length === 0) {
        console.error('❌ 没有解析出任何消息。请检查格式（JSON 数组 / JSONL 每行一个 JSON / TXT 每行「名字: 内容」）。');
        process.exit(1);
    }

    console.log(`\n📥 解析到 ${msgs.length} 条消息`);
    console.log(`   用户消息: ${msgs.filter(m => m.sender === 'user').length} 条`);
    console.log(`   伴侣消息: ${msgs.filter(m => m.sender === 'ai').length} 条`);
    console.log('   预览：');
    for (const m of msgs.slice(0, 5)) {
        console.log(`     [${m.timestamp}] ${m.sender === 'user' ? USER.name : AI.name}: ${m.content.slice(0, 40)}`);
    }

    if (args.dryRun) {
        console.log('\n(dry-run 模式，未写入)');
        process.exit(0);
    }

    const name = args.name || `导入 ${path.basename(args.file)} ${new Date().toISOString().slice(0, 10)}`;
    const { chatId, count } = importMessages(msgs, { chatId: args.chatId, name });

    console.log(`✅ 已写入 ${count} 条消息到 chat #${chatId}`);
    console.log(`\n下一步：后台 agent loop 会在下个 tick（约 2 分钟内）自动运行 Scribe 提取记忆碎片。`);
    process.exit(0);
}

main().catch(e => { console.error('❌ 导入失败:', e); process.exit(1); });
