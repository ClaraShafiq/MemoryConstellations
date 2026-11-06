'use strict';

/**
 * retrieval_rank 调用链测试：
 * 建临时库 → 插两条只差权重的碎片 → searchHybrid 排序应随权重变化。
 * 验证的是「投影字段真的进了 librarian 的生产排序路径」，
 * 不只是纯函数算得对。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_FILE = path.join(os.tmpdir(), `mc-rank-test-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;
process.env.SANCTUARY_ENCRYPTION_KEY = 'a'.repeat(64);

const { initDatabase } = require('../database');
const db = initDatabase();

const insert = db.prepare(`
    INSERT INTO memory_fragments
        (type, entity, content, status, retrieval_rank, created_at, emotional_weight, read_count)
    VALUES ('event', '权重测试实体', ?, 'active', ?, '2026-11-05 12:00:00', 0.5, 0)
`);
const CONTENT = '排序权重验证 关键词甲 关键词乙 同一段文字';
const hotId = Number(insert.run(CONTENT, 1.0).lastInsertRowid);
const coldId = Number(insert.run(CONTENT, 0.9).lastInsertRowid);

(async () => {
    const { searchHybrid, searchFragments } = require('../services/librarian');

    const raw = searchFragments('排序权重验证 关键词甲', 5);
    console.log('FTS raw:', JSON.stringify(raw.map(r => ({ id: r.id, rank: r.rank, rr: r.retrieval_rank }))));

    const first = await searchHybrid('排序权重验证 关键词甲', 5);
    const firstIds = first.map(r => Number(r.id));
    assert.ok(firstIds.includes(hotId), `高权重碎片未出现在结果里: ${firstIds}`);
    assert.ok(firstIds.includes(coldId), `低权重碎片未出现在结果里: ${firstIds}`);
    assert.ok(
        firstIds.indexOf(hotId) < firstIds.indexOf(coldId),
        `高权重应排前: ${firstIds}`,
    );

    // 交换权重，排序应翻转
    db.prepare('UPDATE memory_fragments SET retrieval_rank = 0.85 WHERE id = ?').run(hotId);
    db.prepare('UPDATE memory_fragments SET retrieval_rank = 1.0 WHERE id = ?').run(coldId);

    const second = await searchHybrid('排序权重验证 关键词甲', 5);
    const secondIds = second.map(r => Number(r.id));
    assert.ok(
        secondIds.indexOf(coldId) < secondIds.indexOf(hotId),
        `权重互换后排序应翻转: ${secondIds}`,
    );

    console.log(`retrieval rank 调用链: ok (${firstIds} → ${secondIds})`);

    try { db.close(); } catch (_) {}
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_FILE + suffix, { force: true }); } catch (_) {}
    }
})().catch(err => {
    console.error('retrieval rank 调用链测试失败:', err.message);
    process.exitCode = 1;
});
