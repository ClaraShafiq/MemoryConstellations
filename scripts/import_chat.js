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
// 支持两种格式：
// 1. JSONL（每行一个 JSON 对象，字段名兼容多种习惯）：
//      {"role":"user","content":"今天好累","timestamp":"2026-08-15 14:30:00"}
//      {"role":"assistant","content":"辛苦了","timestamp":"2026-08-15 14:31:00"}
//      （也支持 sender 字段，以及 time/date 等时间字段别名）
// 2. TXT（每行「名字: 内容」，可带时间戳前缀）：
//      [2026-08-15 14:30:00] 小夜: 今天好累
//      小夜: 今天好累
//      （没有时间戳的行按当前时间递增写入）
//
// 导入后，后台 agent loop（2 分钟一次 tick）会自动触发 Scribe 扫描这批消息、
// 提取记忆碎片，无需手动操作。

const fs = require('fs');
const path = require('path');
const { initDatabase, getDb } = require('../database');
const { USER, AI } = require('../services/nameResolver');

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

// ── 归一化 sender → DB 值（'user' / 'draco'）──
function mapSender(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'user' || s === 'human' || s === 'me') return 'user';
    if (s === 'assistant' || s === 'ai' || s === 'draco' || s === 'bot' || s === 'system') return 'draco';
    // 匹配配置里的名字
    if (s && (s === String(USER.name).toLowerCase() || s === String(USER.name))) return 'user';
    if (s && (s === String(AI.name).toLowerCase() || s === String(AI.name))) return 'draco';
    // 未知名字默认归用户——导入自己的聊天时，用户消息占多数；
    // AI 消息通常会用 assistant/ai/draco 等关键词或 AI.name，已被上面拦截。
    return 'user';
}

// ── 归一化时间戳 → 'YYYY-MM-DD HH:MM:SS' ──
function normalizeTime(ts) {
    if (!ts) return null;
    let d = null;
    const s = String(ts).trim();
    if (/^\d+$/.test(s)) {
        // unix 秒或毫秒
        const n = parseInt(s, 10);
        d = new Date(n > 1e12 ? n : n * 1000);
    } else {
        d = new Date(s.replace(' ', 'T'));
    }
    if (!d || isNaN(d.getTime())) return null;
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── 从 content 提取纯文本 ──
// 兼容：字符串 或 OpenAI 式 [{type:"text",text:"..."}] 数组
// 跳过 type:"think"（AI 内心推理）、剥掉 <system_reminder> 系统注入
function extractText(content) {
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
        const parts = [];
        for (const item of content) {
            if (typeof item === 'string') { parts.push(item); continue; }
            if (item && typeof item === 'object' && item.type === 'text' && item.text) {
                parts.push(item.text);
            }
            // 跳过 think / 其它类型
        }
        return parts.join('\n')
            .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, '')
            .trim();
    }
    return '';
}

// 把一个消息对象转成 {sender, content, timestamp}
function msgFromObject(o) {
    if (!o || typeof o !== 'object') return null;
    const content = extractText(o.content ?? o.text ?? o.message ?? o.msg ?? '');
    if (!content) return null;
    const sender = mapSender(o.sender ?? o.role ?? o.name ?? o.from);
    const ts = o.timestamp ?? o.time ?? o.date ?? o.created_at ?? o.ts ?? null;
    return { sender, content, timestamp: normalizeTime(ts) };
}

// ── 解析整文件 JSON 数组 [{role, content}, ...] ──
function parseJsonArray(text) {
    try {
        const arr = JSON.parse(text);
        if (!Array.isArray(arr)) return [];
        const msgs = [];
        for (const o of arr) {
            const m = msgFromObject(o);
            if (m) msgs.push(m);
        }
        return msgs;
    } catch (e) {
        return [];
    }
}

// ── 解析 JSONL（每行一个 JSON 对象）──
function parseJsonl(text) {
    const msgs = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
            const m = msgFromObject(JSON.parse(t));
            if (m) msgs.push(m);
        } catch (e) {
            console.warn(`[跳过] 非 JSON 行: ${t.slice(0, 60)}`);
        }
    }
    return msgs;
}

// ── 解析 TXT ──
function parseTxt(text) {
    const msgs = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        // 时间戳前缀： [2026-08-15 14:30:00] 名字: 内容  或  2026-08-15 14:30:00 名字: 内容
        let ts = null;
        let rest = t;
        let m = t.match(/^\[([^\]]+)\]\s*(.*)$/);
        if (m) { ts = normalizeTime(m[1]); rest = m[2]; }
        else {
            m = t.match(/^(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?)\s+(.*)$/);
            if (m) { ts = normalizeTime(m[1]); rest = m[2]; }
        }
        // 名字: 内容
        const ci = rest.indexOf('：') >= 0 ? rest.indexOf('：') : rest.indexOf(':');
        if (ci <= 0) {
            // 没有冒号，无法判断说话人，整行当作 user 消息
            msgs.push({ sender: 'user', content: rest, timestamp: ts });
            continue;
        }
        const name = rest.slice(0, ci).trim();
        const content = rest.slice(ci + 1).trim();
        if (!content) continue;
        msgs.push({ sender: mapSender(name), content, timestamp: ts });
    }
    return msgs;
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
    const db = getDb();

    const raw = fs.readFileSync(args.file, 'utf8');
    const ext = path.extname(args.file).toLowerCase();

    // 依次尝试：整文件 JSON 数组 → JSONL（每行一个 JSON）→ TXT（名字: 内容）
    let msgs = [];
    if (ext === '.txt') {
        msgs = parseTxt(raw);
    } else {
        msgs = parseJsonArray(raw);
        if (msgs.length === 0) msgs = parseJsonl(raw);
    }
    if (msgs.length === 0) msgs = parseTxt(raw);
    if (msgs.length === 0) {
        console.error('❌ 没有解析出任何消息。请检查格式（JSON 数组 / JSONL 每行一个 JSON / TXT 每行「名字: 内容」）。');
        process.exit(1);
    }

    // 补全缺省时间戳：从最后一条往前推，无时间的用当前时间递减
    let cursor = Date.now();
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (!msgs[i].timestamp) {
            msgs[i].timestamp = normalizeTime(cursor);
            cursor -= 1000;
        } else {
            cursor = new Date(msgs[i].timestamp.replace(' ', 'T')).getTime() - 1000;
        }
    }

    console.log(`\n📥 解析到 ${msgs.length} 条消息`);
    console.log(`   用户消息: ${msgs.filter(m => m.sender === 'user').length} 条`);
    console.log(`   伴侣消息: ${msgs.filter(m => m.sender === 'draco').length} 条`);
    console.log('   预览：');
    for (const m of msgs.slice(0, 5)) {
        console.log(`     [${m.timestamp}] ${m.sender === 'user' ? USER.name : AI.name}: ${m.content.slice(0, 40)}`);
    }

    if (args.dryRun) {
        console.log('\n(dry-run 模式，未写入)');
        process.exit(0);
    }

    // 确定 chat_id
    let chatId = args.chatId;
    if (!chatId) {
        const name = args.name || `导入 ${path.basename(args.file)} ${new Date().toISOString().slice(0, 10)}`;
        const info = db.prepare('INSERT INTO chats (name) VALUES (?)').run(name);
        chatId = info.lastInsertRowid;
        console.log(`\n📝 新建会话 #${chatId}「${name}」`);
    }

    // 写入 messages（明文 is_encrypted=0，Scribe 直接读取）
    const insert = db.prepare(`
        INSERT INTO messages (chat_id, sender, content, timestamp, is_encrypted, message_type, status)
        VALUES (?, ?, ?, ?, 0, 'text', 'sent')
    `);
    const tx = db.transaction((batch) => {
        for (const m of batch) insert.run(chatId, m.sender, m.content, m.timestamp);
    });
    tx(msgs);

    console.log(`✅ 已写入 ${msgs.length} 条消息到 chat #${chatId}`);
    console.log(`\n下一步：后台 agent loop 会在下个 tick（约 2 分钟内）自动运行 Scribe 提取记忆碎片。`);
    console.log(`也可以手动触发：node -e "require('./services/scribe');"（或等 agent loop）`);
    process.exit(0);
}

main().catch(e => { console.error('❌ 导入失败:', e); process.exit(1); });
