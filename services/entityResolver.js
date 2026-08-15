// =================================================================
// Entity Resolver（实体解析器）：自动绑定 fragment → entity
//
// 在 Scribe 写入碎片后调用，四层管线：
//   1. 关键词匹配：fragment 的 entity/content 含已知人名/别名 → 直接关联
//   2. ★ 向量联想：embed fragment → ChromaDB 查相似碎片 → 聚合已有 entity 关联 →
//                候选实体投票
//   3. LLM 指代消解：结合候选实体列表 + 描述，做单选判断（一条碎片一个直接归属）
//   4. ★ 派生关联：从直接实体出发，沿 related_entity_ids 自动派生二级链接，
//                标记为 derived_from，供 Librarian/overview 做辅助参考
//
// 写入目标：fragment_entities 多对多表（+ 兼容 memory_fragments.entity_id 旧字段）
// 设计原则：同步执行，Scribe 返回前 entity 链接已填充完毕。
// LLM 只做单选（准确性最高），多维度关联走确定性的关系图谱派生。
// =================================================================

const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { USER, AI, SKIP_NAMES, fillPrompt } = require('./nameResolver');
const { chromaDBOperation, getLocalEmbedding } = require('./memory');

// 向量联想配置
const VECTOR_HINT_TOP_K = 5;
const VECTOR_HINT_MIN_SIMILARITY = 0.55;
const VECTOR_HINT_MAX_CANDIDATES = 5;

// 派生关联置信度（低于直接关联，供下游区分权重）
const DERIVED_CONFIDENCE = 0.45;

// 内存缓存，5分钟刷新
let _aliasCache = null;
let _cacheAge = 0;

function getAliasData() {
    const now = Date.now();
    if (_aliasCache && (now - _cacheAge) < 300000) return _aliasCache;

    const db = getDb();
    const rows = db.prepare(`
        SELECT id, name, category, aliases, facts, related_entity_ids FROM entity_profiles
        WHERE name IS NOT NULL AND category != 'term'
    `).all();

    const aliasMap = new Map();
    const knownEntities = [];
    const entityDescriptors = new Map();
    // ★ 关系图谱：entity_id → [related_entity_id, ...]  供派生关联用
    const relationGraph = new Map();

    for (const row of rows) {
        let aliasList = [], relatedIds = [];
        try { aliasList = JSON.parse(row.aliases || '[]'); } catch (_) {}
        try { relatedIds = JSON.parse(row.related_entity_ids || '[]'); } catch (_) {}

        knownEntities.push({ id: row.id, name: row.name, aliases: aliasList });

        let shortDesc = '';
        if (row.facts) {
            shortDesc = row.facts.replace(/\n/g, ' ').substring(0, 120);
            if (row.facts.length > 120) shortDesc += '…';
        }
        entityDescriptors.set(row.id, {
            name: row.name,
            category: row.category || 'unknown',
            shortDesc,
        });

        if (relatedIds.length > 0) {
            relationGraph.set(row.id, relatedIds);
        }

        aliasMap.set(row.name.toLowerCase(), { id: row.id, name: row.name });
        for (const alias of aliasList) {
            if (alias && alias.trim()) {
                aliasMap.set(alias.trim().toLowerCase(), { id: row.id, name: row.name });
            }
        }
    }

    _aliasCache = { aliasMap, knownEntities, entityDescriptors, relationGraph };
    _cacheAge = now;
    return _aliasCache;
}

// ── 内部：写入 fragment_entities（替换旧 entity_id UPDATE）──
function linkFragmentToEntity(fragmentId, entityId, relation, confidence, classifiedBy) {
    const db = getDb();
    db.prepare(`
        INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(fragmentId, entityId, relation || null, confidence, classifiedBy);

    // 同步更新 entity_profiles.fragment_count
    db.prepare(`
        UPDATE entity_profiles SET fragment_count = (
            SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?
        ) WHERE id = ?
    `).run(entityId, entityId);

    // 兼容旧字段
    db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE id = ? AND entity_id IS NULL')
        .run(entityId, fragmentId);
}

// ── 内部：从直接实体派生二级关联 ──
// 读取 entity 的 related_entity_ids，写入 fragment_entities（标记 derived_from）
function deriveEntityLinks(fragmentId, directEntityId) {
    const db = getDb();
    const { relationGraph, entityDescriptors } = _aliasCache;  // 可能在当前 tick 内已过期，fallback 到实查

    // 先查缓存，缓存没有则查 DB
    let relatedIds = relationGraph?.get(directEntityId);
    if (!relatedIds) {
        const row = db.prepare('SELECT related_entity_ids FROM entity_profiles WHERE id = ?').get(directEntityId);
        if (!row?.related_entity_ids) return 0;
        try { relatedIds = JSON.parse(row.related_entity_ids); } catch (_) { return 0; }
        if (!relatedIds?.length) return 0;
    }

    let derived = 0;
    for (const rid of relatedIds) {
        // 跳过不存在的 entity
        const exists = db.prepare('SELECT 1 FROM entity_profiles WHERE id = ? AND status = ?').get(rid, 'active');
        if (!exists) continue;

        const relation = `derived_from:${directEntityId}`;
        db.prepare(`
            INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by, created_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
        `).run(fragmentId, rid, relation, DERIVED_CONFIDENCE, 'resolver.derived');

        // 更新派生 entity 的 fragment_count
        db.prepare(`
            UPDATE entity_profiles SET fragment_count = (
                SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?
            ) WHERE id = ?
        `).run(rid, rid);

        derived++;
    }

    if (derived > 0) {
        const entName = entityDescriptors?.get(directEntityId)?.name || `#${directEntityId}`;
        console.log(`[EntityResolver] 🔗 派生关联: frag #${fragmentId} → ${derived} 个实体 (from ${entName})`);
    }

    return derived;
}

// ── 内部：关键词匹配 ──
function matchByKeyword(fragment, aliasMap) {
    if (fragment.entity && fragment.entity.trim()) {
        const key = fragment.entity.trim().toLowerCase();
        if (aliasMap.has(key)) return aliasMap.get(key);
    }

    const content = (fragment.content || '').toLowerCase();
    for (const [alias, entry] of aliasMap) {
        if (alias.length >= 2 && content.includes(alias)) {
            if (entry.name === USER.name || entry.name === AI.name) continue;
            return entry;
        }
    }
    return null;
}

// ── 内部：向量联想 ──
async function matchByVectorHint(unmatchedFragments) {
    if (unmatchedFragments.length === 0) return {};

    const db = getDb();
    const { entityDescriptors } = getAliasData();
    const candidates = {};

    for (const frag of unmatchedFragments) {
        try {
            const embedding = await getLocalEmbedding(frag.content);
            if (!embedding) continue;

            const queryResult = await chromaDBOperation('query', {
                embedding,
                n_results: VECTOR_HINT_TOP_K,
                min_similarity: VECTOR_HINT_MIN_SIMILARITY,
                query_text: frag.content,
            });

            const ids = queryResult?.ids?.[0] || [];
            const distances = queryResult?.distances?.[0] || [];
            if (ids.length === 0) continue;

            const neighborIds = [];
            const neighborScores = new Map();
            for (let i = 0; i < ids.length; i++) {
                const fragMatch = ids[i]?.match(/^fragment_(\d+)$/);
                if (fragMatch) {
                    const nid = parseInt(fragMatch[1]);
                    neighborIds.push(nid);
                    const sim = 1 - (distances[i] || 0);
                    const existing = neighborScores.get(nid) || 0;
                    neighborScores.set(nid, Math.max(existing, sim));
                }
            }

            if (neighborIds.length === 0) continue;

            const placeholders = neighborIds.map(() => '?').join(',');
            const links = db.prepare(`
                SELECT fe.entity_id, fe.fragment_id
                FROM fragment_entities fe
                WHERE fe.fragment_id IN (${placeholders})
            `).all(...neighborIds);

            if (links.length === 0) continue;

            const voteMap = new Map();
            for (const link of links) {
                const sim = neighborScores.get(link.fragment_id) || 0;
                const existing = voteMap.get(link.entity_id);
                if (existing) {
                    existing.votes++;
                    existing.max_sim = Math.max(existing.max_sim, sim);
                    existing.sum_sim += sim;
                } else {
                    const desc = entityDescriptors.get(link.entity_id);
                    voteMap.set(link.entity_id, {
                        entity_id: link.entity_id,
                        entity_name: desc?.name || `id:${link.entity_id}`,
                        category: desc?.category || 'unknown',
                        shortDesc: desc?.shortDesc || '',
                        votes: 1,
                        max_sim: sim,
                        sum_sim: sim,
                    });
                }
            }

            const ranked = Array.from(voteMap.values())
                .sort((a, b) => (b.votes * b.max_sim) - (a.votes * a.max_sim))
                .slice(0, VECTOR_HINT_MAX_CANDIDATES);

            if (ranked.length > 0) candidates[frag.id] = ranked;
        } catch (e) {
            console.error(`[EntityResolver] 向量联想失败 frag #${frag.id}:`, e.message);
        }
    }

    if (Object.keys(candidates).length > 0) {
        const totalHints = Object.values(candidates).reduce((s, c) => s + c.length, 0);
        console.log(`[EntityResolver] 🔗 向量联想: ${Object.keys(candidates).length}/${unmatchedFragments.length} 条碎片获得候选 (共 ${totalHints} 个候选实体)`);
    }

    return candidates;
}

// ── 内部：LLM 指代消解（单选）──
async function resolveByLLM(unmatchedFragments, conversationText, knownEntities, entityCandidates) {
    if (unmatchedFragments.length === 0) return {};

    const entityLines = knownEntities.map(e => {
        const desc = entityCandidates?.[e.id] || null;
        const catTag = desc?.category ? ` | ${desc.category}` : '';
        const overviewHint = desc?.shortDesc ? ` — ${desc.shortDesc}` : '';
        return `- [ID:${e.id}] ${e.name}${catTag}${overviewHint}${e.aliases.length ? '（别名：' + e.aliases.join('、') + '）' : ''}`;
    });

    const fragmentLines = unmatchedFragments.map(f => {
        const hints = entityCandidates[f.id];
        let hintText = '';
        if (hints && hints.length > 0) {
            hintText = '\n  ★ 向量关联候选（按相似度排序）：' + hints.map(h =>
                `[ID:${h.entity_id}] ${h.entity_name}${h.category ? ' (' + h.category + ')' : ''} — 邻居碎片投票 ${h.votes} 票, 最高相似度 ${h.max_sim.toFixed(2)}${h.shortDesc ? ' | ' + h.shortDesc : ''}`
            ).join('；');
        }
        return `[frag_${f.id}] entity="${f.entity_label}" content="${f.content}"${hintText}`;
    });

    const prompt = `你是实体指代消解器。给定对话上下文、已知实体列表和记忆碎片，判断每条碎片提及的人物/事物指向哪个已知实体。

已知实体：
${entityLines.join('\n')}

规则：
- 每条碎片最多分配一个实体——选最直接的那一个
- ★ 向量关联候选的使用方法：
  · 信号强（同一实体 ≥2 票 或 最高相似度 ≥0.75）→ 候选很可能是对的，结合描述判断后确认
  · 信号弱（各实体各1票且相似度 <0.70）→ 候选只是"听起来有点像"，不要强行关联
  · 候选实体描述与碎片内容明显不是一回事 → 即使票数高也输出 null
- ★ 使用已知实体的描述（category + 概述）来判断语义关联
- 代词（他/她/它/这个人/那人）在上下文中指向谁，就输出谁的 ID
- 如果是 {{user.name}} 或 {{ai.name}} 自己，输出 entity_id: null
- 如果无法确定指向谁，输出 entity_id: null
- 不要因为"好像有点关系"就分配 ID——只在确定时分配

输出严格JSON：
{
  "resolutions": [
    {"fragment_id": 123, "entity_id": 1, "entity_name": "某个朋友"},
    {"fragment_id": 124, "entity_id": null, "reason": "指代不明"}
  ]
}`;

    const userContent = `对话上下文：
${conversationText.slice(0, 4000)}

待消解的记忆碎片：
${fragmentLines.join('\n')}`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: userContent }] }],
            fillPrompt(prompt),
            null,
            { temperature: 0.1, maxOutputTokens: 2000 },
            36
        );
        const clean = raw.reply.replace(/```json|```/g, '').trim();
        const result = JSON.parse(clean);

        const resolutions = {};
        if (result?.resolutions) {
            for (const r of result.resolutions) {
                if (r.entity_id != null) {
                    resolutions[r.fragment_id] = r.entity_id;
                    console.log(`[EntityResolver] 🎯 LLM消解: frag #${r.fragment_id} → entity ${r.entity_id} (${r.entity_name || '?'})`);
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
 * 解析新写入 fragments 的 entity 关联
 * @param {number[]} fragmentIds - 刚写入的 fragment IDs
 * @param {string} conversationText - Scribe 已解密的格式化对话文本
 * @returns {number} 成功解析的数量（含直接+派生）
 */
async function resolveEntityIds(fragmentIds, conversationText) {
    if (!fragmentIds || fragmentIds.length === 0) return 0;

    const db = getDb();
    const { aliasMap, knownEntities } = getAliasData();
    if (aliasMap.size === 0) return 0;

    const placeholders = fragmentIds.map(() => '?').join(',');
    const fragments = db.prepare(`
        SELECT id, entity, content FROM memory_fragments WHERE id IN (${placeholders})
    `).all(...fragmentIds);

    const unmatched = [];
    let totalDirect = 0, totalDerived = 0;

    // —— 第一层：关键词匹配 ——
    for (const frag of fragments) {
        const match = matchByKeyword(frag, aliasMap);
        if (match) {
            linkFragmentToEntity(frag.id, match.id, 'keyword', 0.90, 'resolver.keyword');
            totalDerived += deriveEntityLinks(frag.id, match.id);
            totalDirect++;
        } else {
            unmatched.push(frag);
        }
    }

    if (totalDirect > 0) {
        console.log(`[EntityResolver] 关键词匹配: ${totalDirect}/${fragments.length} 条 (+${totalDerived} 派生)`);
    }

    // —— 第二层：向量联想 ——
    let entityCandidates = {};
    if (unmatched.length > 0) {
        entityCandidates = await matchByVectorHint(unmatched);
    }

    // —— 第三层：LLM 指代消解 ——
    if (unmatched.length > 0 && conversationText) {
        const llmResolutions = await resolveByLLM(unmatched, conversationText, knownEntities, entityCandidates);
        let llmDirect = 0, llmDerived = 0;
        for (const [fragId, entityId] of Object.entries(llmResolutions)) {
            linkFragmentToEntity(parseInt(fragId), entityId, 'llm_resolved', 0.70, 'resolver.llm');
            llmDerived += deriveEntityLinks(parseInt(fragId), entityId);
            llmDirect++;
        }
        totalDirect += llmDirect;
        totalDerived += llmDerived;
        if (llmDirect > 0) {
            console.log(`[EntityResolver] LLM指代消解: ${llmDirect}/${unmatched.length} 条 (+${llmDerived} 派生)`);
        }

        const hintedUnresolved = unmatched.filter(
            f => entityCandidates[f.id]?.length > 0 && !llmResolutions[f.id]
        );
        if (hintedUnresolved.length > 0) {
            console.log(`[EntityResolver] ⚠️ 向量有候选但LLM判定不关联: ${hintedUnresolved.length} 条 (frag #${hintedUnresolved.map(f => f.id).join(',')})`);
        }
    }

    // —— 第四层（fire-and-forget）：实体关系发现 ——
    try {
        const { discoverEntityRelationships } = require('./archivist');
        const db = getDb();

        const missingRels = db.prepare(`
            SELECT COUNT(*) as c FROM entity_profiles ep
            WHERE ep.category = 'person'
              AND ep.name NOT IN ('${USER.name}', '${AI.name}')
              AND (ep.relationship_to_clara IS NULL OR ep.relationship_to_clara = '')
              AND (SELECT COUNT(*) FROM memory_fragments WHERE entity_id = ep.id AND status = 'active') >= 5
        `).get();

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

        if (missingRels?.c > 0 || lowConfRels?.c > 0) {
            discoverEntityRelationships({ includeReEval: true }).catch(e =>
                console.error('[EntityResolver] 关系发现失败（非致命）:', e.message));
        }
    } catch (e) {
        // 不阻塞
    }

    return totalDirect + totalDerived;
}

module.exports = { resolveEntityIds };
