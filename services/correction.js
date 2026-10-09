// =================================================================
// Correction（纠正闭环）：用户纠正 → 教训 → Scribe 注入
// =================================================================
// 两条闭环共用 correction_log 表：
//   ① correct_memory 工具 → processChatCorrection → 定位错源、修记忆、记账
//   ② recordCorrection 攒到 MERGE_THRESHOLD → mergeGuidelines → 长期准则 → Scribe 注入
//
// ⚠️ correction_log.status 只表示「合并生命周期」（active → merged）。
//    「这条纠正是否已做过级联降权」是另一件事，必须另开列记账——
//    把两件事塞进同一个 status 会让两边互相掐死（一方处理完就把行移出 active，
//    另一方永远攒不到阈值）。见 README 的架构说明。

const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { chromaDBOperation } = require('./memory');
const { fillPrompt, USER } = require('./nameResolver');

const CORRECTION_CONFIG = {
    // 归因判断用哪个模型配置：字符串=按名称查，数字=按 id 查，null=用 is_default=1 的配置。
    // 新库没有内置的 api_configs id，留 null 即可（跑 scripts/setup_llm.js 建默认配置）。
    API_CONFIG_ID: null,
    ACTIVE_LIMIT: 5,        // Scribe 注入最近 N 条活跃教训
    MERGE_THRESHOLD: 10,    // 累积 N 条 → 合并为长期准则
};

// 写入一条纠正
function recordCorrection({ targetType, targetId, wrongSummary, correctSummary, source = 'manual', chatMessageId = null }) {
    const db = getDb();
    const insert = db.prepare(`
        INSERT INTO correction_log (target_type, target_id, wrong_summary, correct_summary, source, chat_message_id, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
    `);
    const info = insert.run(targetType, targetId || null, wrongSummary, correctSummary, source, chatMessageId);
    console.log(`[Correction] 记录纠正 #${info.lastInsertRowid}: ${wrongSummary.slice(0, 50)} → ${correctSummary.slice(0, 50)}`);

    // 观星手记可见化：聊天自动纠正写入 changelog（手动删除已有自己的可见路径）
    if (source === 'chat_correction') {
        try {
            db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status) VALUES ('memory_correction', NULL, ?, 'done')`)
                .run(JSON.stringify({
                    wrong: (wrongSummary || '').slice(0, 80),
                    correct: (correctSummary || '').slice(0, 80),
                    target: targetType,
                }));
        } catch (e) { /* changelog 失败不影响纠正主流程 */ }
    }

    // 如果被纠正的记忆在 memories 表中，降权
    if (targetType === 'memory' && targetId) {
        db.prepare("UPDATE memories SET weight = MAX(1, weight * 0.3), updated_at = datetime('now') WHERE id = ?").run(targetId);
        console.log(`[Correction] 记忆 #${targetId} 已降权 ×0.3`);
    }
    if (targetType === 'fragment' && targetId) {
        db.prepare("UPDATE memory_fragments SET status = 'consolidated' WHERE id = ?").run(targetId);
        console.log(`[Correction] 碎片 #${targetId} 已标记 consolidated`);
    }

    // 检查是否需要合并
    const activeCount = db.prepare("SELECT COUNT(*) as c FROM correction_log WHERE status='active'").get();
    if (activeCount.c >= CORRECTION_CONFIG.MERGE_THRESHOLD) {
        console.log(`[Correction] 活跃纠正已达 ${activeCount.c} 条，触发合并...`);
        // 异步合并，不阻塞请求
        mergeGuidelines().catch(e => console.error('[Correction] 合并失败:', e.message));
    }

    return info.lastInsertRowid;
}

// 获取最近活跃纠正教训（供 Scribe 注入）
function getActiveCorrections(limit = CORRECTION_CONFIG.ACTIVE_LIMIT) {
    const db = getDb();
    const rows = db.prepare(`
        SELECT wrong_summary, correct_summary FROM correction_log
        WHERE status = 'active'
        ORDER BY created_at DESC LIMIT ?
    `).all(limit);

    if (!rows.length) return null;

    return rows.map(r =>
        `- 错误：${r.wrong_summary} → 正确：${r.correct_summary}`
    ).join('\n');
}

// 合并活跃纠正为长期准则
async function mergeGuidelines() {
    const db = getDb();
    const rows = db.prepare("SELECT id, wrong_summary, correct_summary FROM correction_log WHERE status='active'").all();
    if (rows.length < CORRECTION_CONFIG.MERGE_THRESHOLD) return null;

    const itemsText = rows.map(r => `- wrong: ${r.wrong_summary}\n  correct: ${r.correct_summary}`).join('\n');

    const systemPrompt = `你是编辑准则合并器。将多条纠正教训归纳为3-5条"长期编辑准则"，每条一句话（不超过40字），去重合并同类项。

输出JSON：{"guidelines": ["准则1", "准则2", ...]}`;

    let guidelines = [];
    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: `请合并以下纠正教训为编辑准则：\n\n${itemsText}` }] }],
            systemPrompt,
            null,
            { temperature: 0.3, maxOutputTokens: 1000 },
            CORRECTION_CONFIG.API_CONFIG_ID
        );
        const clean = raw.reply.replace(/```json|```/g, '').trim();
        const result = JSON.parse(clean);
        guidelines = result.guidelines || [];
    } catch (e) {
        console.error('[Correction] LLM合并失败，使用原文:', e.message);
        guidelines = rows.map(r => `${r.wrong_summary} → ${r.correct_summary}`);
    }

    // 写入 user_settings
    const { setUserSetting } = require('../utils/settings');
    await setUserSetting('scribe_guidelines', JSON.stringify({
        guidelines,
        merged_at: new Date().toISOString(),
        merged_from: rows.length
    }));

    // 标记已合并
    const mark = db.prepare("UPDATE correction_log SET status='merged' WHERE status='active'");
    mark.run();

    console.log(`[Correction] 合并完成：${rows.length}条 → ${guidelines.length}条长期准则`);
    return guidelines;
}

// 获取长期准则（供 Scribe 注入）
async function getMergedGuidelines() {
    const { getUserSetting } = require('../utils/settings');
    const setting = await getUserSetting('scribe_guidelines');
    if (!setting?.value) return null;

    try {
        const parsed = JSON.parse(setting.value);
        if (parsed.guidelines?.length) {
            return parsed.guidelines.map((g, i) => `${i + 1}. ${g}`).join('\n');
        }
    } catch (_) {}
    return null;
}

// =================================================================
// 聊天修正：{{ai.name}} 调 correct_memory 工具 → 小模型定位源记忆 → 执行修正
// =================================================================

async function createCoreFragment(content, chatId) {
    const db = getDb();
    const info = db.prepare(`
        INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, source_msg_ids, layer, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        'correction',
        USER.name,
        content,
        0.7,
        'chat_correction',
        '[]',
        'event',
        'active'
    );
    const fragId = info.lastInsertRowid;
    console.log(`[Correction] 写入修正 fragment #${fragId}`);

    try {
        await chromaDBOperation('index_batch', {
            items: [{
                id: `fragment_${fragId}`,
                text: `${USER.name}: ${content}`,
                metadata: { type: 'correction', entity: USER.name, content, source: 'chat_correction', fragment_id: fragId }
            }]
        });
        console.log(`[Correction] ChromaDB indexed: fragment_${fragId}`);
    } catch (e) {
        console.error(`[Correction] ChromaDB 索引失败 fragment_${fragId}:`, e.message);
    }

    return fragId;
}

async function judgeCorrectionSource(wrongStatement, correction, candidates) {
    const candLines = candidates.map((c, i) =>
        `[${i}] id=${c.id} source_table=${c.source_table}\n内容: ${c.content}`
    ).join('\n\n');

    // 只有模板串过 fillPrompt；下面拼进去的是用户/记忆原文，不能再走 fillPrompt
    // （原文里出现 {user} 之类的字面量会被误替换）。
    const systemPrompt = fillPrompt(`你是记忆修正判断器。给定：
1. 一条错误陈述（{{ai.name}}说的话）
2. 正确的版本（{{user.name}}的纠正）
3. 若干候选记忆条目

判断：错误陈述是否来源于某条候选记忆？
- 如果是 → 指出是哪条（id），并生成修正后的内容（保持原记忆的第三人称风格）
- 如果不是 → 标记为 hallucination

输出严格JSON：{"matched": true/false, "memory_id": null或数字, "source_table": "fragment"或"memory"或null, "corrected_content": "修正后的记忆内容（第三人称）", "explanation": "简短中文判断理由"}`);

    const userPrompt = `错误陈述：「${wrongStatement}」
正确版本：「${correction}」

候选记忆：
${candLines || '（无候选记忆）'}`;

    let reply;
    try {
        const res = await callLLM(
            [{ role: 'user', parts: [{ text: userPrompt }] }],
            systemPrompt,
            null,
            { temperature: 0.2, maxOutputTokens: 1024 },
            CORRECTION_CONFIG.API_CONFIG_ID
        );
        reply = res.reply;
    } catch (e) {
        console.error('[Correction] 归因判断调用失败:', e.message);
        return { matched: false, memory_id: null, source_table: null, corrected_content: correction, explanation: 'LLM调用失败，按幻听处理' };
    }

    try {
        const json = JSON.parse(reply.replace(/```json\s*|\s*```/g, '').trim());
        return {
            matched: Boolean(json.matched),
            memory_id: json.memory_id || null,
            source_table: json.source_table || null,
            corrected_content: json.corrected_content || correction,
            explanation: json.explanation || ''
        };
    } catch (e) {
        console.error('[Correction] JSON解析失败:', reply.slice(0, 200));
        return { matched: false, memory_id: null, source_table: null, corrected_content: correction, explanation: '解析失败，按幻听处理' };
    }
}

async function processChatCorrection({ wrongStatement, correction, memoryId, chatId }) {
    // 参数护栏：缺参数时直接把话说回去。否则下面的 wrongStatement.slice 会抛
    // TypeError，工具结果喂不回上下文，表现为{{ai.name}}「说完就沉默」。
    if (!wrongStatement || !correction) {
        return { success: false, formatted: '需要同时给出 wrong_statement（说错的那句）和 correction（正确版本）。' };
    }

    const db = getDb();
    const candidates = [];

    // 1. 收集候选记忆
    // 1a. 传了 memoryId → 查 DB
    if (memoryId) {
        let record = db.prepare('SELECT id, content, \'memory\' AS source_table FROM memory_valid_episodes AS memories WHERE id = ?').get(memoryId);
        if (!record) {
            record = db.prepare('SELECT id, content, \'fragment\' AS source_table FROM memory_visible_fragments AS memory_fragments WHERE id = ?').get(memoryId);
        }
        if (record) {
            candidates.push(record);
        }
    }

    // 1b. 工作记忆池
    try {
        const { getRecentFragments } = require('./workingMemory');
        const recent = getRecentFragments();
        const seen = new Set(candidates.map(c => `${c.source_table}-${c.id}`));
        for (const r of recent) {
            const key = `${r.source_table}-${r.id}`;
            if (!seen.has(key)) {
                seen.add(key);
                candidates.push({ id: r.id, content: r.content, source_table: r.source_table });
            }
        }
        console.log(`[Correction] 工作记忆池候选: ${recent.length} 条`);
    } catch (e) {
        console.error('[Correction] 工作记忆池查询失败:', e.message);
    }

    // 1c. 向量搜索补位
    try {
        const { searchMemoriesByVector } = require('./memory');
        const vecResults = await searchMemoriesByVector(wrongStatement, 5);
        const seen = new Set(candidates.map(c => `${c.source_table}-${c.id}`));
        for (const v of vecResults) {
            const sourceTable = v._table === 'fragments' ? 'fragment' : 'memory';
            const key = `${sourceTable}-${v.id}`;
            if (!seen.has(key)) {
                seen.add(key);
                candidates.push({ id: v.id, content: v.content || v.title, source_table: sourceTable });
            }
        }
        console.log(`[Correction] 向量搜索候选: ${vecResults.length} 条`);
    } catch (e) {
        console.error('[Correction] 向量搜索失败:', e.message);
    }

    console.log(`[Correction] 候选记忆共 ${candidates.length} 条（wrong="${wrongStatement.slice(0, 60)}", correction="${correction.slice(0, 60)}"）`);

    // 2. 纯幻觉：无候选
    if (candidates.length === 0) {
        console.log('[Correction] 无候选记忆 → 纯幻觉');
        const fragId = await createCoreFragment(correction, chatId);
        recordCorrection({ targetType: 'hallucination', targetId: null, wrongSummary: wrongStatement, correctSummary: correction, source: 'chat_correction', chatMessageId: chatId });
        return {
            success: true,
            formatted: `记忆库里没有找到相关的记忆——你刚才说的「${wrongStatement.slice(0, 50)}」很可能是你自己编造或混淆的。我已将正确版本存为新记忆 #${fragId}。`
        };
    }

    // 3. 小模型判断
    const judgment = await judgeCorrectionSource(wrongStatement, correction, candidates);
    console.log(`[Correction] 判断结果: matched=${judgment.matched} id=${judgment.memory_id} ${judgment.explanation}`);

    if (judgment.matched && judgment.memory_id) {
        const sourceTable = judgment.source_table === 'memory' ? 'memory' : 'fragment';
        if (sourceTable === 'fragment') {
            db.prepare(`UPDATE memory_fragments SET status = 'cooling', lifecycle_updated_at = datetime('now') WHERE id = ?`).run(judgment.memory_id);
        } else {
            db.prepare(`UPDATE memories SET layer = 'cooling' WHERE id = ?`).run(judgment.memory_id);
        }
        console.log(`[Correction] 标记 ${sourceTable}[${judgment.memory_id}] 为 cooling`);

        const fragId = await createCoreFragment(judgment.corrected_content, chatId);
        recordCorrection({ targetType: sourceTable, targetId: judgment.memory_id, wrongSummary: wrongStatement, correctSummary: correction, source: 'chat_correction', chatMessageId: chatId });

        return {
            success: true,
            formatted: `记忆修正完成。找到了你说错的来源——记忆 #${judgment.memory_id}（${judgment.explanation || '内容有误'}）。已将那条记忆标记为降温，并写入了修正后的新记忆 #${fragId}。`
        };
    }

    // 未命中 → 幻听
    const fragId = await createCoreFragment(judgment.corrected_content || correction, chatId);
    recordCorrection({ targetType: 'hallucination', targetId: null, wrongSummary: wrongStatement, correctSummary: correction, source: 'chat_correction', chatMessageId: chatId });

    return {
        success: true,
        formatted: `记忆库中有 ${candidates.length} 条可能相关的记忆，但经过比对，你刚才说的似乎是自己编造或混淆的（${judgment.explanation || '找不到确切的来源记忆'}）。我已将正确版本存为新记忆 #${fragId}。`
    };
}

module.exports = { recordCorrection, getActiveCorrections, mergeGuidelines, getMergedGuidelines, processChatCorrection };
