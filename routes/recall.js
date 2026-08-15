// routes/recall.js — 记忆检索（读侧），供外部机器人回复前查询
//
// POST /api/recall
//   body: { "query": "今天好累", "limit": 8 }
//   → 返回相关的记忆碎片/叙事/实体，formatted 是拼好可塞进 LLM prompt 的文本。
//
// 配合 routes/ingest.js（写侧 /api/messages）形成完整闭环：
//   收到消息 → POST /api/messages 攒记忆
//   回复前   → POST /api/recall 查记忆 → 拼 prompt → LLM 回复
//
// ⚠️ 本接口无鉴权，仅供内网/localhost 使用。

const express = require('express');
const { searchHybrid, formatHybridContext } = require('../services/librarian');
const router = express.Router();

router.post('/recall', async (req, res) => {
    const { query, limit } = req.body || {};
    const q = String(query || '').trim();
    if (!q) {
        return res.status(400).json({ success: false, error: '需提供 query（检索关键词或短句）' });
    }

    try {
        const n = Math.min(parseInt(limit, 10) || 8, 20);
        const memories = await searchHybrid(q, n);

        const formatted = memories.length > 0
            ? `【记忆库检索结果】\n${formatHybridContext(memories)}`
            : '记忆库中没有找到相关记忆。';

        res.json({
            success: true,
            query: q,
            count: memories.length,
            formatted,
        });
    } catch (e) {
        console.error('[recall] 检索失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
