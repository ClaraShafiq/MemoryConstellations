// routes/ingest.js — 聊天记录接入（旁路管线入口）
//
// 用途：接收外部聊天机器人的对话，写入 messages 表，供 Scribe 提取记忆。
// 记忆库不负责回复——回复由外部机器人（如 AstrBot）自己处理。
//
// POST /api/messages  接受三种格式：
//   1. 简单格式（推荐，AstrBot 插件转发用）：
//      { "sender": "user"|"bot", "content": "...", "timestamp": "2026-08-15 14:30:00", "chat_id": 1 }
//      或 { "role": "user"|"assistant", "content": "..." }
//   2. 数组： [ {sender, content, timestamp}, ... ]
//   3. OneBot v11 message 事件（SnowLuma 直连时用）：
//      { "post_type":"message", "message_type":"private"|"group", "user_id":123,
//        "self_id":456, "raw_message":"...", "time":1755234600, "group_id":789 }
//
// sender 判定（映射到 messages.sender 的 'user'/'ai'）：
//   'user'/'human'/'我' → 'user'
//   'assistant'/'ai'/'bot'/'它' → 'ai'
//   OneBot：user_id === self_id → ai（机器人自己），否则 user
//
// ⚠️ 本接口无鉴权，仅供内网/localhost 使用，不要暴露到公网。

const express = require('express');
const { getDb } = require('../database');
const router = express.Router();

// 归一化时间戳 → 'YYYY-MM-DD HH:MM:SS'
function normalizeTime(ts) {
    if (!ts) return null;
    let d = null;
    const s = String(ts).trim();
    if (/^\d+$/.test(s)) {
        const n = parseInt(s, 10);
        d = new Date(n > 1e12 ? n : n * 1000); // 秒或毫秒
    } else {
        d = new Date(s.replace(' ', 'T'));
    }
    if (!d || isNaN(d.getTime())) return null;
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 简单格式的 sender → 'user'/'ai'
function mapSender(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'user' || s === 'human' || s === '我' || s === 'me') return 'user';
    return 'ai'; // assistant/ai/bot/draco/它 及其它默认当 AI
}

// 把一条消息（简单格式 或 OneBot 事件）规整成 {sender, content, timestamp}
function normalizeMessage(obj) {
    if (!obj || typeof obj !== 'object') return null;

    // OneBot v11 事件
    if (obj.post_type === 'message') {
        const content = obj.raw_message || obj.message || '';
        if (!content) return null;
        const sender = String(obj.user_id) === String(obj.self_id) ? 'ai' : 'user';
        return { sender, content: String(content), timestamp: normalizeTime(obj.time) };
    }

    // 简单格式
    const content = obj.content ?? obj.text ?? obj.message ?? '';
    if (!content) return null;
    const sender = mapSender(obj.sender ?? obj.role);
    return { sender, content: String(content), timestamp: normalizeTime(obj.timestamp ?? obj.time) };
}

router.post('/messages', (req, res) => {
    const db = getDb();
    const body = req.body;

    // 规整成消息数组
    const rawList = Array.isArray(body) ? body : [body];
    const msgs = [];
    for (const item of rawList) {
        const m = normalizeMessage(item);
        if (m) msgs.push(m);
    }

    if (msgs.length === 0) {
        return res.status(400).json({ success: false, error: '没有解析出有效消息（需 content + sender/role 或 OneBot message 事件）' });
    }

    // 补缺省时间戳（无时间的按当前时间递增写入）
    let cursor = Date.now();
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (!msgs[i].timestamp) {
            msgs[i].timestamp = normalizeTime(cursor);
            cursor -= 1000;
        } else {
            cursor = new Date(msgs[i].timestamp.replace(' ', 'T')).getTime() - 1000;
        }
    }

    // 默认 chat_id=1（若没有独立 chat 概念）
    const chatId = body.chat_id ?? body.group_id ?? 1;

    const insert = db.prepare(`
        INSERT INTO messages (chat_id, sender, content, timestamp, is_encrypted, message_type, status)
        VALUES (?, ?, ?, ?, 0, 'text', 'sent')
    `);
    const tx = db.transaction((list) => {
        for (const m of list) insert.run(chatId, m.sender, m.content, m.timestamp);
    });
    tx(msgs);

    res.json({ success: true, count: msgs.length });
});

module.exports = router;
