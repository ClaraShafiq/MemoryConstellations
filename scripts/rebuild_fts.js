// scripts/rebuild_fts.js — FTS 索引重建 / 体检
//
// 为什么需要单独一个脚本：
// FTS5 的 external content 表（content='memory_fragments'）不存原文，正文读的是内容表。
// 这带来两个坑：
//   1. 用 COUNT(*) / rowid 查询验证同步状态是**量不到**的——它会委托到内容表，永远返回"看起来对"。
//      真正可信的是 _docsize 影子表（每个被索引的文档一行）。
//   2. 索引里的文本是 splitCJK 展开过的（中文按单字切），而 FTS5 自带的 'rebuild' 指令
//      是拿内容表**原文**重新分词——跑一次，单字索引整条失效，而且零报错。
//
// 所以本脚本不用 'rebuild' 指令，而是 DROP + CREATE + 按 splitCJK 回补，最后用 _docsize 验证。
//
// 什么时候要跑：检索结果对不上、搜旧词还能命中已删的记忆、数据库损坏恢复之后。
//
// 用法：
//   node scripts/rebuild_fts.js          # 体检 + 重建
//   node scripts/rebuild_fts.js --check  # 只体检，不动数据

require('dotenv').config();
const { initDatabase, getDb } = require('../database');

const CHECK_ONLY = process.argv.includes('--check');

initDatabase();
const db = getDb();

// CJK 单字分割（与 database.js 里注册的 splitCJK SQL 函数保持一致）
const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/g;
function splitCJK(text) {
    return text ? text.replace(CJK_RE, ' $& ') : '';
}

// ── 体检：用 _docsize 影子表，而不是 COUNT(*) ──
function health() {
    const fragIndexed = db.prepare('SELECT COUNT(*) c FROM memory_fragments_fts_docsize').get().c;
    const fragActive  = db.prepare("SELECT COUNT(*) c FROM memory_fragments WHERE status = 'active'").get().c;
    const memIndexed  = db.prepare('SELECT COUNT(*) c FROM memories_fts_docsize').get().c;
    const memTotal    = db.prepare('SELECT COUNT(*) c FROM memories').get().c;
    const triggers    = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'trigger'").get().c;

    console.log('── FTS 体检 ──');
    console.log(`  memory_fragments_fts 已索引 ${fragIndexed} 条（活跃碎片 ${fragActive}）${fragIndexed === fragActive ? ' ✅' : ' ❌ 不一致'}`);
    console.log(`  memories_fts 已索引 ${memIndexed} 条（源表 ${memTotal}）${memIndexed === memTotal ? ' ✅' : ' ❌ 不一致'}`);
    console.log(`  触发器 ${triggers} 个（应为 6）${triggers === 6 ? ' ✅' : ' ❌'}`);
    console.log('  （注：COUNT(*) 查 FTS 表会委托到内容表，量不到不一致——所以这里必须看 _docsize）');

    return fragIndexed === fragActive && memIndexed === memTotal && triggers === 6;
}

if (CHECK_ONLY) {
    const ok = health();
    console.log(ok ? '\n体检通过。' : '\n发现问题，去掉 --check 跑一次重建。');
    process.exit(ok ? 0 : 1);
}

// ── 重建 ──
console.log('开始重建 FTS 索引……\n');

// 1. 清掉旧的触发器和表
db.exec(`
    DROP TRIGGER IF EXISTS mf_fts_insert;
    DROP TRIGGER IF EXISTS mf_fts_update;
    DROP TRIGGER IF EXISTS mf_fts_delete;
    DROP TRIGGER IF EXISTS memories_fts_insert;
    DROP TRIGGER IF EXISTS memories_fts_update;
    DROP TRIGGER IF EXISTS memories_fts_delete;
    DROP TABLE IF EXISTS memory_fragments_fts;
    DROP TABLE IF EXISTS memories_fts;
`);

// 2. 建表
db.exec(`
    CREATE VIRTUAL TABLE memory_fragments_fts
        USING fts5(content, entity, content='memory_fragments', content_rowid='id');
    CREATE VIRTUAL TABLE memories_fts
        USING fts5(title, tags_text);
`);

// 3. 回补 memory_fragments_fts（活跃碎片 + CJK 单字分割）
const frags = db.prepare(
    "SELECT id, content, COALESCE(entity, '') AS entity FROM memory_fragments WHERE status = 'active'"
).all();
const insFrag = db.prepare('INSERT INTO memory_fragments_fts(rowid, content, entity) VALUES (?, ?, ?)');
db.transaction((rows) => {
    for (const r of rows) insFrag.run(r.id, splitCJK(r.content), splitCJK(r.entity));
})(frags);
console.log(`  回补 memory_fragments_fts: ${frags.length} 条`);

// 4. 回补 memories_fts（title + tags 展开，与触发器逻辑一致）
const mems = db.prepare("SELECT id, COALESCE(title, '') AS title, COALESCE(tags, '') AS tags FROM memories").all();
const insMem = db.prepare('INSERT INTO memories_fts(rowid, title, tags_text) VALUES (?, ?, ?)');
db.transaction((rows) => {
    for (const r of rows) {
        const tagsText = r.tags.replace(/\["/g, '').replace(/"\]/g, '').replace(/","/g, ' ').replace(/"/g, '');
        insMem.run(r.id, r.title, tagsText);
    }
})(mems);
console.log(`  回补 memories_fts: ${mems.length} 条`);

// 5. 重建 6 个触发器（与 database.js 里的一致）
db.exec(`
    CREATE TRIGGER mf_fts_insert
        AFTER INSERT ON memory_fragments BEGIN
            INSERT INTO memory_fragments_fts(rowid, content, entity)
            VALUES (new.id, splitCJK(new.content), splitCJK(COALESCE(new.entity, '')));
        END;
    CREATE TRIGGER mf_fts_delete
        AFTER DELETE ON memory_fragments BEGIN
            INSERT INTO memory_fragments_fts(memory_fragments_fts, rowid, content, entity)
            VALUES ('delete', old.id, splitCJK(old.content), splitCJK(COALESCE(old.entity, '')));
        END;
    CREATE TRIGGER mf_fts_update
        AFTER UPDATE ON memory_fragments BEGIN
            INSERT INTO memory_fragments_fts(memory_fragments_fts, rowid, content, entity)
            VALUES ('delete', old.id, splitCJK(old.content), splitCJK(COALESCE(old.entity, '')));
            INSERT INTO memory_fragments_fts(rowid, content, entity)
            VALUES (new.id, splitCJK(new.content), splitCJK(COALESCE(new.entity, '')));
        END;
    CREATE TRIGGER memories_fts_insert
        AFTER INSERT ON memories BEGIN
            INSERT INTO memories_fts(rowid, title, tags_text)
            VALUES (new.id, COALESCE(new.title, ''),
                COALESCE(REPLACE(REPLACE(REPLACE(REPLACE(new.tags, '["', ''), '"]', ''), '","', ' '), '"', ''), ''));
        END;
    CREATE TRIGGER memories_fts_delete
        AFTER DELETE ON memories BEGIN
            DELETE FROM memories_fts WHERE rowid = old.id;
        END;
    CREATE TRIGGER memories_fts_update
        AFTER UPDATE ON memories BEGIN
            UPDATE memories_fts
            SET title = COALESCE(new.title, ''),
                tags_text = COALESCE(REPLACE(REPLACE(REPLACE(REPLACE(new.tags, '["', ''), '"]', ''), '","', ' '), '"', ''), '')
            WHERE rowid = new.id;
        END;
`);

console.log('');
health();
process.exit(0);
