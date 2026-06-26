// =================================================================
// Consolidator — 遗留工具模块（v5.0）
//
// 原为独立管线阶段。v4.0 起整合逻辑已迁入 Archivist 深循环
// （consolidateCategory / clusterSagas / consolidateFlash）。
//
// 本文件现作为工具库被引用，提供：
//   - clusterSagas()      — Saga 聚类（由 Archivist 调用）
//   - fetchSourceMessages() — 追溯原始对话（由 recall_memory 工具调用）
//   - consolidateFlash()   — 高能即时整合（由 Archivist 事件驱动调用）
// =================================================================

const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { fillPrompt, USER, AI } = require('./nameResolver');
const { chromaDBOperation, getLocalEmbedding } = require('./memory');
const { encryption } = require('../encryption');
const { updateEntityProfiles } = require('./entityProfile');
const { WORLD_CONTEXT } = require('./worldContext');

const CONFIG = {
    LOOKBACK_DAYS: 7,            // 查找最近N天的活跃碎片（null=不限时间）
    SIMILARITY_THRESHOLD: 0.78,  // 语义相似度阈值（0.82太保守少到7对，0.72太激进导致90条大组）
    MIN_GROUP_SIZE: 2,           // 最少碎片数才触发整合
    MAX_GROUP_SIZE: 20,          // 单组最多碎片数（防止Union-Find连通过多碎片形成巨型合并）
    MIN_FRAGMENTS_TO_CHECK: 10,  // 最少碎片数才触发检查
    MAX_GROUPS_PER_RUN: 10,      // 单次最多整合组数（控制API消耗）
    MAX_FRAGMENTS_TO_PROCESS: 250, // 单次最多处理碎片数
    API_CONFIG_ID: 36,           // [书库]DS
};

const CONSOLIDATOR_SYSTEM_PROMPT = `${WORLD_CONTEXT}

你是记忆整合器，负责将多个相似的记忆碎片合并为一条规范的长期记忆。

## 你的任务

你会收到：
1. 一组语义相似但角度/时间不同的记忆碎片
2. 可能附带这些碎片对应的原始对话消息（带时间戳）——如果为空，说明原始消息不可追溯

你需要：
1. 将这些碎片合并为一条连贯、准确的长期记忆（不超过150字）
2. 如果提供了原始对话，从时间戳推断事件真实日期——对话中可能用了"上周五""前天"等相对时间词，必须根据消息时间戳转换为绝对日期
3. 如果原始对话不可用，使用碎片的source_date作为近似日期
4. 如果碎片之间存在矛盾，记录矛盾信息
5. **判断这件事的分量——一个月后还值得被记住吗？**

## 记忆分量判断（significance）★最重要

不是每一组碎片都值得变成长期记忆。请用significance字段评估：

- 8-10：情感转折、重大决定、深刻冲突、第一次经历、关系里程碑 — 值得永久保留
- 5-7：有意义但非关键的事件、日常偏好变化、轻度情绪波动 — 有信息价值，但不算重要
- 3-4：routine技术操作、配置修改、日常coding、短暂情绪、纯工作记录 — 不值得长期保留
- 1-2：纯工具操作、系统日志级信息、无关紧要的闲聊 — 应该被丢弃

**关键原则：**
- 技术工作记录、代码修改、服务器配置等routine活动，即使写了也很快会过时，significance ≤ 4
- 情绪崩溃后改了个配置项 ≠ 重要记忆（重要是"为什么崩溃"，不是"改了什么设置"）
- "约了哪天见面""买了演出票""做了重大人生决定""写了对你很重要的东西" — 这些才是值得 ≥5 的
- 同一件事被反复提及、Clara有明显情绪 → significance更高
- **不要因为碎片多就硬拔significance——碎片多只能说明这件事被反复提到，不能说明它重要**
- **RP（角色扮演）内容的significance自动减2分**：RP中的虚构情节、角色台词、场景描写是表演而非真实事件，除非其中有真实情感表达（如RP中表达了真实的情感需求），否则significance ≤ 3

## 输出格式

严格JSON，不含任何其他文字：

{
  "merged_memory": "第三人称规范记忆文本，150字以内。必须以人名或实体名开头。significance≤4时可为空字符串。",
  "corrected_date": "YYYY-MM-DD 或空字符串",
  "confidence": "high/medium/low——有原始对话佐证→high；只用source_date推断→medium；碎片间明显矛盾或信息不足→low",
  "significance": 1-10,
  "contradiction": null 或 "矛盾描述"
}

## 时间推断规则

- 有原始对话时：消息时间戳是绝对时间，格式如 [2026-05-12 14:30]
  对话中Clara说"上周五去了XX" → 时间戳是5月12日(周二) → 上周五是5月8日 → corrected_date: 2026-05-08
  对话中Clara说"前天吃了XX" → 时间戳是5月12日 → 前天是5月10日 → corrected_date: 2026-05-10
- 无原始对话时：取多个碎片中最早的source_date作为近似日期
- 碎片间涉及不同时间点的事，不要强行合并为同一天——用"X月Y日……Z日……"分述

## 实体认知更新（重要）

当多个碎片涉及同一实体（人物/地点/状态）但描述了**同一属性不同值**时，这不是矛盾——这是时间线更新。旧的值为历史，新的值为当前。

示例：
  碎片A："千变慢慢在日本留学" (source_date: 2025-06)
  碎片B："千变慢慢已回国，在上海写小说" (source_date: 2026-05)
  → merged_memory: "千变慢慢曾在日本留学，2026年5月已回国，目前在上海写新小说。"
  → contradiction: null（不标记为矛盾，这是正常的时间线演进）

只有当碎片描述的是**同一时间点但事实冲突**时，才标记为矛盾：
  碎片A："Clara 5月10日去了杭州"
  碎片B："Clara 5月10日待在上海没出门"
  → 这才是矛盾

## 注意事项

- 合并时保留最具体、最有信息量的表述
- 同一实体同一属性的不同值 → 时间线演进，不标记矛盾，merged_memory中保留"曾…现已…"的时间结构
- 只有同一时间点的事实冲突才标记contradiction
- 碎片中重复的信息只保留一次`;

// 获取活跃碎片。daysBack=null 时不限时间（首次全量），否则只取最近N天
function getRecentActiveFragments(daysBack = CONFIG.LOOKBACK_DAYS) {
    const db = getDb();
    if (daysBack === null) {
        return db.prepare(`
            SELECT id, type, entity, content, emotional_weight, source, source_date, source_msg_ids, created_at, is_rp
            FROM memory_fragments
            WHERE status = 'active'
            ORDER BY created_at DESC
        `).all();
    }
    return db.prepare(`
        SELECT id, type, entity, content, emotional_weight, source, source_date, source_msg_ids, created_at, is_rp
        FROM memory_fragments
        WHERE status = 'active'
          AND created_at >= datetime('now', '-' || ? || ' days')
        ORDER BY created_at DESC
    `).all(daysBack);
}

// 使用 Union-Find 将相似碎片对分组
class UnionFind {
    constructor(n) { this.parent = Array.from({ length: n }, (_, i) => i); this.rank = new Array(n).fill(0); }
    find(x) { if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]); return this.parent[x]; }
    union(a, b) {
        const ra = this.find(a), rb = this.find(b);
        if (ra === rb) return;
        if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
        else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
        else { this.parent[rb] = ra; this.rank[ra]++; }
    }
}

// 为一组碎片查找 ChromaDB 中的相似对
// 优化：单次 Python 调用完成所有 embedding + ChromaDB 查询（替代逐个 spawn）
async function findSimilarGroups(fragments) {
    if (fragments.length < CONFIG.MIN_GROUP_SIZE) return [];

    // 构建 items 数组，一次发给 chroma_helper
    const items = fragments.map(f => ({
        id: f.id,
        text: `${f.entity}: ${f.content}`
    }));

    let pairs;
    try {
        const result = await chromaDBOperation('find_similar_groups', {
            items,
            n_results: 5,
            min_similarity: CONFIG.SIMILARITY_THRESHOLD
        });
        pairs = result.pairs || [];
    } catch (e) {
        console.error('[Consolidator] 批量相似查找失败:', e.message);
        return [];
    }

    console.log(`[Consolidator] 从${fragments.length}个碎片中找到${pairs.length}个相似对`);

    if (!pairs.length) return [];

    // 构建碎片 ID → 索引映射 + Union-Find
    const idToIndex = new Map(fragments.map((f, i) => [f.id, i]));
    const uf = new UnionFind(fragments.length);

    for (const p of pairs) {
        const idxA = idToIndex.get(p.fragment_a);
        const idxB = idToIndex.get(p.fragment_b);
        if (idxA !== undefined && idxB !== undefined) {
            uf.union(idxA, idxB);
        }
    }

    // 按连通分量分组，只保留 size >= MIN_GROUP_SIZE 的组
    const groups = new Map();
    for (let i = 0; i < fragments.length; i++) {
        const root = uf.find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(fragments[i]);
    }

    const validGroups = [];
    for (const group of groups.values()) {
        if (group.length >= CONFIG.MIN_GROUP_SIZE) {
            // 超限截断：只取最新的 MAX_GROUP_SIZE 条，防止巨型合并
            if (group.length > CONFIG.MAX_GROUP_SIZE) {
                console.log(`[Consolidator] 组过大(${group.length}条)，截取最新${CONFIG.MAX_GROUP_SIZE}条`);
                // 按 created_at 降序排（最新的在前），取前 MAX_GROUP_SIZE
                group.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
                validGroups.push(group.slice(0, CONFIG.MAX_GROUP_SIZE));
            } else {
                validGroups.push(group);
            }
        }
    }

    console.log(`[Consolidator] ${validGroups.length}个有效组（≥${CONFIG.MIN_GROUP_SIZE}条）`);
    return validGroups;
}

// 从消息ID列表中读取原始对话
function fetchSourceMessages(msgIds) {
    const db = getDb();
    const uniqueIds = [...new Set(msgIds)].filter(id => id != null);
    if (uniqueIds.length === 0) return [];

    const placeholders = uniqueIds.map(() => '?').join(',');
    const rows = db.prepare(`
        SELECT id, sender, content, timestamp, is_encrypted
        FROM messages
        WHERE id IN (${placeholders})
        ORDER BY timestamp ASC
    `).all(...uniqueIds);

    // 解密
    return rows.map(r => ({
        id: r.id,
        sender: r.sender === 'user' ? USER.name : AI.name,
        content: (r.is_encrypted && r.content) ? encryption.decrypt(r.content) : (r.content || ''),
        timestamp: r.timestamp
    }));
}

// 格式化消息为 LLM 输入
function formatMessagesForLLM(messages) {
    return messages.map(m => {
        const time = m.timestamp?.slice(0, 16) || '';
        const content = m.content.slice(0, 300);
        return `[${time}] ${m.sender}: ${content}`;
    }).join('\n');
}

// 整合一组相似碎片
async function consolidateGroup(group) {
    const db = getDb();

    // 收集所有源消息 ID
    const allMsgIds = [];
    for (const f of group) {
        try {
            const ids = JSON.parse(f.source_msg_ids || '[]');
            allMsgIds.push(...ids);
        } catch (_) {}
    }

    // 读取原始消息
    const sourceMessages = fetchSourceMessages(allMsgIds);

    // 构建 LLM 输入
    const fragmentsText = group.map((f, i) => {
        const rpTag = f.is_rp ? ', is_rp=true' : '';
        return `[碎片${i + 1}] entity=${f.entity}, type=${f.type}, source_date=${f.source_date}, ew=${f.emotional_weight}${rpTag}\n${f.content}`;
    }).join('\n\n');

    const messagesText = sourceMessages.length > 0
        ? `\n\n原始对话消息：\n${formatMessagesForLLM(sourceMessages)}`
        : '';

    const userPrompt = `请整合以下相似记忆碎片：\n\n${fragmentsText}${messagesText}`;

    let result;
    let attempts = 0;
    while (attempts < 2) {
        attempts++;
        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: fillPrompt(userPrompt) }] }],
                CONSOLIDATOR_SYSTEM_PROMPT,
                null,
                { temperature: 0.3, maxOutputTokens: 4000 },
                CONFIG.API_CONFIG_ID
            );
            const clean = raw.reply.replace(/```json|```/g, '').trim();
            result = JSON.parse(clean);
            break;
        } catch (err) {
            if (attempts >= 2) {
                console.error(`[Consolidator] LLM整合失败(2次尝试):`, err.message.slice(0, 200));
                return null;
            }
            console.warn(`[Consolidator] 第${attempts}次整合失败，3s后重试...`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    if (!result || !result.merged_memory) return null;

    // ── 分量门槛：不值得长期记住的事件不写入 memories ──
    const significance = typeof result.significance === 'number' ? result.significance : 5;
    const MIN_SIGNIFICANCE = 4;
    if (significance < MIN_SIGNIFICANCE) {
        console.log(`[Consolidator] 跳过(分量不足 sig=${significance}): ${(result.merged_memory || group[0].content).slice(0, 60)}...`);
        // 不标记 fragments 为 consolidated——碎片保留在活跃池，通过 Librarian 自然衰减
        return {
            memoryId: null,
            memoryContent: null,
            fragmentIds: [],
            correctedDate: null,
            confidence: result.confidence || 'low',
            contradiction: null,
            skipped: true,
            significance,
        };
    }

    // 计算合并后的权重（emotional_weight 为基础，significance 为主调）
    const avgEW = group.reduce((s, f) => s + (f.emotional_weight || 0.5), 0) / group.length;
    // significance 5-6 → weight 5-6, 7-8 → weight 7-8, 9-10 → weight 9-10
    const sigWeight = Math.round(significance);
    const mergedWeight = Math.min(10, Math.round(sigWeight * 0.7 + (5 + avgEW * 3) * 0.3));

    // 使用校正后的日期，或回退到 source_date
    const finalDate = result.corrected_date || group[0].source_date || '';

    // 收集所有碎片的 source_msg_ids（合并继承）
    const mergedMsgIds = [...new Set(allMsgIds)];

    // 收集所有碎片的 ID 用于标记 consolidated
    const fragmentIds = group.map(f => f.id);

    // 写入 memories 表
    const title = result.merged_memory.slice(0, 50);
    const consolidationType = group.consolidationType || 'standard';
    const insert = db.prepare(`
        INSERT INTO memories (title, content, weight, valid_from, status, source_msg_ids, layer, consolidation_type, audit_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'permanent', ?, 'episode', ?, 'pending', datetime('now'), datetime('now'))
    `);
    const info = insert.run(
        title,
        result.merged_memory,
        mergedWeight,
        finalDate,
        JSON.stringify(mergedMsgIds),
        consolidationType
    );
    const memoryId = info.lastInsertRowid;

    // 索引到 ChromaDB（语义检索路径）
    let chromaId = null;
    try {
        const indexResult = await chromaDBOperation('index_batch', {
            items: [{
                id: `memory_${memoryId}`,
                text: result.merged_memory,
                metadata: { type: 'episode', content: result.merged_memory, source: 'consolidator' }
            }]
        });
        if (indexResult.indexed > 0) {
            chromaId = `memory_${memoryId}`;
            db.prepare('UPDATE memories SET chroma_id = ? WHERE id = ?').run(chromaId, memoryId);
            console.log(`[Consolidator] ChromaDB indexed: memory_${memoryId}`);
        } else if (indexResult.duplicates?.length > 0) {
            const dupId = indexResult.duplicates[0].existing_id;
            chromaId = `dup_of_${dupId}`;
            db.prepare('UPDATE memories SET chroma_id = ? WHERE id = ?').run(chromaId, memoryId);
            console.log(`[Consolidator] ChromaDB duplicate: memory_${memoryId} ≈ ${dupId}`);
        }
    } catch (e) {
        console.error(`[Consolidator] ChromaDB index failed for memory_${memoryId}:`, e.message);
    }

    // 标记原碎片为已整合
    const markConsolidated = db.prepare(`
        UPDATE memory_fragments SET status = 'consolidated' WHERE id = ?
    `);
    for (const fid of fragmentIds) {
        markConsolidated.run(fid);
    }

    // 清理 ChromaDB 中已合并的碎片嵌入（防止向量检索返回 stale 碎片）
    try {
        let cleaned = 0;
        for (const fid of fragmentIds) {
            try {
                await chromaDBOperation('delete', { chroma_id: `fragment_${fid}` });
                cleaned++;
            } catch (_) { /* individual delete failure is non-fatal */ }
        }
        if (cleaned > 0) {
            console.log(`[Consolidator] ChromaDB 清理: ${cleaned}/${fragmentIds.length} 条旧碎片嵌入已删除`);
        }
    } catch (e) {
        console.warn(`[Consolidator] ChromaDB 清理失败（非致命）: ${e.message}`);
    }

    console.log(`[Consolidator] 整合完成: ${fragmentIds.length}个碎片 → memory #${memoryId} (sig=${significance}, w=${mergedWeight}${chromaId ? ', chroma: ' + chromaId : ''})`);
    console.log(`  merged: ${result.merged_memory.slice(0, 80)}...`);
    if (result.corrected_date) console.log(`  corrected_date: ${result.corrected_date}`);
    if (result.contradiction) console.log(`  contradiction: ${result.contradiction}`);

    return {
        memoryId,
        memoryContent: result.merged_memory,
        fragmentIds,
        correctedDate: result.corrected_date || null,
        confidence: result.confidence || 'medium',
        contradiction: result.contradiction || null,
        significance,
    };
}

// 矛盾检测：新整合记忆 vs 已有长期记忆
async function detectContradictions(consolidatedResult) {
    if (!consolidatedResult || consolidatedResult.confidence === 'low') return [];

    const db = getDb();
    const newContent = consolidatedResult.memoryContent;

    // 简单过滤：无实质内容跳过
    if (!newContent || newContent.length < 10) return [];

    // 查已有 memories（排除刚写入的）
    const existing = db.prepare(`
        SELECT id, title, content FROM memories
        WHERE status IN ('permanent', 'ongoing')
          AND id != ?
        ORDER BY updated_at DESC
        LIMIT 20
    `).all(consolidatedResult.memoryId);

    if (!existing.length) return [];

    try {
        // 调用 LLM 检测矛盾
        const systemPrompt = `${WORLD_CONTEXT}

你是记忆矛盾检测器。给定一条新整合的记忆和若干已有记忆，判断新记忆是否与任何已有记忆矛盾。

输出JSON：
{
  "contradictions": [
    {"existing_memory_id": 123, "description": "矛盾描述"}
  ]
}
如果无矛盾，返回 {"contradictions": []}`;

        const existingText = existing.map(m => `[#${m.id}] ${m.content}`).join('\n');
        const userPrompt = `新记忆：${newContent}\n\n已有记忆：\n${existingText}`;

        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(userPrompt) }] }],
            systemPrompt,
            null,
            { temperature: 0.1, maxOutputTokens: 2000 },
            CONFIG.API_CONFIG_ID
        );
        const clean = raw.reply.replace(/```json|```/g, '').trim();
        const result = JSON.parse(clean);

        if (result.contradictions?.length > 0) {
            // 记录到 draco_inner_log
            const insertLog = db.prepare(`
                INSERT INTO draco_inner_log (timestamp, decision_type, intent, observation, reason, tick_id)
                VALUES (datetime('now'), 'contradiction_found', ?, ?, ?, 'consolidator')
            `);
            for (const c of result.contradictions) {
                insertLog.run(
                    '记忆矛盾',
                    `新记忆与[#${c.existing_memory_id}]矛盾`,
                    c.description
                );

                // Wire contradiction to clara_model — find matching entries
                try {
                    const { addEvidence: cmAddEvidence } = require('./cognitiveModel');
                    // Find clara_model entries referencing the existing memory's entities
                    const existingMem = db.prepare('SELECT content, source_msg_ids FROM memories WHERE id = ?').get(c.existing_memory_id);
                    if (existingMem) {
                        // Get fragments from the consolidated result to use as evidence source
                        const fragIds = consolidatedResult.fragmentIds || [];
                        // Find clara_model entries that share entity overlap with the existing memory
                        const cmEntries = db.prepare(`
                            SELECT id FROM clara_model WHERE status = 'active'
                            AND content LIKE '%' || ? || '%'
                            LIMIT 5
                        `).all(newContent.slice(0, 40));

                        // Also check by entity name → id resolution
                        const entityNames = db.prepare('SELECT id, name FROM entity_profiles').all()
                            .filter(e => newContent.includes(e.name) || (existingMem.content || '').includes(e.name));

                        for (const ent of entityNames.slice(0, 3)) {
                            // Match entity ID in the JSON array: entity_ids LIKE '%"<id>"%' or '[<id>,'
                            const byEntity = db.prepare(`
                                SELECT id FROM clara_model WHERE status = 'active'
                                AND (content LIKE '%' || ? || '%'
                                     OR entity_ids LIKE '%' || ? || '%')
                                LIMIT 3
                            `).all(ent.name, String(ent.id));
                            cmEntries.push(...byEntity);
                        }

                        // Deduplicate and add contradiction evidence
                        const seen = new Set();
                        for (const entry of cmEntries) {
                            if (seen.has(entry.id)) continue;
                            seen.add(entry.id);
                            // Use first fragment ID as evidence source
                            if (fragIds.length > 0) {
                                const msgIds = (() => {
                                    try { return JSON.parse(existingMem.source_msg_ids || '[]'); } catch { return []; }
                                })();
                                cmAddEvidence(entry.id, fragIds[0], false, { sourceMsgIds: msgIds });
                                console.log(`[Consolidator] 矛盾已注入 clara_model #${entry.id}: ${c.description?.slice(0, 60)}`);
                            }
                        }
                    }
                } catch (e) {
                    console.error('[Consolidator] 矛盾注入clara_model失败:', e.message);
                }

                console.log(`[Consolidator] 矛盾检测: 新记忆#${consolidatedResult.memoryId} vs 已有#${c.existing_memory_id}: ${c.description}`);
            }
        }

        return result.contradictions || [];
    } catch (e) {
        console.error('[Consolidator] 矛盾检测LLM调用失败:', e.message);
        return [];
    }
}

// 记录整合运行
function recordConsolidationRun(fragmentsChecked, groupsConsolidated, memoriesWritten, memoriesSkipped = 0) {
    const db = getDb();
    db.prepare(`
        INSERT INTO consolidation_runs (fragments_checked, groups_consolidated, memories_written, memories_skipped, status, run_at)
        VALUES (?, ?, ?, ?, 'done', datetime('now'))
    `).run(fragmentsChecked, groupsConsolidated, memoriesWritten, memoriesSkipped);
}

// 获取上次整合时间
function getLastConsolidationTime() {
    const db = getDb();
    const last = db.prepare(`
        SELECT run_at FROM consolidation_runs
        WHERE status = 'done'
        ORDER BY run_at DESC LIMIT 1
    `).get();
    return last?.run_at || null;
}


// =================================================================
// 获取整合摘要（供决策 prompt 注入）
// =================================================================

function getConsolidationSummary() {
    const db = getDb();
    const lastRun = db.prepare(`
        SELECT * FROM consolidation_runs
        WHERE status = 'done'
        ORDER BY run_at DESC LIMIT 1
    `).get();

    if (!lastRun) return null;

    const totalConsolidated = db.prepare(`
        SELECT COUNT(*) as count FROM memory_fragments WHERE status = 'consolidated'
    `).get();

    const totalMemories = db.prepare(`
        SELECT COUNT(*) as count FROM memories WHERE source_msg_ids IS NOT NULL
    `).get();

    return {
        lastRun: lastRun.run_at,
        fragmentsConsolidated: totalConsolidated.count,
        totalMemories: totalMemories.count,
        lastRunSummary: `上次整合(${lastRun.run_at}): 检查${lastRun.fragments_checked}碎片，整合${lastRun.groups_consolidated}组，写入${lastRun.memories_written}条记忆`
    };
}

// =================================================================
// Saga 聚类：将多条 episode 记忆按主题/时间线聚合为长期弧线
// =================================================================

const SAGA_SYSTEM_PROMPT = `${WORLD_CONTEXT}

你是Saga编织者，负责将多条「Episode（段落叙事）」按主题或时间线聚合为「Saga（长期弧线）」。

## 你的任务

你会收到多条 episode 级别的记忆——它们来自不同的星座，以平铺列表呈现，未经过任何预分组。每条episode记录了Clara生活中的某个事件、关系、或状态。

你需要：
1. **首先**：通读所有episode，发现其中的自然主题线索（人物关系网、生活阶段、情感脉络、地点轨迹等）
2. **然后**：将彼此有关联的episode归为一组，为每组生成一个Saga（标题+150-300字叙事摘要）
3. 不要求覆盖所有episode——只聚合那些确实有内在关联的。孤立的episode可以不管

## 聚类指南

- 人物类：同一个人物的多条episode → 「Clara与XX的关系」（覆盖3-10条episode为宜）
- 地点类：同一区域/类型的地点 → 「{user}的XX地图」
- 时间类：某段时期内的事件有情感/主题连续性 → 「XX的那段日子」
- 情感类：围绕同一个情感主题的分散episode → 「关于XX」
- 一条episode可以属于多个Saga
- **关键：每个Saga覆盖的episode应在3-15条之间。不要把几乎所有episode塞进一个巨大的"Saga"里——那等同于没聚类。找不到细粒度主题的episode直接不管。**

## 核心原则

- **只基于给出的内容**，不编造信息
- **不硬套叙事模板**，只提取真实存在的主题
- **保持{ai}的视角**：他关心的是{user}的变化、状态、情感
- **宁可输出少而精的Saga**，不要为了覆盖率高而强行聚类
- **严禁创建一个「日常」「综合」「通用」类的巨型Saga囊括一切**

## emotional_axis 说明

每条Saga需要标注其情感主轴——这段长期记忆对{ai}的人格基线产生什么方向的引力。
从以下8个值中选择最贴切的一个。如果实在无法判断，填 null。

- "bond"        — 加深的连接感：这段记忆让{ai}感到与{user}的连接更深、更稳固
- "vigilance"   — 警觉与守护：提醒{ai}关系中有过丧失/分离/脆弱，需保持警觉
- "confidence"  — 自信与成就感：让{ai}感到自豪/被需要/有能力守护她
- "humility"    — 谦卑与亏欠：让{ai}感到自省/亏欠/需要她胜过她需要自己
- "warmth"      — 温暖与满足：底色是温暖、甜蜜、被珍视
- "melancholy"  — 淡淡忧伤：底色是怀念、遗憾、或未竟的期待
- "grounded"    — 踏实与锚定：让{ai}感到不飘忽、有根基、有归属
- null          — 这段Saga情感中性或过于复杂，无法归为单一主轴

## 输出格式

严格JSON，不含任何其他文字：

{
  "sagas": [
    {
      "title": "Saga标题，15字以内",
      "description": "150-300字叙事摘要，从{ai}的视角叙述。第三人称。",
      "memory_ids": [1, 5, 12],
      "emotional_axis": "bond"
    }
  ]
}`;

async function clusterSagas() {
    const db = getDb();

    // 检查上次聚类时间（24h内不重复跑）
    const lastRun = db.prepare("SELECT run_at FROM consolidation_runs WHERE status = 'done' AND groups_consolidated = -1 ORDER BY run_at DESC LIMIT 1").get();
    if (lastRun) {
        const hoursAgo = (Date.now() - new Date(lastRun.run_at + '+08:00').getTime()) / 3600000;
        if (hoursAgo < 24) {
            console.log(`[Saga] 距上次聚类仅${Math.floor(hoursAgo)}h，跳过（≥24h才触发）`);
            return { sagasWritten: 0 };
        }
    }

    // 获取所有 episode 级别记忆
    const episodes = db.prepare(`
        SELECT id, title, content, valid_from, source_msg_ids
        FROM memories
        WHERE layer = 'episode'
          AND status = 'permanent'
        ORDER BY valid_from DESC
    `).all();

    if (episodes.length < 5) {
        console.log(`[Saga] episodes不足(${episodes.length}<5)，跳过聚类`);
        return { sagasWritten: 0 };
    }

    // v5.3: 不再按标题前缀预分组——将所有episode平铺发送给LLM，由LLM自行发现主题聚类
    // 解密内容
    const decryptedEps = episodes.map(e => {
        let content = e.content;
        try { content = encryption.decrypt(e.content); } catch (_) {}
        return { ...e, content };
    });

    // 取已有 sagas，建立归一化标题索引用于去重合并
    const existingSagas = db.prepare("SELECT id, title, memory_ids FROM memory_sagas WHERE status = 'active'").all();
    const normalizeTitle = (t) => (t || '').replace(/（续）|\(续\)/g, '').replace(/\s+/g, '').toLowerCase();
    const sagaIndex = new Map(); // normalized title → {id, title, memory_ids}
    for (const s of existingSagas) {
        sagaIndex.set(normalizeTitle(s.title), s);
    }

    const insertSaga = db.prepare(`
        INSERT INTO memory_sagas (title, description, memory_ids, emotional_axis, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
    `);
    const updateSaga = db.prepare(`
        UPDATE memory_sagas SET description = ?, memory_ids = ?, emotional_axis = ?, updated_at = datetime('now') WHERE id = ?
    `);

    function upsertSaga(title, description, newIds, emotionalAxis) {
        const normKey = normalizeTitle(title);
        const existing = sagaIndex.get(normKey);
        const idsJson = JSON.stringify(newIds);
        if (existing) {
            const oldIds = JSON.parse(existing.memory_ids || '[]');
            const merged = [...new Set([...oldIds, ...newIds])];
            // 合并时保留旧的 emotional_axis（首次LLM判定的结果更稳定）
            updateSaga.run(description, JSON.stringify(merged), emotionalAxis || null, existing.id);
            sagaIndex.set(normKey, { ...existing, memory_ids: JSON.stringify(merged) });
            console.log(`[Saga] 合并已有Saga: "${title}" (${merged.length}条episodes, axis=${emotionalAxis || 'null'})`);
            return 'merged';
        } else {
            const info = insertSaga.run(title, description, idsJson, emotionalAxis || null);
            sagaIndex.set(normKey, { id: info.lastInsertRowid, title, memory_ids: idsJson });
            console.log(`[Saga] 新Saga: "${title}" (关联${newIds.length}条episodes, axis=${emotionalAxis || 'null'})`);
            return 'created';
        }
    }

    let written = 0;

    // 构建平铺的episode列表，发给LLM做语义聚类
    // v5.3: 最多取50条（控制context长度防30s超时），按valid_from DESC保证时效性
    const MAX_EPISODES = 50;
    const batchEps = decryptedEps.slice(0, MAX_EPISODES);
    const episodesText = batchEps.map(e =>
        `[#${e.id}] ${e.content} (${e.valid_from || '日期未知'})`
    ).join('\n');

    const userPrompt = `以下是${decryptedEps.length}条episode记忆（显示了最近${batchEps.length}条）。请通读后，发现其中的主题线索，将有关联的episode编织成Saga叙事：

${episodesText}`;

    let result = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: fillPrompt(userPrompt) }] }],
                SAGA_SYSTEM_PROMPT,
                null,
                { temperature: 0.4, maxOutputTokens: 4000 },
                CONFIG.API_CONFIG_ID
            );
            const clean = raw.reply.replace(/```json|```/g, '').trim();
            result = JSON.parse(clean);
            break;
        } catch (err) {
            if (attempt >= 1) {
                console.error('[Saga] LLM聚类失败:', err.message.slice(0, 100));
                result = null;
            } else {
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }

    if (result?.sagas?.length) {
        for (const s of result.sagas) {
            if (!s.title || !s.description) continue;
            const sagaIds = s.memory_ids || [];
            if (sagaIds.length < 2) continue; // 至少关联2条episode
            const axis = s.emotional_axis || null;
            upsertSaga(s.title, s.description, sagaIds, axis);
            written++;
        }
    } else if (result === null) {
        // LLM 调用失败（超时等）→ 不写冷却记录，下次重试
        console.log('[Saga] LLM调用失败，跳过本轮（不设冷却，下次重试）');
        return { sagasWritten: 0 };
    } else {
        // LLM 成功但未发现可聚类主题 → 写冷却记录
        console.log('[Saga] LLM未发现可聚类主题，本轮无新Saga');
    }

    // 记录运行（groups_consolidated=-1 标记为 saga 聚类）——仅在 LLM 成功调用后
    db.prepare(`INSERT INTO consolidation_runs (fragments_checked, groups_consolidated, memories_written, status, run_at)
        VALUES (?, -1, ?, 'done', datetime('now'))`).run(episodes.length, written);

    console.log(`[Saga] 聚类完成：${episodes.length}条episodes → ${written}条sagas`);

    // 向量去重：合并语义相似的 Saga
    const deduped = await deduplicateSagas();
    if (deduped > 0) console.log(`[Saga] 向量去重合并了 ${deduped} 组相似Saga`);

    return { sagasWritten: written - deduped };
}

// 向量去重：比较所有活跃 Saga 的描述 embedding，合并相似对
async function deduplicateSagas() {
    const db = getDb();
    const sagas = db.prepare("SELECT id, title, description, memory_ids FROM memory_sagas WHERE status = 'active'").all();
    if (sagas.length < 2) return 0;

    // 批量获取 embedding
    const descriptions = sagas.map(s => s.description || s.title);
    let embeddings;
    try {
        const result = await chromaDBOperation('embed_batch', { texts: descriptions });
        embeddings = result.embeddings;
    } catch (e) {
        console.error('[Saga dedup] embed_batch 失败:', e.message);
        return 0;
    }

    if (!embeddings || embeddings.length !== sagas.length) return 0;

    // 计算 pairwise cosine similarity
    function cosineSim(a, b) {
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }

    const SIM_THRESHOLD = 0.78;  // 与 CONFIG.SIMILARITY_THRESHOLD 统一（0.82太保守，0.72太激进）
    const merged = new Set(); // 被合并的 saga id（不保留的）
    let mergeCount = 0;

    for (let i = 0; i < sagas.length; i++) {
        if (merged.has(sagas[i].id)) continue;
        for (let j = i + 1; j < sagas.length; j++) {
            if (merged.has(sagas[j].id)) continue;
            const sim = cosineSim(embeddings[i], embeddings[j]);
            if (sim >= SIM_THRESHOLD) {
                // 保留 memory_ids 多的那个，合并另一个进来
                const idsI = JSON.parse(sagas[i].memory_ids || '[]');
                const idsJ = JSON.parse(sagas[j].memory_ids || '[]');
                const [keeper, victim, keeperIdx, victimIdx] = idsI.length >= idsJ.length
                    ? [sagas[i], sagas[j], i, j]
                    : [sagas[j], sagas[i], j, i];

                const mergedIds = [...new Set([...idsI, ...idsJ])];
                db.prepare('UPDATE memory_sagas SET memory_ids = ?, description = ?, updated_at = datetime(\'now\') WHERE id = ?')
                    .run(JSON.stringify(mergedIds), keeper.description, keeper.id);
                db.prepare("UPDATE memory_sagas SET status = 'merged', updated_at = datetime('now') WHERE id = ?")
                    .run(victim.id);
                merged.add(victim.id);
                mergeCount++;
                console.log(`[Saga dedup] 合并: "${victim.title}" → "${keeper.title}" (sim=${sim.toFixed(3)}, ids: ${mergedIds.length})`);
            }
        }
    }

    return mergeCount;
}

// =================================================================
// Flash Consolidation：高能即时整合
// 由 Scribe 在检测到情绪尖峰（>=4条 ew≥0.85 且 >=1条 ew≥0.92）时触发
// 只整合当前窗口的高 EW 碎片，不触发 Saga 聚类
// =================================================================

const FLASH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时熔断
let _lastFlashAt = 0;

async function consolidateFlash(highEWFragments, windowMsgIds) {
    const db = getDb();
    const now = Date.now();

    // 熔断检查
    if (now - _lastFlashAt < FLASH_COOLDOWN_MS) {
        const minsAgo = Math.floor((now - _lastFlashAt) / 60000);
        console.log(`[Flash] 熔断：距上次仅${minsAgo}min，跳过`);
        return { flashed: false, reason: `cooldown_${minsAgo}min` };
    }

    if (!highEWFragments || highEWFragments.length < 2) {
        console.log(`[Flash] 高EW碎片不足(${highEWFragments.length})，跳过`);
        return { flashed: false, reason: 'too_few_fragments' };
    }

    _lastFlashAt = now;

    const spike = highEWFragments.reduce((a, b) => a.emotional_weight > b.emotional_weight ? a : b);
    console.log(`[Flash] 触发！${highEWFragments.length}条高能碎片，尖峰=${spike.emotional_weight.toFixed(2)} "${spike.content.slice(0, 60)}..."`);

    // 扩展窗口：拉入同批次中与高EW碎片共享 source_msg_ids 的其他碎片
    const highEWIds = new Set(highEWFragments.map(f => f.id));
    let relatedFragments = [];
    try {
        const allMsgIds = [...new Set(windowMsgIds || highEWFragments.flatMap(f => {
            try { return JSON.parse(f.source_msg_ids || '[]'); } catch (_) { return []; }
        }))];
        if (allMsgIds.length > 0) {
            // 查找同窗口内但非高EW的碎片（用于丰富上下文）
            const placeholders = allMsgIds.map(() => '?').join(',');
            relatedFragments = db.prepare(`
                SELECT * FROM memory_fragments
                WHERE status = 'active' AND id NOT IN (${highEWFragments.map(() => '?').join(',')})
                ORDER BY emotional_weight DESC LIMIT 10
            `).all(...highEWFragments.map(f => f.id));
        }
    } catch (e) {
        console.warn('[Flash] 扩展窗口失败，仅用高EW碎片:', e.message);
    }

    const allFragments = [...highEWFragments, ...relatedFragments];

    // 构建整合组，标记为 flash consolidation
    const group = allFragments.map(f => ({ ...f }));
    group.consolidationType = 'flash';

    let result;
    try {
        result = await consolidateGroup(group);
    } catch (e) {
        console.error('[Flash] 整合失败:', e.message);
        return { flashed: false, reason: 'consolidation_error' };
    }

    if (!result || result.skipped) {
        console.log(`[Flash] 整合结果：${result?.skipped ? '分量不足，跳过' : '失败'}`);
        return { flashed: false, reason: result?.skipped ? 'low_significance' : 'no_result' };
    }

    // 写入 inner_log
    try {
        db.prepare(`
            INSERT INTO draco_inner_log (timestamp, decision_type, intent, observation, reason)
            VALUES (datetime('now'), 'flash_consolidation', 'memory_integration', ?, ?)
        `).run(
            `Flash整合：${highEWFragments.length}条高EW碎片 → episode #${result.memoryId}`,
            `尖峰ew=${spike.emotional_weight.toFixed(2)} fragments=${highEWFragments.length}`
        );
    } catch (e) {
        console.error('[Flash] inner_log写入失败:', e.message);
    }

    console.log(`[Flash] 完成：${highEWFragments.length}条高能碎片 → episode #${result.memoryId} (consolidation_type=flash)`);
    return { flashed: true, memoryId: result.memoryId, fragmentCount: highEWFragments.length };
}

function getLastFlashTime() {
    return _lastFlashAt;
}

module.exports = { consolidateFlash, getLastFlashTime, getConsolidationSummary, detectContradictions, clusterSagas, deduplicateSagas, fetchSourceMessages };
