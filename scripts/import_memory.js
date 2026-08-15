// scripts/import_memory.js — 导入记忆库导出文件（迁移 / 恢复）
//
// 用法：
//   node scripts/import_memory.js <文件.jsonl> [--merge]
//
//   默认：跳过已存在的记录（INSERT OR IGNORE，按主键 id 去重，可安全重复导入）。
//   --merge：对已存在的 id 做覆盖更新（慎用，会覆盖目标库现有内容）。
//
// 注意：导入前目标库应是干净的新库（或至少没有同 id 冲突的记录）。

const fs = require('fs');
const { initDatabase, getDb } = require('../database');

// 白名单：只允许导入这些表，防止恶意导出文件执行任意 SQL
const ALLOWED_TABLES = new Set(['entity_profiles', 'memory_fragments', 'fragment_entities', 'memories']);

function main() {
    const args = process.argv.slice(2);
    const inFile = args.find(a => !a.startsWith('--'));
    const merge = args.includes('--merge');

    if (!inFile || !fs.existsSync(inFile)) {
        console.log('用法: node scripts/import_memory.js <文件.jsonl> [--merge]');
        process.exit(1);
    }

    initDatabase();
    const db = getDb();

    const lines = fs.readFileSync(inFile, 'utf8').split('\n');
    let imported = 0, skipped = 0;
    const counts = {};

    const tx = db.transaction(() => {
        for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            let obj;
            try { obj = JSON.parse(t); } catch { continue; }
            const { table, row } = obj || {};
            if (!table || !row || typeof row !== 'object' || !ALLOWED_TABLES.has(table)) continue;

            const cols = Object.keys(row);
            const placeholders = cols.map(() => '?').join(',');
            const values = cols.map(c => row[c]);

            if (merge) {
                // 覆盖更新：REPLACE INTO（按主键 id 替换）
                db.prepare(`REPLACE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`).run(...values);
                imported++;
            } else {
                const r = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`).run(...values);
                if (r.changes > 0) imported++; else skipped++;
            }
            counts[table] = (counts[table] || 0) + 1;
        }
    });
    tx();

    console.log('✅ 记忆库导入完成');
    for (const t of Object.keys(counts)) console.log(`   ${t}: ${counts[t]} 条`);
    console.log(`   写入 ${imported} 条，跳过 ${skipped} 条（已存在）`);
    console.log('\n导入后，FTS 全文索引会由触发器自动重建，无需手动操作。');
    process.exit(0);
}

main().catch(e => { console.error('❌ 导入失败:', e); process.exit(1); });
