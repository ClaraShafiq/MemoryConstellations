// =================================================================
// Entity Resolver（实体解析器）：自动绑定 fragment.entity_id
//
// 在 Scribe 写入碎片后调用，做两件事：
//   1. 关键词匹配：fragment 的 entity/content 含已知人名/别名 → 直接填 entity_id
//   2. LLM 指代消解：代词/隐式指称 → 批处理一次 LLM 确定指向
//
// 设计原则：同步执行，Scribe 返回前 entity_id 已填充完毕，无时间差窗口。
// =================================================================

const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { USER, AI, SKIP_NAMES } = require('./nameResolver');

// 内存缓存，5分钟刷新
let _aliasCache = null;
let _cacheAge = 0;

function getAliasData() {
    const now = Date.now();
    if (_aliasCache && (now - _cacheAge) < 300000) return _aliasCache;

    const db = getDb();
    const rows = db.prepare(`
        SELECT id, name, category, aliases FROM entity_profiles
        WHERE name IS NOT NULL AND category != 'term'
    `).all();

    // aliasMap: lowercase alias → {id, name}
    const aliasMap = new Map();
    // knownEntities: [{id, name, aliases}]
    const knownEntities = [];

    for (const row of rows) {
        let aliasList = [];
        try { aliasList = JSON.parse(row.aliases || '[]'); } catch (_) {}

        knownEntities.push({
            id: row.id,
            name: row.name,
            aliases: aliasList,
        });

        aliasMap.set(row.name.toLowerCase(), { id: row.id, name: row.name });
        for (const alias of aliasList) {
            if (alias && alias.trim()) {
                aliasMap.set(alias.trim().toLowerCase(), { id: row.id, name: row.name });
            }
        }
    }

    _aliasCache = { aliasMap, knownEntities };
    _cacheAge = now;
    return _aliasCache;
}

// ── 内部：关键词匹配 ──
function matchByKeyword(fragment, aliasMap) {
    // entity 字段直接匹配（Scribe 提取时已标注的人名）
    if (fragment.entity && fragment.entity.trim()) {
        const key = fragment.entity.trim().toLowerCase();
        if (aliasMap.has(key)) {
            return aliasMap.get(key);
        }
    }

    // content 中查找（≥2字的 alias，排除 Clara/Draco 自身）
    const content = (fragment.content || '').toLowerCase();
    for (const [alias, entry] of aliasMap) {
        if (alias.length >= 2 && content.includes(alias)) {
            if (entry.name === USER.name || entry.name === AI.name) continue;
            return entry;
        }
    }

    return null;
}

// ── 内部：LLM 指代消解（批处理） ──
async function resolveByLLM(unmatchedFragments, conversationText, knownEntities) {
    if (unmatchedFragments.length === 0) return {};

    const items = unmatchedFragments.map(f => ({
        fragment_id: f.id,
        entity_label: f.entity || '(未标注)',
        content: f.content,
    }));

    const prompt = `你是实体指代消解器。给定对话上下文和记忆碎片，判断每条碎片中提及的人物指向哪个已知实体。

已知实体：
${knownEntities.map(e => `- [ID:${e.id}] ${e.name}${e.aliases.length ? '（别名：' + e.aliases.join('、') + '）' : ''}`).join('\n')}

规则：
- 如果碎片明确指向某个已知实体，输出该实体的 ID
- 代词（他/她/它/这个人/那人）在上下文中指向谁，就输出谁的 ID
- 如果是 Clara 或 Draco 自己，输出 entity_id: null
- 如果无法确定指向谁，输出 entity_id: null
- 不要因为"好像有点关系"就分配 ID——只在确定时分配

输出严格JSON：
{
  "resolutions": [
    {"fragment_id": 123, "entity_id": 1, "entity_name": "千变慢慢"},
    {"fragment_id": 124, "entity_id": null, "reason": "指代不明"}
  ]
}`;

    const userContent = `对话上下文：
${conversationText.slice(0, 4000)}

待消解的记忆碎片：
${items.map(f => `[frag_${f.fragment_id}] entity="${f.entity_label}" content="${f.content}"`).join('\n')}`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: userContent }] }],
            prompt,
            null,
            { temperature: 0.1, maxOutputTokens: 1000 },
            36
        );
        const clean = raw.reply.replace(/```json|```/g, '').trim();
        const result = JSON.parse(clean);

        const resolutions = {};
        if (result?.resolutions) {
            for (const r of result.resolutions) {
                if (r.entity_id != null) {
                    resolutions[r.fragment_id] = r.entity_id;
                }
            }
        }
        return resolutions;
    } catch (e) {
        console.error('[EntityResolver] LLM指代消解失败:', e.message);
        return {};
    }
}

// =================================================================
// 公开 API
// =================================================================

/**
 * 解析新写入 fragments 的 entity_id
 * @param {number[]} fragmentIds - 刚写入的 fragment IDs
 * @param {string} conversationText - Scribe 已解密的格式化对话文本（用于 LLM 指代消解上下文）
 * @returns {number} 成功解析的数量
 */
async function resolveEntityIds(fragmentIds, conversationText) {
    if (!fragmentIds || fragmentIds.length === 0) return 0;

    const db = getDb();
    const { aliasMap, knownEntities } = getAliasData();
    if (aliasMap.size === 0) return 0;

    // 读刚写入的 fragments
    const placeholders = fragmentIds.map(() => '?').join(',');
    const fragments = db.prepare(`
        SELECT id, entity, content FROM memory_fragments WHERE id IN (${placeholders})
    `).all(...fragmentIds);

    const unmatched = [];
    const update = db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE id = ?');

    for (const frag of fragments) {
        const match = matchByKeyword(frag, aliasMap);
        if (match) {
            update.run(match.id, frag.id);
        } else {
            unmatched.push(frag);
        }
    }

    const keywordResolved = fragments.length - unmatched.length;
    if (keywordResolved > 0) {
        console.log(`[EntityResolver] 关键词匹配: ${keywordResolved}/${fragments.length} 条`);
    }

    // LLM 指代消解（仅对未匹配的，需要对话上下文）
    if (unmatched.length > 0 && conversationText) {
        const llmResolutions = await resolveByLLM(unmatched, conversationText, knownEntities);
        let llmResolved = 0;
        for (const [fragId, entityId] of Object.entries(llmResolutions)) {
            update.run(entityId, parseInt(fragId));
            llmResolved++;
        }
        if (llmResolved > 0) {
            console.log(`[EntityResolver] LLM指代消解: ${llmResolved}/${unmatched.length} 条`);
        }
    }

    // 实体关系发现：检查是否有 entity 需要关系发现或重评估
    // fire-and-forget，不阻塞 entityResolver
    try {
        const { discoverEntityRelationships } = require('./archivist');
        const db = getDb();

        // A: 缺少关系的 entity（现有逻辑）
        const missingRels = db.prepare(`
            SELECT COUNT(*) as c FROM entity_profiles ep
            WHERE ep.category = 'person'
              AND ep.name NOT IN ('${USER.name}', '${AI.name}')
              AND (ep.relationship_to_clara IS NULL OR ep.relationship_to_clara = '')
              AND (SELECT COUNT(*) FROM memory_fragments WHERE entity_id = ep.id AND status = 'active') >= 5
        `).get();

        // B: 低/中置信度 + 有新增碎片
        const lowConfRels = db.prepare(`
            SELECT COUNT(*) as c FROM entity_profiles ep
            WHERE ep.category = 'person'
              AND ep.name NOT IN ('${USER.name}', '${AI.name}')
              AND ep.relationship_confidence IN ('low', 'medium')
              AND (ep.last_evaluated_at IS NULL OR ep.last_evaluated_at < datetime('now', '-1 day'))
              AND (SELECT COUNT(*) FROM memory_fragments
                   WHERE entity_id = ep.id AND status = 'active'
                     AND created_at > COALESCE(ep.last_evaluated_at, '1970-01-01')) >= 3
        `).get();

        // C: 高置信度但长期未重评 + 有显著新增
        const staleRels = db.prepare(`
            SELECT COUNT(*) as c FROM entity_profiles ep
            WHERE ep.category = 'person'
              AND ep.name NOT IN ('${USER.name}', '${AI.name}')
              AND ep.relationship_confidence = 'high'
              AND ep.last_evaluated_at < datetime('now', '-30 days')
              AND (SELECT COUNT(*) FROM memory_fragments
                   WHERE entity_id = ep.id AND status = 'active'
                     AND created_at > ep.last_evaluated_at) >= 5
        `).get();

        const needsReEval = (lowConfRels?.c > 0) || (staleRels?.c > 0);
        const needsDiscovery = missingRels?.c > 0;

        if (needsDiscovery || needsReEval) {
            discoverEntityRelationships({ includeReEval: needsReEval }).catch(e =>
                console.error('[EntityResolver] 关系发现失败（非致命）:', e.message));
        }
    } catch (e) {
        // 不阻塞：archivist 模块可能还没加载
    }

    return keywordResolved;
}

module.exports = { resolveEntityIds };
