// =================================================================
// Entity Profile（实体档案）：维护人物/地点/事件/作品的最新已知状态
// =================================================================

const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { WORLD_CONTEXT } = require('./worldContext');

const ENTITY_EXTRACT_PROMPT = `${WORLD_CONTEXT}

你是实体档案更新器。识别以下记忆片段中人物/地点/事件/作品的状态变化。

状态变化 = 人物/地点/事件/作品的状态发生更新（人物所在地/工作/生活阶段/关系变化；地点用途/状态变化；事件进展/状态变化；作品进度/状态变化）。

输出严格JSON：
{
  "updates": [
    {"entity": "实体名", "category": "person|place|event|project", "new_status": "一句话最新状态", "status_since": "YYYY-MM或空"}
  ]
}

规则：
- 只提取明确的状态变化，不编造
- "{user}"和"{ai}"的状态也提取
- 同一实体多条状态变化取最新一条
- 没有状态变化的记忆忽略`;

async function updateEntityProfiles(newEpisodes) {
    if (!newEpisodes || newEpisodes.length === 0) return [];

    const episodesText = newEpisodes.map((ep, i) =>
        `[记忆${i + 1}] ${ep.memoryContent} (date: ${ep.correctedDate || '未知'})`
    ).join('\n\n');

    let result;
    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: `识别以下记忆中的实体状态变化：\n\n${episodesText}` }] }],
            ENTITY_EXTRACT_PROMPT,
            null,
            { temperature: 0.1, maxOutputTokens: 2000 },
            36
        );
        const clean = raw.reply.replace(/```json|```/g, '').trim();
        result = JSON.parse(clean);
    } catch (e) {
        console.error('[EntityProfile] LLM提取失败:', e.message);
        return [];
    }

    if (!result?.updates?.length) return [];

    const db = getDb();

    // 预取已有档案，做 status_since 时间校验
    const existingMap = new Map();
    const allNames = [...new Set(result.updates.map(u => u.entity).filter(Boolean))];
    if (allNames.length > 0) {
        const placeholders = allNames.map(() => '?').join(',');
        const existing = db.prepare(`SELECT name, status_since FROM entity_profiles WHERE name IN (${placeholders})`).all(...allNames);
        for (const e of existing) {
            existingMap.set(e.name, e.status_since || '');
        }
    }

    const upsert = db.prepare(`
        INSERT INTO entity_profiles (name, category, current_status, status_since, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(name) DO UPDATE SET
            current_status = excluded.current_status,
            status_since = COALESCE(excluded.status_since, entity_profiles.status_since),
            updated_at = datetime('now')
    `);

    const updated = [];
    for (const u of result.updates) {
        if (!u.entity || !u.new_status) continue;

        // 时间校验：新 status_since 不比旧的新 → 跳过（防止过期信息覆盖新信息）
        const newSince = u.status_since || '';
        const oldSince = existingMap.get(u.entity) || '';
        if (newSince && oldSince && newSince < oldSince) {
            console.log(`[EntityProfile] ${u.entity} 跳过（status_since ${newSince} < ${oldSince}，旧信息更新）`);
            continue;
        }

        upsert.run(u.entity, u.category || 'person', u.new_status, u.status_since || '');
        updated.push(u.entity);
        console.log(`[EntityProfile] ${u.entity} → ${u.new_status}`);
    }

    return updated;
}

// 从检索结果中提取涉及的非主角实体，查档案返回近况注入行
function getEntityContext(fragments) {
    if (!fragments || fragments.length === 0) return null;

    const db = getDb();
    const entityIds = new Set();

    // Path 1: fragment_entities 链接（新系统——星座归属）
    const fragIds = fragments
        .filter(f => f.source_table === 'fragment')
        .map(f => f.id);
    if (fragIds.length > 0) {
        const placeholders = fragIds.map(() => '?').join(',');
        const linked = db.prepare(`
            SELECT DISTINCT entity_id FROM fragment_entities
            WHERE fragment_id IN (${placeholders})
        `).all(...fragIds);
        linked.forEach(r => entityIds.add(r.entity_id));
    }

    // Path 2: 旧 entity 字段（Scribe 提取时标注的实体名）
    if (fragIds.length > 0) {
        const placeholders = fragIds.map(() => '?').join(',');
        const rows = db.prepare(`
            SELECT DISTINCT entity FROM memory_fragments
            WHERE id IN (${placeholders}) AND entity != ''
        `).all(...fragIds);
        const names = [...new Set(rows.map(r => r.entity))];
        if (names.length > 0) {
            const matched = db.prepare(`
                SELECT id FROM entity_profiles
                WHERE name IN (${names.map(() => '?').join(',')})
            `).all(...names);
            matched.forEach(r => entityIds.add(r.id));
        }
    }

    if (entityIds.size === 0) return null;

    // Fetch profiles with related_entities
    const idList = [...entityIds];
    const profiles = db.prepare(`
        SELECT name, overview, category, related_entities
        FROM entity_profiles
        WHERE id IN (${idList.map(() => '?').join(',')})
          AND name NOT IN (?, ?)
        ORDER BY fragment_count DESC
        LIMIT 5
    `).all(...idList, ...require('./memoryConfig').SKIP_NAMES.slice(0, 2));

    if (profiles.length === 0) return null;

    return profiles.map(p => {
        let line = `※ ${p.name}（${p.category}）`;
        if (p.overview) {
            const ov = p.overview.slice(0, 120);
            line += ` — ${ov}${p.overview.length > 120 ? '…' : ''}`;
        }
        // 关联星座：让 Draco 知道可以顺藤摸瓜
        try {
            const rels = JSON.parse(p.related_entities || '[]');
            if (rels.length > 0) {
                const relStr = rels.slice(0, 3)
                    .map(r => r.relation ? `${r.name}（${r.relation}）` : r.name)
                    .join('、');
                line += `\n  ↳ 关联星座：${relStr}`;
            }
        } catch (_) {}
        return line;
    }).join('\n') + '\n（使用 recall_memory 可追溯任意星座的详细记忆与原始对话）';
}

module.exports = { updateEntityProfiles, getEntityContext };
