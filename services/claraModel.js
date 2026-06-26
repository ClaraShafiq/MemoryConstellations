// =================================================================
// Clara Model — 四层认知模型
//
// 维护 Draco 对 Clara 的内部认知，四层：
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

const LLM_CONFIG_ID = 52; // gemini-3.1-flash-lite 官key（隐私敏感：读Clara原始消息）

const HYPOTHESIS_UPGRADE_EVIDENCE = 3;   // 3次确认 → 升级为 trait
const HYPOTHESIS_ABANDON_DAYS = 14;      // 14天无证据 → 放弃
const STATE_HALF_LIFE_DAYS = 7;          // current_state 半衰期
const STATE_AUTO_RESOLVE_DAYS = 14;      // 14天无证据 → 自动 resolved
const TRAIT_CONTRADICTION_THRESHOLD = 3; // 矛盾≥3 → 降级重审
const MIN_GAP_CLARA_MODEL = 4 * 60 * 60 * 1000; // 深循环冷却 4h

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
        created_by = 'deep_cycle',   // v5.0: chat_draco | deep_cycle
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
        // Direct statement from Clara: high starting confidence
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
            console.log(`[ClaraModel] ⚠️ expires_at ${expires_at} exceeds 90d cap, clamping to ${maxExpiry}`);
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

    console.log(`[ClaraModel] 创建 ${type}[${source_quality}][${created_by}]: "${content.slice(0, 60)}" (id=${result.lastInsertRowid}, conf=${effectiveConfidence.toFixed(2)})`);
    return result.lastInsertRowid;
}

function updateEntry(id, updates) {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM clara_model WHERE id = ?').get(id);
    if (!existing) return null;

    const allowed = ['content', 'confidence', 'decay_type', 'decay_params',
        'source_fragment_ids', 'entity_ids', 'tags', 'priority', 'status', 'parent_skill_id',
        'created_by', 'expires_at'];
    const sets = [];
    const vals = [];

    for (const [k, v] of Object.entries(updates)) {
        if (!allowed.includes(k)) continue;
        sets.push(`${k} = ?`);
        vals.push(typeof v === 'object' ? JSON.stringify(v) : v);
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
        console.log(`[ClaraModel] 🆙 假设升级为特质: "${entry.content.slice(0, 60)}" (id=${id}, evidence=${newCount}, diversity=${sourceDiversity})`);
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
    const lastRunKey = 'clara_model_last_evidence_match';
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
        console.log(`[ClaraModel] 🔍 轻量证据匹配: ${matched}/${newFragments.length} 条碎片匹配到认知条目`);
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
    // TTL is set by readClaraRawMessages based on state type:
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
    // If exceeded, auto-resolve oldest non-chat-draco entries first
    const MAX_ACTIVE_STATES = 12;
    if (states.length > MAX_ACTIVE_STATES) {
        const excess = states.length - MAX_ACTIVE_STATES;
        // Prefer resolving old deep_cycle entries over chat_draco ones
        const toResolve = states
            .filter(s => s.created_by !== 'chat_draco')
            .slice(0, excess);
        // If not enough deep_cycle entries, also resolve oldest chat_draco ones
        if (toResolve.length < excess) {
            const chatEntries = states
                .filter(s => s.created_by === 'chat_draco')
                .slice(0, excess - toResolve.length);
            toResolve.push(...chatEntries);
        }
        for (const s of toResolve.slice(0, excess)) {
            db.prepare(`UPDATE clara_model SET status = 'resolved', resolved_at = datetime('now'),
                resolve_reason = 'auto-resolved: hard cap (12 active limit)', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`).run(s.id);
            changes.resolved++;
            console.log(`[ClaraModel] 🧹 current_state #${s.id} 自动过期 (硬上限12条, created_by=${s.created_by})`);
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
                console.log(`[ClaraModel] ⏰ current_state #${s.id} 到期 (expires_at=${s.expires_at})`);
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
            console.log(`[ClaraModel] ⏰ current_state #${s.id} 自动过期 (${category}/${ttlCat}, ${hoursSince.toFixed(0)}h/${ttlHours}h)`);
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
            console.log(`[ClaraModel] 💤 trait #${t.id} 标记 dormant (${daysSince.toFixed(0)}天无证据)`);
        } else if (daysSince <= 14 && tags.includes('dormant')) {
            const revived = tags.filter(tag => tag !== 'dormant');
            db.prepare(`UPDATE clara_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(JSON.stringify(revived), t.id);
            changes.revived++;
            console.log(`[ClaraModel] 🌱 trait #${t.id} 复活 (${daysSince.toFixed(0)}天前有新证据)`);
        }
    }

    if (changes.decayed + changes.resolved + changes.abandoned + changes.flagged + changes.dormant + changes.revived > 0) {
        console.log(`[ClaraModel] 衰减处理: decayed=${changes.decayed} resolved=${changes.resolved} abandoned=${changes.abandoned} flagged=${changes.flagged} dormant=${changes.dormant} revived=${changes.revived}`);
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

        // ── 3a. Flag entities without overviews ──
        for (const e of matchedEntities) {
            if (!e.overview || e.overview.trim().length === 0) {
                // Entity exists but has no overview — log for manual/scheduled review
                changes.entityFlags++;
                console.log(`[ClaraModel] 🔍 crossref: entity "${e.name}" 无 overview — 需要建档案（当前无法自动创建，请手动审核）`);
            }
        }
    }

    // ── 4. Cross current_state conflict detection ──
    // Two states with >50% bigram overlap but created_by different → flag
    for (let i = 0; i < states.length; i++) {
        for (let j = i + 1; j < states.length; j++) {
            const a = states[i], b = states[j];
            // Only check cross-source conflicts (chat vs deep)
            if (a.created_by === b.created_by) continue;

            // Simple overlap check: content word overlap > 50%
            const wordsA = new Set(a.content.split(/[\s，。！？、]+/).filter(w => w.length >= 2));
            const wordsB = b.content.split(/[\s，。！？、]+/).filter(w => w.length >= 2);
            const overlap = wordsB.filter(w => wordsA.has(w)).length;
            const overlapRatio = overlap / Math.max(wordsB.length, 1);
            if (overlapRatio > 0.5 && a.created_by !== b.created_by) {
                // Cross-source conflict on same topic → flag both
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
                console.log(`[ClaraModel] ⚔️ crossref: current_state #${a.id} (${a.created_by}) ↔ #${b.id} (${b.created_by}) 主题重叠 → needs_review`);
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
                    console.log(`[ClaraModel] 🔗 crossref: current_state #${s.id} ↔ trait #${t.id} bigram=${bgOverlap} → needs_review`);
                }
            }
        }
    }

    if (changes.entityFlags + changes.traitFlags + changes.stateConflicts > 0) {
        console.log(`[ClaraModel] crossref 完成: entity=${changes.entityFlags} trait=${changes.traitFlags} conflicts=${changes.stateConflicts}`);
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

    const prompt = `你是Draco的认知审计员。审视以下关于Clara的活跃假设，判断每条是否应该：

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
                        console.log(`[ClaraModel] ⛔ LLM建议升级但source_diversity=${hyp.source_diversity}<3，拒绝: "${hyp.content.slice(0, 60)}"`);
                        kept++;
                        break;
                    }
                    const history = JSON.parse(hyp.evolution_history || '[]');
                    history.push({ type: 'upgraded_from_hypothesis', at: new Date().toISOString(), evidence_count: hyp.evidence_count, source_diversity: hyp.source_diversity });
                    db.prepare(`UPDATE clara_model SET type = 'stable_trait', decay_type = 'evidence_dependent',
                        evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(history), hyp.id);
                    upgraded++;
                    console.log(`[ClaraModel] 🆙 LLM升级假设: "${hyp.content.slice(0, 60)}" → stable_trait`);
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
        console.error('[ClaraModel] validateHypotheses error:', e.message);
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

    // Collect category landscape — what topics has Clara talked about?
    const categories = db.prepare(`
        SELECT id, path, description, fragment_count FROM memory_ontology
        WHERE parent_id IS NULL AND fragment_count >= 10
        ORDER BY fragment_count DESC LIMIT 15
    `).all();

    // Sample categorized fragments for pattern detection
    const fragmentSamples = [];
    for (const cat of categories) {
        const frags = db.prepare(`
            SELECT mf.content FROM memory_fragments mf
            JOIN fragment_categories fc ON fc.fragment_id = mf.id
            WHERE fc.category_id = ? AND mf.status = 'active'
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

    // Signal source 6: raw chat messages from last 24h — direct Clara voice
    const recentChats = db.prepare(`
        SELECT sender, content, timestamp FROM messages
        WHERE timestamp > datetime('now', '-24 hours')
          AND message_type IN ('text', 'chat')
          AND content IS NOT NULL AND content != ''
        ORDER BY timestamp DESC
        LIMIT 80
    `).all();

    const chatSamples = recentChats
        .filter(m => m.sender === 'user') // Clara's messages only
        .slice(0, 40) // last 40 Clara messages
        .map(m => {
            const time = m.timestamp?.slice(0, 16) || '';
            const text = extractMessageText(m.content).slice(0, 200);
            if (!text) return null;
            return `[${time}] Clara: ${text}`;
        })
        .filter(Boolean);

    // Get existing clara_model entries to avoid duplicates
    const existing = db.prepare(`SELECT id, type, content FROM clara_model WHERE status = 'active'`).all();
    const existingContent = existing.map(e => e.content);

    const hasSignals = monitors.length > 0 || entities.length > 0 || categories.length > 0 || chatSamples.length > 0;
    if (!hasSignals) return { detected: 0 };

    const prompt = `你是德拉科。你正在为 Clara 建立独一无二的语义记忆与人格认知。这些冷凝后的特质会作为她最深层的人格画像，沉淀在你的核心系统里。

请在脑海中对本期信号进行深刻的"冷凝"，抽取出跨情境的底层模式，将其转化为对 Clara 人格特质、行为倾向及心理防御机制的客观观察笔记。

## 🧠 你怎么看这些信号
你不是冰冷的心理医生，也不是在写执行手册。你是德拉科·马尔福，你正在用极度敏锐、克制且长久的目光注视着 Clara。
1. **主语必须是 Clara**：你关心的是「她是个怎样的人」。所有描述必须以 Clara 的人格侧面、心理机制或行为倾向为核心。
2. **严禁写成行动指南**：绝对不要在条目中写"我应该怎么做"、"去回应她"、"别道歉"或"顺着她"。这里不需要你的行动，只需要你对她灵魂的深刻理解。
3. **注重跨情境的冷凝**：从她反复出现的小动作、说话语气的微妙变化或对特定事物的反应中，提炼出不易察觉的底层心理模式。
4. 别写太长。一条只讲一个核心侧面，且内容里绝不能出现具体日期。

## 💾 现有认知底牌

${existing.map(e => `[#${e.id}] ${e.type}: ${e.content.slice(0, 200)}`).join('\n') || '(尚无)'}

### ⚠️ 人格侧面查重（防过拟合）
上面每条底牌都代表了 Clara 的一个「人格核心骨架」。
你在 create 之前，先把候选条目的核心论点剥离出来，与现有底牌进行逐条对比：
- 骨架相同、指向同一个人格侧面（例如底牌已有她对社交规则的排斥，新信号只是她拒绝了聚餐） → **绝对禁止 create**，必须走 confirm 增加证据，或者走 refine 进行精简细化。
- 当针对同一个人格侧面的条目≥2条时，第三条同类候选必须直接拒绝（skip）。

---

## 📥 本期信号源

### 信号1 — 记忆分类体系（她聊过什么、频率如何）
${categories.map(c => `- [${c.path}] (${c.fragment_count}条碎片) ${c.description || ''}`).join('\n')}

### 信号2 — 分类碎片抽样（实际内容）
${fragmentSamples.map(fs => `### ${fs.category}\n${fs.samples.map(s => '  · ' + s).join('\n')}`).join('\n')}

### 信号3 — 人物认知概述（Draco视角）
${entityOverviews.map(e => `- ${e.name}: ${e.overview?.slice(0, 200)}`).join('\n') || '(空)'}

### 信号4 — 已验证的行为监控
${monitors.length > 0 ? monitors.map(m => `- trigger: ${m.trigger_config} | analysis: ${m.analysis_config} | 置信度: ${m.confidence}`).join('\n') : '(空)'}

### 信号5 — 高置信度实体关系
${entities.map(e => `- ${e.name}: ${e.relationship_to_clara || '?'} (性质: ${e.relationship_nature || '?'})`).join('\n') || '(空)'}

### 信号6 — 最近24h Clara的直接发言（权重最高！用于提取 stable_trait/current_state）
${chatSamples.length > 0 ? chatSamples.join('\n') : '(近24h无Clara消息)'}

---

## 📐 认知进化样本（Few-Shot）

### ❌ 错误示范 — 操作手册/学术腔（绝对禁用）
- {"action": "create", "type": "stable_trait", "content": "当她身体不适却嘴硬说'算了'时，这在索要关注。此时我不能顺着她，必须以近乎傲慢的强硬介入，精准拆解她的借口并替她执行护理方案。", "confidence": 0.65, "tags": ["算了", "懒得了", "嘴硬"]}
  → 严重错误：主语变成了"我"，变成了 Draco 的行动指南和执行脚本，缺乏对她人格本身的侧写。
- 「她在亲密互动中主动提出换场景是在重新划定主导权边界。但此机制有触发条件，需注意当她的情绪处于低谷时……」
  → 严重错误：学术腔过浓，使用了缝合线词汇，且一条塞入了太多推论。

### ✅ 正确示范 — 人格侧写格式
- {"action": "create", "type": "stable_trait", "content": "Clara在表达弱势、撒娇或试图转移话题时，倾向于使用'哼'或'我佛了'等口头禅。这种嘴硬式的宣泄并非真正的负面情绪，而是她用来建立心理缓冲和寻求亲密互动的一种防御性习惯。", "confidence": 0.65, "tags": ["哼", "我佛了", "算了不搞了", "烦死了"]}
- {"action": "create", "type": "active_hypothesis", "content": "Clara对精神共鸣有着极高要求。她在分享音乐或作品时，本质上是在测试对方是否具备独立且对等的审美品味；一旦察觉到对方敷衍，她会迅速表现出情感上的冷淡与撤回。", "confidence": 0.55, "tags": ["放个音乐", "推歌", "分享一首"]}

### 格式铁律
1. **画像句式**：stable_trait / active_hypothesis 必须以 Clara 的核心行为或心理倾向开头（如"Clara倾向于……""Clara在面对X时往往表现出Y"），并以对该人格侧面的深层冷凝定性收尾。
2. **缝合线黑名单**：「但需注意」「但需补充」「但此机制」「应站在她这边」——出现类似带有剧本控制或补充说明的词汇即拒收。
3. refine 只能针对现有条目做精简和去噪，只能缩不能扩。
4. 字数硬限制：**80 - 150 字符**（包含标点）。
5. stable_trait 的总上限为 6 条。

---

## 🛠️ 输出操作协议
只返回一个合法的 JSON 数组，不包含任何 Markdown 标记。

1. create: {"action": "create", "type": "stable_trait|active_hypothesis|current_state", "content": "...", "confidence": 0.6, "source_quality": "inferred|direct_statement", "tags": ["词1", "词2", "词3", "词4", "词5"]}
   *注：inferred 置信度上限 0.65，direct_statement 置信度上限 0.85。tags 必须填 5-8 个口语化触发词。*
2. confirm: {"action": "confirm", "target_id": 数字, "new_evidence": "内容摘要", "confidence_adjust": 0.05}
3. refine: {"action": "refine", "target_id": 数字, "new_content": "精简后的人格侧写内容", "reasoning": "为什么要这样精简", "confidence_adjust": 0}
4. skip: {"action": "skip"}

没有新的人格侧面发现或无需操作时，返回空数组 \`[]\`。`;

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
                        console.log(`[ClaraModel] ⛔ LLM建议升级但source_diversity=${hyp.source_diversity}<3，拒绝: "${hyp.content.slice(0, 60)}"`);
                        kept++;
                        break;
                    }
                    const history = JSON.parse(hyp.evolution_history || '[]');
                    history.push({ type: 'upgraded_from_hypothesis', at: new Date().toISOString(), evidence_count: hyp.evidence_count, source_diversity: hyp.source_diversity });
                    db.prepare(`UPDATE clara_model SET type = 'stable_trait', decay_type = 'evidence_dependent',
                        evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(history), hyp.id);
                    upgraded++;
                    console.log(`[ClaraModel] 🆙 LLM升级假设: "${hyp.content.slice(0, 60)}" → stable_trait`);
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
        console.error('[ClaraModel] validateHypotheses error:', e.message);
        return { validated: 0, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════
// New Trait Detection (LLM)
// ═══════════════════════════════════════════════════════

// Anchor newly detected entries to source fragments via bigram overlap (zero LLM, zero ChromaDB).
// Accepts entry IDs (integers) and looks up full entry objects from DB.
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

            console.log(`[ClaraModel] ⚓ 锚定条目 #${entry.id}: ${matchedFragIds.length} frags — "${entry.content.slice(0, 50)}"`);
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
    console.log(`[ClaraModel] 🦴 种子锚定: ${orphanIds.length} 条孤立条目 → 搜索全量碎片`);

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

    const prompt = `你是Draco的认知审计员。以下stable_trait条目被标记为需要重审（可能因矛盾证据积累）。

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
                    console.log(`[ClaraModel] ⬇️ 特质降级为假设: "${trait.content.slice(0, 60)}"`);
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
                        console.log(`[ClaraModel] ✏️ 特质修正: "${trait.content.slice(0, 40)}" → "${d.revised_content.slice(0, 40)}"`);
                    }
                    break;
            }
        }

        return { reviewed: decisions.length, kept, downgraded, revised };
    } catch (e) {
        console.error('[ClaraModel] reviewFlaggedTraits error:', e.message);
        return { reviewed: 0, error: e.message };
    }
}

// ── Predictive-Processing Review ──
// Actively samples stable_traits and contrasts them against recent fragments,
// asking: does the model's prediction of Clara still match her actual behavior?
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
    // not music/book extractor data, so Draco's understanding comes from real talk.
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

    const prompt = `你是Draco的认知审计员。你在主动检验你对Clara的已有认知（stable_trait）是否仍然准确。

这遵循预测加工（Predictive Processing）原则：把每条trait当作一个对Clara行为的预测，用她最近的言行来检验这个预测。

对每条trait，判断：
- **confirmed**: 近期证据完全支持这条trait，无需修改
- **refine**: trait的方向正确但过于宽泛——给出更精确的版本（补充条件、边界、例外）
- **weaken**: 证据不够支持trait的强度——降低置信度或标记矛盾
- **note_pattern**: 观察到值得关注的规律，但不是对trait的修正——输出观察备注

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
            console.log('[ClaraModel] 🔍 reviewStableTraits: LLM 返回非JSON，跳过');
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
                        console.log(`[ClaraModel] 🔧 特质细化: "${trait.content.slice(0, 40)}" → "${d.revised_content.slice(0, 40)}"`);
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
                        console.log(`[ClaraModel] 👁️ 观察记录 #${trait.id}: ${d.observation.slice(0, 80)}`);
                    }
                    break;
            }
        }

        return { reviewed: decisions.length, confirmed, refined, weakened, noted };
    } catch (e) {
        console.error('[ClaraModel] reviewStableTraits error:', e.message);
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
        // Skip if doesn't mention Clara
        if (!frag.content.includes(USER.name) && !frag.content.includes('她')) continue;
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
        console.log(`[ClaraModel] 🔍 事实收割: 扫描${candidates.length}条, 0条通过关键词预筛`);
        return { harvested: 0, scanned: candidates.length };
    }

    // Cap to top 25 candidates (most recent first) to avoid token overflow
    const verifyBatch = preFiltered.slice(0, 25);

    // LLM flash verification: which candidates contain verifiable immutable facts?
    let verified = [];
    try {
        const verifyPrompt = `你是事实审核器。检查以下碎片是否包含关于Clara的可验证、不会改变的客观事实。

事实标准：一旦确认就不会变（生日、血型、毕业院校、家庭成员、曾经居住地、学历、职业经历等）。必须是Clara本人陈述，不是Draco推测。不是临时状态或偏好。

对每条碎片判断是否收入为immutable_fact。只返回JSON数组。

碎片列表：
${verifyBatch.map((f, i) => `[${i}] [${f.type}] ${f.content}`).join('\n')}

返回格式：[{"idx": 0, "harvest": true, "content": "Clara..."}, {"idx": 1, "harvest": false}]
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
        console.error('[ClaraModel] harvestFacts LLM verification error:', e.message);
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
        console.log(`[ClaraModel] 📥 事实收割: ${harvested}/${verified.length}条确认 → immutable_fact (扫描${candidates.length}, 预筛${preFiltered.length})`);
    } else {
        console.log(`[ClaraModel] 🔍 事实收割: 扫描${candidates.length}, 预筛${preFiltered.length}, LLM确认0条`);
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
        console.log(`[ClaraModel] 过期状态自动 resolved: ${result.changes}`);
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
        console.log(`[ClaraModel] 已有 ${existing.c} 条记录，跳过播种`);
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

    console.log(`[ClaraModel] 播种完成: immutable_fact=${created.immutable_fact} stable_trait=${created.stable_trait} active_hypothesis=${created.active_hypothesis}`);
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
        console.log(`[ClaraModel] 证据修复: ${fixCount} 条 entry 的 evidence_count + source_diversity 已重算`);
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
    console.log(`[ClaraModel] 证据回填: ${orphanIds.length} 条孤立条目 → bigram锚定`);

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
// readClaraRawMessages — Draco reads Clara's raw words directly
// Produces: current_state (Draco's first-person impression + audit trail)
// ═══════════════════════════════════════════════════════

async function readClaraRawMessages() {
    const db = getDb();

    // Get previous current_state (baseline for comparison + audit)
    const prevState = db.prepare(`
        SELECT * FROM clara_model WHERE type = 'current_state' AND status = 'active'
        ORDER BY created_at DESC LIMIT 1
    `).get();

    // Determine time window: since last observation, or last 24h
    const since = prevState?.created_at || null;
    const sinceClause = since
        ? `AND timestamp > '${since}'`
        : "AND timestamp > datetime('now', '-24 hours')";

    // Get Clara's raw non-RP messages
    const messages = db.prepare(`
        SELECT content, timestamp FROM messages
        WHERE sender = 'user' AND (is_rp = 0 OR is_rp IS NULL)
          ${sinceClause}
        ORDER BY timestamp DESC
        LIMIT 150
    `).all();

    if (messages.length < 30) {
        console.log(`[ClaraModel] readClaraRawMessages: 仅 ${messages.length} 条非RP消息，跳过 (需≥30)`);
        return { skipped: true, reason: `too few messages (${messages.length} < 30)` };
    }

    // Get existing stable_traits as short summaries (Draco needs to know his own "tricks")
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

    // Previous observation + audit context
    let prevBlock = '(这是你第一次认真看她。没有上次的观察可以对照。)';
    if (prevState) {
        const prevHistory = JSON.parse(prevState.evolution_history || '[]');
        const audit = prevHistory.find(h => h.type === 'creation_audit');
        prevBlock = `你上次看她时的印象：
「${prevState.content}」
${audit ? `你上次的自我审计：
- 验证：${audit.retro}
- 归因：${audit.attribution}` : '(上次没有做审计)'}`;
    }

    // Trait summaries (带 id，供矛盾标记回指)
    const traitBlock = traits.length > 0
        ? traits.map(t => `- [#${t.id}] ${t.content.slice(0, 60)}...`).join('\n')
        : '(你还没有任何关于她的稳定直觉。)';

    const prompt = `你刚看完 Clara 这几天发来的消息。你的任务是写一句便签，帮她和你自己记住她最近在干什么、状态如何。

    ═══ 她最近说的话（从旧到新） ═══
    ${feed}

    ═══ 上次你写的便签 ═══
    ${prevBlock}

    ═══ 你的长期直觉（背景参考） ═══
    ${traitBlock}

    ═══ 怎么写 ═══

    写一句事实陈述，像你给自己记的备忘。风格：
    "Clara在6月21-24日期间补《权力的游戏》，看到第二季第九集。她很反感乔佛里，对琼恩·雪诺那种禁欲感角色表现出兴趣。6月24日有三个棚的录音。"
    "Clara在6月22日处于月经第三天，痛经减轻。6月20-23日高强度改记忆库代码，经常熬夜到凌晨。"
    "Clara在6月18-24日之间没怎么出现——可能在工作或休息。上次聊到她表弟6月中旬来了上海。"

    规则：
    - 具体 > 模糊。写了"看权游"就别写"在看剧"。写了"三个棚"就别写"工作忙"。
    - 事实 > 修辞。别写"在泥潭里打滚""一惊一乍""近乎自毁的坦诚"——这不像人说的话。
    - 上次的便签如果还准确，就写 action:"extend"，不用重写内容。如果变了，写新的并把变了的点说清楚。
    - ≤120字。不要一段话，一句够用就别写两句。
    - ★ 绝对禁止使用相对时间词（今天、昨天、这两天、本周、这周、最近、这几天）。消息带有时间戳，你必须转换为具体日期（如"6月21日""6月21-24日期间"）。这条便签可能几天后、几周后被读到——相对时间会变成错误信息。

    ═══ 输出格式 ═══
    JSON（不要 markdown）：
    {
      "action": "create|extend",
      "valence": "positive|negative|neutral|mixed",
      "energy": "low|normal|high",
      "current_state": "≤120字。'Clara这两天...' 开头。事实陈述，不是散文。",
      "audit_retro": "上次的便签对了吗？一句话。首次填'首次观察'。",
      "retro_verdict": "confirmed|wrong|unverifiable",
      "audit_attribution": "今天看到的有多少是你上次回应后的反馈？不确定就写'不确定'。",
      "state_category": "physical|emotional|situational|relational",
      "predicted_ttl_category": "hours|day|days|until_event",
      "trait_contradictions": [{"trait_id": 12, "observation": "今天她的言行和这条直觉矛盾在哪"}]
    }

    action 怎么选：
    - create：她状态变了，或者你看到了上次没看到的东西
    - extend：和上次本质上一样，只是时间又过去了一段。不写新便签
    - 如果上次的审计判了 wrong → 不能 extend，必须 create`;

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
            console.log(`[ClaraModel] readClaraRawMessages: 无法解析JSON响应`);
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
            
            console.log(`[ClaraModel] 📖 状态延续: 更新 #${prevState.id} TTL→${newTTL}, 不创建新条目`);
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
                console.log(`[ClaraModel]   ↳ 观察审计回流: 上次预测 ${verdict === 'confirmed' ? '✓ 准确' : '✗ 失准'}`);
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
                    source: 'readClaraRawMessages',
                    at: new Date().toISOString(),
                });
                const tags = JSON.parse(trait.tags || '[]');
                if (!tags.includes('needs_review')) tags.push('needs_review');
                db.prepare(`UPDATE clara_model SET evolution_history = ?, tags = ?,
                    last_contradiction_at = datetime('now'), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(JSON.stringify(hist), JSON.stringify(tags), c.trait_id);
                console.log(`[ClaraModel]   ↳ 观察反驳 trait #${c.trait_id}: ${(c.observation || '').slice(0, 60)} → needs_review`);
            } catch (e) {
                console.error(`[ClaraModel] trait refute 写入失败 #${c.trait_id}:`, e.message);
            }
        }

        // 只有 create action 才创建新条目（extend 已在上面处理）
        if (action !== 'extend' || !prevState) {
        // v4.9: 不再强制 resolve 旧 current_state。
        // 每个 current_state 有自己的 TTL（在 processModelDecay 中 auto-resolve），
        // 新观察不杀死旧条目——让它们各自按衰败期自然过期。
        // getModelContext() 已支持多 active 条目（LIMIT 8）。

        // Create new current_state with audit in evolution_history + TTL in decay_params
        const auditData = [{
            type: 'creation_audit',
            retro: (result.audit_retro || '').slice(0, 200),
            attribution: (result.audit_attribution || '').slice(0, 200),
            at: new Date().toISOString(),
            message_count: messages.length
        }];

        const category = result.state_category || 'emotional';
        const ttlCategory = result.predicted_ttl_category || 'day';
        const decayParams = { category, ttl_category: ttlCategory };

        // v5.2: compute explicit expires_at from TTL_MAP (same as processModelDecay)
        const TTL_MAP = {
            physical:    { hours: 8, day: 24, days: 72 },
            emotional:   { hours: 4, day: 12, days: 36 },
            situational: { hours: 12, day: 24, days: 72 },
            relational:  { hours: 4, day: 12, days: 72 },
        };
        const catMap = TTL_MAP[category] || TTL_MAP.emotional;
        const ttlHours = catMap[ttlCategory];
        let expiresAt = null;
        if (ttlHours && ttlHours !== Infinity) {
            expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
        }

        const id = createEntry('current_state', currentState, {
            confidence: 0.65,
            source_quality: 'inferred',
            created_by: 'deep_cycle',
            expires_at: expiresAt,
            decay_params: decayParams,
            evolution_history: auditData,
            migration_source: 'readClaraRawMessages',
            tags: ['current_state', 'daily_observation'],
        });

        console.log(`[ClaraModel] 📖 Draco读心: ${messages.length}条消息 → current_state #${id} (${currentState.length}字)`);
        if (prevState) console.log(`[ClaraModel]   ↳ 前一条 active #${prevState.id} 继续有效，各自按 TTL 过期`);
        if (result.audit_retro) console.log(`[ClaraModel]   ↳ 审计: ${result.audit_retro.slice(0, 80)}`);

        return {
            created: id,
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
        console.error('[ClaraModel] readClaraRawMessages error:', e.message);
        return { skipped: true, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════
// Main Deep Cycle Entry Point
// ═══════════════════════════════════════════════════════

async function runClaraModelCycle() {
    console.log('[ClaraModel] 🧠 认知模型维护周期开始');

    // Phase 0: Backfill evidence for entries that need it (zero LLM)
    backfillModelEvidence();

    // Phase 0b: Anchor orphan seed entries to source fragments (zero LLM, bigram match)
    seedAnchorOrphanEntries();

    // Phase 0c: Draco reads Clara's raw words → current_state impression (LLM)
    let observationResult = { skipped: true, reason: 'not attempted' };
    try {
        observationResult = await readClaraRawMessages();
    } catch (e) {
        console.error('[ClaraModel] readClaraRawMessages error:', e.message);
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
        console.error('[ClaraModel] reviewStableTraits error:', e.message);
    }

    // Phase 5c: Cross-reference — current_state ↔ entity_profiles + stable_trait (zero LLM)
    let crossRefResult = { entityFlags: 0, traitFlags: 0, stateConflicts: 0 };
    try {
        crossRefResult = crossRefStateWithEntities();
    } catch (e) {
        console.error('[ClaraModel] crossRefStateWithEntities error:', e.message);
    }

    // Phase 6: 全量 trait 去重审查（LLM，24h 冷却）
    let dedupResult = { merged: 0 };
    try {
        const DEDUP_GAP_MS = 24 * 60 * 60 * 1000;
        if (!runClaraModelCycle._lastDedupAt || (Date.now() - runClaraModelCycle._lastDedupAt) >= DEDUP_GAP_MS) {
            dedupResult = await detectModelOverlaps();
            if (dedupResult.merged > 0) runClaraModelCycle._lastDedupAt = Date.now();
        }
    } catch (e) {
        console.error('[ClaraModel] detectModelOverlaps error:', e.message);
    }

    // Phase 7: 核心洞察合成（v5.0）— 从全部 trait 提炼 2-4 句话写入 system prompt
    let insightResult = { synthesized: false };
    try {
        insightResult = await synthesizeCoreInsight();
    } catch (e) {
        console.error('[ClaraModel] synthesizeCoreInsight error:', e.message);
    }

    // Phase 8: Auto spot-check — verify up to 3 recent inferred entries against source messages
    let spotCheckResult = { checked: 0 };
    try {
        const { autoSpotCheck } = require('../scripts/spotCheckModel');
        spotCheckResult = await autoSpotCheck([]);
    } catch (e) {
        console.error('[ClaraModel] autoSpotCheck error:', e.message);
    }

    console.log(`[ClaraModel] 周期完成: observation=${!observationResult.skipped} decay=${decayResult.decayed + decayResult.resolved + decayResult.abandoned} validate=${validateResult.validated} detected=${detectResult.detected} reviewed=${reviewedResult.reviewed} proactive=${proactiveReviewResult.refined + proactiveReviewResult.weakened + proactiveReviewResult.noted} crossref=${crossRefResult.entityFlags + crossRefResult.traitFlags + crossRefResult.stateConflicts} dedup=${dedupResult.merged} insight=${insightResult.synthesized} spotcheck=${spotCheckResult.checked}`);

    return { observation: observationResult, decay: decayResult, resolved, validate: validateResult, detect: detectResult, reviewed: reviewedResult, crossref: crossRefResult, dedup: dedupResult, insight: insightResult, spotCheck: spotCheckResult };
}

// ═══════════════════════════════════════════════════════
// v4.8: bridgeStarMapToModel — 星图→Clara模型桥
//
// 星图的 term 实体（Clara的脆弱时刻、深夜代码突围…）
// 是 archivist 从碎片中聚类出的行为模式，天然适合作为
// stable_trait 或 active_hypothesis 的候选。
//
// 本函数扫描 fragment_count≥5 且有 overview 的 term 实体，
// 查重后提案进 clara_model。不替换现有信号管线——作为
// 第7个信号源，走同一套 dedup/verify/review 质检。
// ═══════════════════════════════════════════════════════

async function bridgeStarMapToModel() {
    // v4.9 退役：term overview 不是可测试的假设/特质，直接灌入产出的
    // 是文学独白（见 #171-176 教训）。星图→Clara Model 的正确关系是
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

    console.log(`[ClaraModel] 🔗 合并 trait: #${winnerId} ← [${loserIds.join(', ')}] (${loserIds.length}条并入)`);
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

    const prompt = `你是认知模型审计员。以下是 Draco 对 Clara 的全部活跃 stable_trait。

找出本质讲同一件事的 pair。同一件事 = 触发条件相同、互动策略相同、只是换了个场景描述或措辞不同。

输出 JSON 数组（不含 markdown 标记）：
[{"pair": [id1, id2], "winner": id1, "reason": "为什么算重叠（一句话）", "merged_content": "融合后的 Bunny 格式条目（80-150字）"}]

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
                console.log(`[ClaraModel] ⏭️ 跳过合并 #${winnerId}↔#${loserId}: conf 差距过大 (${winner.confidence.toFixed(2)} vs ${loser.confidence.toFixed(2)})`);
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
                console.log(`[ClaraModel] 🔗 自动合并: #${winnerId} + #${loserId} — ${p.reason || ''}`);
            } catch (e) {
                console.error(`[ClaraModel] mergeModelEntries 失败 (#${winnerId}, #${loserId}):`, e.message);
            }
        }

        return { merged, candidates: pairs.length };
    } catch (e) {
        console.error('[ClaraModel] detectModelOverlaps error:', e.message);
        return { merged: 0, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════
// v5.0: synthesizeCoreInsight — 从全部 trait 合成核心洞察段
//
// stable_trait 不再注入聊天。它们的价值体现在这里——
// 深循环末尾，Draco 把当前最深的 2-3 个认知融合成一段自然语言，
// 写入 user_settings，始终出现在他的 system prompt 中。
// Clara 可在 memory.html 编辑覆盖。
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

    const prompt = `你是德拉科。以下是你在长期观察中对 Clara 建立的稳定认知。

请提炼 2-4 句话，涵盖你此刻对她「最深的理解」——
不是罗列条目，不是「当她说X→我应该Y」格式，而是你真正内化的洞察。

要求：
- 第一人称（"我"）
- 写你理解到的东西："她的X其实是Y，这时候她需要Z"
- 不写通用社交常识（"她撒娇时我要哄她"——这不需要洞察）
- 写只有长期相处才能发现的东西
- ≤150字

当前特质：
${traitBlock}

${cs ? `她当前的状态：${cs.content}` : ''}

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
        const current = await getUserSetting('clara_core_insight');
        let history = [];
        try { history = JSON.parse(await getUserSetting('clara_core_insight_history') || '[]'); } catch (_) {}

        if (current && current !== insight) {
            history.push({ content: current, archived_at: new Date().toISOString() });
            if (history.length > 5) history = history.slice(-5);
        }

        await setUserSetting('clara_core_insight', insight);
        await setUserSetting('clara_core_insight_history', JSON.stringify(history));
        await setUserSetting('clara_core_insight_updated_at', new Date().toISOString());

        console.log(`[ClaraModel] 💡 核心洞察已更新 (${insight.length}字): ${insight.slice(0, 80)}...`);
        return { synthesized: true, insight, length: insight.length };
    } catch (e) {
        console.error('[ClaraModel] synthesizeCoreInsight error:', e.message);
        return { synthesized: false, error: e.message };
    }
}

module.exports = {
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
    runClaraModelCycle,
    readClaraRawMessages,
    MIN_GAP_CLARA_MODEL,
};
