// =================================================================
// 冥想盆：记忆检索系统（硬触发 + 向量检索 + ChromaDB操作）
// =================================================================

const { getDb } = require('../database');
const { encryption } = require('../encryption');

// ChromaDB 常驻服务地址
const CHROMA_URL = 'http://127.0.0.1:7707';

// =================================================================
// ChromaDB 操作（HTTP 调用 chroma_service.py 常驻服务）
// =================================================================

async function chromaDBOperation(action, data) {
    const resp = await fetch(`${CHROMA_URL}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    const result = await resp.json();
    if (result.error) throw new Error(result.error);
    return result;
}

// =================================================================
// 多 Collection 批量查询（供 Librarian 双路召回）
// =================================================================
async function queryMultiCollections(queries) {
    if (!queries || queries.length === 0) return [];
    const result = await chromaDBOperation('query_multi', { queries });
    return result.results || [];
}

// =================================================================
// 硬触发检索：检查用户消息是否包含记忆库中的标签
// =================================================================

function searchMemoriesByHardTrigger(userMessage) {
    if (!userMessage) return [];

    try {
        const db = getDb();
        const allMemories = db.prepare(`
            SELECT id, content, tags, status, valid_from, valid_to
            FROM memories
            WHERE tags IS NOT NULL AND tags != '[]'
              AND status IN ('permanent', 'ongoing')
        `).all();

        const matchedMemories = [];
        const today = new Date().toISOString().split('T')[0];

        for (const memory of allMemories) {
            let tags = [];
            try { tags = JSON.parse(memory.tags); } catch (e) { continue; }

            const isMatch = tags.some(tag => userMessage.includes(tag));

            if (isMatch) {
                if (memory.valid_from && memory.valid_from > today) continue;

                try {
                    memory.content = encryption.decrypt(memory.content);
                    matchedMemories.push(memory);
                } catch (err) {
                    console.error(`Memory ID ${memory.id} decryption failed`, err);
                }
            }
        }
        return matchedMemories;
    } catch (error) {
        console.error('searchMemoriesByHardTrigger error:', error);
        return [];
    }
}

// =================================================================
// 本地 Embedding（HTTP 调用 chroma_service）
// =================================================================

async function getLocalEmbedding(text) {
    const resp = await fetch(`${CHROMA_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
    });
    const result = await resp.json();
    if (result.embedding) return result.embedding;
    throw new Error(result.error || 'No embedding in response');
}

// =================================================================
// 向量检索：本地 embedding + ChromaDB 查询
// =================================================================

async function searchMemoriesByVector(query, nResults = 3) {
    try {
        // 1. 本地生成 query embedding
        const queryEmbedding = await getLocalEmbedding(query);
        console.log('searchMemoriesByVector: query="' + query.substring(0, 60) + '" dim:', queryEmbedding?.length);

        if (!queryEmbedding || queryEmbedding.length === 0) {
            console.log('searchMemoriesByVector: embedding generation failed');
            return [];
        }

        // 2. HTTP 调用 chroma_service 查询
        const pythonResult = await chromaDBOperation('query', {
            embedding: queryEmbedding,
            n_results: nResults,
            query_text: query,
            min_similarity: 0.20,
        });

        const db = getDb();

        // 3. 计算每个结果的相似度（1 - distance）
        const resultIds = pythonResult.ids[0] || [];
        const resultDistances = pythonResult.distances?.[0] || [];
        console.log(`searchMemoriesByVector: ChromaDB returned ${resultIds.length} results, similarities: [${resultDistances.map(d => (1-d).toFixed(3)).join(', ')}]`);
        const idToSimilarity = {};
        for (let i = 0; i < resultIds.length; i++) {
            idToSimilarity[resultIds[i]] = 1 - resultDistances[i];
        }

        // v5.3: 重新启用 episode（memories 表）向量检索
        // v5.0 退役是因为旧 episode 来自废弃知识树。v5.3 consolidateCategory
        // 改为从 entity_profiles 星座产出，新 episode 质量可靠且已重新索引 ChromaDB
        const fragmentIds = [];
        const memoryIds = [];

        for (const id of resultIds) {
            if (id.startsWith('fragment_')) fragmentIds.push(id.replace('fragment_', ''));
            else if (id.startsWith('memory_')) memoryIds.push(id.replace('memory_', ''));
        }

        if (resultIds.length === 0) return [];

        const results = [];

        // 查 memory_fragments 表（只返回 active，consolidated 不走向量路径）
        if (fragmentIds.length > 0) {
            const placeholders = fragmentIds.map(() => '?').join(',');
            const fragments = db.prepare(`SELECT * FROM memory_fragments WHERE id IN (${placeholders}) AND status = 'active'`).all(...fragmentIds);
            const staleCount = fragmentIds.length - fragments.length;
            if (staleCount > 0) {
                console.log(`searchMemoriesByVector: 过滤 ${staleCount} 条已合并/非活跃碎片 (ChromaDB stale entries)`);
            }
            for (const f of fragments) {
                const chromaId = `fragment_${f.id}`;
                results.push({ _table: 'fragments', _similarity: idToSimilarity[chromaId] || 0, ...f });
            }
        }

        // 查 memories 表（只返回 episode + permanent，旧冥想盆历史条目不纳入）
        if (memoryIds.length > 0) {
            const placeholders = memoryIds.map(() => '?').join(',');
            const episodes = db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders}) AND layer = 'episode' AND status = 'permanent'`).all(...memoryIds);
            for (const m of episodes) {
                try { m.content = encryption.decrypt(m.content); } catch (_) {}
                try { m.title = encryption.decrypt(m.title); } catch (_) {}
                const chromaId = `memory_${m.id}`;
                results.push({ _table: 'memories', _similarity: idToSimilarity[chromaId] || 0, ...m });
            }
        }

        // 按相似度降序
        results.sort((a, b) => (b._similarity || 0) - (a._similarity || 0));

        return results;

    } catch (error) {
        console.error('searchMemoriesByVector error:', error.message);
        return [];
    }
}

// ChromaDB 陈旧条目清理：删除 status != 'active' 但仍残留在 ChromaDB 的碎片嵌入
async function cleanupStaleChromaEntries() {
    const db = getDb();
    // Find fragments with status != 'active' that likely still have ChromaDB entries
    const stale = db.prepare(`
        SELECT id, chroma_id FROM memory_fragments
        WHERE status != 'active' AND chroma_id IS NOT NULL
        LIMIT 50
    `).all();

    if (stale.length === 0) return { cleaned: 0 };

    let cleaned = 0;
    for (const s of stale) {
        try {
            await chromaDBOperation('delete', { chroma_id: `fragment_${s.id}` });
            db.prepare('UPDATE memory_fragments SET chroma_id = NULL WHERE id = ?').run(s.id);
            cleaned++;
        } catch (_) { /* non-fatal */ }
    }

    if (cleaned > 0) {
        console.log(`[Memory] ChromaDB 陈旧清理: ${cleaned}/${stale.length} 条`);
    }
    return { cleaned, scanned: stale.length };
}

module.exports = {
    chromaDBOperation,
    queryMultiCollections,
    searchMemoriesByHardTrigger,
    searchMemoriesByVector,
    cleanupStaleChromaEntries,
    getLocalEmbedding
};
