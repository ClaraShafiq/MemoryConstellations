// =================================================================
// Memory Constellations — 记忆管线冒烟测试
// 验证：碎片写入 → 向量化 → FTS5 → 检索 → 衰减
// 用法: node tests/smoke_memory.js
// =================================================================

require('dotenv').config();
const { initDatabase } = require('../database');
const { initSettings } = require('../routes/settings');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        passed++;
    } catch (e) {
        console.log(`  \x1b[31m✗\x1b[0m ${name}`);
        console.log(`    ${e.message}`);
        failed++;
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        passed++;
    } catch (e) {
        console.log(`  \x1b[31m✗\x1b[0m ${name}`);
        console.log(`    ${e.message}`);
        failed++;
    }
}

async function main() {
    console.log('🧪 Memory Constellations — 记忆管线冒烟测试\n');

    initDatabase();
    initSettings();
    const { getDb } = require('../database');
    const db = getDb();

    // ── 1. 记忆表存在 ──
    console.log('── 1. 数据库 ──');
    const tables = ['memory_fragments', 'memory_fragments_fts', 'memories', 'memories_fts',
                    'entity_profiles', 'fragment_entities', 'entity_timeline',
                    'clara_model', 'memory_sagas', 'ontology_changelog'];
    for (const t of tables) {
        test(`表 ${t}`, () => {
            const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
            if (!r) throw new Error('缺失');
        });
    }

    // ── 2. 碎片 CRUD ──
    console.log('\n── 2. 碎片 ──');
    let fragId = null;
    test('写入碎片', () => {
        const r = db.prepare(`INSERT INTO memory_fragments
            (type, entity, content, emotional_weight, source, source_date, status, created_at)
            VALUES ('event', 'Test', '冒烟测试碎片——验证记忆管线。', 0.6, 'chat', '2026-01-01', 'active', datetime('now'))`).run();
        fragId = r.lastInsertRowid;
        if (!fragId) throw new Error('写入失败');
    });
    test('FTS5 索引同步', () => {
        const r = db.prepare("SELECT content FROM memory_fragments_fts WHERE content MATCH '冒烟测试'").get();
        if (!r) throw new Error('FTS5 未索引');
    });
    test('清理测试碎片', () => {
        db.prepare('DELETE FROM memory_fragments WHERE id = ?').run(fragId);
    });

    // ── 3. 实体星系 ──
    console.log('\n── 3. 实体星系 ──');
    test('entity_profiles 有核心实体', () => {
        const { USER, AI } = require('../services/memoryConfig');
        const u = db.prepare("SELECT id FROM entity_profiles WHERE name = ?").get(USER.name);
        const a = db.prepare("SELECT id FROM entity_profiles WHERE name = ?").get(AI.name);
        if (!u || !a) throw new Error('核心实体缺失');
    });
    test('fragment_entities 可写入', () => {
        const r = db.prepare("INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, confidence, classified_by) VALUES (1, 7, 0.60, 'test')").run();
    });

    // ── 4. Clara Model ──
    console.log('\n── 4. Clara Model ──');
    test('processModelDecay 不抛异常', () => {
        const { processModelDecay } = require('../services/cognitiveModel');
        const r = processModelDecay();
        if (!r || typeof r.resolved !== 'number') throw new Error('返回异常');
    });
    test('resolveExpiredStates 不抛异常', () => {
        const { resolveExpiredStates } = require('../services/cognitiveModel');
        const r = resolveExpiredStates();
        if (typeof r !== 'number') throw new Error('返回异常');
    });

    // ── 5. 配置 ──
    console.log('\n── 5. 配置 ──');
    test('memory_config.json 可读', () => {
        const { USER, AI, config } = require('../services/memoryConfig');
        if (!USER.name || !AI.name) throw new Error('USER/AI 缺失');
    });
    test('source_routing 配置加载', () => {
        const raw = require('../memory_config.json');
        if (!raw.source_routing || typeof raw.source_routing !== 'object') throw new Error('source_routing 缺失或格式错误');
    });

    // ── 6. ChromaDB ──
    console.log('\n── 6. ChromaDB ──');
    await asyncTest('ChromaDB heartbeat', async () => {
        const { chromaDBOperation } = require('../services/memory');
        const r = await chromaDBOperation('heartbeat');
        if (!r) throw new Error('ChromaDB 无响应');
    });

    // ── 结果 ──
    console.log(`\n══════════════════`);
    console.log(`通过: ${passed}  失败: ${failed}`);
    if (failed === 0) {
        console.log('🎉 记忆管线就绪！');
    } else {
        console.log('⚠️  有测试失败。');
        process.exit(1);
    }
    process.exit(0);
}

main().catch(e => {
    console.error('💥 测试中断:', e.message);
    process.exit(1);
});
