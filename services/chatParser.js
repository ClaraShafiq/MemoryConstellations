// services/chatParser.js — 聊天记录解析（CLI 导入脚本 + API 接口共用）
//
// 支持三种格式：
//   1. 整文件 JSON 数组  [{role, content}, ...]
//   2. JSONL（每行一个 JSON）
//   3. TXT（每行「名字: 内容」，可带时间戳前缀）
//
// content 兼容字符串 或 OpenAI 式 [{type:"text",text:"..."}] 数组；
// 自动跳过 type:"think"（AI 内心推理）、剥掉 <system_reminder> 系统注入。

const { USER, AI } = require('./nameResolver');

// 归一化 sender → DB 值（'user' / 'ai'）
function mapSender(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'user' || s === 'human' || s === 'me') return 'user';
    if (s === 'assistant' || s === 'ai' || s === 'bot' || s === 'system') return 'ai';
    if (s && (s === String(USER.name).toLowerCase() || s === String(USER.name))) return 'user';
    if (s && (s === String(AI.name).toLowerCase() || s === String(AI.name))) return 'ai';
    return 'user';
}

// 归一化时间戳 → 'YYYY-MM-DD HH:MM:SS'
function normalizeTime(ts) {
    if (!ts) return null;
    let d = null;
    const s = String(ts).trim();
    if (/^\d+$/.test(s)) {
        const n = parseInt(s, 10);
        d = new Date(n > 1e12 ? n : n * 1000);
    } else {
        d = new Date(s.replace(' ', 'T'));
    }
    if (!d || isNaN(d.getTime())) return null;
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 从 content 提取纯文本
function extractText(content) {
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
        const parts = [];
        for (const item of content) {
            if (typeof item === 'string') { parts.push(item); continue; }
            if (item && typeof item === 'object' && item.type === 'text' && item.text) {
                parts.push(item.text);
            }
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

// 解析整文件 JSON 数组 [{role, content}, ...]
function parseJsonArray(text) {
    try {
        const arr = JSON.parse(text);
        if (!Array.isArray(arr)) return [];
        return arr.map(msgFromObject).filter(Boolean);
    } catch (e) {
        return [];
    }
}

// 解析 JSONL（每行一个 JSON 对象）
function parseJsonl(text) {
    const msgs = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
            const m = msgFromObject(JSON.parse(t));
            if (m) msgs.push(m);
        } catch (e) {
            // 跳过非 JSON 行
        }
    }
    return msgs;
}

// 解析 TXT（每行「名字: 内容」，可带时间戳前缀）
function parseTxt(text) {
    const msgs = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let ts = null;
        let rest = t;
        let m = t.match(/^\[([^\]]+)\]\s*(.*)$/);
        if (m) { ts = normalizeTime(m[1]); rest = m[2]; }
        else {
            m = t.match(/^(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?)\s+(.*)$/);
            if (m) { ts = normalizeTime(m[1]); rest = m[2]; }
        }
        const ci = rest.indexOf('：') >= 0 ? rest.indexOf('：') : rest.indexOf(':');
        if (ci <= 0) {
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

// 依次尝试：JSON 数组 → JSONL → TXT
function parseAny(text) {
    let msgs = parseJsonArray(text);
    if (msgs.length === 0) msgs = parseJsonl(text);
    if (msgs.length === 0) msgs = parseTxt(text);
    return msgs;
}

module.exports = {
    mapSender, normalizeTime, extractText, msgFromObject,
    parseJsonArray, parseJsonl, parseTxt, parseAny,
};
