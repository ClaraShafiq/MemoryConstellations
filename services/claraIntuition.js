// Clara Intuition — 上下文触发的认知直觉引擎
// ================================================================
// 替代 claraModel.getModelContext() 的「全量 dump」模式。
// 只在 Clara 的当前对话触发了某个行为模式时，才注入对应的直觉条目。
// 自包含模块，可插拔替换——开源后每个 user 可挂自己的直觉数据源。
//
// 分层触发规则：
//   current_state   → 始终注入（瞬时态，活在当下）
//   stable_trait    → 关键词命中（tags 字段）→ 直接触发；未命中 → bigram 兜底（阈值 5）
//   active_hypothesis → 同上
//   immutable_fact  → v4.8 退役（v4.6 设计，现 18 条已迁移分流）

const { getDb } = require('../database');
const { encryption } = require('../encryption');

// ── TTL helpers for current_state display ──
const TTL_LABELS = {
    hours: '几小时内', day: '今天内', days: '数天内', until_event: '持续中',
};

function formatTimeAgo(dateStr) {
    if (!dateStr) return '近期';
    const minutesAgo = Math.round((Date.now() - new Date(dateStr)) / (1000 * 60));
    if (minutesAgo < 60) return `${minutesAgo}分钟前`;
    const hoursAgo = Math.round(minutesAgo / 60);
    if (hoursAgo < 24) return `${hoursAgo}小时前`;
    const daysAgo = Math.round(hoursAgo / 24);
    return `${daysAgo}天前`;
}

function formatTtlHint(createdAt, decayParams) {
    const dp = decayParams || {};
    const ttlCat = dp.ttl_category;
    if (!createdAt || !ttlCat) return '';
    if (ttlCat === 'until_event') return '，持续中';
    const TTL_HOURS = { hours: 8, day: 24, days: 72 };
    const ttlHours = TTL_HOURS[ttlCat];
    if (!ttlHours) return '';
    const expiresAt = new Date(new Date(createdAt).getTime() + ttlHours * 60 * 60 * 1000);
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) return '，即将过期';
    const remainingH = Math.round(remainingMs / (1000 * 60 * 60));
    if (remainingH < 1) return '，约1小时内过期';
    if (remainingH < 24) return `，预计持续约${remainingH}小时`;
    const remainingD = Math.round(remainingH / 24);
    return `，预计持续约${remainingD}天`;
}

// ═══════════════════════════════════════════════════════════════
// Bigram tokenizer — 复用 anchorEntriesToFragments 同款算法
// ═══════════════════════════════════════════════════════════════

function tokenize(text) {
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

function bigramOverlap(entryContent, contextText) {
  const entryBigrams = new Set(tokenize(entryContent));
  const contextBigrams = tokenize(contextText);
  let overlap = 0;
  for (const bg of contextBigrams) {
    if (entryBigrams.has(bg)) overlap++;
  }
  return overlap;
}

// ═══════════════════════════════════════════════════════════════
// 触发判定：关键词优先 + bigram 兜底
// Layer 1 — tags 字段任一关键词出现在上下文中 → 直接触发
// Layer 2 — bigram 重叠 ≥ BIGRAM_THRESHOLD → 兜底触发
// ═══════════════════════════════════════════════════════════════

const BIGRAM_THRESHOLD = 5;

// ── 高频词停用表：Clara 日常说烂了的词不能当触发器 ──
// 「代码」「界面」「开源」这类词天天出现，挂上它们的条目等于永远激活，
// 直觉注入退化成全量 dump。由 Archivist 深循环统计近30天高频词维护
// （user_settings.intuition_stopwords），此处加载缓存 10 分钟。
let _stopwordsCache = null;
let _stopwordsCacheAt = 0;

function getIntuitionStopwords() {
  if (_stopwordsCache && Date.now() - _stopwordsCacheAt < 10 * 60 * 1000) return _stopwordsCache;
  try {
    const { getUserSetting } = require('../utils/settings');
    const raw = getUserSetting('intuition_stopwords');
    _stopwordsCache = new Set(JSON.parse(raw || '[]'));
  } catch (_) {
    _stopwordsCache = new Set();
  }
  _stopwordsCacheAt = Date.now();
  return _stopwordsCache;
}

function isTriggered(entry, contextText) {
  const stopwords = getIntuitionStopwords();
  // Layer 1: keyword hit — exact or partial (≥3 char substring of ≥4 char keywords)
  try {
    const tags = JSON.parse(entry.tags || '[]');
    if (tags.length > 0) {
      for (const tag of tags) {
        if (stopwords.has(tag)) continue; // 高频词不触发
        if (contextText.includes(tag)) return true;
        // Partial: for longer keywords, match 3-char substrings (handles "这个bug修完就睡" vs "这个bug修了一晚上")
        if (tag.length >= 4) {
          for (let i = 0; i <= tag.length - 3; i++) {
            const sub = tag.slice(i, i + 3);
            if (stopwords.has(sub)) continue;
            if (contextText.includes(sub)) return true;
          }
        }
      }
    }
  } catch (_) {}
  // Layer 2: bigram fallback for out-of-vocabulary expressions
  return bigramOverlap(entry.content, contextText) >= BIGRAM_THRESHOLD;
}

// ═══════════════════════════════════════════════════════════════
// 构建触发上下文：当前消息 + 最近 N 条对话
// ═══════════════════════════════════════════════════════════════

function buildContextText(userMessage, recentMsgCount = 10) {
  const db = getDb();
  const parts = [userMessage || ''];

  try {
    const recent = db.prepare(`
      SELECT sender, content, timestamp FROM messages
      WHERE status = 'sent' AND content IS NOT NULL AND content != ''
      ORDER BY timestamp DESC LIMIT ?
    `).all(recentMsgCount);

    for (const m of recent.reverse()) {
      let text = (m.content || '').slice(0, 200);
      if (text.startsWith('enc:')) {
        try { text = encryption.decrypt(text, { silent: true }); } catch (_) { text = ''; }
      }
      if (text) parts.push(text);
    }
  } catch (_) { /* DB unavailable — fall back to userMessage only */ }

  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// v5.2: 会话级实体缓存 — 30分钟滑动窗口
// Clara 提到千变慢慢 → 注入 overview → 缓存。下一条消息继续聊他
// 但没提名字 → overview 仍在。30分钟内无再次提及 → 过期清除。
// ═══════════════════════════════════════════════════════════════

const ENTITY_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
const _entityCache = new Map(); // entityId → {entity, injectedAt}

function _cleanEntityCache() {
    const now = Date.now();
    for (const [id, entry] of _entityCache) {
        if (now - entry.injectedAt > ENTITY_CACHE_TTL_MS) _entityCache.delete(id);
    }
}

function _getCachedEntities() {
    _cleanEntityCache();
    return [..._entityCache.values()].map(e => e.entity);
}

// ═══════════════════════════════════════════════════════════════
// Entity lookup helpers (reuse same logic as librarian.js)
// ═══════════════════════════════════════════════════════════════

function lookupEntitiesInMessage(userMessage) {
  const db = getDb();
  if (!userMessage || !userMessage.trim()) return [];
  const entities = db.prepare(`
    SELECT id, name, aliases, overview, overview_updated_at FROM entity_profiles
    WHERE name IS NOT NULL AND status IN ('active', 'seed')
      AND overview IS NOT NULL AND overview != ''
    ORDER BY fragment_count DESC
  `).all();

  const matched = [];
  const msgLower = userMessage.toLowerCase();
  for (const e of entities) {
    if (msgLower.includes(e.name.toLowerCase())) {
      matched.push(e);
      continue;
    }
    let aliasList = [];
    try { aliasList = JSON.parse(e.aliases || '[]'); } catch (_) {}
    if (aliasList.some(a => a && a.length >= 2 && msgLower.includes(a.toLowerCase()))) {
      matched.push(e);
    }
  }
  return matched.slice(0, 3); // max 3 entities to prevent token explosion
}

// ═══════════════════════════════════════════════════════════════
// 主入口：获取触发式直觉上下文
// ═══════════════════════════════════════════════════════════════

function getTriggeredIntuition(userMessage, maxTokens = 800) {
  const db = getDb();

  // v5.0: stable_trait + active_hypothesis 不再注入聊天。
  // 它们的价值体现在 core_insight（始终在 system prompt 中）+
  // deep cycle 的持续认知迭代。这里只保留 current_state。
  // v5.1: 新增 entity overview 注入——当 Clara 提到某人时，
  // 星座描述（替代旧冥想盆）自动出现在 Draco 的感知中。

  const states = db.prepare(`
    SELECT content, confidence, last_evidence_at, created_at, expires_at, decay_params, source_quality
    FROM clara_model
    WHERE type = 'current_state' AND status = 'active'
    ORDER BY last_evidence_at DESC LIMIT 8
  `).all();

  const matchedEntities = lookupEntitiesInMessage(userMessage);

  if (states.length === 0 && matchedEntities.length === 0) {
    return { text: '', signals: [] };
  }

  const lines = ['<clara_intuition>',
    '（你此刻感知到的Clara的状态——不是推理，是观察。）',
    ''];

  // ── 当前状态（含 TTL 提示）──
  if (states.length > 0) {
    lines.push('● 当前状态：');
    for (const s of states) {
      const ago = formatTimeAgo(s.last_evidence_at);
      // v5.0: prefer explicit expires_at over legacy TTL calculation
      let ttlHint = '';
      if (s.expires_at) {
        const remainingMs = new Date(s.expires_at) - Date.now();
        if (remainingMs <= 0) {
          ttlHint = '，已过期';
        } else {
          const remainingH = Math.round(remainingMs / (1000 * 60 * 60));
          if (remainingH < 1) ttlHint = '，即将过期';
          else if (remainingH < 24) ttlHint = `，约${remainingH}h后过期`;
          else ttlHint = `，约${Math.round(remainingH/24)}d后过期`;
        }
      } else {
        // Legacy fallback
        const dp = (() => { try { return JSON.parse(s.decay_params || '{}'); } catch (_) { return {}; } })();
        ttlHint = formatTtlHint(s.created_at, dp);
      }
      lines.push(`- ${s.content}（${ago}更新${ttlHint}）`);
    }
    lines.push('');
  }

  // ── v5.2: 星座描述 — 新匹配 + 缓存合并 ──
  const cachedEntities = _getCachedEntities();
  const allEntities = [...matchedEntities];
  // Add cached entities that weren't newly matched
  for (const ce of cachedEntities) {
    if (!allEntities.find(e => e.id === ce.id)) {
      allEntities.push(ce);
    }
  }
  // Update cache with newly matched entities
  const now = Date.now();
  for (const e of matchedEntities) {
    _entityCache.set(e.id, { entity: e, injectedAt: now });
  }

  if (allEntities.length > 0) {
    lines.push('● 相关的星座（你记忆中关于这些人/事的总览）：');
    for (const e of allEntities.slice(0, 5)) {
      const cached = _entityCache.has(e.id) && !matchedEntities.find(m => m.id === e.id);
      const updatedAgo = e.overview_updated_at
        ? Math.round((Date.now() - new Date(e.overview_updated_at)) / (1000*60*60*24))
        : null;
      const freshness = cached ? '（从缓存保留）'
        : updatedAgo !== null && updatedAgo > 3 ? `（${updatedAgo}天前更新）`
        : '';
      lines.push(`◇ ${e.name}：${e.overview}${freshness}`);
    }
    lines.push('');
  }

  // ── v5.2: 观察到的模式（日积月累的行为观察，话题触发）──
  const patterns = db.prepare(`
    SELECT content, evidence_count, first_seen, last_seen, confidence, tags, strategy
    FROM clara_patterns WHERE status = 'active'
    ORDER BY confidence DESC LIMIT 15
  `).all();

  if (patterns.length > 0 && userMessage) {
    const msgBigrams = (() => {
      const segs = (userMessage || '').replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(s => s.length >= 2);
      const set = new Set();
      for (const seg of segs) { for (let i = 0; i < seg.length - 1; i++) set.add(seg.slice(i, i + 2)); }
      return set;
    })();

    const triggered = [];
    for (const p of patterns) {
      if (triggered.length >= 3) break;
      const pTags = (() => { try { return JSON.parse(p.tags || '[]'); } catch(_) { return []; } })();
      const tagText = p.content + ' ' + pTags.join(' ');
      const pBigrams = new Set();
      const pWords = tagText.replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(s => s.length >= 2);
      for (const seg of pWords) { for (let i = 0; i < seg.length - 1; i++) pBigrams.add(seg.slice(i, i + 2)); }
      let overlap = 0;
      for (const bg of msgBigrams) { if (pBigrams.has(bg)) overlap++; }
      if (overlap >= 3) {
        const spanMonths = p.first_seen && p.last_seen
          ? Math.round((new Date(p.last_seen) - new Date(p.first_seen)) / (1000 * 60 * 60 * 24 * 30))
          : 0;
        const spanLabel = spanMonths > 0 ? `，跨${spanMonths}个月` : '';
        let patternLine = `◇ ${p.content}（${p.evidence_count}次观察${spanLabel}）`;
        if (p.strategy) patternLine += `\n   → ${p.strategy}`;
        lines.push(patternLine);
        triggered.push(p);
      }
    }
    if (triggered.length > 0) lines.push('');
  }

  lines.push('</clara_intuition>');

  const fullText = lines.join('\n');
  const estimatedTokens = Math.ceil(fullText.length / 1.5);

  if (estimatedTokens <= maxTokens) return { text: fullText, signals: [] };

  // 超预算：保留 current_state + 缩减 entity overview
  const slim = ['<clara_intuition>',
    '（你此刻感知到的Clara的状态——不是推理，是观察。）',
    ''];
  if (states.length > 0) {
    slim.push('● 当前状态：');
    for (const s of states) {
      slim.push(`- ${s.content}`);
    }
    slim.push('');
  }
  if (matchedEntities.length > 0) {
    slim.push('● 相关的星座：');
    for (const e of matchedEntities) {
      slim.push(`◇ ${e.name}：${e.overview.slice(0, 200)}`);
    }
    slim.push('');
  }
  slim.push('</clara_intuition>');
  return { text: slim.join('\n'), signals: [] };
}

// ═══════════════════════════════════════════════════════════════
// 调试：全量 dump（保留兼容，供 memory.html / 手动检查用）
// ═══════════════════════════════════════════════════════════════

function getFullModel() {
  const db = getDb();
  return {
    facts: db.prepare("SELECT * FROM clara_model WHERE type='immutable_fact' AND status='active' ORDER BY confidence DESC").all(),
    traits: db.prepare("SELECT * FROM clara_model WHERE type='stable_trait' AND status='active' ORDER BY confidence DESC").all(),
    states: db.prepare("SELECT * FROM clara_model WHERE type='current_state' AND status='active' ORDER BY last_evidence_at DESC").all(),
    hyps: db.prepare("SELECT * FROM clara_model WHERE type='active_hypothesis' AND status='active' ORDER BY confidence DESC").all(),
  };
}

module.exports = { getTriggeredIntuition, getFullModel };
