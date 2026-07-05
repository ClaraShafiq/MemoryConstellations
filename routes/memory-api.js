// routes/memory-api.js
// 冥想盆记忆 CRUD + Embedding配置 + LLM配置 + 标签提取
// 从 index.js 拆出

const express = require('express');
const { getDb } = require('../database');
const { encryption } = require('../encryption');
const { requireAuth } = require('./auth');
const { getEmbedding, getEmbeddingAPIKey } = require('../services/llm');
const { chromaDBOperation } = require('../services/memory');

const router = express.Router();

// ── 时区转换：UTC → 上海时间 HH:MM ──
function toShanghaiHHMM(utcStr) {
    if (!utcStr) return '';
    try {
        const d = new Date(utcStr + (utcStr.endsWith('Z') ? '' : 'Z'));
        if (isNaN(d.getTime())) return utcStr.slice(11, 16) || '';
        return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
    } catch (_) {
        return utcStr.slice(11, 16) || '';
    }
}

// ========== 记忆 CRUD ==========

// POST /api/memory - 新增记忆
router.post('/api/memory', requireAuth, async (req, res) => {
    const db = getDb();
    const { title, content, tags, status, valid_from, valid_to } = req.body;
    console.log('📥 收到的请求数据:', { title, content, tags, status });
    
    try {
        if (!title || !content) {
            return res.status(400).json({ error: "Title and content are required" });
        }
        
        const encryptedContent = encryption.encrypt(content);
        const tagsJSON = JSON.stringify(tags || []);
        
        const stmt = db.prepare(
            `INSERT INTO memories (title, content, tags, status, valid_from, valid_to, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        );
        const result = stmt.run(title, encryptedContent, tagsJSON, status || 'permanent', valid_from || null, valid_to || null);
        
        const memoryId = result.lastInsertRowid;
        console.log(`📝 Memory saved to DB: id=${memoryId}`);
        
        // 生成embedding向量
        const embeddingConfig = await getEmbeddingAPIKey();
        const embeddingText = `${title}\n${content}`;
        let embedding;
        
        try {
            embedding = await getEmbedding(embeddingText, embeddingConfig);
            console.log(`🧠 Embedding generated: ${embedding.length} dimensions`);
        } catch (embError) {
            console.error("⚠️ Embedding generation failed, but memory saved:", embError);
            return res.json({
                success: true,
                id: memoryId,
                warning: "Memory saved but embedding failed"
            });
        }
        
        // 存入ChromaDB
        try {
            await chromaDBOperation('add', {
                id: `memory_${memoryId}`,
                embedding: embedding,
                metadata: {
                    memory_id: Number(memoryId),
                    title: title,
                    tags: (tags || []).join(','),
                    status: status || 'permanent',
                    created_at: new Date().toISOString()
                }
            });

            console.log(`✅ Memory added to ChromaDB: memory_${memoryId}`);
            db.prepare('UPDATE memories SET chroma_id = ? WHERE id = ?').run(`memory_${memoryId}`, memoryId);

        } catch (chromaError) {
            console.error("⚠️ ChromaDB save failed, but memory saved:", chromaError);
            return res.json({
                success: true,
                id: memoryId,
                warning: "Memory saved but vector storage failed"
            });
        }
        
        res.json({
            success: true,
            id: memoryId,
            message: "Memory saved successfully"
        });
        
    } catch (error) {
        console.error("❌ POST /api/memory error:", error);
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/memory/:id - 编辑记忆（智能向量更新）
router.put('/api/memory/:id', requireAuth, async (req, res) => {
    const db = getDb();
    const memoryId = req.params.id;
    const { title, content, tags, status, valid_from, valid_to } = req.body;
    
    try {
        const oldMemory = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(memoryId);
        
        if (!oldMemory) {
            return res.status(404).json({ error: "Memory not found" });
        }
        
        const oldContent = encryption.decrypt(oldMemory.content);
        const oldTitle = oldMemory.title;
        const contentChanged = (oldContent !== content) || (oldTitle !== title);
        
        const encryptedContent = encryption.encrypt(content);
        const tagsJSON = JSON.stringify(tags || []);
        
        db.prepare(
            `UPDATE memories 
             SET title = ?, content = ?, tags = ?, status = ?, valid_from = ?, valid_to = ?, updated_at = datetime('now')
             WHERE id = ?`
        ).run(title, encryptedContent, tagsJSON, status || 'permanent', valid_from || null, valid_to || null, memoryId);
        
        console.log(`📝 Memory updated in DB: id=${memoryId}`);
        
        if (contentChanged) {
            console.log(`🔄 Content changed, regenerating embedding for memory ${memoryId}...`);
            
            const embeddingText = `${title}\n${content}`;
            let embedding;
            
            try {
                embedding = await getEmbedding(embeddingText);
                console.log(`🧠 Embedding regenerated: ${embedding.length} dimensions`);
            } catch (embError) {
                console.error("⚠️ Embedding generation failed:", embError);
                return res.json({
                    success: true,
                    warning: "Memory updated but embedding failed"
                });
            }
            
            try {
                await chromaDBOperation('update', {
                    id: `memory_${memoryId}`,
                    embedding: embedding,
                    metadata: {
                        memory_id: Number(memoryId),
                        title: title,
                        tags: (tags || []).join(','),
                        status: status || 'permanent',
                        updated_at: new Date().toISOString()
                    }
                });

                console.log(`✅ Memory vector updated in ChromaDB: memory_${memoryId}`);
                db.prepare('UPDATE memories SET chroma_id = ? WHERE id = ?').run(`memory_${memoryId}`, memoryId);
                
            } catch (chromaError) {
                console.error("⚠️ ChromaDB update failed:", chromaError);
                return res.json({
                    success: true,
                    warning: "Memory updated but vector storage failed"
                });
            }
        } else {
            console.log(`✅ Content unchanged, skipping embedding regeneration for memory ${memoryId}`);
        }
        
        res.json({
            success: true,
            message: "Memory updated successfully"
        });
        
    } catch (error) {
        console.error(`❌ PUT /api/memory/${memoryId} error:`, error);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/memories - 获取记忆列表（支持TAG和日期筛选）
router.get('/api/memories', requireAuth, async (req, res) => {
    const db = getDb();
    const { tags, status, created_date } = req.query;

    try {
        let query = `SELECT id, title, tags, status, valid_from, valid_to, created_at, updated_at
                     FROM memories`;
        const params = [];
        const conditions = [];

        if (status) {
            conditions.push('status = ?');
            params.push(status);
        }
        if (created_date) {
            conditions.push("created_at LIKE ?");
            params.push(created_date + '%');
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }
        query += ' ORDER BY created_at DESC';

        const memories = db.prepare(query).all(...params);

        const memoriesWithTags = memories.map(m => ({
            ...m,
            tags: JSON.parse(m.tags || '[]')
        }));

        let filteredMemories = memoriesWithTags;
        if (tags) {
            const filterTags = tags.split(',').map(t => t.trim());
            filteredMemories = memoriesWithTags.filter(m =>
                filterTags.some(ft => m.tags.includes(ft))
            );
        }

        console.log(`📚 Retrieved ${filteredMemories.length} memories`);
        res.json({ memories: filteredMemories });

    } catch (error) {
        console.error("❌ GET /api/memories error:", error);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/memories/months — 获取记忆月份列表
router.get('/api/memories/months', requireAuth, (req, res) => {
    const db = getDb();
    try {
        const months = db.prepare(`
            SELECT substr(created_at, 1, 7) as month, COUNT(*) as count
            FROM memories
            GROUP BY month
            ORDER BY month DESC
        `).all();
        res.json({ months });
    } catch (e) {
        console.error('[memories API] 月份列表失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════
// GET /api/memory/universe — 星空可视化全量数据
// 必须在 /api/memory/:id 之前注册，否则 Express 把 "universe" 当作 :id
// ═══════════════════════════════════════════════════════
router.get('/api/memory/universe', requireAuth, (req, res) => {
    try {
        const db = getDb();

        // ── v4.7 星座 = 活跃实体档案（按星系分组）──
        const GALAXY_COLORS = {
            person: '#ff9966', pet: '#ff9966', organization: '#ff9966',
            place: '#6699ff',
            event: '#66cc99',
            project: '#cc99ff', work: '#cc99ff', term: '#cc99ff',
            hobby: '#ffcc66', consumed: '#ffcc66',
            music_aggregate: '#ffcc66', book_aggregate: '#ffcc66', movie_aggregate: '#ffcc66'
        };
        const { USER, AI, UI } = require('../services/memoryConfig');
        const GALAXY_LABELS = { person:'社交', pet:'社交', organization:'社交', place:'地点', event:'事件', project: USER.name + '的', work: USER.name + '的', term: USER.name + '的', hobby:'爱好', consumed:'爱好', music_aggregate:'爱好', book_aggregate:'爱好', movie_aggregate:'爱好' };

        const entities = db.prepare(`
            SELECT ep.id, ep.name, ep.category, ep.subcategory, ep.overview, ep.fragment_count,
                   ep.related_entities, ep.current_status, ep.status as lifecycle_status,
                   ep.updated_at, ep.created_at, ep.relationship_to_clara, ep.aliases, ep.tags,
                   ep.entity_type
            FROM entity_profiles ep
            WHERE ep.status = 'active' AND ep.fragment_count > 0
            ORDER BY
                CASE ep.category WHEN 'person' THEN 0 WHEN 'pet' THEN 1 WHEN 'place' THEN 2
                    WHEN 'event' THEN 3 WHEN 'project' THEN 4 ELSE 5 END,
                ep.fragment_count DESC
        `).all();

        // 子分类派生：从 entity_type + relationship_to_clara 提取，不再靠 LLM 猜
        function deriveSubcategory(ent) {
            // pet 直接按 category
            if (ent.category === 'pet') return 'pet';
            // person: 从 entity_type 和 relationship 派生
            if (ent.category === 'person') {
                const et = ent.entity_type || '';
                if (et === 'public_figure') return 'celebrity';
                if (et === 'fictional_character') return 'fictional';
                const rel = (ent.relationship_to_clara || '').toLowerCase();
                if (/母亲|父亲|妈妈|爸爸|女儿|儿子|家人|亲戚|家属/.test(rel)) return 'family';
                if (/朋友|好友|闺蜜|死党|伙伴|老朋友/.test(rel)) return 'friend';
                if (/网友|线上|群友|小红书.*认识/.test(rel)) return 'online';
                return null;  // 不确定就不填
            }
            // place/event/project/work/term: entity_type 暂未覆盖，留 NULL
            return null;
        }
        // 为每个实体计算派生子分类
        for (const ent of entities) {
            ent.subcategory = deriveSubcategory(ent);
        }

        // v5 双星核心：不作为普通星座，单独返回档案
        const CORE_NAMES = [USER.name, AI.name];
        const coreEntities = entities.filter(e => CORE_NAMES.includes(e.name));
        const normalEntities = entities.filter(e => !CORE_NAMES.includes(e.name));

        const core = coreEntities.map(ent => ({
            id: 'e' + ent.id,
            name: ent.name,
            overview: ent.overview || '',
            fragment_count: ent.fragment_count,
            relationship: ent.relationship_to_clara || '',
            currentStatus: ent.current_status || '',
            updatedAt: ent.updated_at,
            color: ent.name === USER.name ? UI.user_color : UI.ai_color,
            role: ent.name === USER.name ? 'user' : 'ai',
        }));

        // Build constellations: each entity = one constellation with its linked fragments as stars
        const maxFrags = Math.max(1, ...normalEntities.map(e => e.fragment_count || 0));

        // 衰减λ按情绪权重四档（与 Librarian segmentedDecay 同语义）：
        // 高情绪记忆亮得久，琐事快速变暗
        const ewLambda = (ew) => {
            if (ew >= 0.8) return 0.005;   // 半衰期 ~139天
            if (ew >= 0.6) return 0.01;    // ~69天
            if (ew >= 0.4) return 0.02;    // ~35天
            return 0.04;                   // ~17天
        };

        const constellations = normalEntities.map(ent => {
            const frags = db.prepare(`
                SELECT mf.id, COALESCE(mf.content, '') AS title, mf.content,
                       mf.emotional_weight, mf.created_at AS date, mf.status AS lifecycle,
                       CAST(julianday('now') - julianday(COALESCE(mf.last_accessed_at, mf.created_at)) AS REAL) AS days_since_access,
                       mf.read_count,
                       mf.entity_id, fe.confidence AS link_confidence, fe.relation
                FROM memory_fragments mf
                JOIN fragment_entities fe ON fe.fragment_id = mf.id
                WHERE fe.entity_id = ? AND mf.status IN ('active', 'consolidated', 'cooling', 'frozen')
                ORDER BY
                    CASE mf.status WHEN 'active' THEN 0 WHEN 'consolidated' THEN 1 WHEN 'cooling' THEN 2 ELSE 3 END,
                    fe.confidence DESC, mf.emotional_weight DESC
                LIMIT 40
            `).all(ent.id);

            const depth = 0.4 + (ent.fragment_count / maxFrags) * 1.2;

            const stars = frags.map(f => {
                const daysSince = Math.max(0, f.days_since_access || 0);
                const λ = ewLambda(f.emotional_weight || 0.3);
                const decay = Math.exp(-λ * daysSince);
                // read_count = Librarian 检索命中次数（聊天里被想起 → 星星更亮）
                const recallBonus = Math.min(0.3, Math.log(1 + (f.read_count || 0)) * 0.08);
                let brightness = Math.min(1.0, decay + recallBonus);
                // 生命周期硬上限：冷却的星不可能亮，冻结的星接近熄灭
                if (f.lifecycle === 'cooling') brightness = Math.min(brightness, 0.30);
                else if (f.lifecycle === 'frozen') brightness = Math.min(brightness, 0.12);
                const mag = +(6.5 - brightness * 5.5).toFixed(1);
                return {
                    id: 'f' + f.id,
                    title: (f.title || '').slice(0, 40) || '…',
                    content: (f.content || '').slice(0, 200),
                    conf: brightness,
                    mag,
                    lifecycle: f.lifecycle,
                    date: f.date?.slice(0, 10) || '',
                    entity_id: f.entity_id,
                    relation: f.relation || null,
                };
            });
            const coolingCount = stars.filter(s => s.lifecycle !== 'active').length;

            // v5.3: 星座的记忆叙事片段（episodes）
            // 旧 episode 可能是加密的，需解密后再截取
            const episodes = db.prepare(`
                SELECT id, title, content, weight, valid_from AS date
                FROM memories
                WHERE layer = 'episode' AND status = 'permanent' AND entity_id = ?
                ORDER BY weight DESC, valid_from DESC
                LIMIT 8
            `).all(ent.id).map(ep => {
                let content = ep.content || '';
                try { content = encryption.decrypt(content); } catch (_) {}
                let title = ep.title || '';
                try { title = encryption.decrypt(title); } catch (_) {}
                return {
                    id: ep.id,
                    title: title.slice(0, 60),
                    content: content.slice(0, 250),
                    weight: ep.weight,
                    date: ep.date?.slice(0, 10) || '',
                };
            });

            const cat = ent.category || 'person';
            return {
                id: 'e' + ent.id,
                label: ent.name,
                description: ent.overview || '',
                color: GALAXY_COLORS[cat] || '#8899aa',
                depth,
                fragment_count: ent.fragment_count,
                stars,
                episodes,
                // Entity-specific fields
                category: cat,
                subcategory: ent.subcategory || '',
                galaxyLabel: GALAXY_LABELS[cat] || cat,
                aliases: safeJsonParse(ent.aliases) || [],
                tags: safeJsonParse(ent.tags) || [],
                lifecycleStatus: ent.lifecycle_status,
                coolingCount,
                relatedEntities: safeJsonParse(ent.related_entities) || [],
                relationship: ent.relationship_to_clara || '',
                currentStatus: ent.current_status || '',
                updatedAt: ent.updated_at,
                createdAt: ent.created_at,
            };
        });

        // ── Clara Model 认知模型 ──
        const cognitiveModel = db.prepare(`
            SELECT id, type, content, confidence, evidence_count,
                   decay_type, status, last_evidence_at, created_at, decay_params, tags, priority,
                   created_by, expires_at
            FROM clara_model
            WHERE status = 'active'
            ORDER BY
                CASE type
                    WHEN 'immutable_fact' THEN 1
                    WHEN 'stable_trait' THEN 2
                    WHEN 'current_state' THEN 3
                    WHEN 'active_hypothesis' THEN 4
                END,
                confidence DESC
        `).all().map(e => ({
            ...e,
            tags: safeJsonParse(e.tags) || [],
        }));

        // ── 观星手记 = Archivist 最近活动 ──
        const archlog = db.prepare(`
            SELECT created_at AS time, action, category_path, detail, status
            FROM ontology_changelog
            WHERE action != 'merge_proposal'  -- 提案有独立的「Draco的疑问」面板
            ORDER BY created_at DESC LIMIT 15
        `).all().map(r => {
            const detail = safeJsonParse(r.detail);
            let text = '';
            let color = '#8ab4ff';
            switch (r.action) {
                case 'emergent_constellation':
                    text = `🌟 新星座诞生：<strong>"${detail?.name || '?'}"</strong> — ${(detail?.reason || '').slice(0, 80)}`;
                    color = '#ffd580';
                    break;
                case 'seed_merge':
                    text = `🔗 合并星座：<strong>"${detail?.victim || '?'}"</strong> 并入 "${detail?.survivor || '?'}"`;
                    color = '#c4a3f5';
                    break;
                case 'seed_unmerge':
                    text = `↩️ 撤销误合并：<strong>"${detail?.restored || '?'}"</strong> 恢复独立`;
                    color = '#ffd580';
                    break;
                case 'entity_bridges':
                    text = `🌉 发现 <strong>${detail?.count || '?'}</strong> 对星座关联`;
                    color = '#8ab4ff';
                    break;
                case 'episode_audit': {
                    const v = detail?.verdict;
                    const emoji = v === 'fabricated' ? '⚠️' : v === 'confirmed' ? '✅' : '🔍';
                    text = `${emoji} 记忆审计：${v === 'fabricated' ? '发现编造记忆' : v === 'confirmed' ? '确认记忆真实' : '审计'}`;
                    if (detail?.reason) text += ` — ${detail.reason.slice(0, 60)}`;
                    color = v === 'fabricated' ? '#ff9d8a' : '#5ee8b0';
                    break;
                }
                case 'consolidate_category':
                    text = `📝 整理了 <strong>"${r.category_path || '?'}"</strong> 的记忆碎片`;
                    color = '#5ee8b0';
                    break;
                case 'auto_merge':
                case 'merge_executed':
                    text = `合并重叠类别：<strong>"${detail?.victim || '?'}"</strong> → "${detail?.survivor || '?'}"`;
                    color = '#c4a3f5';
                    break;
                case 'category_created':
                    text = `💡 发现新主题：<strong>"${r.category_path || '?'}"</strong>`;
                    color = '#ffd580';
                    break;
                case 'deep_cycle':
                    text = `🌙 深循环完成：LLM <strong>${detail?.llm_calls || '?'}</strong> 次，未分类 ${detail?.unclassified_remaining ?? '?'}，种子 ${detail?.seeds_remaining ?? '?'}`;
                    color = '#8ab4ff';
                    break;
                case 'classify':
                    text = `🪐 分类碎片：<strong>${detail?.count || '?'}</strong> 条归入 ${detail?.constellations || '?'} 个星座`;
                    color = '#5ee8b0';
                    break;
                case 'rematch':
                    text = `🔗 字面回补：<strong>${detail?.count || '?'}</strong> 条碎片归位`;
                    color = '#89c4ff';
                    break;
                case 'semantic_rematch':
                    text = `🔮 语义回补：<strong>${detail?.count || '?'}</strong> 条描述性提及归位`;
                    color = '#b8a9ff';
                    break;
                case 'insights':
                    text = `💭 碎片洞察：提取 <strong>${detail?.count || '?'}</strong> 条行为模式`;
                    color = '#ffb3d4';
                    break;
                case 'entity_relation':
                    text = `👤 更新人物关系：<strong>${detail?.entity_name || '?'}</strong>`;
                    color = '#ffb3d4';
                    break;
                case 'memory_correction':
                    text = `✏️ 修正记忆：<strong>"${(detail?.wrong || '?').slice(0, 40)}"</strong> → "${(detail?.correct || '?').slice(0, 40)}"`;
                    color = '#ff9d8a';
                    break;
                default:
                    text = `${r.action}: ${r.category_path || (typeof detail === 'object' ? JSON.stringify(detail).slice(0, 80) : '')}`;
                    color = '#8ab4ff';
            }
            return {
                time: toShanghaiHHMM(r.time),
                color,
                text,
                fullTime: r.time,
            };
        });

        // ── 待确认合并提案（Draco 提案，Clara 裁决）──
        const mergeProposals = db.prepare(`
            SELECT id, category_path, detail, created_at
            FROM ontology_changelog
            WHERE action = 'merge_proposal' AND status = 'pending'
            ORDER BY created_at DESC LIMIT 20
        `).all().map(r => ({ id: r.id, ...((safeJsonParse(r.detail)) || {}), createdAt: r.created_at }));

        // ── v5.2: Patterns (accumulated behavioral observations) ──
        const patterns = db.prepare(`
            SELECT id, content, category, evidence_count, first_seen, last_seen, confidence, status, tags
            FROM clara_patterns WHERE status = 'active'
            ORDER BY confidence DESC
        `).all().map(p => ({
            ...p,
            tags: safeJsonParse(p.tags) || [],
        }));

        res.json({
            constellations,
            core,
            cognitiveModel,
            patterns,
            archlog,
            mergeProposals,
            entities: constellations.map(c => ({ id: c.id, name: c.label, category: c.category, overview: c.description, fragmentIds: c.stars.map(s => s.id) })),
            total_fragments: constellations.reduce((s, c) => s + c.stars.length, 0),
            total_categories: constellations.length,
        });

    } catch (e) {
        console.error('[universe API] failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/memory/:id - 获取单个记忆详情
router.get('/api/memory/:id', requireAuth, async (req, res) => {
    const db = getDb();
    const memoryId = req.params.id;
    
    try {
        const memory = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(memoryId);
        
        if (!memory) {
            return res.status(404).json({ error: "Memory not found" });
        }
        
        const decryptedContent = encryption.decrypt(memory.content);
        const tags = JSON.parse(memory.tags || '[]');

        // 显式查看 = 访问记录，供生命周期衰减用
        try {
            db.prepare("UPDATE memories SET last_accessed_at = datetime('now') WHERE id = ?").run(memoryId);
        } catch (_) {}

        res.json({
            ...memory,
            content: decryptedContent,
            tags: tags
        });
        
    } catch (error) {
        console.error(`❌ GET /api/memory/${memoryId} error:`, error);
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════
// v4.8: 合并提案裁决 — Clara 人工确认/拒绝
// POST /api/memory/merge-proposal/:id  body: { decision: 'approve' | 'reject' }
// ═══════════════════════════════════════════════════════

router.post('/api/memory/merge-proposal/:id', requireAuth, (req, res) => {
    const db = getDb();
    const proposalId = parseInt(req.params.id);
    const { decision } = req.body || {};

    try {
        const row = db.prepare(`
            SELECT id, detail FROM ontology_changelog
            WHERE id = ? AND action = 'merge_proposal' AND status = 'pending'
        `).get(proposalId);
        if (!row) return res.status(404).json({ error: 'proposal not found or already decided' });

        const detail = safeJsonParse(row.detail) || {};

        if (decision === 'approve') {
            // 碎片多者存活；同数则名字短者存活
            const aFc = detail.a_fc || 0, bFc = detail.b_fc || 0;
            const [survivorId, victimId] = (aFc > bFc ||
                (aFc === bFc && (detail.a_name || '').length <= (detail.b_name || '').length))
                ? [detail.a_id, detail.b_id] : [detail.b_id, detail.a_id];
            const { executeEntityMerge } = require('../services/archivist');
            const ok = executeEntityMerge(survivorId, victimId);
            if (!ok) return res.status(500).json({ error: 'merge execution failed' });
            db.prepare(`UPDATE ontology_changelog SET status = 'approved' WHERE id = ?`).run(proposalId);
            return res.json({ ok: true, merged: true });
        }
        if (decision === 'reject') {
            // rejected 状态留底——mergeDuplicateSeeds 不会对同一对重复提案
            db.prepare(`UPDATE ontology_changelog SET status = 'rejected' WHERE id = ?`).run(proposalId);
            return res.json({ ok: true, merged: false });
        }
        return res.status(400).json({ error: 'decision must be approve or reject' });
    } catch (e) {
        console.error('[merge-proposal] failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════
// v5.0: 核心洞察 — Clara 手动编辑
// ═══════════════════════════════════════════════════════

router.get('/api/memory/core-insight', requireAuth, async (req, res) => {
    try {
        const { getUserSetting } = require('../utils/settings');
        const insight = await getUserSetting('clara_core_insight') || '';
        const updatedAt = await getUserSetting('clara_core_insight_updated_at') || '';
        res.json({ ok: true, insight, updated_at: updatedAt });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/memory/core-insight', requireAuth, async (req, res) => {
    try {
        const { insight } = req.body || {};
        if (typeof insight !== 'string') return res.status(400).json({ error: 'insight required' });
        const { getUserSetting, setUserSetting } = require('../utils/settings');
        // Archive current version
        const current = await getUserSetting('clara_core_insight');
        let history = [];
        try { history = JSON.parse(await getUserSetting('clara_core_insight_history') || '[]'); } catch (_) {}
        if (current && current !== insight) {
            history.push({ content: current, archived_at: new Date().toISOString(), source: 'clara_manual' });
            if (history.length > 5) history = history.slice(-5);
        }
        await setUserSetting('clara_core_insight', insight);
        await setUserSetting('clara_core_insight_history', JSON.stringify(history));
        await setUserSetting('clara_core_insight_updated_at', new Date().toISOString());
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════
// v5.0: 手动解除碎片-实体链接
// ═══════════════════════════════════════════════════════

router.post('/api/memory/unlink-fragment', requireAuth, (req, res) => {
    try {
        const { entity_id, fragment_id } = req.body || {};
        if (!entity_id || !fragment_id) return res.status(400).json({ error: 'entity_id and fragment_id required' });
        const db = getDb();
        const r = db.prepare('DELETE FROM fragment_entities WHERE entity_id=? AND fragment_id=?').run(entity_id, fragment_id);
        if (r.changes === 0) {
            // Already unlinked — still success
            return res.json({ ok: true, already: true });
        }
        // Update fragment_count
        db.prepare(`UPDATE entity_profiles SET fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id=?), updated_at=datetime('now') WHERE id=?`).run(entity_id, entity_id);
        console.log(`[memory-api] 🔗 手动解除: fragment #${fragment_id} ← entity #${entity_id}`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════
// v4.7: 溯源链路 — 碎片 → 源消息
// GET /api/memory/trace/:fragmentId
// ═══════════════════════════════════════════════════════

router.get('/api/memory/trace/:fragmentId', requireAuth, (req, res) => {
    const db = getDb();
    const fragmentId = parseInt(req.params.fragmentId);

    try {
        // 1. Get the fragment
        const fragment = db.prepare(`
            SELECT mf.*, (SELECT GROUP_CONCAT(ep.name, ', ') FROM fragment_entities fe
                JOIN entity_profiles ep ON ep.id = fe.entity_id WHERE fe.fragment_id = mf.id) as entity_names
            FROM memory_fragments mf WHERE mf.id = ?
        `).get(fragmentId);

        if (!fragment) {
            return res.status(404).json({ error: 'Fragment not found' });
        }

        // 2. Get source messages if available
        let sourceMessages = [];
        try {
            const msgIds = JSON.parse(fragment.source_msg_ids || '[]');
            if (msgIds.length > 0) {
                const placeholders = msgIds.map(() => '?').join(',');
                sourceMessages = db.prepare(`
                    SELECT id, sender, content, timestamp, chat_id
                    FROM messages WHERE id IN (${placeholders})
                    ORDER BY timestamp
                `).all(...msgIds);
            }
        } catch (_) {}

        // 3. Get context messages (2 before, 2 after) if source messages exist
        let contextMessages = [];
        if (sourceMessages.length > 0) {
            const firstMsg = sourceMessages[0];
            const lastMsg = sourceMessages[sourceMessages.length - 1];
            try {
                // Before
                const before = db.prepare(`
                    SELECT id, sender, content, timestamp FROM messages
                    WHERE chat_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 2
                `).all(firstMsg.chat_id, firstMsg.timestamp).reverse();
                // After
                const after = db.prepare(`
                    SELECT id, sender, content, timestamp FROM messages
                    WHERE chat_id = ? AND timestamp > ? ORDER BY timestamp LIMIT 2
                `).all(lastMsg.chat_id, lastMsg.timestamp);
                contextMessages = [...before, ...after];
            } catch (_) {}
        }

        // 4. Get entity timeline for this fragment
        const timeline = db.prepare(`
            SELECT et.*, ep.name as entity_name FROM entity_timeline et
            JOIN entity_profiles ep ON ep.id = et.entity_id
            WHERE et.fragment_id = ? ORDER BY et.created_at DESC LIMIT 20
        `).all(fragmentId);

        // Record access
        db.prepare(`UPDATE memory_fragments SET last_accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?`).run(fragmentId);

        res.json({
            fragment: {
                id: fragment.id,
                type: fragment.type,
                entity: fragment.entity,
                content: fragment.content,
                emotional_weight: fragment.emotional_weight,
                source: fragment.source,
                source_date: fragment.source_date,
                layer: fragment.layer,
                insight: fragment.insight,
                entityNames: fragment.entity_names,
                accessCount: fragment.access_count,
                lastAccessedAt: fragment.last_accessed_at,
                createdAt: fragment.created_at,
            },
            sourceMessages,
            contextMessages,
            timeline,
        });
    } catch (e) {
        console.error('[trace API] failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/memory/:id - 删除记忆
router.delete('/api/memory/:id', requireAuth, async (req, res) => {
    const db = getDb();
    const memoryId = req.params.id;
    
    try {
        const existing = db.prepare(`SELECT id, title, content, source_msg_ids FROM memories WHERE id = ?`).get(memoryId);

        if (!existing) {
            return res.status(404).json({ error: "Memory not found" });
        }

        // 写入纠正日志（删除即纠正信号）
        try {
            db.prepare(`INSERT INTO correction_log (target_type, target_id, wrong_summary, correct_summary, source, status, created_at)
                VALUES ('memory', ?, ?, '', 'manual', 'active', datetime('now'))`).run(
                memoryId, existing.title
            );
        } catch (logErr) {
            console.error('⚠️ correction_log写入失败:', logErr.message);
        }

        db.prepare(`DELETE FROM memories WHERE id = ?`).run(memoryId);
        console.log(`🗑️ Memory deleted from DB: id=${memoryId}`);
        
        try {
            await chromaDBOperation('delete', { id: `memory_${memoryId}` });
            console.log(`✅ Memory vector deleted from ChromaDB: memory_${memoryId}`);
        } catch (chromaError) {
            console.error("⚠️ ChromaDB delete failed, but memory deleted:", chromaError);
            return res.json({
                success: true,
                warning: "Memory deleted but vector removal failed"
            });
        }
        
        res.json({
            success: true,
            message: "Memory deleted successfully"
        });
        
    } catch (error) {
        console.error(`❌ DELETE /api/memory/${memoryId} error:`, error);
        res.status(500).json({ error: error.message });
    }
});

// ========== Embedding 配置 ==========

// 获取当前embedding配置
router.get('/api/embedding-config', requireAuth, (req, res) => {
    try {
        const db = getDb();
        const config = db.prepare(`
            SELECT id, name, model_name, provider, endpoint, created_at 
            FROM api_configs 
            WHERE model_name LIKE '%embedding%'
            AND (provider = 'gemini' OR provider = 'openai_compatible')
            LIMIT 1
        `).get();
        
        if (config) {
            res.json({ 
                source: 'database',
                exists: true,
                model_name: config.model_name,
                provider: config.provider,
                endpoint: config.endpoint,
                configured_at: config.created_at
            });
        } else {
            res.json({ 
                source: 'environment',
                exists: false 
            });
        }
    } catch (error) {
        console.error('获取embedding配置失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 测试embedding连接
router.post('/api/test-embedding', requireAuth, async (req, res) => {
    const { api_key, model_name, provider, endpoint } = req.body;
    
    if (!api_key || !model_name) {
        return res.status(400).json({ 
            success: false, 
            error: '缺少必需参数' 
        });
    }
    
    try {
        const testConfig = {
            api_key: api_key,
            model_name: model_name,
            provider: provider || 'gemini',
            endpoint: endpoint || 'https://generativelanguage.googleapis.com/v1beta'
        };
        
        const testText = '这是一条测试文本，用于验证embedding API是否正常工作。';
        const testEmbedding = await getEmbedding(testText, testConfig);
        
        if (testEmbedding && Array.isArray(testEmbedding) && testEmbedding.length > 0) {
            res.json({ 
                success: true, 
                dimension: testEmbedding.length,
                message: `连接成功！向量维度: ${testEmbedding.length}`
            });
        } else {
            res.json({ 
                success: false, 
                error: '返回格式错误或向量为空' 
            });
        }
    } catch (error) {
        console.error('测试embedding失败:', error);
        res.json({ 
            success: false, 
            error: error.message || '连接失败，请检查API Key和endpoint'
        });
    }
});

// 保存embedding配置
router.post('/api/save-embedding-config', requireAuth, (req, res) => {
    const db = getDb();
    const { api_key, model_name, provider, endpoint } = req.body;
    
    if (!api_key || !model_name) {
        return res.status(400).json({ 
            success: false,
            error: '缺少必需参数: api_key 和 model_name' 
        });
    }
    
    try {
        const encryptedKey = encryption.encrypt(api_key);
        
        const existing = db.prepare(`
            SELECT id FROM api_configs 
            WHERE model_name LIKE '%embedding%'
            AND (provider = 'gemini' OR provider = 'openai_compatible')
            LIMIT 1
        `).get();
        
        if (existing) {
            db.prepare(`
                UPDATE api_configs 
                SET api_key = ?, model_name = ?, provider = ?, endpoint = ?
                WHERE id = ?
            `).run(
                encryptedKey, model_name, 
                provider || 'gemini', 
                endpoint || 'https://generativelanguage.googleapis.com/v1beta',
                existing.id
            );
            console.log(`已更新embedding配置 (ID: ${existing.id})`);
        } else {
            const result = db.prepare(`
                INSERT INTO api_configs 
                (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                'Embedding API',
                provider || 'gemini',
                endpoint || 'https://generativelanguage.googleapis.com/v1beta',
                encryptedKey,
                model_name,
                0, 0
            );
            console.log(`已创建embedding配置 (ID: ${result.lastInsertRowid})`);
        }
        
        res.json({ success: true, message: '配置保存成功' });
        
    } catch (error) {
        console.error('保存embedding配置失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== 记忆库 LLM 配置 ==========

// 获取记忆库LLM配置
router.get('/api/memory-llm-config', requireAuth, (req, res) => {
    try {
        const db = getDb();
        const config = db.prepare(`
            SELECT id, name, model_name, provider, endpoint, created_at 
            FROM api_configs 
            WHERE name = 'Memory LLM'
            LIMIT 1
        `).get();
        
        if (config) {
            res.json({ 
                source: 'database',
                exists: true,
                model_name: config.model_name,
                provider: config.provider,
                endpoint: config.endpoint,
                configured_at: config.created_at
            });
        } else {
            res.json({ source: 'environment', exists: false });
        }
    } catch (error) {
        console.error('获取LLM配置失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 测试LLM连接
router.post('/api/test-llm', requireAuth, async (req, res) => {
    const { api_key, model_name, endpoint } = req.body;
    
    if (!api_key || !model_name) {
        return res.status(400).json({ success: false, error: '缺少必需参数' });
    }
    
    try {
        const testEndpoint = endpoint || 'https://generativelanguage.googleapis.com/v1beta';
        const url = `${testEndpoint}/models/${model_name}:generateContent?key=${api_key}`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: '测试连接' }] }],
                generationConfig: { maxOutputTokens: 10 }
            })
        });
        
        if (response.ok) {
            const data = await response.json();
            if (data.candidates && data.candidates.length > 0) {
                res.json({ success: true, message: '连接成功！模型响应正常' });
            } else {
                res.json({ success: false, error: '模型返回格式异常' });
            }
        } else {
            const errorText = await response.text();
            res.json({ success: false, error: `HTTP ${response.status}: ${errorText}` });
        }
    } catch (error) {
        console.error('测试LLM失败:', error);
        res.json({ success: false, error: error.message || '连接失败' });
    }
});

// 智能提取标签
router.post('/api/extract-tags', requireAuth, async (req, res) => {
    const db = getDb();
    const { title, content } = req.body;
    
    if (!content) {
        return res.status(400).json({ success: false, error: '内容不能为空' });
    }
    
    try {
        const config = db.prepare(`
            SELECT model_name, endpoint, api_key 
            FROM api_configs 
            WHERE name = 'Memory LLM'
            LIMIT 1
        `).get();
        
        let modelName, endpoint, apiKey;
        
        if (config) {
            modelName = config.model_name;
            endpoint = config.endpoint || 'https://generativelanguage.googleapis.com/v1beta';
            apiKey = encryption.decrypt(config.api_key);
        } else {
            modelName = 'gemini-3-flash-preview';
            endpoint = 'https://generativelanguage.googleapis.com/v1beta';
            apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
        }
        
        if (!apiKey) {
            return res.status(500).json({ success: false, error: 'API Key未配置' });
        }
        
        const prompt = `从以下文本中提取3-8个关键标签，要求：
1. 优先提取专有名词、人名、地点、特定概念
2. 避免虚词和泛化概念（如"重要"、"讨论"、"记忆"）
3. 保持简洁，每个标签1-3个字
4. 只返回逗号分隔的标签列表，不要其他解释

${title ? `标题: ${title}\n` : ''}内容: ${content}

标签列表：`;
        
        const url = `${endpoint}/models/${modelName}:generateContent?key=${apiKey}`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 100 }
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`LLM调用失败: ${response.status} ${errorText}`);
        }
        
        const data = await response.json();
        
        if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
            throw new Error('LLM返回格式异常');
        }
        
        const rawText = data.candidates[0].content.parts[0].text.trim();
        const tags = rawText
            .split(/[,，、]/)
            .map(tag => tag.trim())
            .filter(tag => tag.length > 0 && tag.length <= 10);
        
        res.json({ success: true, tags: tags });
        
    } catch (error) {
        console.error('提取标签失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 保存记忆库完整配置（Embedding + LLM）
router.post('/api/save-memory-config', requireAuth, (req, res) => {
    const db = getDb();
    const { api_key, embedding, llm } = req.body;
    
    if (!api_key || !embedding || !llm) {
        return res.status(400).json({ success: false, error: '缺少必需参数' });
    }
    
    try {
        const encryptedKey = encryption.encrypt(api_key);
        
        // 保存Embedding配置
        const existingEmb = db.prepare(`
            SELECT id FROM api_configs 
            WHERE model_name LIKE '%embedding%'
            LIMIT 1
        `).get();
        
        if (existingEmb) {
            db.prepare(`
                UPDATE api_configs SET api_key = ?, model_name = ?, endpoint = ? WHERE id = ?
            `).run(encryptedKey, embedding.model_name, embedding.endpoint || 'https://generativelanguage.googleapis.com/v1beta', existingEmb.id);
            console.log(`✅ 更新Embedding配置 (ID: ${existingEmb.id})`);
        } else {
            const result = db.prepare(`
                INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run('Embedding API', 'gemini', embedding.endpoint || 'https://generativelanguage.googleapis.com/v1beta', encryptedKey, embedding.model_name, 0, 0);
            console.log(`✅ 创建Embedding配置 (ID: ${result.lastInsertRowid})`);
        }
        
        // 保存LLM配置
        const existingLLM = db.prepare(`
            SELECT id FROM api_configs WHERE name = 'Memory LLM' LIMIT 1
        `).get();
        
        if (existingLLM) {
            db.prepare(`
                UPDATE api_configs SET api_key = ?, model_name = ?, endpoint = ? WHERE id = ?
            `).run(encryptedKey, llm.model_name, llm.endpoint || 'https://generativelanguage.googleapis.com/v1beta', existingLLM.id);
            console.log(`✅ 更新LLM配置 (ID: ${existingLLM.id})`);
        } else {
            const result = db.prepare(`
                INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run('Memory LLM', 'gemini', llm.endpoint || 'https://generativelanguage.googleapis.com/v1beta', encryptedKey, llm.model_name, 0, 0);
            console.log(`✅ 创建LLM配置 (ID: ${result.lastInsertRowid})`);
        }
        
        res.json({ success: true, message: '配置保存成功' });
        
    } catch (error) {
        console.error('保存配置失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== 记忆碎片 API（memory_fragments） ==========

// GET /api/fragments — 获取碎片列表（分页+筛选）
router.get('/api/fragments', requireAuth, (req, res) => {
    const db = getDb();
    const { status, min_ew, max_ew, source_date, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const offset = (pageNum - 1) * limitNum;

    try {
        let where = [];
        let params = [];

        if (status) {
            where.push('status = ?');
            params.push(status);
        }
        if (min_ew) {
            where.push('emotional_weight >= ?');
            params.push(parseFloat(min_ew));
        }
        if (max_ew) {
            where.push('emotional_weight <= ?');
            params.push(parseFloat(max_ew));
        }
        if (source_date) {
            // YYYY-MM prefix match
            where.push("source_date LIKE ?");
            params.push(source_date + '%');
        }

        const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

        const total = db.prepare(`SELECT COUNT(*) as count FROM memory_fragments ${whereClause}`).get(...params);
        const fragments = db.prepare(`
            SELECT id, type, entity, content, emotional_weight, source, source_date, status, created_at,
                   read_count, last_accessed_at, chroma_id
            FROM memory_fragments ${whereClause}
            ORDER BY source_date DESC, created_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, limitNum, offset);

        res.json({
            fragments,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: total.count,
                totalPages: Math.ceil(total.count / limitNum)
            }
        });
    } catch (e) {
        console.error('[fragments API] 列表获取失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/fragments/months — 获取有数据的月份列表
router.get('/api/fragments/months', requireAuth, (req, res) => {
    const db = getDb();
    try {
        const months = db.prepare(`
            SELECT substr(source_date, 1, 7) as month, COUNT(*) as count
            FROM memory_fragments
            WHERE status != 'deleted'
            GROUP BY month
            ORDER BY month DESC
        `).all();
        res.json({ months });
    } catch (e) {
        console.error('[fragments API] 月份列表失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/fragment/:id — 获取单个碎片
router.get('/api/fragment/:id', requireAuth, (req, res) => {
    const db = getDb();
    try {
        const f = db.prepare(`SELECT * FROM memory_fragments WHERE id = ?`).get(req.params.id);
        if (!f) return res.status(404).json({ error: '碎片不存在' });
        res.json(f);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/fragment/:id — 更新碎片（权重、状态、内容）
router.put('/api/fragment/:id', requireAuth, (req, res) => {
    const db = getDb();
    const { emotional_weight, status, content, entity } = req.body;
    try {
        const existing = db.prepare(`SELECT id FROM memory_fragments WHERE id = ?`).get(req.params.id);
        if (!existing) return res.status(404).json({ error: '碎片不存在' });

        const updates = [];
        const params = [];
        if (emotional_weight !== undefined) {
            updates.push('emotional_weight = ?');
            params.push(parseFloat(emotional_weight));
        }
        if (status) {
            updates.push('status = ?');
            params.push(status);
        }
        if (content !== undefined) {
            updates.push('content = ?');
            params.push(content);
        }
        if (entity !== undefined) {
            updates.push('entity = ?');
            params.push(entity);
        }

        if (updates.length === 0) return res.status(400).json({ error: '没有要更新的字段' });

        params.push(req.params.id);
        db.prepare(`UPDATE memory_fragments SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        res.json({ success: true });
    } catch (e) {
        console.error('[fragment API] 更新失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/fragment/:id — 真删除碎片 + 级联降权同源碎片
router.delete('/api/fragment/:id', requireAuth, async (req, res) => {
    const db = getDb();
    try {
        const frag = db.prepare(`SELECT id, content, source_msg_ids, emotional_weight FROM memory_fragments WHERE id = ?`).get(req.params.id);
        if (!frag) return res.status(404).json({ error: '碎片不存在' });

        // 写入纠正日志（删除即纠正信号）
        try {
            db.prepare(`INSERT INTO correction_log (target_type, target_id, wrong_summary, correct_summary, source, status, created_at)
                VALUES ('fragment', ?, ?, '', 'manual', 'active', datetime('now'))`).run(
                frag.id, (frag.content || '').slice(0, 80)
            );
            console.log(`[Correction] 碎片删除写入纠正日志 #${frag.id}`);
        } catch (logErr) {
            console.error('⚠️ correction_log写入失败:', logErr.message);
        }

        // 级联降权：查同源碎片（同一批对话提取的），emotional_weight × 0.5
        let sourceIds = [];
        try { sourceIds = JSON.parse(frag.source_msg_ids || '[]'); } catch (_) {}
        if (sourceIds.length > 0) {
            const placeholders = sourceIds.map(() => '?').join(',');
            const sameSource = db.prepare(`
                SELECT id, source_msg_ids FROM memory_fragments
                WHERE id != ? AND status = 'active'
                  AND source_msg_ids IS NOT NULL
            `).all(frag.id).filter(f => {
                try {
                    const ids = JSON.parse(f.source_msg_ids || '[]');
                    return ids.some(id => sourceIds.includes(id));
                } catch (_) { return false; }
            });

            if (sameSource.length > 0) {
                const demote = db.prepare("UPDATE memory_fragments SET emotional_weight = MAX(0.1, emotional_weight * 0.5), lifecycle_updated_at = datetime('now') WHERE id = ?");
                for (const s of sameSource) demote.run(s.id);
                console.log(`[Correction] 级联降权: ${sameSource.length}条同源碎片 ew×0.5 (source: fragment #${frag.id})`);
            }
        }

        // 删除 ChromaDB 向量
        try {
            const { chromaDBOperation } = require('../services/memory');
            await chromaDBOperation('delete', { id: `fragment_${frag.id}` });
        } catch (e) {
            console.error(`ChromaDB delete fragment_${frag.id} failed:`, e.message);
        }

        // 真删除
        db.prepare(`DELETE FROM memory_fragments WHERE id = ?`).run(frag.id);
        console.log(`🗑️ Fragment hard-deleted: #${frag.id} "${(frag.content || '').slice(0, 50)}"`);
        res.json({ success: true, demotedSameSource: true });

    } catch (e) {
        console.error(`❌ DELETE /api/fragment/${req.params.id}:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/fragments/stats — 碎片统计
router.get('/api/fragments/stats', requireAuth, (req, res) => {
    const db = getDb();
    try {
        const total = db.prepare(`SELECT COUNT(*) as c FROM memory_fragments`).get();
        const active = db.prepare(`SELECT COUNT(*) as c FROM memory_fragments WHERE status='active'`).get();
        const consolidated = db.prepare(`SELECT COUNT(*) as c FROM memory_fragments WHERE status='consolidated'`).get();
        const deleted = db.prepare(`SELECT COUNT(*) as c FROM memory_fragments WHERE status='deleted'`).get();
        const avgEW = db.prepare(`SELECT AVG(emotional_weight) as avg FROM memory_fragments WHERE status='active'`).get();
        res.json({
            total: total.c, active: active.c, consolidated: consolidated.c, deleted: deleted.c,
            avgEmotionalWeight: Math.round((avgEW.avg || 0) * 100) / 100
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ========== 纠正反馈闭环 API ==========

// 纠正反馈模块是可选的
let recordCorrection, getActiveCorrections, getMergedGuidelines, mergeGuidelines;
try { ({ recordCorrection, getActiveCorrections, getMergedGuidelines, mergeGuidelines } = require('../services/correction')); } catch (_) {
  recordCorrection = () => {};
  getActiveCorrections = () => [];
  getMergedGuidelines = async () => [];
  mergeGuidelines = () => {};
}

// POST /api/corrections — 记录一条纠正
router.post('/api/corrections', requireAuth, (req, res) => {
    const { targetType, targetId, wrongSummary, correctSummary, source, chatMessageId } = req.body;

    if (!targetType || !wrongSummary || !correctSummary) {
        return res.status(400).json({ error: 'targetType, wrongSummary, correctSummary 为必填字段' });
    }

    try {
        const id = recordCorrection({
            targetType,
            targetId: targetId || null,
            wrongSummary,
            correctSummary,
            source: source || 'manual',
            chatMessageId: chatMessageId || null
        });
        res.json({ success: true, id });
    } catch (e) {
        console.error('[corrections API] 记录纠正失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/corrections — 获取纠正列表（活跃+统计）
router.get('/api/corrections', requireAuth, (req, res) => {
    const db = getDb();
    try {
        const active = db.prepare(`
            SELECT id, target_type, target_id, wrong_summary, correct_summary, source, status, created_at
            FROM correction_log WHERE status = 'active'
            ORDER BY created_at DESC
        `).all();

        const merged = db.prepare(`
            SELECT id, target_type, target_id, wrong_summary, correct_summary, source, status, created_at
            FROM correction_log WHERE status = 'merged'
            ORDER BY created_at DESC LIMIT 30
        `).all();

        const total = db.prepare('SELECT COUNT(*) as c FROM correction_log').get();
        const activeCount = db.prepare("SELECT COUNT(*) as c FROM correction_log WHERE status='active'").get();
        const mergeThreshold = 10;

        res.json({
            active,
            merged,
            stats: {
                total: total.c,
                active: activeCount.c,
                mergeThreshold,
                needsMerge: activeCount.c >= mergeThreshold
            }
        });
    } catch (e) {
        console.error('[corrections API] 获取列表失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/corrections/merge — 手动触发合并
router.post('/api/corrections/merge', requireAuth, async (req, res) => {
    try {
        const guidelines = await mergeGuidelines();
        res.json({ success: true, guidelines });
    } catch (e) {
        console.error('[corrections API] 合并失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/corrections/guidelines — 获取已合并的长期准则
router.get('/api/corrections/guidelines', requireAuth, async (req, res) => {
    try {
        const guidelines = await getMergedGuidelines();
        res.json({ guidelines: guidelines || null });
    } catch (e) {
        console.error('[corrections API] 获取准则失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ========== 本体论 API（知识图谱） ==========

const { getChildren, getCategoryFragments, getCategoryFragmentCountRecursive, getByPath } = require('../services/ontology');

// GET /api/ontology/tree — 完整类别树（含碎片计数）
router.get('/api/ontology/tree', requireAuth, (req, res) => {
    const db = getDb();
    try {
        // 一次性查全部类别，前端组装树
        const all = db.prepare(`
            SELECT o.id, o.path, o.label, o.description, o.fragment_count,
                   (SELECT COUNT(*) FROM fragment_categories fc WHERE fc.category_id = o.id) as direct_count
            FROM memory_ontology o
            ORDER BY o.fragment_count DESC
        `).all();

        const categories = all.map(c => ({
            id: c.id,
            path: c.path,
            label: c.label,
            description: c.description,
            fragment_count: c.direct_count,
            children: []
        }));

        res.json({ tree: categories });
    } catch (e) {
        console.error('[ontology API] tree failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/ontology/stats — 全局统计
router.get('/api/ontology/stats', requireAuth, (req, res) => {
    const db = getDb();
    try {
        const totalCategories = db.prepare('SELECT COUNT(*) as c FROM memory_ontology').get().c;
        const rootCategories = db.prepare('SELECT COUNT(*) as c FROM memory_ontology WHERE parent_id IS NULL').get().c;
        const totalFragments = db.prepare('SELECT COUNT(*) as c FROM memory_fragments WHERE status != ?').get('deleted').c;
        const classifiedFragments = db.prepare(`
            SELECT COUNT(DISTINCT fragment_id) as c FROM fragment_categories fc
            JOIN memory_fragments mf ON mf.id = fc.fragment_id
            WHERE mf.status != 'deleted'
        `).get().c;

        // Archivist 最后运行时间
        const lastRun = db.prepare(`
            SELECT created_at FROM ontology_changelog
            WHERE action = 'archivist_run'
            ORDER BY created_at DESC LIMIT 1
        `).get();

        // 待处理提案
        const pendingThemes = db.prepare(`
            SELECT COUNT(*) as c FROM ontology_changelog
            WHERE action = 'theme_proposal' AND status = 'pending'
        `).get().c;
        const pendingDensity = db.prepare(`
            SELECT COUNT(*) as c FROM ontology_changelog
            WHERE action = 'density_warning' AND status = 'pending'
        `).get().c;

        // 最近活动
        const recentActivity = db.prepare(`
            SELECT action, detail, created_at FROM ontology_changelog
            ORDER BY created_at DESC LIMIT 20
        `).all().map(r => ({
            ...r,
            detail: safeJsonParse(r.detail)
        }));

        res.json({
            totalCategories,
            rootCategories,
            totalFragments,
            classifiedFragments,
            unclassifiedFragments: totalFragments - classifiedFragments,
            classificationRate: totalFragments > 0 ? Math.round(classifiedFragments / totalFragments * 100) : 0,
            lastArchivistRun: lastRun?.created_at || null,
            pendingThemeProposals: pendingThemes,
            pendingDensityWarnings: pendingDensity,
            recentActivity
        });
    } catch (e) {
        console.error('[ontology API] stats failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/archivist/status — Agent state + skills + activity
router.get('/api/archivist/status', requireAuth, (req, res) => {
    const db = getDb();
    try {
        const { getStatus } = require('../services/archivist');
        const { getLastWhisper } = require('../services/whisper');
        const agentRaw = getStatus();

        const toolLabels = {
            classify_fragments: '归类新记忆',
            discover_relationships: '识别人物关系',
            extract_insights: '提炼碎片洞察',
            detect_themes: '发掘新主题',
            check_overdensity: '监控过密类别',
            analyze_leaf_structure: '分析叶子类别结构',
            audit_tree: '审查知识树结构',
            regenerate_descriptions: '更新类别描述',
            regenerate_entity_overviews: '生成人物概述',
        };

        const agent = {
            running: agentRaw.running,
            lastCheck: agentRaw.lastCheck,
            inDeepWork: agentRaw.inDeepWork,
            tool_labels: toolLabels,
        };

        const skills = db.prepare(`
            SELECT id, type, source_pattern, confidence, status,
                   json_array_length(observations) as obs_count,
                   created_at, last_evaluated_at, last_triggered_at
            FROM archivist_skills WHERE status = 'active'
            ORDER BY confidence DESC
        `).all();

        const corrections = db.prepare(`
            SELECT COUNT(*) as c FROM cognitive_corrections WHERE status = 'active'
        `).get();

        const recentEntities = db.prepare(`
            SELECT id, name, relationship_to_clara, relationship_confidence
            FROM entity_profiles
            WHERE category = 'person'
              AND relationship_to_clara IS NOT NULL
            ORDER BY
                CASE WHEN relationship_confidence = 'high' THEN 0 ELSE 1 END,
                last_evaluated_at DESC
            LIMIT 5
        `).all();

        const activity = db.prepare(`
            SELECT created_at, action, detail FROM ontology_changelog
            WHERE detail IS NOT NULL
            ORDER BY created_at DESC LIMIT 20
        `).all();

        const totalFrags = db.prepare("SELECT COUNT(*) as c FROM memory_fragments WHERE status = 'active'").get();
        const classified = db.prepare("SELECT COUNT(DISTINCT fragment_id) as c FROM fragment_categories").get();
        const insighted = db.prepare("SELECT COUNT(*) as c FROM memory_fragments WHERE status = 'active' AND insight IS NOT NULL").get();
        const entitiesWithRel = db.prepare("SELECT COUNT(*) as c FROM entity_profiles WHERE category = 'person' AND relationship_to_clara IS NOT NULL").get();

        const whisper = getLastWhisper();

        res.json({
            agent,
            skills,
            corrections: corrections.c,
            entities: recentEntities,
            whisper,
            activity,
            stats: {
                totalFragments: totalFrags.c,
                classifiedFragments: classified.c,
                insightedFragments: insighted.c,
                entitiesWithRelations: entitiesWithRel.c,
            }
        });
    } catch (e) {
        console.error('[archivist API] status failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/entity/:id — Quick-edit relationship label + confidence
router.put('/api/entity/:id', requireAuth, (req, res) => {
    const db = getDb();
    try {
        const { relationship_to_clara, relationship_confidence } = req.body;
        if (!relationship_to_clara && !relationship_confidence) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        const updates = [];
        const params = [];
        if (relationship_to_clara !== undefined) {
            updates.push("relationship_to_clara = ?");
            params.push(relationship_to_clara);
        }
        if (relationship_confidence !== undefined) {
            const valid = ['high','medium','low'];
            if (!valid.includes(relationship_confidence)) {
                return res.status(400).json({ error: 'Invalid confidence: ' + relationship_confidence });
            }
            updates.push("relationship_confidence = ?");
            params.push(relationship_confidence);
        }
        updates.push("updated_at = datetime('now')");
        params.push(req.params.id);

        const result = db.prepare(`UPDATE entity_profiles SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Entity not found' });
        }
        res.json({ success: true });
    } catch (e) {
        console.error('[entity API] update failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/ontology/category/:id — 类别详情 + 碎片列表 + 人物档案
router.get('/api/ontology/category/:id', requireAuth, (req, res) => {
    const db = getDb();
    try {
        const cat = db.prepare(`SELECT * FROM memory_ontology WHERE id = ?`).get(req.params.id);
        if (!cat) return res.status(404).json({ error: 'Category not found' });

        const fragments = getCategoryFragments(cat.id, 20, 0);

        res.json({
            ...cat,
            child_count: 0,
            children: [],
            recursive_fragment_count: cat.fragment_count,
            fragments,
        });
    } catch (e) {
        console.error('[ontology API] category detail failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/ontology/changelog — 变更日志
router.get('/api/ontology/changelog', requireAuth, (req, res) => {
    const db = getDb();
    try {
        const log = db.prepare(`
            SELECT id, action, category_id, detail, status, created_at
            FROM ontology_changelog
            ORDER BY created_at DESC LIMIT 50
        `).all().map(r => ({
            ...r,
            detail: safeJsonParse(r.detail)
        }));
        res.json({ changelog: log });
    } catch (e) {
        console.error('[ontology API] changelog failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/ontology/category/:id/fragments — 类别碎片（分页）
router.get('/api/ontology/category/:id/fragments', requireAuth, (req, res) => {
    try {
        const limit = Math.min(50, parseInt(req.query.limit) || 20);
        const offset = parseInt(req.query.offset) || 0;
        const fragments = getCategoryFragments(req.params.id, limit, offset);
        res.json({ fragments });
    } catch (e) {
        console.error('[ontology API] category fragments failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

function safeJsonParse(str) {
    if (!str) return null;
    try { return JSON.parse(str); } catch (_) { return str; }
}
module.exports = router;