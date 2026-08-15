// scripts/repair_fts.js — FTS 索引回补（一次性运维脚本）
// 数据库损坏恢复后 FTS 触发器可能丢失，导致 memories_fts 索引为空。
// 本脚本回补 memories_fts（title + tags 展开，与触发器逻辑一致），
// 并报告 memory_fragments_fts 的同步状态。
// 触发器重建由 initDatabase() 的幂等块负责（见 database.js），无需在此重复。

const { initDatabase, getDb } = require('../database');

initDatabase();
const db = getDb();

// 1. 回补 memories_fts
const srcCount = db.prepare('SELECT COUNT(*) c FROM memories').get().c;
const before = db.prepare('SELECT COUNT(*) c FROM memories_fts').get().c;

db.exec(`
    DELETE FROM memories_fts;
    INSERT INTO memories_fts(rowid, title, tags_text)
    SELECT id, COALESCE(title, ''),
        COALESCE(REPLACE(REPLACE(REPLACE(REPLACE(tags, '["', ''), '"]', ''), '","', ' '), '"', ''), '')
    FROM memories;
`);

const after = db.prepare('SELECT COUNT(*) c FROM memories_fts').get().c;
console.log(`memories_fts: ${before} → ${after} 条（源表 memories: ${srcCount} 条）${after === srcCount ? '✅' : '❌ 数量不符'}`);

// 2. 报告 memory_fragments_fts 同步状态
const fragTotal = db.prepare('SELECT COUNT(*) c FROM memory_fragments').get().c;
const ftsTotal = db.prepare('SELECT COUNT(*) c FROM memory_fragments_fts').get().c;
const orphans = db.prepare('SELECT COUNT(*) c FROM memory_fragments_fts f WHERE NOT EXISTS (SELECT 1 FROM memory_fragments mf WHERE mf.id = f.rowid)').get().c;
const missing = db.prepare('SELECT COUNT(*) c FROM memory_fragments mf WHERE NOT EXISTS (SELECT 1 FROM memory_fragments_fts f WHERE f.rowid = mf.id)').get().c;
console.log(`memory_fragments_fts: ${ftsTotal} / ${fragTotal}（orphans:${orphans} missing:${missing}）${ftsTotal === fragTotal && orphans === 0 && missing === 0 ? '✅ 同步' : '❌ 需重建'}`);

// 3. 报告触发器
const triggers = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'trigger'").get().c;
console.log(`触发器数量: ${triggers}（应为 6）${triggers === 6 ? '✅' : '❌'}`);

process.exit(0);
