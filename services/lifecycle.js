// =================================================================
// 生命周期引擎 — 记忆的新陈代谢
//
// 每个记忆对象都有完整的生命周期：出生 → 成熟 → 衰减 → 退休
// 每天凌晨运行一次，负责碎片GC、episode衰减、实体提取、纠正反馈
// =================================================================

const { getDb } = require('../database');
const { chromaDBOperation } = require('./memory');
const { callLLM } = require('./llm');

const CONFIG = {
    FRAGMENT_COOLING_DAYS: 14,     // 14天无人访问 → 冷却
    FRAGMENT_FROZEN_DAYS: 30,      // 冷却后30天 → 冻结（从ChromaDB删除向量）
    FRAGMENT_TOMBSTONE_DAYS: 90,   // 冻结后90天 → 墓碑（清空内容，仅留证据链）
    EPISODE_MATURE_MONTHS: 6,      // 6个月未触达 → 成熟（权重减半）
    EPISODE_ARCHIVE_MONTHS: 12,    // 12个月 → 归档
    MIN_FRAGS_FOR_ENTITY: 2,       // 实体最少碎片数才提取
    CORRECTION_DAYS_LOOKBACK: 7,   // 纠正反馈追溯天数
    LLM_API_NAME: '[书库]DS',      // 使用便宜稳定的DS
};

// =================================================================
// Fragment GC: 推动碎片走完整生命周期
// =================================================================

async function runFragmentGC() {
    const db = getDb();
    const now = new Date().toISOString();
    const stats = { cooled: 0, resurrected: 0, frozen: 0, tombstoned: 0 };

    // 1. 活跃 → 冷却：14天以上没人看过
    const coolingCutoff = new Date(Date.now() - CONFIG.FRAGMENT_COOLING_DAYS * 24 * 3600 * 1000).toISOString();
    const toCool = db.prepare(`
        SELECT id, chroma_id FROM memory_fragments
        WHERE status = 'active'
          AND read_count = 0
          AND created_at < ?
    `).all(coolingCutoff);

    for (const f of toCool) {
        db.prepare(`UPDATE memory_fragments SET status = 'cooling', lifecycle_updated_at = ? WHERE id = ?`)
            .run(now, f.id);
    }
    stats.cooled = toCool.length;

    // 2. 复活：冷却期被访问过的 → 重回活跃
    const resurrected = db.prepare(`
        SELECT id FROM memory_fragments
        WHERE status = 'cooling'
          AND read_count > 0
    `).all();

    for (const f of resurrected) {
        db.prepare(`UPDATE memory_fragments SET status = 'active', lifecycle_updated_at = ? WHERE id = ?`)
            .run(now, f.id);
    }
    stats.resurrected = resurrected.length;

    // 3. 冷却 → 冻结：冷却30天以上 → 删除ChromaDB向量
    const frozenCutoff = new Date(Date.now() - CONFIG.FRAGMENT_FROZEN_DAYS * 24 * 3600 * 1000).toISOString();
    const toFreeze = db.prepare(`
        SELECT id, chroma_id FROM memory_fragments
        WHERE status = 'cooling'
          AND lifecycle_updated_at IS NOT NULL
          AND lifecycle_updated_at < ?
    `).all(frozenCutoff);

    for (const f of toFreeze) {
        // 从 ChromaDB 删除向量（fire-and-forget，不阻塞）
        if (f.chroma_id && !f.chroma_id.startsWith('dup_of_')) {
            chromaDBOperation('delete', { id: f.chroma_id }).catch(e =>
                console.error(`[Lifecycle] ChromaDB删除失败 frag#${f.id}:`, e.message)
            );
        }
        db.prepare(`UPDATE memory_fragments SET status = 'frozen', lifecycle_updated_at = ? WHERE id = ?`)
            .run(now, f.id);
    }
    stats.frozen = toFreeze.length;

    // 4. 冻结 → 墓碑：冻结90天 → 清空内容，仅保留证据链
    const tombstoneCutoff = new Date(Date.now() - CONFIG.FRAGMENT_TOMBSTONE_DAYS * 24 * 3600 * 1000).toISOString();
    const toTombstone = db.prepare(`
        SELECT id FROM memory_fragments
        WHERE status = 'frozen'
          AND lifecycle_updated_at IS NOT NULL
          AND lifecycle_updated_at < ?
    `).all(tombstoneCutoff);

    for (const f of toTombstone) {
        db.prepare(`UPDATE memory_fragments SET status = 'tombstone', content = '[expired]', lifecycle_updated_at = ? WHERE id = ?`)
            .run(now, f.id);
    }
    stats.tombstoned = toTombstone.length;

    if (stats.cooled + stats.resurrected + stats.frozen + stats.tombstoned > 0) {
        console.log(`[Lifecycle] Fragment GC: cooled=${stats.cooled} back=${stats.resurrected} frozen=${stats.frozen} tomb=${stats.tombstoned}`);
    }

    return stats;
}

// =================================================================
// Episode 衰减: permanent → mature → archived
// =================================================================

async function runEpisodeDecay() {
    const db = getDb();
    const now = new Date().toISOString();
    const stats = { matured: 0, archived: 0 };

    // permanent → mature: 6个月（标准）/ 12个月（flash）
    const matureCutoff = new Date(Date.now() - CONFIG.EPISODE_MATURE_MONTHS * 30 * 24 * 3600 * 1000).toISOString();
    const matureFlashCutoff = new Date(Date.now() - CONFIG.EPISODE_MATURE_MONTHS * 2 * 30 * 24 * 3600 * 1000).toISOString();

    // 标准 episode
    const toMatureStandard = db.prepare(`
        SELECT id FROM memories
        WHERE status = 'permanent'
          AND (consolidation_type IS NULL OR consolidation_type != 'flash')
          AND (last_accessed_at IS NULL OR last_accessed_at < ?)
          AND (updated_at IS NULL OR updated_at < ?)
    `).all(matureCutoff, matureCutoff);

    // Flash episode：衰减减半
    const toMatureFlash = db.prepare(`
        SELECT id FROM memories
        WHERE status = 'permanent'
          AND consolidation_type = 'flash'
          AND (last_accessed_at IS NULL OR last_accessed_at < ?)
          AND (updated_at IS NULL OR updated_at < ?)
    `).all(matureFlashCutoff, matureFlashCutoff);

    const toMature = [...toMatureStandard, ...toMatureFlash];

    for (const m of toMature) {
        db.prepare(`
            UPDATE memories SET status = 'mature', weight = MAX(1, weight / 2), updated_at = ?
            WHERE id = ?
        `).run(now, m.id);
    }
    stats.matured = toMature.length;

    // mature → archived: 12个月（标准）/ 24个月（flash）
    const archiveCutoff = new Date(Date.now() - CONFIG.EPISODE_ARCHIVE_MONTHS * 30 * 24 * 3600 * 1000).toISOString();
    const archiveFlashCutoff = new Date(Date.now() - CONFIG.EPISODE_ARCHIVE_MONTHS * 2 * 30 * 24 * 3600 * 1000).toISOString();

    const toArchiveStandard = db.prepare(`
        SELECT id FROM memories
        WHERE status = 'mature'
          AND (consolidation_type IS NULL OR consolidation_type != 'flash')
          AND updated_at < ?
    `).all(archiveCutoff);

    const toArchiveFlash = db.prepare(`
        SELECT id FROM memories
        WHERE status = 'mature'
          AND consolidation_type = 'flash'
          AND updated_at < ?
    `).all(archiveFlashCutoff);

    const toArchive = [...toArchiveStandard, ...toArchiveFlash];

    for (const m of toArchive) {
        db.prepare(`UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?`)
            .run(now, m.id);
    }
    stats.archived = toArchive.length;

    if (stats.matured + stats.archived > 0) {
        console.log(`[Lifecycle] Episode decay: matured=${stats.matured} archived=${stats.archived}`);
    }

    return stats;
}

// =================================================================
// 实体提取：从活跃碎片直接提取实体状态（不依赖Consolidator）
// =================================================================

const ENTITY_EXTRACTION_SYSTEM = `你是实体状态提取器。给出关于同一个实体的碎片列表，提取这个实体当前的最新状态。

输出严格JSON：
{
  "current_status": "一句话描述实体的最新状态（如'已从日本回国，在上海写小说'、'家里茶叶：岩茶、老树红茶、煎茶，玉露茶已喝完'）",
  "no_change": false
}

规则：
- 只记录最新状态，不保留历史
- 如果碎片没有描述实体状态的实际变化，设 no_change=true
- 优先记录实体属性变化（位置、职业、状态、拥有物）
- 不要编造碎片中没有的信息`;

async function runEntityExtraction() {
    const db = getDb();
    const stats = { extracted: 0, skipped: 0, unchanged: 0 };

    // 拿到最近7天的活跃碎片，按实体分组
    const cutoffDate = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const frags = db.prepare(`
        SELECT id, entity, content, type, emotional_weight, source_date
        FROM memory_fragments
        WHERE status IN ('active', 'cooling')
          AND entity IS NOT NULL
          AND entity != ''
          AND created_at >= ?
        ORDER BY entity, created_at DESC
    `).all(cutoffDate);

    // 按 entity 分组
    const groups = {};
    for (const f of frags) {
        if (!groups[f.entity]) groups[f.entity] = [];
        if (groups[f.entity].length < 15) groups[f.entity].push(f); // 每组最多15条
    }

    const apiConfig = db.prepare(`SELECT id FROM api_configs WHERE name = ?`).get(CONFIG.LLM_API_NAME);
    if (!apiConfig) {
        console.warn('[Lifecycle] 实体提取：未找到LLM渠道，跳过');
        return stats;
    }

    for (const [entity, fragList] of Object.entries(groups)) {
        if (fragList.length < CONFIG.MIN_FRAGS_FOR_ENTITY) {
            stats.skipped++;
            continue;
        }

        try {
            // 查已有档案
            const existing = db.prepare('SELECT current_status FROM entity_profiles WHERE name = ?').get(entity);

            const fragText = fragList.map(f =>
                `[${f.source_date || '?'}] ${f.content}`
            ).join('\n');

            const currentHint = existing
                ? `\n该实体当前已知状态：${existing.current_status}\n请判断碎片中是否有需要更新的新信息。`
                : '';

            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: `实体：${entity}\n\n碎片列表：\n${fragText}${currentHint}` }] }],
                ENTITY_EXTRACTION_SYSTEM,
                null,
                { temperature: 0.2, maxOutputTokens: 300 },
                apiConfig.id
            );

            const clean = (raw.reply || '').replace(/```json\n?|```/g, '').trim();
            const result = JSON.parse(clean);

            if (result.no_change) {
                stats.unchanged++;
                continue;
            }

            if (result.current_status) {
                const now = new Date().toISOString();
                const sourceFragIds = JSON.stringify(fragList.map(f => f.id));

                db.prepare(`
                    INSERT INTO entity_profiles (name, category, current_status, status_since, source_fragment_ids, updated_at)
                    VALUES (?, 'person', ?, date('now'), ?, ?)
                    ON CONFLICT(name) DO UPDATE SET
                        current_status = excluded.current_status,
                        status_since = date('now'),
                        source_fragment_ids = excluded.source_fragment_ids,
                        updated_at = excluded.updated_at
                `).run(entity, result.current_status, sourceFragIds, now);

                console.log(`[Lifecycle] 实体更新: ${entity} → ${result.current_status.slice(0, 60)}`);
                stats.extracted++;
            }
        } catch (e) {
            if (e instanceof SyntaxError) {
                // JSON解析失败，跳过
            } else {
                console.error(`[Lifecycle] 实体提取失败 ${entity}:`, e.message);
            }
        }
    }

    return stats;
}

// =================================================================
// 纠正反馈：Clara删除记忆 → 查同类碎片降权
// =================================================================

async function runCorrectionFeedback() {
    const db = getDb();
    const stats = { processed: 0, cascaded: 0 };

    // 拿到最近7天内新增的纠正记录
    const cutoffDate = new Date(Date.now() - CONFIG.CORRECTION_DAYS_LOOKBACK * 24 * 3600 * 1000).toISOString();
    const corrections = db.prepare(`
        SELECT * FROM correction_log
        WHERE status = 'active'
          AND created_at >= ?
        ORDER BY created_at DESC
    `).all(cutoffDate);

    for (const c of corrections) {
        try {
            // 降权同类碎片：找到与被纠正记忆内容相近的活跃碎片
            if (c.target_type === 'memory' && c.target_id) {
                // 查被删记忆的碎片来源
                const deletedMemory = db.prepare('SELECT source_msg_ids FROM memories WHERE id = ?').get(c.target_id);
                let sourceIds = [];
                try { sourceIds = JSON.parse(deletedMemory?.source_msg_ids || '[]'); } catch {}

                if (sourceIds.length > 0) {
                    // 找到同源碎片 → 降权
                    const placeholders = sourceIds.map(() => '?').join(',');
                    const relatedFrags = db.prepare(`
                        SELECT id, emotional_weight FROM memory_fragments
                        WHERE status = 'active'
                          AND id IN (${placeholders})
                    `).all(...sourceIds);

                    for (const f of relatedFrags) {
                        const newEW = Math.max(0.1, (f.emotional_weight || 0.5) * 0.5);
                        db.prepare(`UPDATE memory_fragments SET emotional_weight = ? WHERE id = ?`)
                            .run(newEW, f.id);
                        stats.cascaded++;
                    }
                }
            }

            db.prepare(`UPDATE correction_log SET status = 'applied' WHERE id = ?`).run(c.id);
            stats.processed++;
        } catch (e) {
            console.error(`[Lifecycle] 纠正处理失败 #${c.id}:`, e.message);
        }
    }

    if (stats.processed > 0) {
        console.log(`[Lifecycle] Correction feedback: ${stats.processed} processed, ${stats.cascaded} frags demoted`);
    }

    return stats;
}

// =================================================================
// 主入口：每日cron调用
// =================================================================

async function runLifecycleMaintenance() {
    console.log('[Lifecycle] 每日维护开始...');
    const db = getDb();

    // 确保 migration 已跑（lifecycle_updated_at 列）
    ensureLifecycleMigration(db);

    // 1. Fragment GC — 每天
    const gcStats = await runFragmentGC();

    // 2. Episode 衰减 — 每天
    const decayStats = await runEpisodeDecay();

    // 3. 实体提取 — 每周一次（周日）
    const isSunday = new Date().getDay() === 0;
    let entityStats = null;
    if (isSunday) {
        entityStats = await runEntityExtraction();
    }

    // 4. 纠正反馈 — 每周一次（周日）
    let correctionStats = null;
    if (isSunday) {
        correctionStats = await runCorrectionFeedback();
    }

    // 5. Memory Weight 重算 — 每天
    const weightStats = recalculateMemoryWeights();

    console.log(`[Lifecycle] 完成: GC(${gcStats.cooled}c/${gcStats.frozen}f) decay(${decayStats.matured}m/${decayStats.archived}a) weight(${weightStats.memoriesUpdated})` +
        (entityStats ? ` entities(${entityStats.extracted})` : '') +
        (correctionStats ? ` corrections(${correctionStats.processed})` : ''));

    return { gcStats, decayStats, entityStats, correctionStats, weightStats };
}

// =================================================================
// Migration: 确保 lifecycle_updated_at 列存在
// =================================================================

function ensureLifecycleMigration(db) {
    try {
        const cols = db.prepare('PRAGMA table_info(memory_fragments)').all();
        if (!cols.find(c => c.name === 'lifecycle_updated_at')) {
            db.exec(`ALTER TABLE memory_fragments ADD COLUMN lifecycle_updated_at DATETIME`);
            // 现有碎片按创建时间初始化
            db.exec(`UPDATE memory_fragments SET lifecycle_updated_at = created_at WHERE lifecycle_updated_at IS NULL`);
            console.log('[Lifecycle] migration: lifecycle_updated_at column added');
        }
        // 确保 memories 表有 last_accessed_at
        const memCols = db.prepare('PRAGMA table_info(memories)').all();
        if (!memCols.find(c => c.name === 'last_accessed_at')) {
            db.exec(`ALTER TABLE memories ADD COLUMN last_accessed_at DATETIME`);
        }
    } catch (e) {
        console.error('[Lifecycle] migration error:', e.message);
    }
}

// 注入追踪：记录本轮对话注入了哪些记忆（供纠正反馈使用）
function trackMemoryInjection(chatId, messageId, memoryIds, fragmentIds) {
    try {
        const db = getDb();
        const record = JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            memory_ids: memoryIds || [],
            fragment_ids: fragmentIds || [],
            injected_at: new Date().toISOString(),
        });
        // 存到 message 的 metadata 或单独表。简便做法：存到 correction_log 边上的一个轻量表
        // 这里先不做独立的 injection 表，避免复杂化。需要时再建。
        // 当下只记录到日志，下一次迭代可以用上。
        console.log(`[Lifecycle] Injection tracked: chat=${chatId} msg=${messageId} mems=${(memoryIds||[]).length} frags=${(fragmentIds||[]).length}`);
    } catch (e) {
        // 非关键路径，静默失败
    }
}

// =================================================================
// Memory Weight 衰减 — 每天重算 memories 和 memory_fragments 权重
// =================================================================

function recalculateMemoryWeights() {
    const db = getDb();

    // memories: 时间衰减 (-0.5/30天) + 访问加成 (7天内+2, 30天内+1), clamp[2,8]
    const memResult = db.prepare(`
        UPDATE memories SET weight = CASE
            WHEN 5
                + CASE WHEN last_accessed_at > datetime('now', '-7 days') THEN 2
                       WHEN last_accessed_at > datetime('now', '-30 days') THEN 1
                       ELSE 0 END
                - CAST((julianday('now') - julianday(COALESCE(created_at, datetime('now')))) / 30.0 AS INTEGER) * 0.5
                < 2 THEN 2
            WHEN 5
                + CASE WHEN last_accessed_at > datetime('now', '-7 days') THEN 2
                       WHEN last_accessed_at > datetime('now', '-30 days') THEN 1
                       ELSE 0 END
                - CAST((julianday('now') - julianday(COALESCE(created_at, datetime('now')))) / 30.0 AS INTEGER) * 0.5
                > 8 THEN 8
            ELSE CAST(5
                + CASE WHEN last_accessed_at > datetime('now', '-7 days') THEN 2
                       WHEN last_accessed_at > datetime('now', '-30 days') THEN 1
                       ELSE 0 END
                - CAST((julianday('now') - julianday(COALESCE(created_at, datetime('now')))) / 30.0 AS INTEGER) * 0.5 AS INTEGER)
        END
        WHERE status IN ('permanent', 'ongoing')
    `).run();

    if (memResult.changes > 0) {
        console.log(`[Lifecycle] ⚖️ Memories Weight重算: ${memResult.changes}条`);
    }
    return { memoriesUpdated: memResult.changes };
}

module.exports = { runLifecycleMaintenance, runFragmentGC, runEpisodeDecay, runEntityExtraction, runCorrectionFeedback, trackMemoryInjection, recalculateMemoryWeights };
