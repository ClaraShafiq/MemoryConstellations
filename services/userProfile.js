// services/userProfile.js
// v5.4 Phase 2b: User 画像组装
//
// 从认知模型中读取活跃条目，按分类组装为可注入 system prompt 的文本块。
// 替代 core-prompt.txt 中手动维护的 <用户核心信息>。

const { getDb } = require('../database');
const { fillPrompt, USER, AI } = require('./nameResolver');

// ── 分类标签 → 显示名称 ──
const CATEGORY_ORDER = [
    { key: 'basic',                label: '基本信息' },
    { key: 'personality',          label: '性格' },
    { key: 'career',               label: '职业' },
    { key: 'social',               label: '社交关系' },
    { key: 'preference',           label: '偏好' },
    { key: 'lifestyle',            label: '生活方式' },
    { key: 'health',               label: '健康' },
    { key: 'creative_work',        label: '创作' },
    { key: 'personal_history',     label: '过去经历' },
    { key: 'relationship_with_companion', label: '与伴侣的关系' },
    { key: 'finance',              label: '经济' },
    { key: 'communication',        label: '沟通风格' },
];

const SUB_TAGS = new Set([
    'identity','birth','appearance','education','mbti','core',
    'persistence','romantic','living','pets',
    'aesthetic','fandom','food','recent','hobbies','sleep','creative',
    'health_tech','home','bond','devotion','trauma','current',
]);

// ── Public API ──

/**
 * 组装 User 画像文本（用于注入 system prompt）
 * @param {number} maxTokens — 预算上限（估算）
 * @returns {string} 格式化的画像文本
 */
function assembleProfile(maxTokens = 500) {
    const db = getDb();
    const entries = db.prepare(`
        SELECT id, type, content, tags, confidence, source_quality,
               evidence_count, last_evidence_at, created_at
        FROM clara_model
        WHERE status = 'active'
          AND type IN ('stable_trait', 'immutable_fact')
          AND confidence >= 0.5
        ORDER BY priority DESC, confidence DESC, created_at
    `).all();

    if (!entries.length) return '';

    // Assign injection tiers
    for (const e of entries) {
        if ((e.source_diversity || 0) >= 5 && (e.evidence_count || 0) >= 30) {
            e.injection_tier = 'core';
        } else if ((e.source_diversity || 0) >= 3) {
            e.injection_tier = 'high';
        } else {
            e.injection_tier = 'normal';
        }
    }

    // Group by category
    const groups = {};
    for (const e of entries) {
        let tags = [];
        try { tags = typeof e.tags === 'string' ? JSON.parse(e.tags) : (e.tags || []); } catch(_) {}
        // Skip companion profile entries — they belong in persona_model, not the user's portrait
        if (tags.includes('companion_profile')) continue;
        // Skip companion's intuitive observations — personal intuitions, not objective user facts
        if (tags.includes('companion_intuition')) continue;
        const cat = _primaryCategory(tags);
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(e);
    }

    // Assemble text
    const lines = [];
    lines.push(`<User_profile>`);

    // Core traits first (铁证级 — 始终在伴侣视野中)
    const coreTraits = entries.filter(e => e.injection_tier === 'core');
    if (coreTraits.length > 0) {
        lines.push('\n[核心认知 — 以下条目经反复验证，置信度极高]');
        for (const e of coreTraits) {
            lines.push(`- ${e.content}`);
        }
    }

    for (const { key, label } of CATEGORY_ORDER) {
        const items = groups[key];
        if (!items || !items.length) continue;
        delete groups[key]; // mark as consumed

        // Don't repeat core traits in their category section
        const nonCore = items.filter(e => e.injection_tier !== 'core');
        if (!nonCore.length) continue;

        lines.push(`\n[${label}]`);
        for (const e of nonCore) {
            // Mark stale entries
            const staleMarker = _isStale(e) ? ' [可能过时]' : '';
            const tierMarker = e.injection_tier === 'high' ? ' ★' : '';
            lines.push(`- ${e.content}${tierMarker}${staleMarker}`);
        }

        // Early exit if approaching token budget
        if (lines.join('\n').length > maxTokens * 3) break;
    }

    // Any remaining categories not in CATEGORY_ORDER
    for (const [cat, items] of Object.entries(groups)) {
        if (!items || !items.length) continue;
        lines.push(`\n[${cat}]`);
        for (const e of items) {
            lines.push(`- ${e.content}${_isStale(e) ? ' [可能过时]' : ''}`);
        }
    }

    lines.push('</User_profile>');
    return lines.join('\n');
}

/**
 * 组装 User 画像 JSON（用于前端编辑器 API）
 * @returns {object} { groups: [{ category, label, entries: [...] }] }
 */
function assembleProfileJSON() {
    const db = getDb();
    const entries = db.prepare(`
        SELECT id, type, content, tags, confidence, source_quality,
               evidence_count, last_evidence_at, created_at, updated_at
        FROM clara_model
        WHERE status = 'active'
          AND type IN ('stable_trait', 'immutable_fact')
        ORDER BY priority DESC, confidence DESC, created_at
    `).all();

    const groups = {};
    for (const e of entries) {
        let tags = [];
        try { tags = typeof e.tags === 'string' ? JSON.parse(e.tags) : (e.tags || []); } catch(_) {}
        // Skip companion profile entries — they belong in persona_model, not the user's portrait
        if (tags.includes('companion_profile')) continue;
        // Skip companion's intuitive observations — personal intuitions, not objective user facts
        if (tags.includes('companion_intuition')) continue;
        const cat = _primaryCategory(tags);
        if (!groups[cat]) groups[cat] = { category: cat, label: _categoryLabel(cat), entries: [] };
        groups[cat].entries.push({
            id: e.id,
            type: e.type,
            content: e.content,
            tags,
            confidence: e.confidence,
            source_quality: e.source_quality,
            evidence_count: e.evidence_count,
            stale: _isStale(e),
            created_at: e.created_at,
            updated_at: e.updated_at,
        });
    }

    return { groups: Object.values(groups) };
}

// ── Helpers ──

function _primaryCategory(tags) {
    if (!Array.isArray(tags) || !tags.length) return 'other';
    // Find first tag that's a valid category (not a sub-tag)
    const cat = tags.find(t =>
        CATEGORY_ORDER.some(c => c.key === t) && !SUB_TAGS.has(t)
    );
    if (cat) return cat;
    // Fallback: first category-matching tag
    const anyCat = tags.find(t => CATEGORY_ORDER.some(c => c.key === t));
    return anyCat || tags[0] || 'other';
}

function _categoryLabel(key) {
    const found = CATEGORY_ORDER.find(c => c.key === key);
    return found ? found.label : key;
}

function _isStale(entry) {
    // Entries with no new evidence in 90+ days
    if (!entry.last_evidence_at) {
        // Check created_at instead
        if (!entry.created_at) return false;
        const created = new Date(entry.created_at);
        return (Date.now() - created) > 90 * 24 * 60 * 60 * 1000;
    }
    const last = new Date(entry.last_evidence_at);
    return (Date.now() - last) > 90 * 24 * 60 * 60 * 1000;
}

module.exports = { assembleProfile, assembleProfileJSON };
