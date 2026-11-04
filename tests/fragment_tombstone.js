'use strict';

// 墓碑不能吃掉正文：
// 冻结满 90 天的碎片只打 status='tombstone'，content 必须原样保留。
// 一旦覆盖成 '[expired]'，原始发言与证据链就永久丢失（表里没有第二份）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-constellations-tombstone-'));
process.env.DB_PATH = path.join(tmpDir, 'tombstone.sqlite');
process.env.SANCTUARY_ENCRYPTION_KEY ||= '33'.repeat(32);

const { initDatabase } = require('../database');
const { runFragmentGC } = require('../services/lifecycle');

const ORIGINAL_CONTENT = '2026-06-01 21:30｜成员A 说：墓碑测试用的原始发言，含证据链，删掉就找不回来。';

function sqlDaysAgo(days) {
    return new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
}

(async () => {
    const db = initDatabase();
    try {
        const insert = db.prepare(`
            INSERT INTO memory_fragments (type, entity, content, status, source_date, created_at, lifecycle_updated_at)
            VALUES ('event', ?, ?, 'frozen', ?, ?, ?)
        `);
        const old = sqlDaysAgo(91);
        const info = insert.run('测试实体', ORIGINAL_CONTENT, '2026-06-01', old, old);
        const fragId = info.lastInsertRowid;

        const before = db.prepare('SELECT content, status FROM memory_fragments WHERE id = ?').get(fragId);
        assert.equal(before.content, ORIGINAL_CONTENT);
        assert.equal(before.status, 'frozen');

        await runFragmentGC();

        const after = db.prepare('SELECT content, status FROM memory_fragments WHERE id = ?').get(fragId);
        assert.equal(after.status, 'tombstone', '冻结超期应转为墓碑');
        assert.equal(after.content, ORIGINAL_CONTENT, '墓碑不得覆盖正文');

        // 检索侧只认 status='active'，墓碑因此自然退出召回
        const searchable = db.prepare(
            `SELECT COUNT(*) AS n FROM memory_fragments WHERE id = ? AND status = 'active'`
        ).get(fragId);
        assert.equal(searchable.n, 0, '墓碑不应出现在 active 检索里');

        console.log('fragment tombstone: ok');
    } finally {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
