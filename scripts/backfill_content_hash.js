// scripts/backfill_content_hash.js — memory_fragments.content_hash 一次性回填
// 为已有碎片计算确定性内容哈希，使 hash 硬去重对历史数据同样生效。
// 幂等：只处理 content_hash IS NULL 的行，可安全重复运行。
// 运行：node scripts/backfill_content_hash.js

const { initDatabase, getDb } = require('../database');
const { hashFragmentContent } = require('../utils/text');

initDatabase();
const db = getDb();

const rows = db.prepare(`
    SELECT id, entity, content FROM memory_fragments
    WHERE content_hash IS NULL
`).all();

console.log(`待回填 ${rows.length} 条碎片`);

if (rows.length > 0) {
    const update = db.prepare('UPDATE memory_fragments SET content_hash = ? WHERE id = ?');
    const tx = db.transaction((batch) => {
        for (const r of batch) {
            update.run(hashFragmentContent(r.entity, r.content), r.id);
        }
    });

    const BATCH = 500;
    let done = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
        tx(rows.slice(i, i + BATCH));
        done += Math.min(BATCH, rows.length - i);
        console.log(`已回填 ${done}/${rows.length}`);
    }
    console.log('回填完成');
}

// 校验：统计「同内容 + 同一天」的重复组数（与 scribe.js 去重规则一致）
// 跨天的同一句话是 source_diversity 证据，不算重复，不在这里统计
const dup = db.prepare(`
    SELECT COUNT(*) AS c FROM (
        SELECT content_hash, source_date FROM memory_fragments
        WHERE content_hash IS NOT NULL
        GROUP BY content_hash, source_date HAVING COUNT(*) > 1
    )
`).get().c;
const remainingNull = db.prepare('SELECT COUNT(*) AS c FROM memory_fragments WHERE content_hash IS NULL').get().c;
console.log(`校验：剩余 NULL=${remainingNull}，同天重复组=${dup}`);
