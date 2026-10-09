// =================================================================
// Memory Constellations — 记忆管线冒烟测试
// 验证：碎片写入 → 向量化 → FTS5 → 检索 → 衰减
// 用法: node tests/smoke_memory.js
// =================================================================

const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'constellations-smoke-'));
process.env.DB_PATH=path.join(dir,'fixture.db');
process.env.SANCTUARY_ENCRYPTION_KEY=require('node:crypto').randomBytes(32).toString('hex');
require('dotenv').config();
const { initDatabase } = require('../database');

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
    const { getDb } = require('../database');
    const db = getDb();

    // ── 1. 记忆表存在 ──
    console.log('── 1. 数据库 ──');
    const tables = ['memory_fragments', 'memory_fragments_fts', 'memories', 'memories_fts',
                    'entity_profiles', 'fragment_entities', 'entity_timeline',
                    'user_model', 'memory_sagas', 'ontology_changelog'];
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
        // 索引侧是 splitCJK 展开的单字形态（中文按单字切），查整串「冒烟测试」永远查不到。
        // 这里必须按 librarian 的方式查：拆成单字再 OR。
        const matchStr = [...'冒烟测试'].map(c => `"${c}"`).join(' OR ');
        const r = db.prepare('SELECT COUNT(*) c FROM memory_fragments_fts WHERE memory_fragments_fts MATCH ?').get(matchStr);
        if (r.c === 0) throw new Error('FTS5 未索引（单字检索无命中）');
    });
    test('清理测试碎片', () => {
        db.prepare('DELETE FROM memory_fragments WHERE id = ?').run(fragId);
    });

    // ── 3. 实体星系 ──
    console.log('\n── 3. 实体星系 ──');
    // entity_profiles 不在建表时播种——实体是管线（Scribe / Entity Resolver）跑出来的。
    // 所以这里自己造两个，验证「能写」以及「碎片↔实体 能挂上」，而不是断言存在预置数据。
    let coreEntityId = null;
    let starFragId = null;
    test('entity_profiles 可写入核心实体', () => {
        const { USER, AI } = require('../services/memoryConfig');
        const ins = db.prepare("INSERT OR IGNORE INTO entity_profiles (name, category, aliases, tags) VALUES (?, 'person', '[]', '[]')");
        ins.run(USER.name);
        ins.run(AI.name);
        const u = db.prepare('SELECT id FROM entity_profiles WHERE name = ?').get(USER.name);
        if (!u) throw new Error('核心实体写入失败');
        coreEntityId = u.id;
    });
    test('fragment_entities 可写入', () => {
        // entity_id 必须用真实存在的 id——写死数字会被外键拒掉
        const f = db.prepare(`INSERT INTO memory_fragments
            (type, entity, content, source, source_date, status)
            VALUES ('event', 'Test', '星系关联冒烟碎片', 'chat', '2026-01-01', 'active')`).run();
        starFragId = f.lastInsertRowid;
        db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, confidence, classified_by) VALUES (?, ?, 0.60, ?)')
            .run(starFragId, coreEntityId, 'smoke_test');
        const n = db.prepare('SELECT COUNT(*) c FROM fragment_entities WHERE fragment_id = ?').get(starFragId).c;
        if (n === 0) throw new Error('碎片↔实体关联未写入');
    });
    test('清理星系测试数据', () => {
        if (starFragId) {
            db.prepare('DELETE FROM fragment_entities WHERE fragment_id = ?').run(starFragId);
            db.prepare('DELETE FROM memory_fragments WHERE id = ?').run(starFragId);
        }
    });

    // ── 4. User Model ──
    console.log('\n── 4. User Model ──');
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
        // 新克隆的仓库只有 memory_config.example.json（真配置在 .gitignore 里），
        // memoryConfig 会自动回退到 example——所以这里也照同样的回退来查。
        let raw;
        try {
            raw = require('../memory_config.json');
        } catch (_) {
            raw = require('../memory_config.example.json');
        }
        if (!raw.source_routing || typeof raw.source_routing !== 'object') throw new Error('source_routing 缺失或格式错误');
    });

    // ── 6. 工具注册表 ──
    // 只加载 + 校验声明，不执行 handler（handler 会写库）。
    // 这一层此前完全没有覆盖：工具文件里一个 require 解析不到，
    // 冒烟测试照样全绿，而线上每一次工具调用都会崩。
    console.log('\n── 6. 工具注册表 ──');
    await asyncTest('加载 services/tools/index.js', async () => {
        const tools = require('../services/tools/index.js');
        const { getUserSetting } = require('../utils/settings');
        const { functionDeclarations } = await tools.getEnabledTools({ getUserSetting });

        if (!functionDeclarations.length) throw new Error('没有任何启用的工具');

        for (const d of functionDeclarations) {
            if (!d.name) throw new Error('工具缺 name');
            if (!d.description) throw new Error(`${d.name} 缺 description`);
            if (!d.parameters) throw new Error(`${d.name} 缺 parameters`);
        }
        console.log(`      已注册: ${functionDeclarations.map(d => d.name).join(', ')}`);
    });

    await asyncTest('每个工具都暴露了可调用的 handler', () => {
        // 直接 require 工具模块，逐个校验形状——不真调 handler（会写库）
        const toolList = [
            ...require('../services/tools/memoryTools'),
            require('../services/tools/manageUserState'),
        ];
        if (!toolList.length) throw new Error('工具清单为空');
        for (const t of toolList) {
            if (!t.name) throw new Error('工具缺 name');
            if (typeof t.getFunctionDeclaration !== 'function') throw new Error(`${t.name} 缺 getFunctionDeclaration`);
            if (typeof t.handler !== 'function') throw new Error(`${t.name} 缺 handler`);
        }
        console.log(`      已注册: ${toolList.map(t => t.name).join(', ')}`);
    });

    // ── 7. ChromaDB ──
    console.log('\n── 7. ChromaDB ──');
    console.log('SKIP: real ChromaDB heartbeat (this default smoke test is offline)');

    // ── 结果 ──
    console.log(`\n══════════════════`);
    console.log(`通过: ${passed}  失败: ${failed}`);
    if (failed === 0) {
        console.log('🎉 记忆管线就绪！');
    } else {
        console.log('⚠️  有测试失败。');
        process.exitCode=1;
    }

}

main().catch(e => {
    console.error('💥 测试中断:', e.message);
    process.exitCode=1;
}).finally(()=>{
    try { require('../database').getDb().close(); } catch {}
    fs.rmSync(dir,{recursive:true,force:true});
});
