// scripts/export_memory.js — 导出记忆库，方便迁移 / 备份
//
// 用法：
//   node scripts/export_memory.js [输出文件.jsonl]     （默认 memory_export.jsonl）
//
// 导出内容（按依赖顺序）：
//   entity_profiles    星座（人物/地点/事件实体，三字段模型）
//   memory_fragments   记忆碎片（Scribe 提取的原始事实）
//   fragment_entities  碎片 ↔ 实体关联
//   memories           叙事记忆（episode / saga）
//
// 导出为 JSONL，每行一个 JSON 对象：
//   {"table":"memory_fragments","row":{...全部字段...}}
//
// 对应的导入脚本：node scripts/import_memory.js <文件.jsonl>

const fs = require('fs');
const { initDatabase, getDb } = require('../database');

const TABLES = ['entity_profiles', 'memory_fragments', 'fragment_entities', 'memories'];

function main() {
    const outFile = process.argv[2] || 'memory_export.jsonl';
    initDatabase();
    const db = getDb();

    const stream = fs.createWriteStream(outFile);
    let total = 0;
    const counts = {};

    for (const table of TABLES) {
        const rows = db.prepare(`SELECT * FROM ${table}`).all();
        counts[table] = rows.length;
        for (const row of rows) {
            stream.write(JSON.stringify({ table, row }) + '\n');
            total++;
        }
    }
    stream.end();

    console.log('✅ 记忆库导出完成');
    console.log(`   输出文件: ${outFile}`);
    for (const t of TABLES) console.log(`   ${t}: ${counts[t]} 条`);
    console.log(`   合计: ${total} 条记录`);
    console.log('\n迁移到新机器后，用 `node scripts/import_memory.js ' + outFile + '` 导入。');
    process.exit(0);
}

main().catch(e => { console.error('❌ 导出失败:', e); process.exit(1); });
