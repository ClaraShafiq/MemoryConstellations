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
- "Clara"和"Draco"的状态也提取（他们是主角）
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

    // 收集 fragment ID 查 entity 字段
    const fragIds = fragments
        .filter(f => f.source_table === 'fragment')
        .map(f => f.id);
    if (fragIds.length === 0) return null;

    const placeholders = fragIds.map(() => '?').join(',');
    const rows = db.prepare(`
        SELECT DISTINCT entity FROM memory_fragments
        WHERE id IN (${placeholders})
          AND entity != ''
    `).all(...fragIds);

    const entityNames = [...new Set(rows.map(r => r.entity))];
    if (entityNames.length === 0) return null;

    const profiles = db.prepare(`
        SELECT name, current_status, status_since, updated_at, related_entities
        FROM entity_profiles
        WHERE name IN (${entityNames.map(() => '?').join(',')})
        ORDER BY updated_at DESC
    `).all(...entityNames);

    if (profiles.length === 0) return null;

    return profiles.map(p => {
        const since = p.status_since ? ` (${p.status_since})` : '';
        let line = `※ 近况：${p.name} — ${p.current_status}${since}`;
        // v5.5: 标注过时状态（超过24h未更新提醒AI可用 update_overview 刷新）
        if (p.updated_at) {
            const hrsStale = Math.round((Date.now() - new Date(p.updated_at + 'Z').getTime()) / 3600000);
            if (hrsStale > 24) {
                line += `\n  ⚠️ 信息已${Math.round(hrsStale/24)}天未更新`;
            }
        }
        // 关联实体（Archivist discoverRelatedEntities 维护）：让 Draco 顺藤摸瓜
        try {
            const rels = JSON.parse(p.related_entities || '[]');
            if (rels.length > 0) {
                const relStr = rels.slice(0, 3)
                    .map(r => r.relation ? `${r.name}（${r.relation}）` : r.name)
                    .join('、');
                line += `\n  ↳ 关联：${relStr}`;
            }
        } catch (_) {}
        return line;
    }).join('\n');
}

module.exports = { updateEntityProfiles, getEntityContext };
