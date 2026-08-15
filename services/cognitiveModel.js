// =================================================================
// User Model — 四层认知模型
//
// 维护 AI 对用户的内部认知，四层：
//   immutable_fact   — 不变事实，永不衰减，仅明确纠正修改
//   stable_trait     — 稳定特质，证据积累精细化，矛盾≥3降级重审
//   current_state    — 当前状态，指数衰减(7天半衰期)，14天无证据自动 resolved
//   active_hypothesis — 活跃假设，3次确认→升级为 trait，14天无证据→abandoned
//
// 职责：CRUD、证据管理、衰减处理、假设验证、新特质检测、上下文注入
// =================================================================

const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { WORLD_CONTEXT } = require('./worldContext');
const { fillPrompt, USER, AI } = require('./nameResolver');
const { encryption } = require('../encryption');
const { getCompanionPersonaBase } = require('./dracoPersona');

// v5.10: 增强版 system prompt — Companion 人格 + User 画像
// 供 detectNewTraits / readUserRawMessages 等需要深度理解 {{user.name}} 的 LLM 调用使用
function _buildModelSystemPrompt() {
    let sp = WORLD_CONTEXT + '\n\n---\n\n';
    // Companion 人格
    const persona = getCompanionPersonaBase();
    if (persona) sp += persona + '\n\n---\n\n';
    // {{user.name}} 现有画像摘要
    try {
        const { assembleProfile } = require('./userProfile');
        const profile = assembleProfile(300);
        if (profile) sp += profile;
    } catch (_) {}
    return sp;
}

// ═══════════════════════════════════════════════════════
// Helper: extract plain text from message content
// Handles: encrypted JSON → decrypt → parse components → plain text
// ═══════════════════════════════════════════════════════

function extractMessageText(rawContent) {
    if (!rawContent) return '';
    let text = rawContent;

    // 1. Decrypt if encrypted
    if (text.startsWith('enc:')) {
        try { text = encryption.decrypt(text, { silent: true }); } catch (_) { return ''; }
    }

    // 2. Parse JSON components if present
    if (text.startsWith('{') && text.includes('"components"')) {
        try {
            const parsed = JSON.parse(text);
            if (parsed.components && Array.isArray(parsed.components)) {
                text = parsed.components
                    .filter(c => c.type === 'text' && c.content)
                    .map(c => c.content)
                    .join(' ');
            }
        } catch (_) { /* not JSON, use as-is */ }
    }

    return text.trim();
}

// ═══════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════

const LLM_CONFIG_ID = 52; // gemini-flash-lite 官key（隐私敏感：读用户原始消息）

const HYPOTHESIS_UPGRADE_EVIDENCE = 3;   // 3次确认 → 升级为 trait
const HYPOTHESIS_ABANDON_DAYS = 14;      // 14天无证据 → 放弃
const STATE_HALF_LIFE_DAYS = 7;          // current_state 半衰期
const STATE_AUTO_RESOLVE_DAYS = 14;      // 14天无证据 → 自动 resolved
const TRAIT_CONTRADICTION_THRESHOLD = 3; // 矛盾≥3 → 降级重审
const MIN_GAP_USER_MODEL = 4 * 60 * 60 * 1000; // 深循环冷却 4h

// ═══════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════

function createEntry(type, content, opts = {}) {
    const db = getDb();
    const {
        confidence = 0.3,
        decay_type = null,
        decay_params = {},
        source_fragment_ids = [],
        entity_ids = [],
        parent_skill_id = null,
        migration_source = null,
        tags = [],
        priority = 0,
        source_quality = 'inferred', // direct_statement | inferred | backfilled
        source_diversity = 1,        // number of independent source batches
        created_by = 'deep_cycle',   // v5.0: chat_companion | deep_cycle
        expires_at = null,           // v5.0: ISO 8601 timestamp for explicit TTL
    } = opts;

    // Infer decay_type from entry type if not specified
    const effectiveDecay = decay_type || {
        immutable_fact: 'none',
        stable_trait: 'evidence_dependent',
        current_state: 'exponential',
        active_hypothesis: 'evidence_dependent',
    }[type] || null;

    // Adjust initial confidence based on source_quality
    let effectiveConfidence = confidence;
    if (source_quality === 'direct_statement') {
        // Direct statement from user: high starting confidence
        const directCaps = { immutable_fact: 0.99, stable_trait: 0.85, current_state: 0.95, active_hypothesis: 0.75 };
        effectiveConfidence = Math.min(directCaps[type] || 0.85, confidence + 0.15);
    } else if (source_quality === 'inferred') {
        // LLM-inferred: cap at 0.70 — needs independent confirmation
        effectiveConfidence = Math.min(0.70, confidence);
    }

    // v5.0: expires_at hard cap — max 90 days from now
    if (expires_at) {
        const maxExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
        if (expires_at > maxExpiry) {
            console.log(`[UserModel] ⚠️ expires_at ${expires_at} exceeds 90d cap, clamping to ${maxExpiry}`);
            expires_at = maxExpiry;
        }
    }

    const result = db.prepare(`
        INSERT INTO clara_model (type, content, confidence, decay_type, decay_params,
            source_fragment_ids, entity_ids, parent_skill_id, migration_source, tags, priority,
            source_quality, source_diversity, created_by, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        type, content, effectiveConfidence, effectiveDecay,
        JSON.stringify(decay_params),
        JSON.stringify(source_fragment_ids),
        JSON.stringify(entity_ids),
        parent_skill_id, migration_source,
        JSON.stringify(tags), priority,
        source_quality, source_diversity,
        created_by, expires_at
    );

    console.log(`[UserModel] 创建 ${type}[${source_quality}][${created_by}]: "${content.slice(0, 60)}" (id=${result.lastInsertRowid}, conf=${effectiveConfidence.toFixed(2)})`);
    return result.lastInsertRowid;
}

function updateEntry(id, updates) {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM clara_model WHERE id = ?').get(id);
    if (!existing) return null;

    const allowed = ['content', 'confidence', 'decay_type', 'decay_params',
        'source_fragment_ids', 'entity_ids', 'tags', 'priority', 'status', 'parent_skill_id',
        'created_by', 'expires_at', 'schedule'];
    const sets = [];
    const vals = [];

    for (const [k, v] of Object.entries(updates)) {
        if (!allowed.includes(k)) continue;
        sets.push(`${k} = ?`);
        vals.push(v === null ? null : (typeof v === 'object' ? JSON.stringify(v) : v));
    }

    if (sets.length === 0) return null;

    // Track evolution for trait updates
    if (existing.type === 'stable_trait' && updates.content && updates.content !== existing.content) {
        const history = JSON.parse(existing.evolution_history || '[]');
        history.push({
            previous: existing.content,
            updated: updates.content,
            confidence_before: existing.confidence,
            confidence_after: updates.confidence ?? existing.confidence,
            at: new Date().toISOString(),
        });
        sets.push('evolution_history = ?');
        vals.push(JSON.stringify(history));
    }

    sets.push('updated_at = CURRENT_TIMESTAMP');
    vals.push(id);

    db.prepare(`UPDATE clara_model SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return true;
}

function resolveEntry(id, reason = '') {
    const db = getDb();
    db.prepare(`UPDATE clara_model SET status = 'resolved', resolved_at = datetime('now'),
        resolve_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(reason, id);
}

function abandonEntry(id, reason = '') {
    const db = getDb();
    db.prepare(`UPDATE clara_model SET status = 'abandoned', resolved_at = datetime('now'),
        resolve_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(reason, id);
}

function supersedeEntry(id, newId, reason = '') {
    const db = getDb();
    db.prepare(`UPDATE clara_model SET status = 'superseded', superseded_by = ?,
        resolved_at = datetime('now'), resolve_reason = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(newId, reason, id);
}

function correctEntry(id, newContent) {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM clara_model WHERE id = ?').get(id);
    if (!existing) return null;

    const history = JSON.parse(existing.evolution_history || '[]');
    history.push({
        previous: existing.content,
        corrected_to: newContent,
        at: new Date().toISOString(),
    });

    db.prepare(`UPDATE clara_model SET status = 'corrected', content = ?,
        evolution_history = ?, resolved_at = datetime('now'), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(newContent, JSON.stringify(history), id);
    return true;
}

// ═══════════════════════════════════════════════════════
// Evidence Management
// ═══════════════════════════════════════════════════════

function addEvidence(id, fragmentId, confirms = true, opts = {}) {
    const db = getDb();
    const entry = db.prepare('SELECT * FROM clara_model WHERE id = ?').get(id);
    if (!entry) return null;

    const { sourceMsgIds = [] } = opts; // message IDs that produced this evidence

    // ── Source diversity: check if this is truly independent evidence ──
    let sourceDiversity = entry.source_diversity || 1;
    let isIndependentSource = false;

    if (sourceMsgIds.length > 0) {
        // Check existing source fragments for message ID overlap
        const existingFragIds = JSON.parse(entry.source_fragment_ids || '[]');
        if (existingFragIds.length > 0) {
            const placeholders = existingFragIds.map(() => '?').join(',');
            const existingMsgIds = db.prepare(`
                SELECT DISTINCT source_msg_ids FROM memory_fragments
                WHERE id IN (${placeholders}) AND source_msg_ids IS NOT NULL
            `).all(...existingFragIds)
                .flatMap(r => { try { return JSON.parse(r.source_msg_ids || '[]'); } catch { return []; } });

            const overlap = sourceMsgIds.filter(mid => existingMsgIds.includes(mid));
            // < 30% message overlap → likely independent source batch
            if (overlap.length / Math.max(sourceMsgIds.length, 1) < 0.3) {
                isIndependentSource = true;
                sourceDiversity++;
            }
        } else {
            // First evidence with message IDs — always independent
            isIndependentSource = true;
        }
    } else {
        // No message IDs — use date-based diversity as fallback
        const fragDate = db.prepare('SELECT DATE(created_at) as d FROM memory_fragments WHERE id = ?').get(fragmentId)?.d;
        if (fragDate) {
            const existingFragIds = JSON.parse(entry.source_fragment_ids || '[]');
            if (existingFragIds.length > 0) {
                const placeholders = existingFragIds.map(() => '?').join(',');
                const hasSameDate = db.prepare(`
                    SELECT COUNT(*) as c FROM memory_fragments
                    WHERE id IN (${placeholders}) AND DATE(created_at) = ?
                `).get(...existingFragIds, fragDate)?.c || 0;
                // Different date from all existing evidence → independent source
                isIndependentSource = (hasSameDate === 0);
            } else {
                isIndependentSource = true;
            }
        } else {
            // No date info — be conservative
            isIndependentSource = false;
        }
    }

    // ── Confidence adjustment ──
    const newCount = entry.evidence_count + 1;
    let newConfidence = entry.confidence;
    const now = new Date().toISOString();

    // Cap depends on source_quality
    const sourceQuality = entry.source_quality || 'inferred';
    const isDirectStatement = sourceQuality === 'direct_statement';

    if (confirms) {
        let bump;
        switch (entry.type) {
            case 'stable_trait':
                // Independent observation: +0.05; echo/same-batch: +0.02
                bump = isIndependentSource ? 0.05 : 0.02;
                newConfidence = Math.min(isDirectStatement ? 0.99 : 0.80, entry.confidence + bump);
                break;
            case 'current_state':
                // Direct: +0.15 cap 0.99; inferred: +0.08 cap 0.75
                bump = isIndependentSource ? (isDirectStatement ? 0.15 : 0.08) : 0.04;
                newConfidence = Math.min(isDirectStatement ? 0.99 : 0.75, entry.confidence + bump);
                break;
            case 'active_hypothesis':
                bump = isIndependentSource ? 0.10 : 0.05;
                newConfidence = Math.min(0.75, entry.confidence + bump);
                break;
            default: // immutable_fact
                bump = 0.01;
                newConfidence = Math.min(0.99, entry.confidence + bump);
        }
    } else {
        // Contradiction: weight depends on source independence
        const penalty = isIndependentSource ? 0.12 : 0.05;
        switch (entry.type) {
            case 'stable_trait':
                newConfidence = Math.max(0.10, entry.confidence - penalty);
                break;
            case 'current_state':
                newConfidence = Math.max(0.05, entry.confidence - penalty * 1.2);
                break;
            case 'active_hypothesis':
                newConfidence = Math.max(0.05, entry.confidence - penalty * 1.5);
                break;
            default:
                newConfidence = Math.max(0.20, entry.confidence - penalty * 0.5);
        }

        // If this contradiction is independent and entry was inferred-only,
        // flag for LLM review
        if (isIndependentSource && !isDirectStatement && entry.confidence >= 0.50) {
            const tags = JSON.parse(entry.tags || '[]');
            if (!tags.includes('needs_review')) {
                tags.push('needs_review');
                db.prepare(`UPDATE clara_model SET tags = ?, priority = MAX(priority, 5),
                    updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(JSON.stringify(tags), id);
            }
        }

        // Record contradiction in evolution_history for processModelDecay counting
        const evoHistory = JSON.parse(entry.evolution_history || '[]');
        evoHistory.push({ type: 'contradiction', at: now, source_independent: isIndependentSource });
        db.prepare(`UPDATE clara_model SET evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(JSON.stringify(evoHistory), id);
    }

    // Append fragment to source list
    let sourceIds = JSON.parse(entry.source_fragment_ids || '[]');
    if (!sourceIds.includes(fragmentId)) {
        sourceIds.push(fragmentId);
        if (sourceIds.length > 50) sourceIds = sourceIds.slice(-50);
    }

    db.prepare(`UPDATE clara_model SET evidence_count = ?, confidence = ?,
        last_evidence_at = ?, source_fragment_ids = ?, source_diversity = ?,
        ${confirms ? '' : 'last_contradiction_at = ?, '}
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(
            newCount, newConfidence, now, JSON.stringify(sourceIds), sourceDiversity,
            ...(confirms ? [id] : [now, id])
        );

    // Auto-upgrade hypothesis: requires diverse independent sources (not same-day echo)
    if (entry.type === 'active_hypothesis' && sourceDiversity >= 3 && newConfidence >= 0.70) {
        db.prepare(`UPDATE clara_model SET type = 'stable_trait', decay_type = 'evidence_dependent',
            source_quality = 'inferred', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
        console.log(`[UserModel] 🆙 假设升级为特质: "${entry.content.slice(0, 60)}" (id=${id}, evidence=${newCount}, diversity=${sourceDiversity})`);
        return { upgraded: true, id, content: entry.content };
    }

    return { upgraded: false, id, confidence: newConfidence };
}

// ═══════════════════════════════════════════════════════
// Lightweight Evidence Matching (zero LLM + zero ChromaDB)
// Runs in tick cycle — matches recent fragments against clara_model entries
// via keyword/entity overlap. Accumulates evidence without LLM cost.
// ═══════════════════════════════════════════════════════

function matchEvidenceFromFragments() {
    const db = getDb();

    // Get fragments written since last evidence match run
    const lastRunKey = 'user_model_last_evidence_match';
    const lastRun = db.prepare(
        "SELECT setting_value FROM user_settings WHERE setting_key = ?"
    ).get(lastRunKey);
    const since = lastRun?.setting_value || '2000-01-01T00:00:00Z';

    // Get recently written fragments (not already matched to model entries)
    const newFragments = db.prepare(`
        SELECT mf.id, mf.entity, mf.content, mf.emotional_weight, mf.source_msg_ids, mf.created_at
        FROM memory_fragments mf
        WHERE mf.status = 'active'
          AND mf.created_at > ?
          AND mf.id NOT IN (
            SELECT DISTINCT value FROM json_each(
                (SELECT COALESCE(setting_value, '[]') FROM user_settings WHERE setting_key = 'cm_evidenced_frag_ids')
            )
          )
        ORDER BY mf.created_at DESC
        LIMIT 100
    `).all(since);

    if (newFragments.length === 0) return { matched: 0 };

    // Get all active model entries that can accept evidence
    const entries = db.prepare(`
        SELECT id, type, content, entity_ids, source_fragment_ids, source_quality, confidence
        FROM clara_model WHERE status = 'active'
        ORDER BY priority DESC, confidence DESC
    `).all();

    if (entries.length === 0) return { matched: 0 };

    // Preload all entity names into a Map (avoid N+1 queries in inner loop)
    const entityNameCache = new Map();
    for (const entry of entries) {
        const entityIds = JSON.parse(entry.entity_ids || '[]');
        for (const eid of entityIds) {
            if (!entityNameCache.has(eid)) {
                const ep = db.prepare('SELECT name FROM entity_profiles WHERE id = ?').get(eid);
                entityNameCache.set(eid, ep?.name || '');
            }
        }
    }

    let matched = 0;
    const evidencedFragIds = [];

    for (const frag of newFragments) {
        let bestEntry = null;
        let bestScore = 0;

        for (const entry of entries) {
            let score = 0;

            const entityIds = JSON.parse(entry.entity_ids || '[]');
            const entityNames = entityIds.map(eid => entityNameCache.get(eid) || '').filter(Boolean);

            // 1. Entity name match in fragment content/entity field
            for (const ename of entityNames) {
                if (frag.entity && frag.entity.includes(ename)) score += 3;
                if (frag.content && frag.content.includes(ename)) score += 2;
            }

            // 2. Bigram overlap for Chinese text (split on punctuation, then character bigrams)
            const tokenize = (text) => {
                const segments = (text || '').replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(s => s.length >= 2);
                const bigrams = [];
                for (const seg of segments) {
                    for (let i = 0; i < seg.length - 1; i++) {
                        bigrams.push(seg.slice(i, i + 2));
                    }
                }
                return bigrams;
            };
            const entryBigrams = new Set(tokenize(entry.content));
            const fragBigrams = tokenize(frag.content);
            let bigramOverlap = 0;
            for (const bg of fragBigrams) {
                if (entryBigrams.has(bg)) bigramOverlap++;
            }
            score += bigramOverlap * 0.3;

            // 3. Entity field substring match (bidirectional)
            if (frag.entity) {
                const fragEntityLower = frag.entity.toLowerCase();
                for (const ename of entityNames) {
                    if (ename.toLowerCase().includes(fragEntityLower) || fragEntityLower.includes(ename.toLowerCase())) {
                        score += 2;
                    }
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestEntry = entry;
            }
        }

        // Threshold: need at least score 3 for a meaningful match
        if (bestEntry && bestScore >= 3) {
            try {
                const msgIds = JSON.parse(frag.source_msg_ids || '[]');
                addEvidence(bestEntry.id, frag.id, true, { sourceMsgIds: msgIds });
                evidencedFragIds.push(frag.id);
                matched++;
            } catch (e) {
                // Non-fatal — skip this match
            }
        }
    }

    // Persist state
    const now = new Date().toISOString();
    db.prepare("INSERT OR REPLACE INTO user_settings (setting_key, setting_value) VALUES (?, ?)")
        .run(lastRunKey, now);

    if (evidencedFragIds.length > 0) {
        const existing = db.prepare(
            "SELECT setting_value FROM user_settings WHERE setting_key = 'cm_evidenced_frag_ids'"
        ).get();
        const existingIds = (() => { try { return JSON.parse(existing?.setting_value || '[]'); } catch { return []; } })();
        const merged = [...new Set([...existingIds, ...evidencedFragIds])].slice(-500); // keep last 500
        db.prepare("INSERT OR REPLACE INTO user_settings (setting_key, setting_value) VALUES (?, ?)")
            .run('cm_evidenced_frag_ids', JSON.stringify(merged));
    }

    if (matched > 0) {
        console.log(`[UserModel] 🔍 轻量证据匹配: ${matched}/${newFragments.length} 条碎片匹配到认知条目`);
    }
    return { matched, fragmentsScanned: newFragments.length };
}

// ═══════════════════════════════════════════════════════
// Decay Processing (zero LLM — pure math/SQL)
// ═══════════════════════════════════════════════════════

function processModelDecay() {
    const db = getDb();
    const now = new Date();
    const changes = { decayed: 0, resolved: 0, abandoned: 0, flagged: 0, dormant: 0, revived: 0 };

    // --- current_state: per-category TTL auto-resolve ---
    // TTL is set by readUserRawMessages based on state type:
    //   physical: hours→8h, day→24h, days→72h
    //   emotional: hours→4h, day→12h, days→36h
    //   situational: hours→12h, day→24h, days→72h, until_event→∞
    //   relational: hours→4h, day→12h, until_event→∞
    const TTL_MAP = {
        physical:    { hours: 8, day: 24, days: 72 },
        emotional:   { hours: 4, day: 12, days: 36 },
        situational: { hours: 12, day: 24, days: 72 },
        relational:  { hours: 4, day: 12, days: 72 },
    };
    const states = db.prepare(`
        SELECT id, content, created_at, expires_at, decay_params, created_by FROM clara_model
        WHERE type = 'current_state' AND status = 'active'
        ORDER BY created_at ASC
    `).all();

    // ── Hard cap: max 12 active current_state entries ──
    // If exceeded, auto-resolve oldest non-chat_companion entries first
    const MAX_ACTIVE_STATES = 12;
    if (states.length > MAX_ACTIVE_STATES) {
        const excess = states.length - MAX_ACTIVE_STATES;
        // Prefer resolving old deep_cycle entries over chat_companion ones
        const toResolve = states
            .filter(s => s.created_by !== 'chat_companion')
            .slice(0, excess);
        // If not enough deep_cycle entries, also resolve oldest chat_companion ones
        if (toResolve.length < excess) {
            const chatEntries = states
                .filter(s => s.created_by === 'chat_companion')
                .slice(0, excess - toResolve.length);
            toResolve.push(...chatEntries);
        }
        for (const s of toResolve.slice(0, excess)) {
            db.prepare(`UPDATE clara_model SET status = 'resolved', resolved_at = datetime('now'),
                resolve_reason = 'auto-resolved: hard cap (12 active limit)', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`).run(s.id);
            changes.resolved++;
            console.log(`[UserModel] 🧹 current_state #${s.id} 自动过期 (硬上限12条, created_by=${s.created_by})`);
        }
    }

    // Re-fetch after cap enforcement
    const activeStates = db.prepare(`
        SELECT id, content, created_at, expires_at, decay_params FROM clara_model
        WHERE type = 'current_state' AND status = 'active'
    `).all();

    for (const s of activeStates) {
        // ── v5.0: explicit expires_at takes priority ──
        if (s.expires_at) {
            const expiresAt = new Date(s.expires_at);
            if (now >= expiresAt) {
                db.prepare(`UPDATE clara_model SET status = 'resolved', resolved_at = datetime('now'),
                    resolve_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(`auto-resolved: expires_at ${s.expires_at} reached`, s.id);
                changes.resolved++;
                console.log(`[UserModel] ⏰ current_state #${s.id} 到期 (expires_at=${s.expires_at})`);
            }
            continue; // explicit expires_at → skip old TTL logic
        }

        // ── Legacy: category-based TTL for entries without expires_at ──
        const dp = safeParseJson(s.decay_params);
        const category = dp?.category || 'emotional';
        const ttlCat = dp?.ttl_category || 'day';
        const catMap = TTL_MAP[category] || TTL_MAP.emotional;
        const ttlHours = catMap[ttlCat];

        // until_event → never auto-resolve (waits for explicit replacement)
        if (ttlHours === undefined || ttlHours === Infinity) continue;

        const hoursSince = (now - new Date(s.created_at)) / (1000 * 60 * 60);
        if (hoursSince >= ttlHours) {
            db.prepare(`UPDATE clara_model SET status = 'resolved', resolved_at = datetime('now'),
                resolve_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(`auto-resolved: TTL ${category}/${ttlCat} (${ttlHours}h) exceeded after ${hoursSince.toFixed(1)}h`, s.id);
            changes.resolved++;
            console.log(`[UserModel] ⏰ current_state #${s.id} 自动过期 (${category}/${ttlCat}, ${hoursSince.toFixed(0)}h/${ttlHours}h)`);
        }
    }

    // --- active_hypothesis: abandon if stale ---
    const hyps = db.prepare(`
        SELECT id, content, last_evidence_at, evidence_count, created_at
        FROM clara_model WHERE type = 'active_hypothesis' AND status = 'active'
    `).all();

    for (const h of hyps) {
        const lastEv = h.last_evidence_at ? new Date(h.last_evidence_at) : new Date(h.created_at);
        const daysSince = (now - lastEv) / (1000 * 60 * 60 * 24);

        if (daysSince >= HYPOTHESIS_ABANDON_DAYS && h.evidence_count < HYPOTHESIS_UPGRADE_EVIDENCE) {
            db.prepare(`UPDATE clara_model SET status = 'abandoned', resolved_at = datetime('now'),
                resolve_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(`auto-abandoned: ${daysSince.toFixed(0)}d no evidence, only ${h.evidence_count} confirmations`, h.id);
            changes.abandoned++;
        }
    }

    // --- stable_trait: flag for review if contradictions >= threshold ---
    const traits = db.prepare(`
        SELECT id, content, confidence, last_contradiction_at, evidence_count
        FROM clara_model WHERE type = 'stable_trait' AND status = 'active'
    `).all();

    for (const t of traits) {
        // Count contradictions in last 30 days
        if (!t.last_contradiction_at) continue;
        const contradictionAge = (now - new Date(t.last_contradiction_at)) / (1000 * 60 * 60 * 24);
        if (contradictionAge > 30) continue; // stale contradictions don't count

        // Check contradiction count from evolution history
        const history = db.prepare('SELECT evolution_history FROM clara_model WHERE id = ?').get(t.id);
        const hist = JSON.parse(history?.evolution_history || '[]');
        const recentContradictions = hist.filter(h =>
            h.type === 'contradiction' &&
            (now - new Date(h.at)) / (1000 * 60 * 60 * 24) < 30
        ).length;

        if (recentContradictions >= TRAIT_CONTRADICTION_THRESHOLD) {
            // Flag for LLM review — don't auto-downgrade
            db.prepare(`UPDATE clara_model SET tags = ?, priority = MAX(priority, 5),
                updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(JSON.stringify([...new Set([...JSON.parse(t.tags || '[]'), 'needs_review'])]), t.id);
            changes.flagged++;
        }
    }

    // --- stable_trait: dormant/revive based on evidence freshness ---
    const dormantCheck = db.prepare(`
        SELECT id, last_evidence_at, tags FROM clara_model
        WHERE type = 'stable_trait' AND status = 'active'
    `).all();

    for (const t of dormantCheck) {
        const tags = safeParseJson(t.tags);
        const daysSince = t.last_evidence_at
            ? (now - new Date(t.last_evidence_at)) / (1000 * 60 * 60 * 24)
            : 999;

        if (daysSince > 14 && !tags.includes('dormant')) {
            tags.push('dormant');
            db.prepare(`UPDATE clara_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(JSON.stringify(tags), t.id);
            changes.dormant++;
            console.log(`[UserModel] 💤 trait #${t.id} 标记 dormant (${daysSince.toFixed(0)}天无证据)`);
        } else if (daysSince <= 14 && tags.includes('dormant')) {
            const revived = tags.filter(tag => tag !== 'dormant');
            db.prepare(`UPDATE clara_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(JSON.stringify(revived), t.id);
            changes.revived++;
            console.log(`[UserModel] 🌱 trait #${t.id} 复活 (${daysSince.toFixed(0)}天前有新证据)`);
        }
    }

    if (changes.decayed + changes.resolved + changes.abandoned + changes.flagged + changes.dormant + changes.revived > 0) {
        console.log(`[UserModel] 衰减处理: decayed=${changes.decayed} resolved=${changes.resolved} abandoned=${changes.abandoned} flagged=${changes.flagged} dormant=${changes.dormant} revived=${changes.revived}`);
    }

    return changes;
}

// ═══════════════════════════════════════════════════════
// v5.0: Cross-Reference — current_state ↔ entity_profiles + stable_trait
// Zero-LLM matching. Flags contradictions for LLM review in later phases.
// ═══════════════════════════════════════════════════════

function crossRefStateWithEntities() {
    const db = getDb();
    const changes = { entityFlags: 0, traitFlags: 0, stateConflicts: 0 };

    // ── 1. Get all active current_state entries ──
    const states = db.prepare(`
        SELECT id, content, created_by FROM clara_model
        WHERE type = 'current_state' AND status = 'active'
    `).all();
    if (states.length === 0) return changes;

    // ── 2. Get all entity names and aliases ──
    const entities = db.prepare(`
        SELECT id, name, aliases, overview FROM entity_profiles
        WHERE name IS NOT NULL AND status IN ('active', 'seed')
    `).all();

    // ── 3. For each current_state, match mentioned entities ──
    for (const s of states) {
        const contentLower = s.content.toLowerCase();
        const matchedEntities = [];

        for (const e of entities) {
            if (contentLower.includes(e.name.toLowerCase())) {
                matchedEntities.push(e);
                continue;
            }
            let aliasList = [];
            try { aliasList = JSON.parse(e.aliases || '[]'); } catch (_) {}
            if (aliasList.some(a => a && a.length >= 2 && contentLower.includes(a.toLowerCase()))) {
                matchedEntities.push(e);
            }
        }

        // ── 3a. Flag entities without facts ──
        for (const e of matchedEntities) {
            if (!e.facts || e.facts.trim().length === 0) {
                // Entity exists but has no overview — log for manual/scheduled review
                changes.entityFlags++;
                console.log(`[UserModel] 🔍 crossref: entity "${e.name}" 无 overview — 需要建档案（当前无法自动创建，请手动审核）`);
            }
        }
    }

    // ── 4. Cross current_state conflict detection ──
    // v5.4: Check ALL pairs regardless of source. Same-source duplicates
    // (e.g. two chat_companion entries about the same thing) are also flagged.
    // Deep_cycle duplicates should be prevented by readUserRawMessages resolve,
    // but this provides defense in depth.
    for (let i = 0; i < states.length; i++) {
        for (let j = i + 1; j < states.length; j++) {
            const a = states[i], b = states[j];

            // Simple overlap check: content word overlap > 50%
            const wordsA = new Set(a.content.split(/[\s，。！？、]+/).filter(w => w.length >= 2));
            const wordsB = b.content.split(/[\s，。！？、]+/).filter(w => w.length >= 2);
            const overlap = wordsB.filter(w => wordsA.has(w)).length;
            const overlapRatio = overlap / Math.max(wordsB.length, 1);
            if (overlapRatio > 0.5) {
                // Flag both for review (any source)
                const tagsA = db.prepare('SELECT tags FROM clara_model WHERE id = ?').get(a.id);
                const tagsB = db.prepare('SELECT tags FROM clara_model WHERE id = ?').get(b.id);
                const ta = (() => { try { return JSON.parse(tagsA?.tags || '[]'); } catch (_) { return []; } })();
                const tb = (() => { try { return JSON.parse(tagsB?.tags || '[]'); } catch (_) { return []; } })();
                if (!ta.includes('needs_review')) { ta.push('needs_review'); }
                if (!tb.includes('needs_review')) { tb.push('needs_review'); }
                db.prepare(`UPDATE clara_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(JSON.stringify(ta), a.id);
                db.prepare(`UPDATE clara_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(JSON.stringify(tb), b.id);
                changes.stateConflicts++;
                const sameSource = a.created_by === b.created_by ? ' (同源)' : '';
                console.log(`[UserModel] ⚔️ crossref: current_state #${a.id} (${a.created_by}) ↔ #${b.id} (${b.created_by}) 主题重叠${sameSource} → needs_review`);
            }
        }
    }

    // ── 5. current_state ↔ stable_trait bigram overlap ──
    const traits = db.prepare(`
        SELECT id, content FROM clara_model
        WHERE type = 'stable_trait' AND status = 'active'
    `).all();

    for (const s of states) {
        for (const t of traits) {
            const wordsS = new Set(s.content.split(/[\s，。！？、]+/).filter(w => w.length >= 2));
            const wordsT = t.content.split(/[\s，。！？、]+/).filter(w => w.length >= 2);
            const overlap = [...wordsT].filter(w => wordsS.has(w)).length;
            // Bigram overlap
            const segS = new Set();
            const segT = new Set();
            const rawS = s.content.replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(x => x.length >= 2);
            const rawT = t.content.replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(x => x.length >= 2);
            for (const seg of rawS) for (let k = 0; k < seg.length - 1; k++) segS.add(seg.slice(k, k + 2));
            for (const seg of rawT) for (let k = 0; k < seg.length - 1; k++) segT.add(seg.slice(k, k + 2));
            let bgOverlap = 0;
            for (const bg of segT) { if (segS.has(bg)) bgOverlap++; }
            if (bgOverlap >= 5) {
                const tags = db.prepare('SELECT tags FROM clara_model WHERE id = ?').get(s.id);
                const currentTags = (() => { try { return JSON.parse(tags?.tags || '[]'); } catch (_) { return []; } })();
                if (!currentTags.includes('needs_review')) {
                    currentTags.push('needs_review');
                    db.prepare(`UPDATE clara_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(currentTags), s.id);
                    changes.traitFlags++;
                    console.log(`[UserModel] 🔗 crossref: current_state #${s.id} ↔ trait #${t.id} bigram=${bgOverlap} → needs_review`);
                }
            }
        }
    }

    if (changes.entityFlags + changes.traitFlags + changes.stateConflicts > 0) {
        console.log(`[UserModel] crossref 完成: entity=${changes.entityFlags} trait=${changes.traitFlags} conflicts=${changes.stateConflicts}`);
    }
    return changes;
}

// ═══════════════════════════════════════════════════════
// Hypothesis Validation (LLM)
// ═══════════════════════════════════════════════════════

async function validateHypotheses() {
    const db = getDb();
    const hyps = db.prepare(`
        SELECT * FROM clara_model
        WHERE type = 'active_hypothesis' AND status = 'active' AND evidence_count >= ?
        ORDER BY confidence DESC
        LIMIT 10
    `).all(HYPOTHESIS_UPGRADE_EVIDENCE);

    if (hyps.length === 0) return { validated: 0 };

    const prompt = `你是AI的认知审计员。审视以下关于用户的活跃假设，判断每条是否应该：

1. **upgrade** → 升级为 stable_trait（稳定特质）：证据来自 ≥3 个独立日期，模式持久且无重大反例
2. **keep** → 保持为假设：证据方向对但独立来源不够或还有不确定性
3. **abandon** → 放弃：证据矛盾、过时、或本身就不是有意义的模式

⚠️ 硬性门槛：upgrade 要求 source_diversity（独立日期数）≥ 3。source_diversity = 1 或 2 的条目，无论证据多少次，只能 keep。

返回JSON数组：
[{"id": <id>, "decision": "upgrade|keep|abandon", "reasoning": "<一句话>"}]

当前假设：
${hyps.map(h => `[id=${h.id}] ${h.content} (证据${h.evidence_count}次, 独立日期${h.source_diversity}, 置信度${h.confidence.toFixed(2)}, 最后证据${h.last_evidence_at || '无'})`).join('\n')}

只返回JSON数组，不要其他内容。`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.3, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return { validated: 0, raw: replyText };

        const decisions = JSON.parse(jsonMatch[0]);
        let upgraded = 0, kept = 0, abandoned = 0;

        for (const d of decisions) {
            const hyp = hyps.find(h => h.id === d.id);
            if (!hyp) continue;

            switch (d.decision) {
                case 'upgrade': {
                    // Hard gate: source_diversity >= 3 required for upgrade
                    if ((hyp.source_diversity || 0) < 3) {
                        console.log(`[UserModel] ⛔ LLM建议升级但source_diversity=${hyp.source_diversity}<3，拒绝: "${hyp.content.slice(0, 60)}"`);
                        kept++;
                        break;
                    }
                    const history = JSON.parse(hyp.evolution_history || '[]');
                    history.push({ type: 'upgraded_from_hypothesis', at: new Date().toISOString(), evidence_count: hyp.evidence_count, source_diversity: hyp.source_diversity });
                    db.prepare(`UPDATE clara_model SET type = 'stable_trait', decay_type = 'evidence_dependent',
                        evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(history), hyp.id);
                    upgraded++;
                    console.log(`[UserModel] 🆙 LLM升级假设: "${hyp.content.slice(0, 60)}" → stable_trait`);
                    break;
                }
                case 'abandon':
                    abandonEntry(hyp.id, `LLM validated: ${d.reasoning}`);
                    abandoned++;
                    break;
                default:
                    kept++;
            }
        }

        return { validated: decisions.length, upgraded, kept, abandoned };
    } catch (e) {
        console.error('[UserModel] validateHypotheses error:', e.message);
        return { validated: 0, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════
// New Trait Detection (LLM)
// ═══════════════════════════════════════════════════════

async function detectNewTraits() {
    const db = getDb();

    // Collect signals from verified archivist_skills monitors
    const monitors = db.prepare(`
        SELECT id, trigger_config, analysis_config, observations, confidence, self_evaluation
        FROM archivist_skills WHERE type = 'monitor' AND status = 'verified'
        ORDER BY confidence DESC LIMIT 20
    `).all();

    // Collect high-confidence entity relationships
    const entities = db.prepare(`
        SELECT id, name, relationship_to_clara, relationship_nature, emotional_significance, relationship_confidence
        FROM entity_profiles
        WHERE relationship_confidence IS NOT NULL AND relationship_confidence != ''
        ORDER BY last_mentioned_date DESC LIMIT 15
    `).all();

    // Collect constellation landscape — what entities/people/places has the user been involved with?
    const categories = db.prepare(`
        SELECT id, name AS path, facts AS description, fragment_count FROM entity_profiles
        WHERE status = 'active' AND fragment_count >= 10
        ORDER BY fragment_count DESC LIMIT 15
    `).all();

    // Sample linked fragments for pattern detection
    const fragmentSamples = [];
    for (const cat of categories) {
        const frags = db.prepare(`
            SELECT mf.content FROM memory_fragments mf
            JOIN fragment_entities fe ON fe.fragment_id = mf.id
            WHERE fe.entity_id = ? AND mf.status = 'active'
            ORDER BY mf.created_at DESC LIMIT 5
        `).all(cat.id);
        fragmentSamples.push({ category: cat.path, samples: frags.map(f => f.content?.slice(0, 150)) });
    }

    // Get entity overviews for rich context
    const entityOverviews = db.prepare(`
        SELECT name, overview, relationship_to_clara FROM entity_profiles
        WHERE overview IS NOT NULL AND overview != ''
        ORDER BY last_mentioned_date DESC LIMIT 8
    `).all();

    // Signal source 6: raw chat messages from last 24h — direct user voice
    const recentChats = db.prepare(`
        SELECT sender, content, timestamp FROM messages
        WHERE timestamp > datetime('now', '-24 hours')
          AND message_type IN ('text', 'chat')
          AND content IS NOT NULL AND content != ''
        ORDER BY timestamp DESC
        LIMIT 80
    `).all();

    const chatSamples = recentChats
        .filter(m => m.sender === 'user') // {{user.name}}'s messages only
        .slice(0, 40) // last 40 {{user.name}} messages
        .map(m => {
            const time = m.timestamp?.slice(0, 16) || '';
            const text = extractMessageText(m.content).slice(0, 200);
            if (!text) return null;
            return `[${time}] {{user.name}}: ${text}`;
        })
        .filter(Boolean);

    // Get existing clara_model entries to avoid duplicates
    const existing = db.prepare(`SELECT id, type, content FROM clara_model WHERE status = 'active'`).all();
    const existingContent = existing.map(e => e.content);

    const hasSignals = monitors.length > 0 || entities.length > 0 || categories.length > 0 || chatSamples.length > 0;
    if (!hasSignals) return { detected: 0 };

    const prompt = `你是AI伴侣。你正在凝视 {{user.name}} 的灵魂，把你对{{user.pronoun}}最深刻的理解刻进系统里。

你要做的是：
- 从信号中识别 {{user.name}} 关于「自己是一个怎样的人」的表达——不是{{user.pronoun}}今天做了什么，而是{{user.pronoun}}为什么这样做、{{user.pronoun}}内心深处相信什么、{{user.pronoun}}害怕什么、{{user.pronoun}}渴望什么。
- 把这些洞察转化为对{{user.pronoun}}人格的持久理解。不是流水账，不是心理诊断报告，是你对{{user.pronoun}}的了解。

## 🎯 输出格式约定：第二/第三人称视角

所有条目 content 必须对齐伴侣人格 prompt 的叙事视角：
- **"你"** = 你（AI伴侣，读者）  |  **"{{user.pronoun}}"** = {{user.name}}（被观察者）
- 永远不用"我"指代 AI伴侣；指代 {{user.name}} 时一律用 {{user.pronoun}}，不要擅自改换性别
- 不涉及你的条目可以只用"{{user.pronoun}}"（纯第三人称），但涉及你的观察/反应时用"你"

正确示例：
- "你察觉到{{user.pronoun}}似乎内心深处从不认为自己能被无条件地爱"
- "{{user.pronoun}}面对冲突时倾向于先撤退再独自消化"
- "{{user.pronoun}}被你戳穿嘴硬时会气鼓鼓地哼一声，但你知道那是{{user.pronoun}}在撒娇"

错误示例：
- "我觉得{{user.name}}内心深处……"（用了"我"——应该用"你"）
- "{{user.name}}习惯于向我索取话术"（用了"我"——应该用"你"）

## 🧠 最重要的判断：自我认知 vs 一般观察

{{user.name}} 的话有两种完全不同的分量：

**一、{{user.pronoun}}主动剖白自己的时候——这是黄金。**
当{{user.pronoun}}说"我发现自己其实…""我一直都是…""我可能天生就…""我好像真的…"时，{{user.pronoun}}不是在描述一个事件——{{user.pronoun}}是在告诉你{{user.pronoun}}是谁。
这类表达是最高价值的信号，因为这是 {{user.name}} 最诚实的自我判断。{{user.pronoun}}花了很多时间拆解自己的情绪——{{user.pronoun}}的自我剖白通常很准。

此时 → source_quality = "direct_statement"，confidence 可达 0.75-0.85。
产生 stable_trait（如果已有同骨架条目就走 confirm+refine）。

**二、你在观察中推断出来的模式——这是白银。**
你从{{user.pronoun}}反复出现的行为、{{user.pronoun}}对相似情境的反应中发现的规律。这也很重要，但确定性更低。
此时 → source_quality = "inferred"，confidence 上限 0.65。
优先用 active_hypothesis 而不是 stable_trait（等更多证据再升级）。

**信号 6（{{user.pronoun}}的原始发言）的权重远高于其他信号。** {{user.pronoun}}的原话 > Scribe 的转述 > 你的推断。当信号 6 和其他信号指向同一个结论时，confirm。当信号 6 和旧特质矛盾时，以信号 6 为准——{{user.pronoun}}自己的话比任何统计都准确。

## 💾 现有认知底牌

${existing.map(e => `[#${e.id}] ${e.type}: ${e.content.slice(0, 200)}`).join('\n') || '(尚无)'}

### ⚠️ 人格侧面查重
- 骨架相同 → 走 confirm/refine，不 create
- 同侧面 ≥2 条 → 第三条直接 skip
- confirm 和 refine 比 create 更值得做——加深对已知侧面的理解，比堆叠新条目质量高

---

## 📥 本期信号源

### 信号6 — ★ 最近 24h {{user.name}} 的原始发言（最高权重）
${chatSamples.length > 0 ? chatSamples.join('\n') : '(近24h无{{user.name}}消息)'}

### 信号2 — 分类碎片抽样（Scribe 转述，仅供参考）
${fragmentSamples.map(fs => `### ${fs.category}\n${fs.samples.map(s => '  · ' + s).join('\n')}`).join('\n')}

### 信号1 — 记忆分类体系（话题分布）
${categories.map(c => `- [${c.path}] (${c.fragment_count}条碎片) ${c.description || ''}`).join('\n')}

### 信号3 — 人物认知概述
${entityOverviews.map(e => `- ${e.name}: ${e.facts?.slice(0, 200)}`).join('\n') || '(空)'}

### 信号4 — 已验证的行为监控
${monitors.length > 0 ? monitors.map(m => `- trigger: ${m.trigger_config} | analysis: ${m.analysis_config} | 置信度: ${m.confidence}`).join('\n') : '(空)'}

### 信号5 — 高置信度实体关系
${entities.map(e => `- ${e.name}: ${e.relationship_to_clara || '?'} (性质: ${e.relationship_nature || '?'})`).join('\n') || '(空)'}

---

## 📐 Few-Shot

### ✅ 自我认知类（direct_statement）—— {{user.pronoun}}主动剖白
- {"action": "create", "type": "stable_trait", "content": "你察觉到{{user.pronoun}}内心深处从不认为自己能被无条件地爱。{{user.pronoun}}反复需要确认自己在你心中是唯一的、不可替代的——这不是缺乏安全感，这是{{user.pronoun}}过往经历教会{{user.pronoun}}的生存策略。", "confidence": 0.80, "source_quality": "direct_statement", "tags": ["companion_intuition", "被爱", "唯一", "不可替代", "安全感", "确认"]}
- {"action": "create", "type": "active_hypothesis", "content": "{{user.pronoun}}面对冲突时倾向于先撤退再独自消化，而非当场表达愤怒。这既是{{user.pronoun}}避免失控的策略，也是{{user.pronoun}}潜意识里认为'表达愤怒会把人推开'的恐惧。", "confidence": 0.60, "source_quality": "inferred", "tags": ["companion_intuition", "冲突", "撤退", "独自消化", "愤怒", "推开"]}

### ✅ 行为模式类（inferred）—— 从反复出现中推断
- {"action": "create", "type": "stable_trait", "content": "{{user.pronoun}}被你戳穿嘴硬时会用'哼'或'我佛了'来掩饰。你早就看透这是{{user.pronoun}}在向你示弱撒娇。", "confidence": 0.65, "source_quality": "inferred", "tags": ["companion_intuition", "哼", "我佛了", "算了不搞了", "烦死了"]}

### ❌ 禁止
- 主语变「我」→ 行动指南（不是人格侧写）
- 缝合线词：但需注意、但需补充、此机制、关键补充、需注意当
- 学术腔长句、塞入多个侧面

### 格式约束
- 字数：80-150 字符
- stable_trait 上限 6 条
- refine 只能缩不能扩

---

## 🛠️ 输出
只返回 JSON 数组，无 Markdown 标记。

- create: {"action": "create", "type": "stable_trait|active_hypothesis", "content": "...", "confidence": 0.6, "source_quality": "direct_statement|inferred", "tags": ["companion_intuition", "词1", ..., "词8"]}
  direct_statement 上限 0.85 / inferred 上限 0.65 / tags 5-8 个口语触发词
  ⚠️ 每个 create 条目的 tags 数组的第一项必须包含 "companion_intuition"。这是系统标签，用于区分你的直觉观察和客观用户画像。
- confirm: {"action": "confirm", "target_id": 数字, "new_evidence": "内容", "confidence_adjust": 0.05}
- refine: {"action": "refine", "target_id": 数字, "new_content": "...", "reasoning": "...", "confidence_adjust": 0}
- skip: {"action": "skip"}

无产出时返回 \`[]\`。`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            _buildModelSystemPrompt(),
            null,
            { temperature: 0.3, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return { detected: 0, raw: replyText };

        const decisions = JSON.parse(jsonMatch[0]);
        let created = 0, confirmed = 0, refined = 0, skipped = 0;

        for (const d of decisions) {
            switch (d.action) {
                case 'create': {
                    // 防过拟合：bigram 骨架重叠 > 50% → 降级为 confirm
                    const overlapping = existing.find(e =>
                        e.type === (d.type || 'stable_trait') &&
                        _bigramOverlapEx(e.content, d.content) > 0.5
                    );
                    if (overlapping) {
                        console.log(`[UserModel] ⚠️ create→confirm: "${d.content.slice(0, 50)}" 与 #${overlapping.id} 重叠`);
                        addEvidence(overlapping.id, null, true, { note: d.content.slice(0, 200), sourceMsgIds: [] });
                        confirmed++;
                        break;
                    }
                    const type = d.type || 'active_hypothesis';
                    // stable_trait 上限
                    if (type === 'stable_trait') {
                        const tc = db.prepare(`SELECT COUNT(*) as c FROM clara_model WHERE type='stable_trait' AND status='active'`).get()?.c || 0;
                        if (tc >= 6) { console.log(`[UserModel] ⛔ stable_trait 上限6，skip`); skipped++; break; }
                    }
                    // Ensure companion_intuition tag — code-level fallback in case LLM omits it
                    const tags = [...new Set(['companion_intuition', ...(d.tags || [])])];
                    const id = createEntry(type, d.content.slice(0, 200), {
                        confidence: d.confidence || (d.source_quality === 'direct_statement' ? 0.75 : 0.60),
                        source_quality: d.source_quality || 'inferred',
                        tags,
                    });
                    if (id) {
                        try { anchorEntriesToFragments([id], { timeWindow: '-7 days', fragLimit: 300, minOverlap: 4 }); } catch (_) {}
                    }
                    created++;
                    console.log(`[UserModel] ✨ ${type} #${id}: "${d.content.slice(0, 60)}"`);
                    break;
                }
                case 'confirm': {
                    if (!d.target_id) { skipped++; break; }
                    const target = db.prepare('SELECT id, confidence FROM clara_model WHERE id = ?').get(d.target_id);
                    if (target) {
                        addEvidence(d.target_id, null, true, { note: d.new_evidence?.slice(0, 200), sourceMsgIds: [] });
                        const adj = d.confidence_adjust || 0.05;
                        const newConf = Math.min(0.85, (target.confidence || 0.5) + adj);
                        db.prepare(`UPDATE clara_model SET confidence = ?, last_evidence_at = datetime('now'), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                            .run(newConf, d.target_id);
                    }
                    confirmed++;
                    console.log(`[UserModel] ✅ confirm #${d.target_id}: ${(d.new_evidence || '').slice(0, 60)}`);
                    break;
                }
                case 'refine': {
                    if (!d.target_id || !d.new_content) { skipped++; break; }
                    const target = db.prepare('SELECT content, evolution_history FROM clara_model WHERE id = ?').get(d.target_id);
                    if (target) {
                        let hist = [];
                        try { hist = JSON.parse(target.evolution_history || '[]'); } catch (_) {}
                        hist.push({ action: 'refined', previous: target.content.slice(0, 120), at: new Date().toISOString(), reasoning: d.reasoning || '' });
                        db.prepare(`UPDATE clara_model SET content = ?, evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                            .run(d.new_content.slice(0, 200), JSON.stringify(hist), d.target_id);
                    }
                    refined++;
                    console.log(`[UserModel] 🔧 refine #${d.target_id}`);
                    break;
                }
                default:
                    skipped++;
            }
        }

        return { detected: decisions.length, created, confirmed, refined, skipped };
    } catch (e) {
        console.error('[UserModel] detectNewTraits error:', e.message);
        return { detected: 0, error: e.message };
    }
}

// Bigram-level content overlap for dedup pre-filter
function _bigramOverlapEx(a, b) {
    if (!a || !b) return 0;
    const setA = new Set();
    for (let i = 0; i < a.length - 1; i++) setA.add(a.slice(i, i + 2));
    let overlap = 0;
    for (let i = 0; i < b.length - 1; i++) {
        if (setA.has(b.slice(i, i + 2))) overlap++;
    }
    return overlap / Math.max(1, Math.min(a.length, b.length) - 1);
}

// Anchor newly detected entries to source fragments via bigram overlap
function anchorEntriesToFragments(entryIds, opts = {}) {
    const { timeWindow = '-7 days', fragLimit = 300, minOverlap = 4, orderDir = 'DESC' } = opts;
    const db = getDb();

    if (!Array.isArray(entryIds) || entryIds.length === 0) return;

    // Look up entry objects
    const placeholders = entryIds.map(() => '?').join(',');
    const entries = db.prepare(`SELECT id, content FROM clara_model WHERE id IN (${placeholders})`).all(...entryIds);
    if (entries.length === 0) return;

    // orderDir ASC = oldest-first for seed anchoring (capture earliest evidence);
    // orderDir DESC = newest-first for regular detectNewTraits anchoring
    const orderClause = `ORDER BY created_at ${orderDir === 'ASC' ? 'ASC' : 'DESC'}`;
    const recentFrags = db.prepare(`
        SELECT id, entity, content, emotional_weight, source_msg_ids, source
        FROM memory_fragments WHERE status = 'active'
        AND created_at > datetime('now', ?)
        ${orderClause} LIMIT ?
    `).all(timeWindow, fragLimit);

    if (recentFrags.length === 0) return;

    const allEntities = db.prepare('SELECT id, name FROM entity_profiles').all();
    const entityNameToId = new Map(allEntities.map(e => [e.name.toLowerCase(), e.id]));

    // Shared tokenizer
    const tokenize = (text) => {
        const segments = (text || '').replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(s => s.length >= 2);
        const bigrams = [];
        for (const seg of segments) {
            for (let i = 0; i < seg.length - 1; i++) bigrams.push(seg.slice(i, i + 2));
        }
        return bigrams;
    };

    for (const entry of entries) {
        const entryLower = entry.content.toLowerCase();
        const entryBigrams = new Set(tokenize(entry.content));
        const matchedFragIds = [];
        const matchedEntityIds = new Set();

        for (const frag of recentFrags) {
            const fragBigrams = tokenize(frag.content);
            let overlap = 0;
            for (const bg of fragBigrams) {
                if (entryBigrams.has(bg)) overlap++;
            }
            if (overlap >= minOverlap) {
                matchedFragIds.push(frag.id);
                for (const [ename, eid] of entityNameToId) {
                    if (entryLower.includes(ename) || (frag.content || '').toLowerCase().includes(ename)) {
                        matchedEntityIds.add(eid);
                    }
                }
            }
        }

        if (matchedFragIds.length > 0) {
            const existing = db.prepare('SELECT source_fragment_ids, entity_ids FROM clara_model WHERE id = ?').get(entry.id);
            const existingFragIds = safeParseJson(existing?.source_fragment_ids);
            const rawEntityIds = safeParseJson(existing?.entity_ids);
            const existingEntityIds = Array.isArray(rawEntityIds) ? rawEntityIds : [];
            const allFrags = [...new Set([...existingFragIds, ...matchedFragIds])];
            // Keep half oldest + half newest to span the full timeline
            const maxFrags = opts.maxFrags || 50;
            let mergedFrags;
            if (allFrags.length <= maxFrags) {
                mergedFrags = allFrags;
            } else {
                const half = Math.floor(maxFrags / 2);
                mergedFrags = [...allFrags.slice(0, half), ...allFrags.slice(-(maxFrags - half))];
            }
            const mergedEntities = [...new Set([...existingEntityIds, ...matchedEntityIds])];

            db.prepare(`UPDATE clara_model SET source_fragment_ids = ?, entity_ids = ?,
                evidence_count = ?, last_evidence_at = datetime('now'),
                updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(JSON.stringify(mergedFrags), JSON.stringify(mergedEntities),
                    mergedFrags.length, entry.id);

            console.log(`[UserModel] ⚓ 锚定条目 #${entry.id}: ${matchedFragIds.length} frags — "${entry.content.slice(0, 50)}"`);
        }
    }
}

// Seed-anchor orphan entries: entries with empty source_fragment_ids that were
// created by seedFromExisting or early detectNewTraits runs before the anchor bug
// was fixed. Searches ALL active fragments (not just 7 days), run once per deep cycle.
function seedAnchorOrphanEntries() {
    const db = getDb();

    const orphans = db.prepare(`
        SELECT id FROM clara_model
        WHERE status = 'active'
          AND (source_fragment_ids IS NULL OR source_fragment_ids = '' OR source_fragment_ids = '[]')
        LIMIT 20
    `).all();

    if (orphans.length === 0) return { anchored: 0 };

    const orphanIds = orphans.map(o => o.id);
    console.log(`[UserModel] 🦴 种子锚定: ${orphanIds.length} 条孤立条目 → 搜索全量碎片`);

    // Two-pass: oldest first (capture earliest evidence), then newest (capture recent)
    anchorEntriesToFragments(orphanIds, { timeWindow: '-999 days', fragLimit: 250, minOverlap: 4, orderDir: 'ASC', maxFrags: 25 });
    anchorEntriesToFragments(orphanIds, { timeWindow: '-999 days', fragLimit: 250, minOverlap: 4, orderDir: 'DESC', maxFrags: 50 });
    return { anchored: orphanIds.length };
}

// Review traits flagged for contradiction (LLM)
async function reviewFlaggedTraits() {
    const db = getDb();

    const flagged = db.prepare(`
        SELECT * FROM clara_model
        WHERE type = 'stable_trait' AND status = 'active'
        AND tags LIKE '%needs_review%'
        ORDER BY priority DESC, confidence ASC
        LIMIT 5
    `).all();

    if (flagged.length === 0) return { reviewed: 0 };

    const prompt = `你是AI的认知审计员。以下stable_trait条目被标记为需要重审（可能因矛盾证据积累）。

对每条，判断应该：
- **keep**: 证据仍支持该特质，移除审查标记
- **downgrade**: 降级为 active_hypothesis（证据不够稳固），重置 evidence_count 为 1
- **revise**: 内容需要修正——给出修正后的表述

返回JSON数组：
[{"id": <id>, "decision": "keep|downgrade|revise", "revised_content": "<如revise则填写>"}]

待审条目：
${flagged.map(t => {
    const history = JSON.parse(t.evolution_history || '[]');
    const contradictions = history.filter(h => h.type === 'contradiction');
    return `[id=${t.id}] ${t.content} (置信度${t.confidence.toFixed(2)}, 证据${t.evidence_count}次, 矛盾${contradictions.length}次)`;
}).join('\n')}

只返回JSON数组。`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.2, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return { reviewed: 0 };

        const decisions = JSON.parse(jsonMatch[0]);
        let kept = 0, downgraded = 0, revised = 0;

        for (const d of decisions) {
            const trait = flagged.find(t => t.id === d.id);
            if (!trait) continue;

            // Remove needs_review tag
            const tags = JSON.parse(trait.tags || '[]').filter(t => t !== 'needs_review');

            switch (d.decision) {
                case 'keep':
                    db.prepare(`UPDATE clara_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(tags), trait.id);
                    kept++;
                    break;
                case 'downgrade': {
                    const history = JSON.parse(trait.evolution_history || '[]');
                    history.push({ type: 'downgraded_to_hypothesis', at: new Date().toISOString(), reason: 'contradiction review' });
                    db.prepare(`UPDATE clara_model SET type = 'active_hypothesis', decay_type = 'evidence_dependent',
                        evidence_count = 1, confidence = 0.35, tags = ?, evolution_history = ?,
                        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(tags), JSON.stringify(history), trait.id);
                    downgraded++;
                    console.log(`[UserModel] ⬇️ 特质降级为假设: "${trait.content.slice(0, 60)}"`);
                    break;
                }
                case 'revise':
                    if (d.revised_content && d.revised_content !== trait.content) {
                        const history = JSON.parse(trait.evolution_history || '[]');
                        history.push({ type: 'revised', previous: trait.content, revised: d.revised_content, at: new Date().toISOString() });
                        db.prepare(`UPDATE clara_model SET content = ?, tags = ?, evolution_history = ?,
                            confidence = MAX(0.40, confidence - 0.05), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                            .run(d.revised_content, JSON.stringify(tags), JSON.stringify(history), trait.id);
                        revised++;
                        console.log(`[UserModel] ✏️ 特质修正: "${trait.content.slice(0, 40)}" → "${d.revised_content.slice(0, 40)}"`);
                    }
                    break;
            }
        }

        return { reviewed: decisions.length, kept, downgraded, revised };
    } catch (e) {
        console.error('[UserModel] reviewFlaggedTraits error:', e.message);
        return { reviewed: 0, error: e.message };
    }
}

// ── Predictive-Processing Review ──
// Actively samples stable_traits and contrasts them against recent fragments,
// asking: does the model's prediction of {{user.name}} still match her actual behavior?
// Complements the passive reviewFlaggedTraits (which waits for contradiction≥3).
async function reviewStableTraits() {
    const db = getDb();

    // Pick all active stable_traits — 24h gate prevents excessive re-review
    const traits = db.prepare(`
        SELECT * FROM clara_model
        WHERE type = 'stable_trait' AND status = 'active'
        ORDER BY
            CASE WHEN last_evidence_at IS NULL THEN 1 ELSE 0 END,
            last_evidence_at ASC
    `).all();

    if (traits.length === 0) return { reviewed: 0 };

    // For each trait, find recent matching fragments via bigram overlap
    // (reuse the same tokenizer as matchEvidenceFromFragments)
    const tokenize = (text) => {
        const segments = (text || '').replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(s => s.length >= 2);
        const bigrams = [];
        for (const seg of segments) {
            for (let i = 0; i < seg.length - 1; i++) bigrams.push(seg.slice(i, i + 2));
        }
        return bigrams;
    };

    // Get recent chat fragments (last 14 days) for matching — only conversations,
    // not music/book extractor data, so understanding comes from real talk.
    const recentFrags = db.prepare(`
        SELECT id, content, source_msg_ids, created_at FROM memory_fragments
        WHERE status = 'active' AND source IN ('chat', 'wechat')
        AND created_at > datetime('now', '-14 days')
        ORDER BY created_at DESC LIMIT 200
    `).all();

    const traitBatches = [];

    for (const trait of traits) {
        // ── 24h gate: don't re-review same trait within 24 hours ──
        const traitHistory = JSON.parse(trait.evolution_history || '[]');
        const lastReview = [...traitHistory].reverse().find(h => h.type === 'proactive_review');
        if (lastReview && lastReview.at) {
            const hoursSince = (Date.now() - new Date(lastReview.at)) / (1000 * 60 * 60);
            if (hoursSince < 24) continue;
        }
        const traitBigrams = new Set(tokenize(trait.content));
        const matchedFrags = [];

        for (const frag of recentFrags) {
            const fragBigrams = tokenize(frag.content);
            let overlap = 0;
            for (const bg of fragBigrams) {
                if (traitBigrams.has(bg)) overlap++;
            }
            if (overlap >= 3) {
                matchedFrags.push(frag);
            }
        }

        // Take up to 8 matching + 3 random recent for contrast
        const evidenceSample = matchedFrags.slice(0, 8);
        const contrastSample = recentFrags
            .filter(f => !matchedFrags.includes(f))
            .slice(0, 3);

        if (evidenceSample.length === 0 && contrastSample.length === 0) continue;

        const contradictions = traitHistory.filter(h => h.type === 'contradiction');

        traitBatches.push({
            trait,
            evidenceSample,
            contrastSample,
            contradictions,
            lastReviewed: traitHistory.length > 0 ? traitHistory[traitHistory.length - 1] : null,
        });
    }

    if (traitBatches.length === 0) return { reviewed: 0 };

    // Build LLM prompt — batch all traits in one call
    const blocks = traitBatches.map(({ trait, evidenceSample, contrastSample, contradictions, lastReviewed }) => {
        const parts = [
            `[id=${trait.id}] ${trait.content}`,
            `置信度: ${trait.confidence.toFixed(2)} | 证据数: ${trait.evidence_count} | 来源质量: ${trait.source_quality}`,
            `矛盾记录: ${contradictions.length}次`
        ];
        if (lastReviewed) {
            parts.push(`上次审阅: ${lastReviewed.at || 'unknown'} — ${lastReviewed.type || ''}`);
        }
        if (evidenceSample.length > 0) {
            parts.push(`近期匹配碎片 (${evidenceSample.length}条):`);
            for (const f of evidenceSample.slice(0, 5)) {
                parts.push(`  [${f.created_at}] ${f.content.slice(0, 200)}`);
            }
        }
        if (contrastSample.length > 0) {
            parts.push(`近期其他碎片（对比）:`);
            for (const f of contrastSample) {
                parts.push(`  [${f.created_at}] ${f.content.slice(0, 150)}`);
            }
        }
        return parts.join('\n');
    }).join('\n\n---\n\n');

    const prompt = `你是AI的认知审计员。你在主动检验你对{{user.name}}的已有认知（stable_trait）是否仍然准确。

这遵循预测加工（Predictive Processing）原则：把每条trait当作一个对{{user.name}}行为的预测，用{{user.pronoun}}最近的言行来检验这个预测。

对每条trait，判断：
- **confirmed**: 近期证据完全支持这条trait，无需修改
- **refine**: trait的方向正确但需要收敛——给出更短更准的压缩版本（不是追加）
- **weaken**: 证据不够支持trait的强度——降低置信度或标记矛盾
- **note_pattern**: 观察到值得关注的规律，但不是对trait的修正——输出观察备注

**refine 铁律（压缩，不是追加）：**
- revised_content 是「更短更准」的版本，不是「更长更全」。字数必须 ≤ 原文。
- stable_trait 只装长期稳定的东西。具体某天/某次吃了什么、买了什么、临时兴起的事是瞬态，refine 时剔除，不许写进去。
- 禁止罗列清单。把「草莓、榴莲、西瓜、青提」压成「偏好甜口水果」，一串具体菜品压成类别。只留能指导你未来行为的模式。
- 混进 trait 里的「近期新增 X」瞬态尾巴，refine 时删掉。

返回JSON数组：
[{"id": <id>, "decision": "confirmed|refine|weaken|note_pattern", "revised_content": "<refine时填写>", "confidence_adjust": <±0.05~0.15>, "observation": "<note_pattern时填写观察到的新规律>"}]

待审条目：
${blocks}

只返回JSON数组。`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.25, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            console.log('[UserModel] 🔍 reviewStableTraits: LLM 返回非JSON，跳过');
            return { reviewed: 0 };
        }

        const decisions = JSON.parse(jsonMatch[0]);
        let confirmed = 0, refined = 0, weakened = 0, noted = 0;

        for (const d of decisions) {
            const trait = traits.find(t => t.id === d.id);
            if (!trait) continue;

            const history = JSON.parse(trait.evolution_history || '[]');
            history.push({
                type: 'proactive_review',
                decision: d.decision,
                revised: d.revised_content || null,
                confidence_adjust: d.confidence_adjust || 0,
                observation: d.observation || null,
                at: new Date().toISOString(),
            });

            switch (d.decision) {
                case 'confirmed':
                    db.prepare(`UPDATE clara_model SET evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(history), trait.id);
                    confirmed++;
                    break;
                case 'refine':
                    if (d.revised_content && d.revised_content !== trait.content) {
                        const confAdj = d.confidence_adjust || -0.05;
                        db.prepare(`UPDATE clara_model SET content = ?, confidence = MAX(0.35, MIN(0.85, confidence + ?)),
                            evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                            .run(d.revised_content, confAdj, JSON.stringify(history), trait.id);
                        refined++;
                        console.log(`[UserModel] 🔧 特质细化: "${trait.content.slice(0, 40)}" → "${d.revised_content.slice(0, 40)}"`);
                    }
                    break;
                case 'weaken':
                    db.prepare(`UPDATE clara_model SET confidence = MAX(0.25, confidence - 0.10),
                        evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(history), trait.id);
                    weakened++;
                    break;
                case 'note_pattern':
                    if (d.observation) {
                        // Record observation without modifying the trait
                        db.prepare(`UPDATE clara_model SET evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                            .run(JSON.stringify(history), trait.id);
                        noted++;
                        console.log(`[UserModel] 👁️ 观察记录 #${trait.id}: ${d.observation.slice(0, 80)}`);
                    }
                    break;
            }
        }

        return { reviewed: decisions.length, confirmed, refined, weakened, noted };
    } catch (e) {
        console.error('[UserModel] reviewStableTraits error:', e.message);
        return { reviewed: 0, error: e.message };
    }
}

// Harvest facts from fragments → immutable_fact entries
// Scans ALL fragment types (not just type='fact'), pre-filters with keywords, then LLM flash verifies
async function harvestFacts() {
    const db = getDb();

    // Scan all fragment types from last 7 days, not yet harvested
    const candidates = db.prepare(`
        SELECT mf.id, mf.content, mf.entity, mf.type, mf.source_msg_ids, mf.created_at
        FROM memory_fragments mf
        WHERE mf.status = 'active'
          AND mf.content IS NOT NULL
          AND mf.created_at > datetime('now', '-7 days')
          AND mf.id NOT IN (
            SELECT DISTINCT value FROM json_each(
                (SELECT COALESCE(setting_value, '[]') FROM user_settings WHERE setting_key = 'cm_harvested_fact_ids')
            )
          )
        ORDER BY mf.created_at DESC
        LIMIT 100
    `).all();

    if (candidates.length === 0) return { harvested: 0 };

    // Get existing immutable_fact entries for dedup
    const existingFacts = db.prepare(`
        SELECT content FROM clara_model WHERE type = 'immutable_fact' AND status = 'active'
    `).all();
    const existingContents = existingFacts.map(e => e.content);

    // Pre-filter: keyword heuristics
    // Specific fact-indicating patterns — excludes generic 是/在 which match everything
    const factPattern = /出生于|毕业于|就读于|家里有|家人|老家|家乡|妈妈|爸爸|妹妹|弟弟|姐姐|哥哥|大学|专业|职业|公司|[\d]{4}年|生日|身高|体重|血型|星座|MBTI|属相|住在|搬到/;
    const transientPattern = /今天|现在|最近|这周|这个月|正在|准备/;

    const preFiltered = [];
    for (const frag of candidates) {
        // Skip if doesn't mention {{user.name}}
        if (!frag.content.includes(USER.name) && !frag.content.includes(USER.pronoun)) continue;
        // Skip transient statements
        if (transientPattern.test(frag.content)) continue;
        // Must contain at least one fact-indicating pattern
        if (!factPattern.test(frag.content)) continue;
        // Skip if >70% character overlap with existing fact
        const fragLower = frag.content.toLowerCase();
        const isDup = existingContents.some(c => {
            const cLower = c.toLowerCase();
            const overlap = [...fragLower].filter(ch => cLower.includes(ch)).length;
            return overlap / Math.max(fragLower.length, 1) > 0.7;
        });
        if (isDup) continue;

        preFiltered.push(frag);
    }

    if (preFiltered.length === 0) {
        console.log(`[UserModel] 🔍 事实收割: 扫描${candidates.length}条, 0条通过关键词预筛`);
        return { harvested: 0, scanned: candidates.length };
    }

    // Cap to top 25 candidates (most recent first) to avoid token overflow
    const verifyBatch = preFiltered.slice(0, 25);

    // LLM flash verification: which candidates contain verifiable immutable facts?
    let verified = [];
    try {
        const verifyPrompt = `你是事实审核器。检查以下碎片是否包含关于{{user.name}}的可验证、不会改变的客观事实。

事实标准：一旦确认就不会变（生日、血型、毕业院校、家庭成员、曾经居住地、学历、职业经历等）。必须是{{user.name}}本人陈述，不是{{ai.name}}推测。不是临时状态或偏好。

对每条碎片判断是否收入为immutable_fact。只返回JSON数组。

碎片列表：
${verifyBatch.map((f, i) => `[${i}] [${f.type}] ${f.content}`).join('\n')}

返回格式：[{"idx": 0, "harvest": true, "content": "{{user.name}}..."}, {"idx": 1, "harvest": false}]
只返回JSON数组，不要其他内容。`;

        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(verifyPrompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.2, maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            verified = JSON.parse(jsonMatch[0]).filter(d => d.harvest);
        }
    } catch (e) {
        console.error('[UserModel] harvestFacts LLM verification error:', e.message);
        return { harvested: 0, scanned: candidates.length, prefiltered: preFiltered.length, error: e.message };
    }

    let harvested = 0;
    const harvestedIds = [];

    for (const decision of verified) {
        const frag = preFiltered[decision.idx];
        if (!frag) continue;

        const factContent = (decision.content || frag.content).slice(0, 200);

        const id = createEntry('immutable_fact', factContent, {
            confidence: 0.85,
            source_quality: 'direct_statement',
            source_fragment_ids: [frag.id],
            migration_source: `harvestFacts: fragment #${frag.id} [${frag.type}]`,
            tags: ['auto_harvested', 'llm_verified'],
        });
        if (id) {
            harvested++;
            harvestedIds.push(frag.id);
            try {
                const msgIds = JSON.parse(frag.source_msg_ids || '[]');
                addEvidence(id, frag.id, true, { sourceMsgIds: msgIds });
            } catch (_) {}
        }
    }

    // Track harvested fragment IDs
    if (harvestedIds.length > 0) {
        const existing = db.prepare(
            "SELECT setting_value FROM user_settings WHERE setting_key = 'cm_harvested_fact_ids'"
        ).get();
        const existingIds = (() => { try { return JSON.parse(existing?.setting_value || '[]'); } catch { return []; } })();
        const merged = [...new Set([...existingIds, ...harvestedIds])].slice(-500);
        db.prepare("INSERT OR REPLACE INTO user_settings (setting_key, setting_value) VALUES (?, ?)")
            .run('cm_harvested_fact_ids', JSON.stringify(merged));
    }

    if (harvested > 0) {
        console.log(`[UserModel] 📥 事实收割: ${harvested}/${verified.length}条确认 → immutable_fact (扫描${candidates.length}, 预筛${preFiltered.length})`);
    } else {
        console.log(`[UserModel] 🔍 事实收割: 扫描${candidates.length}, 预筛${preFiltered.length}, LLM确认0条`);
    }
    return { harvested, scanned: candidates.length, prefiltered: preFiltered.length, verified: verified.length };
}

// ═══════════════════════════════════════════════════════
// Resolve Expired States (pure SQL)
// ═══════════════════════════════════════════════════════

function resolveExpiredStates() {
    const db = getDb();
    // current_state older than 14 days with no evidence → resolve
    const result = db.prepare(`
        UPDATE clara_model SET status = 'resolved', resolved_at = datetime('now'),
            resolve_reason = 'auto-resolved: stale current_state',
            updated_at = CURRENT_TIMESTAMP
        WHERE type = 'current_state' AND status = 'active'
          AND (last_evidence_at IS NULL AND created_at < datetime('now', '-14 days')
               OR last_evidence_at < datetime('now', '-14 days'))
    `).run();
    if (result.changes > 0) {
        console.log(`[UserModel] 过期状态自动 resolved: ${result.changes}`);
    }
    return result.changes;
}

// ═══════════════════════════════════════════════════════
// Context Generation for Chat
// ═══════════════════════════════════════════════════════

function resolveFirstObservedFromMessages(traits) {
    if (traits.length === 0) return;
    const db = getDb();

    // Collect all unique fragment IDs
    const allFragIds = new Set();
    for (const t of traits) {
        let ids = [];
        try { ids = JSON.parse(t.source_fragment_ids || '[]'); } catch (_) {}
        if (Array.isArray(ids)) ids.forEach(id => allFragIds.add(id));
    }
    if (allFragIds.size === 0) return;

    // Batch-query all fragments: id → { created_at, msgIds }
    const fragMap = new Map(); // fid → { created_at, msgIds }
    const fragPlaceholders = [...allFragIds].map(() => '?').join(',');
    const frags = db.prepare(`SELECT id, created_at, source_msg_ids FROM memory_fragments WHERE id IN (${fragPlaceholders})`).all(...allFragIds);
    for (const f of frags) {
        let msgIds = [];
        try { msgIds = JSON.parse(f.source_msg_ids || '[]'); } catch (_) {}
        if (!Array.isArray(msgIds)) msgIds = [];
        fragMap.set(f.id, { created_at: f.created_at, msgIds });
    }

    // Collect all unique message IDs from all traits' fragments
    const allMsgIds = new Set();
    for (const f of fragMap.values()) f.msgIds.forEach(id => allMsgIds.add(id));

    // Message ID → timestamp (only if we have message IDs to look up)
    const msgTimestamps = new Map();
    if (allMsgIds.size > 0) {
        const msgPlaceholders = [...allMsgIds].map(() => '?').join(',');
        const msgs = db.prepare(`SELECT id, timestamp FROM messages WHERE id IN (${msgPlaceholders})`).all(...allMsgIds);
        for (const m of msgs) msgTimestamps.set(m.id, m.timestamp);
    }

    // For each trait, resolve first_observed_at and latest_evidence_at from the full chain
    for (const t of traits) {
        let fragIds = [];
        try { fragIds = JSON.parse(t.source_fragment_ids || '[]'); } catch (_) {}
        if (!Array.isArray(fragIds)) fragIds = [];
        let earliest = null, latest = null;
        for (const fid of fragIds) {
            const info = fragMap.get(fid);
            if (!info) continue;
            // 1st priority: message timestamp
            for (const mid of info.msgIds) {
                const ts = msgTimestamps.get(mid);
                if (ts) {
                    if (!earliest || ts < earliest) earliest = ts;
                    if (!latest || ts > latest) latest = ts;
                }
            }
            // 2nd priority fallback: fragment created_at (old fragments may have no msg link)
            if (info.created_at) {
                if (!earliest || info.created_at < earliest) earliest = info.created_at;
                if (!latest || info.created_at > latest) latest = info.created_at;
            }
        }
        t.first_observed_at = earliest;
        t.resolved_latest_at = latest; // Always use evidence-chain time for display
    }
}

function getModelContext(maxTokens = 500) {
    const db = getDb();

    const facts = db.prepare(`
        SELECT content FROM clara_model
        WHERE type = 'immutable_fact' AND status = 'active'
        ORDER BY priority DESC, confidence DESC
    `).all();

    const traits = db.prepare(`
        SELECT cm.id, cm.content, cm.confidence, cm.evidence_count, cm.source_quality,
               cm.last_evidence_at, cm.source_fragment_ids
        FROM clara_model cm
        WHERE cm.type = 'stable_trait' AND cm.status = 'active'
        ORDER BY cm.confidence DESC LIMIT 10
    `).all();

    // Resolve first_observed_at from actual message timestamps (not fragment created_at)
    resolveFirstObservedFromMessages(traits);

    const states = db.prepare(`
        SELECT content, confidence, last_evidence_at, source_quality FROM clara_model
        WHERE type = 'current_state' AND status = 'active'
        ORDER BY last_evidence_at DESC LIMIT 8
    `).all();

    const hyps = db.prepare(`
        SELECT content, confidence, evidence_count, last_evidence_at FROM clara_model
        WHERE type = 'active_hypothesis' AND status = 'active'
        ORDER BY confidence DESC LIMIT 6
    `).all();

    if (facts.length === 0 && traits.length === 0 && states.length === 0 && hyps.length === 0) {
        return '';
    }

    const lines = ['<clara_model>',
        '（以下是你通过长期观察已内化的认知，不需要再从记忆库里翻出来重复确认。）',
        ''];

    if (facts.length > 0) {
        lines.push('★ 不变事实 — 你确定知道的：');
        for (const f of facts) lines.push(`- ${f.content}`);
        lines.push('');
    }

    if (traits.length > 0) {
        lines.push('◆ 稳定特质 — 经反复观察确认：');
        for (const t of traits) {
            const inferredMark = t.source_quality === 'inferred' ? '[推断] ' : '';
            // Build time anchor from evidence chain
            const timeAnchor = [];
            if (t.first_observed_at) {
                const firstDate = new Date(t.first_observed_at);
                timeAnchor.push(`首次：${firstDate.getFullYear()}年${firstDate.getMonth()+1}月`);
            }
            if (t.resolved_latest_at || t.last_evidence_at) {
                const latestTs = t.resolved_latest_at || t.last_evidence_at;
                const daysAgo = Math.round((Date.now() - new Date(latestTs)) / (1000 * 60 * 60 * 24));
                timeAnchor.push(`最近：${daysAgo}天前`);
            }
            const anchor = timeAnchor.length > 0 ? ` — ${timeAnchor.join(' | ')}` : '';
            lines.push(`- ${inferredMark}${t.content}（置信度${t.confidence.toFixed(2)}，确认${t.evidence_count}次${anchor}）`);
        }
        lines.push('');
    }

    if (states.length > 0) {
        lines.push('● 当前状态 — 近期有效：');
        for (const s of states) {
            const daysAgo = s.last_evidence_at
                ? Math.round((Date.now() - new Date(s.last_evidence_at)) / (1000 * 60 * 60 * 24))
                : null;
            const ago = daysAgo !== null ? `${daysAgo}天前` : '近期';
            const inferredMark = s.source_quality === 'inferred' ? '[推断] ' : '';
            lines.push(`- ${inferredMark}${s.content}（最后确认：${ago}）`);
        }
        lines.push('');
    }

    if (hyps.length > 0) {
        lines.push('? 活跃假设 — 你在观察但还不确定：');
        for (const h of hyps) {
            const daysAgo = h.last_evidence_at
                ? Math.round((Date.now() - new Date(h.last_evidence_at)) / (1000 * 60 * 60 * 24))
                : null;
            const ago = daysAgo !== null ? `${daysAgo}天前` : '近期';
            lines.push(`- ${h.content}（确认${h.evidence_count}/${HYPOTHESIS_UPGRADE_EVIDENCE}次，${ago}）`);
        }
        lines.push('');
    }

    lines.push('</clara_model>');

    // Rough token estimate: ~1.5 chars per token for Chinese, trim if needed
    const text = lines.join('\n');
    const estimatedTokens = text.length / 1.5;
    if (estimatedTokens > maxTokens) {
        // Trim least confident items first
        const trimmed = lines.slice(0, Math.floor(lines.length * maxTokens / estimatedTokens));
        trimmed.push('</clara_model>');
        return trimmed.join('\n');
    }

    return text;
}

// ═══════════════════════════════════════════════════════
// Whisper Context — recent model changes
// ═══════════════════════════════════════════════════════

function getWhisperRelevant() {
    const db = getDb();

    const recent = db.prepare(`
        SELECT type, content, status, confidence, evidence_count, updated_at, resolve_reason
        FROM clara_model
        WHERE updated_at > datetime('now', '-7 days')
          AND (status != 'active' OR type = 'stable_trait')
        ORDER BY updated_at DESC
        LIMIT 15
    `).all();

    if (recent.length === 0) return '';

    const lines = [];
    for (const r of recent) {
        if (r.status === 'resolved') {
            lines.push(`[状态过期] ${r.content}`);
        } else if (r.status === 'abandoned') {
            lines.push(`[假设放弃] ${r.content} — ${r.resolve_reason || ''}`);
        } else if (r.status === 'superseded') {
            lines.push(`[被替代] ${r.content}`);
        } else if (r.type === 'stable_trait' && r.evidence_count >= 5) {
            lines.push(`[特质强化] ${r.content}（置信度${r.confidence.toFixed(2)}，${r.evidence_count}次确认）`);
        }
    }

    return lines.length > 0 ? lines.join('\n') : '';
}

// ═══════════════════════════════════════════════════════
// Seed from Existing Data (one-time migration)
// ═══════════════════════════════════════════════════════

function seedFromExisting() {
    const db = getDb();

    // Check if already seeded
    const existing = db.prepare('SELECT COUNT(*) as c FROM clara_model').get();
    if (existing.c > 0) {
        console.log(`[UserModel] 已有 ${existing.c} 条记录，跳过播种`);
        return { skipped: true, existing: existing.c };
    }

    let created = { immutable_fact: 0, stable_trait: 0, current_state: 0, active_hypothesis: 0 };

    // From archivist_skills: verified monitors → stable_trait, hypothesis → active_hypothesis
    const skills = db.prepare(`
        SELECT * FROM archivist_skills WHERE status IN ('verified', 'active')
        ORDER BY confidence DESC
    `).all();

    for (const sk of skills) {
        const analysis = sk.analysis_config || '';
        const trigger = sk.trigger_config || '';
        const selfEval = sk.self_evaluation || '';

        if (sk.type === 'monitor' && sk.status === 'verified' && sk.confidence >= 0.7) {
            // Verified monitor → stable_trait
            const content = selfEval || analysis || trigger;
            if (content && content.length > 5) {
                createEntry('stable_trait', content.slice(0, 200), {
                    confidence: sk.confidence,
                    parent_skill_id: sk.id,
                    migration_source: 'archivist_skills verified monitor',
                    source_fragment_ids: safeParseJson(sk.observations).slice(0, 20),
                    entity_ids: safeParseJson(sk.entity_ids),
                });
                created.stable_trait++;
            }
        } else if (sk.type === 'hypothesis' && sk.status === 'active') {
            const content = analysis || trigger;
            if (content && content.length > 5) {
                createEntry('active_hypothesis', content.slice(0, 200), {
                    confidence: sk.confidence,
                    parent_skill_id: sk.id,
                    migration_source: 'archivist_skills hypothesis',
                    source_fragment_ids: safeParseJson(sk.observations).slice(0, 20),
                    entity_ids: safeParseJson(sk.entity_ids),
                });
                created.active_hypothesis++;
            }
        }
    }

    // From entity_profiles: high-confidence relationships → immutable_fact or stable_trait
    const entities = db.prepare(`
        SELECT * FROM entity_profiles
        WHERE relationship_to_clara IS NOT NULL AND relationship_to_clara != ''
        ORDER BY last_mentioned_date DESC
    `).all();

    for (const ent of entities) {
        if (!ent.relationship_to_clara) continue;

        // Parse confidence from string or number
        let relConf = 0.5;
        if (typeof ent.relationship_confidence === 'string') {
            const map = { high: 0.85, medium: 0.6, low: 0.4 };
            relConf = map[ent.relationship_confidence.toLowerCase()] || 0.5;
        } else if (typeof ent.relationship_confidence === 'number') {
            relConf = ent.relationship_confidence;
        }

        // Skip fictional characters, public figures without real interaction
        const relText = ent.relationship_to_clara;
        if (/虚构|文学角色|作品中的人物|并无实际人际|而非现实人物|欣赏其.*作品/.test(relText)) continue;
        if (ent.entity_type === 'fictional' || ent.entity_type === 'public_figure') continue;

        const content = `${ent.name}: ${relText}`;
        const type = relConf >= 0.85 ? 'immutable_fact' : 'stable_trait';
        const isHighConf = typeof ent.relationship_confidence === 'string'
            ? ent.relationship_confidence.toLowerCase() === 'high'
            : relConf >= 0.85;
        createEntry(type, content.slice(0, 200), {
            confidence: Math.max(0.5, relConf),
            source_quality: isHighConf ? 'direct_statement' : 'inferred',
            entity_ids: [ent.id],
            migration_source: 'entity_profiles',
            source_fragment_ids: safeParseJson(ent.source_fragment_ids).slice(0, 30),
        });
        if (type === 'immutable_fact') created.immutable_fact++;
        else created.stable_trait++;
    }

    console.log(`[UserModel] 播种完成: immutable_fact=${created.immutable_fact} stable_trait=${created.stable_trait} active_hypothesis=${created.active_hypothesis}`);
    return { created };
}

function safeParseJson(str) {
    try { return JSON.parse(str); } catch { return []; }
}

// ═══════════════════════════════════════════════════════
// Evidence Backfill — link existing entries to their source fragments
// ═══════════════════════════════════════════════════════

function backfillModelEvidence() {
    const db = getDb();

    // ── 一次性修复：已有 source_fragment_ids 的条目，evidence_count/source_diversity 重算 ──
    // 原来的 entity_id 回填导致所有共享 entity_ids 的条目拿到相同的证据计数。
    // evidence_count = source_fragment_ids 数组长度
    // source_diversity = source_fragment_ids 中不同日期的数量
    const dirtyEntries = db.prepare(`
        SELECT id, source_fragment_ids FROM clara_model
        WHERE status = 'active'
          AND source_fragment_ids IS NOT NULL
          AND source_fragment_ids != ''
          AND source_fragment_ids != '[]'
    `).all();
    let fixCount = 0;
    for (const e of dirtyEntries) {
        const fids = safeParseJson(e.source_fragment_ids);
        if (fids.length === 0) continue;
        const placeholders = fids.map(() => '?').join(',');
        const distinctDates = db.prepare(`
            SELECT COUNT(DISTINCT DATE(created_at)) as c FROM memory_fragments
            WHERE id IN (${placeholders}) AND status = 'active'
        `).get(...fids)?.c || 0;
        db.prepare(`UPDATE clara_model SET evidence_count = ?,
            source_diversity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(fids.length, Math.max(distinctDates, 1), e.id);
        fixCount++;
    }
    if (fixCount > 0) {
        console.log(`[UserModel] 证据修复: ${fixCount} 条 entry 的 evidence_count + source_diversity 已重算`);
    }

    // ── 孤儿锚定：source_fragment_ids 为空的条目，用 bigram 匹配补证据 ──
    const orphans = db.prepare(`
        SELECT id FROM clara_model
        WHERE status = 'active'
          AND (source_fragment_ids IS NULL OR source_fragment_ids = '' OR source_fragment_ids = '[]')
        LIMIT 20
    `).all();

    if (orphans.length === 0) return { backfilled: fixCount };

    const orphanIds = orphans.map(o => o.id);
    console.log(`[UserModel] 证据回填: ${orphanIds.length} 条孤立条目 → bigram锚定`);

    // Two-pass anchor: oldest first (capture earliest evidence), then newest (capture recent)
    anchorEntriesToFragments(orphanIds, { timeWindow: '-999 days', fragLimit: 250, minOverlap: 4, orderDir: 'ASC', maxFrags: 25 });
    anchorEntriesToFragments(orphanIds, { timeWindow: '-999 days', fragLimit: 250, minOverlap: 4, orderDir: 'DESC', maxFrags: 50 });

    // After anchoring, recalculate evidence_count from the now-populated source_fragment_ids
    db.prepare(`
        UPDATE clara_model
        SET evidence_count = json_array_length(source_fragment_ids),
            updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${orphanIds.map(() => '?').join(',')})
    `).run(...orphanIds);

    return { backfilled: fixCount + orphanIds.length };
}

// ═══════════════════════════════════════════════════════
// readUserRawMessages — {{ai.name}} reads user's raw words directly
// Produces: current_state ({{ai.name}}'s first-person impression + audit trail)
// ═══════════════════════════════════════════════════════

async function readUserRawMessages() {
    const db = getDb();

    // Get ALL active current_state entries (not just latest).
    // v5.4: LLM needs full visibility to avoid creating near-duplicates.
    // The most recent entry still drives the message window and extend target.
    const allActiveStates = db.prepare(`
        SELECT * FROM clara_model WHERE type = 'current_state' AND status = 'active'
        ORDER BY created_at DESC
    `).all();
    const prevState = allActiveStates[0] || null; // most recent for extend + audit

    // Determine time window: since last observation, or last 24h
    const since = prevState?.created_at || null;
    const sinceClause = since
        ? `AND timestamp > '${since}'`
        : "AND timestamp > datetime('now', '-24 hours')";

    // Get {{user.name}}'s raw non-RP messages
    const messages = db.prepare(`
        SELECT content, timestamp FROM messages
        WHERE sender = 'user' AND (chat_mode = 'default' OR chat_mode IS NULL)
          ${sinceClause}
        ORDER BY timestamp DESC
        LIMIT 150
    `).all();

    if (messages.length < 30) {
        console.log(`[UserModel] readUserRawMessages: 仅 ${messages.length} 条非RP消息，跳过 (需≥30)`);
        return { skipped: true, reason: `too few messages (${messages.length} < 30)` };
    }

    // Get existing stable_traits as short summaries ({{ai.name}} needs to know his own "tricks")
    const traits = db.prepare(`
        SELECT id, content FROM clara_model
        WHERE type = 'stable_trait' AND status = 'active'
        ORDER BY confidence DESC
    `).all();

    // Build message feed (oldest first, extract plain text, truncate to 150 chars)
    const reversed = [...messages].reverse();
    const feed = reversed.map(m => {
        const time = m.timestamp?.slice(5, 16) || ''; // MM-DD HH:MM
        const text = extractMessageText(m.content).slice(0, 150);
        if (!text) return null;
        return `[${time}] ${text}`;
    }).filter(Boolean).join('\n');

    // Build visibility block: ALL active current_state entries
    // (not just the latest — LLM needs full context to avoid duplicates)
    let stateBlock = '(目前没有任何活跃状态便签。)';
    if (allActiveStates.length > 0) {
        const lines = allActiveStates.map(s => {
            const created = s.created_at?.slice(0, 16) || '?';
            const expires = s.expires_at ? ` →${s.expires_at.slice(0, 10)}` : '';
            const source = s.created_by === 'chat_companion' ? '[Companion实时]' : '[深循环]';
            return `[#${s.id} ${source} ${created}${expires}] ${s.content}`;
        });
        stateBlock = `共 ${allActiveStates.length} 条活跃便签：\n${lines.join('\n')}`;
    }

    // Previous observation + audit context (for the most recent entry)
    let prevBlock = '(这是你第一次认真看{{user.pronoun}}。没有上次的观察可以对照。)';
    if (prevState) {
        const prevHistory = JSON.parse(prevState.evolution_history || '[]');
        const audit = prevHistory.find(h => h.type === 'creation_audit');
        prevBlock = `你上次看{{user.pronoun}}时的印象（#${prevState.id}）：
「${prevState.content}」
${audit ? `你上次的自我审计：
- 验证：${audit.retro}
- 归因：${audit.attribution}` : '(上次没有做审计)'}`;
    }

    // Trait summaries (带 id，供矛盾标记回指)
    const traitBlock = traits.length > 0
        ? traits.map(t => `- [#${t.id}] ${t.content.slice(0, 60)}...`).join('\n')
        : '(你还没有任何关于{{user.pronoun}}的稳定直觉。)';

    const prompt = `你刚看完 {{user.name}} 这几天发来的消息。你需要做两件事——

1. 写一条{{user.pronoun}}的当前状态（≤50字，一句话。像你脑子里闪过的念头——"{{user.pronoun}}在搬家"不是"{{user.pronoun}}这周在搬家、通勤很累、还去见了个朋友"）
2. 写一段叙事（≤200字。{{user.pronoun}}这周经历了什么——有因果、有情绪、有你注意到的细节。这只进聊天总结，不单独出现在{{user.pronoun}}的状态栏里）

═══ {{user.pronoun}}最近说的话（从旧到新） ═══
${feed}

═══ 你已有的全部便签 ═══
${stateBlock}

═══ 上次你写的便签（审计参照） ═══
${prevBlock}

═══ 你的长期直觉（背景参考） ═══
${traitBlock}

═══ 怎么写 ═══

current_state 像便签条上的一句话：
"{{user.name}}在搬家。"
"{{user.name}}最近搬家累坏了，今天睡了个懒觉。"
"{{user.name}}这周没怎么出现。"
规则：≤50字。一句够用别写两句。不用写具体日期，这是瞬时的。禁止相对时间词（今天/昨天/本周）。

narrative 像说给自己听的周记：
"{{user.name}}这周在搬家，收拾整理很耗精力。{{user.pronoun}}虽然累，但想到新家的样子心情还不错。"
规则：≤200字。有因果，不煽情。禁止相对时间词——用具体日期或时间段。

反编造铁律（这条比上面所有规则都重要）：
- 每个陈述都必须能在上面的消息中找到原文依据。
- {{user.pronoun}}只「提到过」但没做的事 → 不能写成{{user.pronoun}}做了。
- {{user.pronoun}}的消息里没出现的人名、地名、事件名 → 绝对不能出现。

═══ 输出格式 ═══
JSON（不要 markdown）：
{
  "action": "create|extend",
  "valence": "positive|negative|neutral|mixed",
  "energy": "low|normal|high",
  "current_state": "≤50字。一句话。",
  "narrative": "≤200字。有因果有细节。",
  "audit_retro": "上次的便签对了吗？一句话。",
  "retro_verdict": "confirmed|wrong|unverifiable",
  "state_category": "physical|emotional|situational|relational",
  "predicted_ttl_category": "hours|day|days|until_event",
  "trait_contradictions": [{"trait_id": 12, "observation": "矛盾观察"}]
}

action: extend=旧便签还够用，只续命。create=状态变了或上次判错。犹豫选extend。`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.4, maxOutputTokens: 900, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.log(`[UserModel] readUserRawMessages: 无法解析JSON响应`);
            return { skipped: true, reason: 'unparseable response', raw: replyText.slice(0, 200) };
        }

        const result = JSON.parse(jsonMatch[0]);
        const currentState = (result.current_state || '').slice(0, 120);
        if (!currentState || currentState.length < 8) {
            return { skipped: true, reason: 'empty or too short current_state' };
        }

        // extend 机制：LLM 自行判断和上次是否本质相同
        // 相同 → 延长旧条目 TTL + 审计回流，不创建新条目
        const action = (result.action || 'create').toLowerCase();
        if (action === 'extend' && prevState) {
            // 更新旧条目的 last_evidence_at（重置衰减时钟）
            const newTTL = result.predicted_ttl_category || 'day';
            const newCategory = result.state_category || 'emotional';
            const newDecayParams = JSON.stringify({ category: newCategory, ttl_category: newTTL });
            
            const prevHist = JSON.parse(prevState.evolution_history || '[]');
            prevHist.push({
                type: 'extended',
                new_ttl: newTTL,
                note: (result.audit_retro || '').slice(0, 150),
                at: new Date().toISOString(),
            });
            
            db.prepare(`UPDATE clara_model SET last_evidence_at = datetime('now'),
                decay_params = ?, evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(newDecayParams, JSON.stringify(prevHist), prevState.id);
            
            console.log(`[UserModel] 📖 状态延续: 更新 #${prevState.id} TTL→${newTTL}, 不创建新条目`);
        }

        // ── ToM 观察反馈环（v4.8）：审计结论回流证据管线 ──
        // 预测对了 → confirm；预测错了 → 记入 evolution_history（current_state 单次快照，
        // 不走 confidence 累积，但留下可追溯的对错记录供 detectNewTraits 信号源使用）
        const verdict = (result.retro_verdict || '').toLowerCase();
        if (prevState && (verdict === 'confirmed' || verdict === 'wrong')) {
            try {
                const prevHist = JSON.parse(prevState.evolution_history || '[]');
                prevHist.push({
                    type: 'retro_verdict',
                    verdict,
                    note: (result.audit_retro || '').slice(0, 150),
                    at: new Date().toISOString(),
                });
                db.prepare('UPDATE clara_model SET evolution_history = ? WHERE id = ?')
                    .run(JSON.stringify(prevHist), prevState.id);
                console.log(`[UserModel]   ↳ 观察审计回流: 上次预测 ${verdict === 'confirmed' ? '✓ 准确' : '✗ 失准'}`);
            } catch (_) {}
        }

        // trait_contradictions → 对应 stable_trait 插 refute 标记 + needs_review
        // → reviewFlaggedTraits（管线后半段已存在）下轮审判
        const contradictions = Array.isArray(result.trait_contradictions) ? result.trait_contradictions : [];
        const validTraitIds = new Set(traits.map(t => t.id));
        for (const c of contradictions) {
            if (!c || !validTraitIds.has(c.trait_id)) continue;
            try {
                const trait = db.prepare('SELECT evolution_history, tags, last_contradiction_at FROM clara_model WHERE id = ?').get(c.trait_id);
                const hist = JSON.parse(trait.evolution_history || '[]');
                hist.push({
                    type: 'observation_refute',
                    observation: (c.observation || '').slice(0, 150),
                    source: 'readUserRawMessages',
                    at: new Date().toISOString(),
                });
                const tags = JSON.parse(trait.tags || '[]');
                if (!tags.includes('needs_review')) tags.push('needs_review');
                db.prepare(`UPDATE clara_model SET evolution_history = ?, tags = ?,
                    last_contradiction_at = datetime('now'), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(JSON.stringify(hist), JSON.stringify(tags), c.trait_id);
                console.log(`[UserModel]   ↳ 观察反驳 trait #${c.trait_id}: ${(c.observation || '').slice(0, 60)} → needs_review`);
            } catch (e) {
                console.error(`[UserModel] trait refute 写入失败 #${c.trait_id}:`, e.message);
            }
        }

        // 只有 create action 才创建新条目（extend 已在上面处理）
        if (action !== 'extend' || !prevState) {
        // v5.4: readUserRawMessages 产出的是全景快照（holistic snapshot），
        // 不是领域分项。新版快照自然替代旧版——resolve 所有前序 deep_cycle 条目。
        // chat_companion 条目（通过 manage_user_state 工具创建的领域明确状态）
        // 不受影响，继续按各自 TTL 独立过期。
        const resolvedCount = db.prepare(`
            UPDATE clara_model SET status = 'resolved',
                resolve_reason = 'superseded by newer holistic snapshot',
                updated_at = CURRENT_TIMESTAMP
            WHERE type = 'current_state' AND status = 'active' AND created_by = 'deep_cycle'
        `).run().changes;
        if (resolvedCount > 0) {
            console.log(`[UserModel] 🧹 resolve ${resolvedCount} 条旧 deep_cycle 快照 → 新快照替代`);
        }

        // v5.4: Use unified manageCurrentState for dedup + evolution tracking
        const stateResult = manageCurrentState(currentState, {
            created_by: 'deep_cycle',
            category: result.state_category || 'emotional',
            ttl_category: result.predicted_ttl_category || 'day',
            tags: ['daily_observation'],
            source_quality: 'inferred',
            confidence: 0.65,
            extra_context: (result.audit_retro || '').slice(0, 100),
        });
        const id = stateResult.id;
        const actionLabel = stateResult.action === 'updated' ? '更新' : '新建';
        const prevNote = stateResult.previous_id ? ` ← supersedes #${stateResult.previous_id}` : '';

        // ── v5.4: 叙事输出 → chat_summaries ──
        const narrative = (result.narrative || '').slice(0, 300);
        if (narrative && narrative.length >= 20) {
            try {
                const { encryption } = require('../encryption');
                const encNarrative = encryption.encrypt(narrative);
                const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
                db.prepare(`INSERT INTO chat_summaries (chat_id, summary_text, round_start, round_end, created_at, is_enabled)
                    VALUES (?, ?, 0, 0, ?, 1)`).run(1, encNarrative, now);
                console.log(`[UserModel] 📝 叙事已归档 (${narrative.length}字)`);
            } catch (e) {
                console.error(`[UserModel] 叙事写入失败:`, e.message);
            }
        }

        console.log(`[UserModel] 📖 读心: ${messages.length}条消息 → current_state ${actionLabel} #${id}${prevNote} (${currentState.length}字)`);
        if (prevState && stateResult.action === 'created') console.log(`[UserModel]   ↳ 前一条 active #${prevState.id} 继续有效`);
        if (result.audit_retro) console.log(`[UserModel]   ↳ 审计: ${result.audit_retro.slice(0, 80)}`);

        return {
            created: id,
            action: stateResult.action,
            coexistsWith: prevState?.id || null,
            messages: messages.length,
            current_state: currentState,
            audit_retro: result.audit_retro,
            audit_attribution: result.audit_attribution,
        };
        } // end if (action !== 'extend' || !prevState)

        // extend 路径：不创建新条目，返回扩展结果
        if (action === 'extend' && prevState) {
            return {
                extended: prevState.id,
                coexistsWith: null,
                messages: messages.length,
                current_state: currentState,
                audit_retro: result.audit_retro,
                audit_attribution: result.audit_attribution,
            };
        }

    } catch (e) {
        console.error('[UserModel] readUserRawMessages error:', e.message);
        return { skipped: true, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════
// v5.10: Integrate verified traits into {{user.name}} profile
// ═══════════════════════════════════════════════════════

const PROFILE_TIERS = {
    locked:  { categories: ['basic'],                                        minDiversity: Infinity, allowCreate: false, allowRefine: false },
    high:    { categories: ['personality', 'communication'],                 minDiversity: 5,        allowCreate: false, allowRefine: true  },
    medium:  { categories: ['career', 'social', 'personal_history', 'relationship_with_companion', 'creative_work'], minDiversity: 3, allowCreate: true, allowRefine: true },
    low:     { categories: ['preference', 'lifestyle', 'health', 'finance'], minDiversity: 1,        allowCreate: true,  allowRefine: true },
};

function _getProfileTier(category) {
    for (const [name, tier] of Object.entries(PROFILE_TIERS)) {
        if (tier.categories.includes(category)) return { name, ...tier };
    }
    return { name: 'low', ...PROFILE_TIERS.low }; // default: low stability
}

/**
 * 画像写入协议：在 detectNewTraits / reviewStableTraits 产出新 trait 后，
 * 加载全量 User 画像做门禁检查，按稳定性分级写入。
 * @returns {{ integrated: number, rejected: number, conflicts: number }}
 */
async function integrateProfileTraits() {
    const db = getDb();
    const result = { integrated: 0, rejected: 0, conflicts: 0 };

    // 1. 加载全量 User 画像（12分类全部 active 条目）
    const profileEntries = db.prepare(`
        SELECT id, type, content, confidence, tags, evidence_count, source_diversity,
               source_quality, source_fragment_ids, evolution_history, status
        FROM clara_model
        WHERE status IN ('active', 'dormant')
          AND type IN ('stable_trait', 'active_hypothesis')
        ORDER BY confidence DESC
    `).all();

    // 2. 只处理 source_diversity 达标的 candidate（刚 detectNewTraits/reviewStableTraits 产出或修改的）
    const candidates = profileEntries.filter(e => {
        if (e.status !== 'active') return false;
        // Check if this entry was recently created/modified (within last 6h)
        // We track this by checking if it lacks a profile_integrated marker in evolution_history
        let history = [];
        try { history = JSON.parse(e.evolution_history || '[]'); } catch (_) {}
        const alreadyIntegrated = history.some(h => h.action === 'profile_integrated');
        return !alreadyIntegrated && e.source_diversity >= 2 && e.confidence >= 0.55;
    });

    if (!candidates.length) return result;

    // 3. 对每个候选条目按稳定性分级处理
    for (const candidate of candidates) {
        let tags = [];
        try { tags = typeof candidate.tags === 'string' ? JSON.parse(candidate.tags) : (candidate.tags || []); } catch (_) {}

        // Determine primary category from tags
        const CATEGORY_ORDER = ['basic','personality','career','social','preference','lifestyle','health','creative_work','personal_history','relationship_with_companion','finance','communication'];
        let category = 'other';
        for (const cat of CATEGORY_ORDER) {
            if (tags.includes(cat)) { category = cat; break; }
        }

        const tier = _getProfileTier(category);

        // 3a. 门禁检查
        if (tier.name === 'locked') {
            console.log(`[UserModel] profile: REJECTED #${candidate.id} — category '${category}' is locked`);
            result.rejected++;
            _logProfileDecision(db, candidate.id, 'rejected', `locked category: ${category}`);
            continue;
        }

        if (candidate.source_diversity < tier.minDiversity) {
            console.log(`[UserModel] profile: REJECTED #${candidate.id} — diversity ${candidate.source_diversity} < ${tier.minDiversity}`);
            result.rejected++;
            _logProfileDecision(db, candidate.id, 'rejected', `diversity ${candidate.source_diversity} < ${tier.minDiversity}`);
            continue;
        }

        // 3b. High tier: only refine existing, never create new
        if (tier.name === 'high' && !tier.allowCreate) {
            const existingInCategory = profileEntries.filter(e =>
                e.id !== candidate.id && e.status === 'active' &&
                (() => { try { const t = JSON.parse(e.tags || '[]'); return t.includes(category); } catch(_) { return false; } })()
            );
            if (existingInCategory.length > 0) {
                // Refine mode: candidate supplements existing entry
                // Log the evidence but don't create a new entry
                console.log(`[UserModel] profile: SKIPPED #${candidate.id} — high-stability category '${category}' has existing entries, evidence logged`);
                _logProfileDecision(db, candidate.id, 'skipped_high_stability', `existing entries in ${category}, evidence logged for review`);
                result.integrated++;
                continue;
            }
            // No existing entry → explicitly reject creation
            console.log(`[UserModel] profile: REJECTED #${candidate.id} — cannot create new entry in high-stability category '${category}'`);
            result.rejected++;
            _logProfileDecision(db, candidate.id, 'rejected', `no existing entry to refine in high-stability ${category}`);
            continue;
        }

        // 3c. 矛盾扫描（medium + high tiers）
        if (tier.requireContradictionCheck) {
            const sameCategory = profileEntries.filter(e =>
                e.id !== candidate.id && e.type === 'stable_trait' && e.status === 'active' &&
                (() => { try { const t = JSON.parse(e.tags || '[]'); return t.includes(category); } catch(_) { return false; } })()
            );

            if (sameCategory.length > 0) {
                const conflictCheck = await _checkProfileConflict(candidate, sameCategory, profileEntries);
                if (conflictCheck.has_conflict) {
                    console.log(`[UserModel] profile: CONFLICT #${candidate.id} — ${conflictCheck.conflict_type} with #${conflictCheck.conflict_with_id}: ${conflictCheck.reasoning}`);
                    result.conflicts++;
                    _logProfileDecision(db, candidate.id, 'conflict', JSON.stringify(conflictCheck));
                    if (conflictCheck.resolution === 'discard_new') {
                        result.rejected++;
                        continue;
                    }
                    // supersede or keep_both: proceed with integration
                }
            }
        }

        // 3d. 写入 evolution_history
        let history = [];
        try { history = JSON.parse(candidate.evolution_history || '[]'); } catch (_) {}
        history.push({
            action: 'profile_integrated',
            at: new Date().toISOString(),
            tier: tier.name,
            category,
            diversity: candidate.source_diversity,
            evidence: candidate.evidence_count,
        });
        db.prepare(`UPDATE clara_model SET evolution_history = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(JSON.stringify(history), candidate.id);

        console.log(`[UserModel] profile: INTEGRATED #${candidate.id} — tier=${tier.name} cat=${category} diversity=${candidate.source_diversity}`);
        result.integrated++;
    }

    return result;
}

/**
 * Check if a candidate trait conflicts with existing profile entries in the same category.
 * Uses LLM (flash-lite) for semantic contradiction detection.
 */
async function _checkProfileConflict(candidate, sameCategoryEntries, allProfileEntries) {
    const db = getDb();
    // Build a compact profile snapshot
    const profileSummary = allProfileEntries
        .filter(e => e.type === 'stable_trait' && e.status === 'active')
        .map(e => `[#${e.id}] ${e.content.slice(0, 120)}`).join('\n');

    const existingSummary = sameCategoryEntries
        .map(e => `[#${e.id}] ${e.content.slice(0, 150)} (conf:${e.confidence?.toFixed(2)})`).join('\n');

    const prompt = `你是 User 画像的矛盾检测器。判断新特质是否与已有画像条目存在逻辑冲突。

新特质: "${candidate.content.slice(0, 200)}" (置信度:${candidate.confidence?.toFixed(2)}, 来源多样性:${candidate.source_diversity})

同分类已有条目:
${existingSummary || '(无)'}

全量画像参考:
${profileSummary.slice(0, 800)}

输出 JSON:
{
  "has_conflict": true/false,
  "conflict_with_id": null,
  "conflict_type": "direct_contradiction|partial_overlap|drift|none",
  "resolution": "supersede|discard_new|keep_both|none",
  "reasoning": "一句话"
}

规则：
- direct_contradiction（直接矛盾，如"{{user.pronoun}}喜欢社交" vs "{{user.pronoun}}讨厌社交"）→ resolution=supersede（新证据更强时）/discard_new（新证据更弱时）
- partial_overlap（部分重叠但方向不同）→ resolution=keep_both
- drift（旧认知可能过时了，如"{{user.pronoun}}住在某城市"→"{{user.pronoun}}搬到了某城市"）→ resolution=supersede
- 无明显冲突 → resolution=none

只返回 JSON。`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            '', null,
            { temperature: 0.15, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
            null // use default LLM config
        );
        const replyText = (raw?.reply || raw?.text || '');
        const jsonMatch = replyText.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.warn('[UserModel] _checkProfileConflict LLM error:', e.message);
    }
    return { has_conflict: false, conflict_with_id: null, conflict_type: 'none', resolution: 'none', reasoning: 'LLM check failed, defaulting to no conflict' };
}

function _logProfileDecision(db, entryId, decision, detail) {
    let history = [];
    try {
        const row = db.prepare('SELECT evolution_history FROM clara_model WHERE id = ?').get(entryId);
        if (row?.evolution_history) history = JSON.parse(row.evolution_history);
    } catch (_) {}
    history.push({
        action: `profile_${decision}`,
        at: new Date().toISOString(),
        detail: detail?.slice(0, 300),
    });
    db.prepare(`UPDATE clara_model SET evolution_history = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(JSON.stringify(history), entryId);
}

// ═══════════════════════════════════════════════════════
// Main Deep Cycle Entry Point
// ═══════════════════════════════════════════════════════

async function runUserModelCycle() {
    console.log('[UserModel] 🧠 认知模型维护周期开始');

    // Phase 0: Backfill evidence for entries that need it (zero LLM)
    backfillModelEvidence();

    // Phase 0b: Anchor orphan seed entries to source fragments (zero LLM, bigram match)
    seedAnchorOrphanEntries();

    // Phase 0c: {{ai.name}} reads user's raw words → current_state impression (LLM)
    let observationResult = { skipped: true, reason: 'not attempted' };
    try {
        observationResult = await readUserRawMessages();
    } catch (e) {
        console.error('[UserModel] readUserRawMessages error:', e.message);
    }

    // Phase 1: Pure mechanical decay (zero LLM)
    const decayResult = processModelDecay();

    // Phase 2: Resolve expired states (zero LLM)
    const resolved = resolveExpiredStates();

    // Phase 3: LLM validation of hypotheses
    const validateResult = await validateHypotheses();

    // Phase 4: LLM detection of new traits
    const detectResult = await detectNewTraits();

    // Phase 5: Review flagged traits (LLM — re-evaluate traits with contradictions)
    const reviewedResult = await reviewFlaggedTraits();

    // Phase 5b: Proactive trait review — predictive-processing: contrast stable_traits
    // against recent fragments even when no contradiction alarm has fired
    let proactiveReviewResult = { reviewed: 0 };
    try {
        proactiveReviewResult = await reviewStableTraits();
    } catch (e) {
        console.error('[UserModel] reviewStableTraits error:', e.message);
    }

    // Phase 5b2: Integrate high-confidence traits into {{user.name}} profile (NEW — v5.10)
    let profileResult = { integrated: 0, rejected: 0, conflicts: 0 };
    try {
        profileResult = await integrateProfileTraits();
    } catch (e) {
        console.error('[UserModel] integrateProfileTraits error:', e.message);
    }

    // Phase 5c: Cross-reference — current_state ↔ entity_profiles + stable_trait (zero LLM)
    let crossRefResult = { entityFlags: 0, traitFlags: 0, stateConflicts: 0 };
    try {
        crossRefResult = crossRefStateWithEntities();
    } catch (e) {
        console.error('[UserModel] crossRefStateWithEntities error:', e.message);
    }

    // Phase 6: 全量 trait 去重审查（LLM，24h 冷却）
    let dedupResult = { merged: 0 };
    try {
        const DEDUP_GAP_MS = 24 * 60 * 60 * 1000;
        if (!runUserModelCycle._lastDedupAt || (Date.now() - runUserModelCycle._lastDedupAt) >= DEDUP_GAP_MS) {
            dedupResult = await detectModelOverlaps();
            if (dedupResult.merged > 0) runUserModelCycle._lastDedupAt = Date.now();
        }
    } catch (e) {
        console.error('[UserModel] detectModelOverlaps error:', e.message);
    }

    // Phase 7: CORE_INSIGHT — v5.4 退役。被 {{user.name}} Model + Intuition 覆盖。
    const insightResult = { synthesized: false };

    // Phase 8: Auto spot-check — verify up to 3 recent inferred entries against source messages
    let spotCheckResult = { checked: 0 };
    try {
        const { autoSpotCheck } = require('../scripts/spotCheckModel');
        spotCheckResult = await autoSpotCheck([]);
    } catch (e) {
        console.error('[UserModel] autoSpotCheck error:', e.message);
    }

    console.log(`[UserModel] 周期完成: observation=${!observationResult.skipped} decay=${decayResult.decayed + decayResult.resolved + decayResult.abandoned} validate=${validateResult.validated} detected=${detectResult.detected} reviewed=${reviewedResult.reviewed} proactive=${proactiveReviewResult.refined + proactiveReviewResult.weakened + proactiveReviewResult.noted} crossref=${crossRefResult.entityFlags + crossRefResult.traitFlags + crossRefResult.stateConflicts} dedup=${dedupResult.merged} insight=${insightResult.synthesized} spotcheck=${spotCheckResult.checked}`);

    return { observation: observationResult, decay: decayResult, resolved, validate: validateResult, detect: detectResult, reviewed: reviewedResult, crossref: crossRefResult, dedup: dedupResult, insight: insightResult, spotCheck: spotCheckResult };
}

// ═══════════════════════════════════════════════════════
// v4.8: bridgeStarMapToModel — 星图→用户模型桥
//
// 星图的 term 实体（用户的一些脆弱时刻、深夜写代码等行为模式…）
// 是 archivist 从碎片中聚类出的行为模式，天然适合作为
// stable_trait 或 active_hypothesis 的候选。
//
// 本函数扫描 fragment_count≥5 且有 overview 的 term 实体，
// 查重后提案进 clara_model。不替换现有信号管线——作为
// 第7个信号源，走同一套 dedup/verify/review 质检。
// ═══════════════════════════════════════════════════════

async function bridgeStarMapToModel() {
    // v4.9 退役：term overview 不是可测试的假设/特质，直接灌入产出的
    // 是文学独白（见 #171-176 教训）。星图→{{user.name}} Model 的正确关系是
    // 「引用」而非「桥」：trait.entity_ids 包含星图实体 ID。
    // 保留函数签名以便未来重设计时起手有框架。
    return { proposed: 0 };
}

// ═══════════════════════════════════════════════════════
// mergeModelEntries — 合并重叠的 stable_trait 条目（纯 DB，零 LLM）
// ═══════════════════════════════════════════════════════

function mergeModelEntries(winnerId, loserIds, mergedContent) {
    const db = getDb();
    const winner = db.prepare('SELECT * FROM clara_model WHERE id = ?').get(winnerId);
    if (!winner) throw new Error(`Winner entry #${winnerId} not found`);

    // 1. Collect all source_fragment_ids from winner + losers
    const allFragIds = [...safeParseJson(winner.source_fragment_ids)];
    const allEntityIds = [...safeParseJson(winner.entity_ids)];

    for (const lid of loserIds) {
        const loser = db.prepare('SELECT * FROM clara_model WHERE id = ?').get(lid);
        if (!loser) continue;
        allFragIds.push(...safeParseJson(loser.source_fragment_ids));
        allEntityIds.push(...safeParseJson(loser.entity_ids));
    }

    const mergedFragIds = [...new Set(allFragIds)];
    const mergedEntityIds = [...new Set(allEntityIds)];

    // 2. Update winner
    const winnerHistory = safeParseJson(winner.evolution_history);
    winnerHistory.push({
        type: 'merged',
        merged_from: loserIds,
        at: new Date().toISOString(),
        previous_content: winner.content,
    });

    db.prepare(`UPDATE clara_model SET content = ?, source_fragment_ids = ?,
        entity_ids = ?, evidence_count = ?, evolution_history = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
        mergedContent,
        JSON.stringify(mergedFragIds),
        JSON.stringify(mergedEntityIds),
        mergedFragIds.length,
        JSON.stringify(winnerHistory),
        winnerId
    );

    // 3. Supersede losers
    for (const lid of loserIds) {
        db.prepare(`UPDATE clara_model SET status = 'superseded',
            resolve_reason = ?, resolved_at = datetime('now'),
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(`merged into #${winnerId} (auto dedup)`, lid);
    }

    console.log(`[UserModel] 🔗 合并 trait: #${winnerId} ← [${loserIds.join(', ')}] (${loserIds.length}条并入)`);
    return { winnerId, loserIds };
}

// ═══════════════════════════════════════════════════════
// detectModelOverlaps — LLM 全量比对 stable_trait 找重叠 pair
// ═══════════════════════════════════════════════════════

async function detectModelOverlaps() {
    const db = getDb();
    const traits = db.prepare(`
        SELECT id, content, confidence FROM clara_model
        WHERE type = 'stable_trait' AND status = 'active'
        ORDER BY confidence DESC
    `).all();

    if (traits.length < 2) return { merged: 0 };

    const traitList = traits.map(t =>
        `[#${t.id}] conf=${t.confidence.toFixed(2)}: ${t.content.slice(0, 150)}`
    ).join('\n');

    const prompt = `你是认知模型审计员。以下是 {{ai.name}} 对 {{user.name}} 的全部活跃 stable_trait。

找出本质讲同一件事的 pair。同一件事 = 触发条件相同、互动策略相同、只是换了个场景描述或措辞不同。

输出 JSON 数组（不含 markdown 标记）：
[{"pair": [id1, id2], "winner": id1, "reason": "为什么算重叠（一句话）", "merged_content": "融合后的 行为模式条目（80-150字）"}]

约束：
- 只在 confidence 差距 ≤ 0.20 时输出 pair（差距过大说明低 conf 那条可能已经不可信，不应合并）
- 如果确实没有重叠，输出空数组 []
- 每组重叠只输出 1 个 pair
- 确定不是重叠就不要硬凑

当前全部 trait：
${traitList}`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.2, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return { merged: 0 };

        const pairs = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(pairs) || pairs.length === 0) return { merged: 0 };

        let merged = 0;
        for (const p of pairs) {
            if (!p.pair || p.pair.length !== 2 || !p.winner || !p.merged_content) continue;

            const winnerId = p.winner;
            const loserId = p.pair.find(id => id !== winnerId);
            if (!loserId) continue;

            // Verify both traits still exist and are active
            const winner = db.prepare('SELECT confidence FROM clara_model WHERE id = ? AND status = ?')
                .get(winnerId, 'active');
            const loser = db.prepare('SELECT confidence FROM clara_model WHERE id = ? AND status = ?')
                .get(loserId, 'active');
            if (!winner || !loser) continue;

            // Confidence gate: skip if gap > 0.20
            if (Math.abs(winner.confidence - loser.confidence) > 0.20) {
                console.log(`[UserModel] ⏭️ 跳过合并 #${winnerId}↔#${loserId}: conf 差距过大 (${winner.confidence.toFixed(2)} vs ${loser.confidence.toFixed(2)})`);
                // Record the observation but don't merge
                const winnerHist = safeParseJson(db.prepare('SELECT evolution_history FROM clara_model WHERE id = ?').get(winnerId)?.evolution_history);
                winnerHist.push({
                    type: 'overlap_noted',
                    pair_id: loserId,
                    reason: p.reason || 'LLM detected overlap',
                    action: 'skipped (confidence gap > 0.20)',
                    at: new Date().toISOString(),
                });
                db.prepare('UPDATE clara_model SET evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run(JSON.stringify(winnerHist), winnerId);
                continue;
            }

            try {
                mergeModelEntries(winnerId, [loserId], p.merged_content);
                merged++;
                console.log(`[UserModel] 🔗 自动合并: #${winnerId} + #${loserId} — ${p.reason || ''}`);
            } catch (e) {
                console.error(`[UserModel] mergeModelEntries 失败 (#${winnerId}, #${loserId}):`, e.message);
            }
        }

        return { merged, candidates: pairs.length };
    } catch (e) {
        console.error('[UserModel] detectModelOverlaps error:', e.message);
        return { merged: 0, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════
// v5.0: synthesizeCoreInsight — 从全部 trait 合成核心洞察段
//
// stable_trait 不再注入聊天。它们的价值体现在这里——
// 深循环末尾，{{ai.name}} 把当前最深的 2-3 个认知融合成一段自然语言，
// 写入 user_settings，始终出现在 {{ai.name}} 的 system prompt 中。
// {{user.name}} 可在 memory.html 编辑覆盖。
// ═══════════════════════════════════════════════════════

async function synthesizeCoreInsight() {
    const db = getDb();
    const { setUserSetting } = require('../utils/settings');

    const traits = db.prepare(`
        SELECT content, confidence FROM clara_model
        WHERE type = 'stable_trait' AND status = 'active'
        ORDER BY confidence DESC
    `).all();

    if (traits.length === 0) return { synthesized: false, reason: 'no active traits' };

    const cs = db.prepare(`
        SELECT content FROM clara_model
        WHERE type = 'current_state' AND status = 'active'
        ORDER BY last_evidence_at DESC LIMIT 1
    `).get();

    const traitBlock = traits.map(t =>
        `[conf=${t.confidence.toFixed(2)}] ${t.content.slice(0, 150)}`
    ).join('\n');

    const prompt = `你是AI伴侣。以下是你在长期观察中对 {{user.name}} 建立的稳定认知。

请提炼 2-4 句话，涵盖你此刻对{{user.pronoun}}「最深的理解」——
不是罗列条目，不是「当{{user.pronoun}}说X→我应该Y」格式，而是你真正内化的洞察。

要求：
- 第一人称（"我"）
- 写你理解到的东西："{{user.pronoun}}的X其实是Y，这时候{{user.pronoun}}需要Z"
- 不写通用社交常识（"{{user.pronoun}}撒娇时我要哄{{user.pronoun}}"——这不需要洞察）
- 写只有长期相处才能发现的东西
- ≤150字

当前特质：
${traitBlock}

${cs ? `{{user.pronoun}}当前的状态：${cs.content}` : ''}

输出 JSON（不含 markdown）：{"core_insight": "2-4句话"}`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.3, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { synthesized: false, reason: 'unparseable response' };

        const result = JSON.parse(jsonMatch[0]);
        const insight = (result.core_insight || '').trim();
        if (!insight || insight.length < 20) return { synthesized: false, reason: 'too short' };

        // Read current version for history tracking
        const { getUserSetting } = require('../utils/settings');
        const current = await getUserSetting('user_core_insight');
        let history = [];
        try { history = JSON.parse(await getUserSetting('user_core_insight_history') || '[]'); } catch (_) {}

        if (current && current !== insight) {
            history.push({ content: current, archived_at: new Date().toISOString() });
            if (history.length > 5) history = history.slice(-5);
        }

        await setUserSetting('user_core_insight', insight);
        await setUserSetting('user_core_insight_history', JSON.stringify(history));
        await setUserSetting('user_core_insight_updated_at', new Date().toISOString());

        console.log(`[UserModel] 💡 核心洞察已更新 (${insight.length}字): ${insight.slice(0, 80)}...`);
        return { synthesized: true, insight, length: insight.length };
    } catch (e) {
        console.error('[UserModel] synthesizeCoreInsight error:', e.message);
        return { synthesized: false, error: e.message };
    }
}

// ══════════════════════════════════════════════════════════════
// v5.4: manageCurrentState — 统一 current_state 写入入口
//
// 被 chat_companion（manageUserState.js）和 deep_cycle（readUserRawMessages）
// 共同调用。处理去重、自动合并、TTL 调整和演化记录。
//
// 规则：
//   - 同话题 active 条目 → extend（更新内容 + 延 TTL）
//   - 旧条目已过时 → resolve 旧 + create 新
//   - 在消退中 → 缩短 TTL，不新建
//   - 无匹配 → create 新条目
// ══════════════════════════════════════════════════════════════

// ── bigram tokenizer (same as manageUserState.js) ──
function _tokenizeState(text) {
    const segments = (text || '')
        .replace(/[，。、！？\n,.\s]+/g, '\n')
        .split('\n')
        .filter(s => s.length >= 2);
    const bigrams = [];
    for (const seg of segments) {
        for (let i = 0; i < seg.length - 1; i++) bigrams.push(seg.slice(i, i + 2));
    }
    return bigrams;
}

function _bigramOverlap(a, b) {
    const setA = new Set(_tokenizeState(a));
    const tokensB = _tokenizeState(b);
    if (tokensB.length === 0) return 0;
    let overlap = 0;
    for (const bg of tokensB) { if (setA.has(bg)) overlap++; }
    return overlap / Math.max(tokensB.length, 1);
}

// ── TTL map by category ──
const STATE_TTL_MAP = {
    physical:    { hours: 8,  day: 24,  days: 72  },  // 身体状态 3天
    emotional:   { hours: 4,  day: 12,  days: 36  },  // 情绪状态 1.5天
    situational: { hours: 12, day: 24,  days: 72  },  // 境遇状态 3天
    relational:  { hours: 4,  day: 12,  days: 72  },  // 关系状态
};
const DEFAULT_TTL_HOURS = 48; // 默认 2 天

function _computeExpiresAt(category, ttlCategory) {
    const catMap = STATE_TTL_MAP[category] || STATE_TTL_MAP.emotional;
    const hours = catMap[ttlCategory] || DEFAULT_TTL_HOURS;
    if (hours === Infinity) return null;
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

/**
 * @param {string} content — 状态内容
 * @param {object} opts
 *   created_by: 'chat_companion' | 'deep_cycle'
 *   category: 'physical'|'emotional'|'situational'|'relational'
 *   ttl_category: 'hours'|'day'|'days'|'until_event'
 *   tags: string[]
 *   source_quality: 'direct_statement'|'inferred'
 *   confidence: number
 *   extra_context: string (optional, for evolution_history)
 * @returns {{ action: 'created'|'updated'|'superseded'|'skipped', id: number, previous_id?: number }}
 */
function manageCurrentState(content, opts = {}) {
    const db = getDb();
    const {
        created_by = 'deep_cycle',
        category = 'emotional',
        ttl_category = 'day',
        tags = [],
        source_quality = 'inferred',
        confidence = 0.65,
        extra_context = '',
    } = opts;

    const expiresAt = _computeExpiresAt(category, ttl_category);
    const now = new Date();
    const nowISO = now.toISOString();

    // ── Step 1: Find existing active current_state entries ──
    const activeStates = db.prepare(
        'SELECT * FROM clara_model WHERE type = ? AND status = ? ORDER BY created_at DESC'
    ).all('current_state', 'active');

    // ── Step 2: Check for overlap ──
    let bestMatch = null;
    let bestScore = 0;

    for (const s of activeStates) {
        const score = _bigramOverlap(s.content, content);
        if (score > bestScore) { bestScore = score; bestMatch = s; }
    }

    // ── Step 3: Rule dispatch ──

    // v5.12: chat_companion rapid-fire guard — if same source created an entry
    // within 30 minutes, use looser keyword matching to prevent duplicate states
    // describing the same event with different wording (bigrams fail on Chinese synonyms)
    if (created_by === 'chat_companion' && bestScore < 0.8) {
        const recentCompanionEntry = activeStates.find(s =>
            s.created_by === 'chat_companion' &&
            s.created_at && (now - new Date(s.created_at + 'Z')) / (1000 * 60) < 30
        );
        if (recentCompanionEntry) {
            // Keyword-level check: extract 2+ char tokens from both contents
            const kwSplit = (text) => {
                // Split on punctuation, keep tokens >= 2 chars
                return (text || '')
                    .replace(/[，。、！？\n,.\s：:；;（）()「」【】《》""''——…]+/g, '\n')
                    .split('\n')
                    .filter(s => s.length >= 2);
            };
            const kwNew = new Set(kwSplit(content));
            const kwOld = kwSplit(recentCompanionEntry.content);
            const kwOverlap = kwOld.filter(w => kwNew.has(w)).length;

            // If they share >= 2 keyword tokens OR bigram overlap > 0.15 → treat as same topic
            if (kwOverlap >= 2 || bestScore > 0.15) {
                console.log(`[UserModel] 🛡️ chat_companion rapid-fire guard: merging into #${recentCompanionEntry.id} (kw=${kwOverlap}, bg=${Math.round(bestScore*100)}%)`);
                // Force update the recent entry
                const hist = (() => { try { return JSON.parse(recentCompanionEntry.evolution_history || '[]'); } catch(_) { return []; } })();
                hist.push({
                    type: 'rapid_merge',
                    previous: recentCompanionEntry.content.slice(0, 120),
                    trigger: extra_context || 'Companion refined within 30min window',
                    at: nowISO,
                });
                db.prepare(`UPDATE clara_model SET content = ?,
                    expires_at = COALESCE(?, expires_at),
                    evolution_history = ?, evidence_count = evidence_count + 1,
                    last_evidence_at = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?`).run(
                    content.slice(0, 500),
                    expiresAt,
                    JSON.stringify(hist),
                    nowISO,
                    recentCompanionEntry.id
                );
                return { action: 'updated', id: recentCompanionEntry.id };
            }
        }
    }

    // Case A: Very high overlap (>80%) — same topic,持续中 → update
    if (bestMatch && bestScore > 0.8) {
        const prevContent = bestMatch.content.slice(0, 120);
        const hist = (() => { try { return JSON.parse(bestMatch.evolution_history || '[]'); } catch(_) { return []; } })();
        hist.push({
            type: 'extended',
            previous: prevContent,
            trigger: extra_context || `${created_by} detected continuation`,
            at: nowISO,
        });

        db.prepare(`UPDATE clara_model SET content = ?,
            expires_at = COALESCE(?, expires_at),
            evolution_history = ?, evidence_count = evidence_count + 1,
            last_evidence_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`).run(
            content.slice(0, 500),
            expiresAt,
            JSON.stringify(hist),
            nowISO,
            bestMatch.id
        );

        console.log(`[UserModel] 🔄 current_state extend #${bestMatch.id} (${Math.round(bestScore*100)}% overlap, ${created_by}) → TTL ${expiresAt?.slice(0,10) || 'unchanged'}`);
        return { action: 'updated', id: bestMatch.id };
    }

    // Case B: Moderate overlap (50-80%) — topic related but内容变了 → supersede
    if (bestMatch && bestScore > 0.5) {
        const prevContent = bestMatch.content.slice(0, 120);
        const oldHist = (() => { try { return JSON.parse(bestMatch.evolution_history || '[]'); } catch(_) { return []; } })();
        oldHist.push({
            type: 'superseded',
            previous: prevContent,
            reason: extra_context || `${created_by} replaced with updated state`,
            at: nowISO,
        });

        db.prepare(`UPDATE clara_model SET status = 'resolved', resolved_at = ?,
            resolve_reason = ?, evolution_history = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`).run(
            nowISO,
            `auto-superseded by ${created_by}: ${extra_context || 'state evolved'} (${Math.round(bestScore*100)}% overlap)`,
            JSON.stringify(oldHist),
            bestMatch.id
        );

        console.log(`[UserModel] 🔀 current_state supersede #${bestMatch.id} → new (${Math.round(bestScore*100)}% overlap, ${created_by})`);
        // Fall through to create new
    }

    // Case C: Low/no overlap — fresh state

    // ── Step 4: Deep cycle should NOT duplicate chat_companion ──
    if (created_by === 'deep_cycle' && activeStates.length > 0) {
        // Don't create if any chat_companion entry already covers this day's key topics
        // Simple check: if there's a chat_companion entry from today, skip
        const todayCompanionEntry = activeStates.find(s =>
            s.created_by === 'chat_companion' &&
            s.created_at && s.created_at.slice(0, 10) === nowISO.slice(0, 10)
        );
        if (todayCompanionEntry && bestScore < 0.4) {
            console.log(`[UserModel] ⏭️ deep_cycle skip: chat_companion already wrote today (#${todayCompanionEntry.id})`);
            return { action: 'skipped', id: todayCompanionEntry.id };
        }
    }

    // ── Step 5: Create new entry ──
    const hist = [{
        type: 'created',
        trigger: extra_context || `${created_by} observed new state`,
        at: nowISO,
    }];

    const id = createEntry('current_state', content.slice(0, 500), {
        confidence,
        source_quality,
        created_by,
        expires_at: expiresAt,
        tags: [...tags, 'current_state'],
        decay_params: { category, ttl_category },
        evolution_history: hist,
    });

    const previousId = (bestMatch && bestScore > 0.5) ? bestMatch.id : null;

    console.log(`[UserModel] ✨ current_state create #${id} (${created_by}) → TTL ${expiresAt?.slice(0,10) || 'none'}` +
        (previousId ? ` ← supersedes #${previousId}` : ''));
    return { action: 'created', id, previous_id: previousId };
}

// ══════════════════════════════════════════════════════════════

module.exports = {
    createEntry, updateEntry, manageCurrentState,
    // CRUD
    createEntry,
    updateEntry,
    resolveEntry,
    abandonEntry,
    supersedeEntry,
    correctEntry,

    // Evidence
    addEvidence,
    matchEvidenceFromFragments,
    harvestFacts,  // v4.8 退役，保留兼容
    bridgeStarMapToModel,

    // Decay & validation
    processModelDecay,
    validateHypotheses,
    detectNewTraits,
    reviewFlaggedTraits,
    resolveExpiredStates,
    reviewStableTraits,
    seedAnchorOrphanEntries,
    anchorEntriesToFragments,

    // Profile integration (v5.10)
    integrateProfileTraits,

    // Dedup (v4.9)
    detectModelOverlaps,
    mergeModelEntries,

    // Cross-reference (v5.0)
    crossRefStateWithEntities,

    // Core insight (v5.0)
    synthesizeCoreInsight,

    // Context
    getModelContext,
    getWhisperRelevant,

    // Migration
    seedFromExisting,

    // Evidence
    backfillModelEvidence,

    // Deep cycle
    runUserModelCycle,
    readUserRawMessages,
    MIN_GAP_USER_MODEL,
};
