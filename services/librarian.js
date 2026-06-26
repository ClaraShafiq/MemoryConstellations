const { getDb } = require('../database');
const { encryption } = require('../encryption');
const { AI } = require('./nameResolver');

// ── 检索排除源（从 memory_config.json 读取）──
const EXCLUDED_SOURCES = (() => {
    try {
        const cfg = require('../memory_config.json');
        if (cfg.librarian?.exclude_sources && Array.isArray(cfg.librarian.exclude_sources)) {
            return cfg.librarian.exclude_sources.filter(s => typeof s === 'string');
        }
    } catch (_) {}
    return [];
})();
const EXCLUDE_SOURCE_SQL = EXCLUDED_SOURCES.length > 0
    ? `AND mf.source NOT IN (${EXCLUDED_SOURCES.map(() => '?').join(',')})`
    : '';
const EXCLUDE_SOURCE_PARAMS = EXCLUDED_SOURCES;

// 时间衰减：半衰期由 emotional_weight 决定
// ew ≥ 0.8 → λ=0.005 (140天半衰期)  重要记忆持久
// ew ≥ 0.6 → λ=0.01  (70天半衰期)   标准
// ew ≥ 0.4 → λ=0.02  (35天半衰期)   轻度记忆较快消退
// ew  < 0.4 → λ=0.04  (17天半衰期)   琐碎信息快速沉底
function getDecayLambda(emotionalWeight) {
  const ew = emotionalWeight || 0.5;
  if (ew >= 0.8) return 0.005;
  if (ew >= 0.6) return 0.01;
  if (ew >= 0.4) return 0.02;
  return 0.04;
}

// 分段衰减（Ombre Brain 启发）：前3天新鲜度主导，3天后情绪强度主导
// 短线：timeWeight=0.7 emotionWeight=0.3 → 新鲜事优先浮现
// 长线：timeWeight=0.3 emotionWeight=0.7 → 高ew记忆顽强存活，低ew琐碎快速沉底
const STM_TIME_WEIGHT = 0.7;     // ≤3天：时间新鲜度权重
const LTM_EMOTION_WEIGHT = 0.7;  // >3天：情绪强度权重
const SEGMENT_DAYS = 3;          // 分段切换天数

function segmentedDecay(days, emotionalWeight) {
  const ew = emotionalWeight || 0.5;
  const lambda = getDecayLambda(ew);
  // 纯时间衰减
  const timeDecay = Math.exp(-lambda * days);
  // 情绪保留：越高ew记忆越不容易被时间冲淡
  const emotionRetention = 0.3 + ew * 0.7;

  if (days <= SEGMENT_DAYS) {
    // 短期：新鲜度为王。近期发生的事即使分量轻也值得浮现
    return STM_TIME_WEIGHT * timeDecay + (1 - STM_TIME_WEIGHT) * emotionRetention;
  }
  // 长期：情绪接管。3天后时间不再是最重要的——ew=0.8的记忆可能比ew=0.3的存活长4倍
  return (1 - LTM_EMOTION_WEIGHT) * timeDecay + LTM_EMOTION_WEIGHT * emotionRetention;
}

// 召回分数底线：低于此值的碎片不返回（被衰减+低权重自然淘汰）
// YantrikDB 思路：召回端多道关卡，信号弱时宁可空返回也不塞噪音
const MIN_COMBINED_SCORE = 0.005;   // 综合分底线（0.002→0.005，过滤弱关联）
const VEC_SIMILARITY_FLOOR = 0.22;  // 向量结果相似度地板，低于此值不进RRF
const EPISODE_BOOST = 1.5;          // EbbingFlow思路：整合过的episode权重高于原始碎片
const FTS5_ONLY_PENALTY = 0.7;      // FTS5单字匹配无向量交叉验证 → 降权（CJK单字索引太松）

// 新颖度惩罚：被访问越多次的碎片越往后让，防止通用碎片污染所有查询
// read_count=0→1.0, 35→0.46, 100→0.33, 500→0.27, 1000→0.25
// 真正的通用碎片(500+)受影响较大，一般热门(100-)不误伤
function noveltyPenalty(readCount) {
  if (!readCount || readCount <= 1) return 1.0;
  return 1 / (1 + Math.log10(readCount + 1));
}

function daysAgo(dateLabel) {
  if (!dateLabel) return 365;
  try {
    const d = new Date(dateLabel);
    if (isNaN(d.getTime())) return 365;
    return Math.max(0, (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  } catch { return 365; }
}

// ── 实体聚合辅助：从用户消息中识别已知实体 → 按 entity_id 全量捞碎片 ──
// 实体名缓存：30秒TTL，避免每次检索都全表扫描 entity_profiles
let _entityCache = null;
let _entityCacheAt = 0;
const ENTITY_CACHE_TTL = 30 * 1000;

function lookupEntityIds(userMessage) {
    const now = Date.now();
    if (!_entityCache || now - _entityCacheAt > ENTITY_CACHE_TTL) {
        const db = getDb();
        _entityCache = db.prepare(`
            SELECT id, name, aliases FROM entity_profiles
            WHERE name IS NOT NULL AND status IN ('active','seed')
        `).all();
        _entityCacheAt = now;
    }

    const ids = [];
    const msgLower = userMessage.toLowerCase();
    for (const e of _entityCache) {
        // 标准名匹配
        if (msgLower.includes(e.name.toLowerCase())) {
            ids.push(e.id);
            continue;
        }
        // 别名匹配
        let aliasList = [];
        try { aliasList = JSON.parse(e.aliases || '[]'); } catch (_) {}
        if (aliasList.some(a => a && a.length >= 2 && msgLower.includes(a.toLowerCase()))) {
            ids.push(e.id);
        }
    }
    return ids;
}

function getEntityFragments(entityIds, limit = 10) {
    if (!entityIds || entityIds.length === 0) return [];
    const db = getDb();
    const placeholders = entityIds.map(() => '?').join(',');
    // v5.0 fix: use fragment_entities junction table (canonical source),
    // not memory_fragments.entity_id (which is mostly NULL)
    return db.prepare(`
        SELECT mf.id, mf.content, mf.emotional_weight, mf.source_date AS date_label,
               mf.created_at, mf.read_count, mf.layer, fe.entity_id,
               'fragment' AS source_table
        FROM memory_fragments mf
        JOIN fragment_entities fe ON fe.fragment_id = mf.id
        WHERE fe.entity_id IN (${placeholders})
          AND mf.status = 'active'
        ORDER BY mf.created_at DESC
        LIMIT ?
    `).all(...entityIds, limit);
}

// =================================================================
// 意图路由：规则分类查询意图（ebbingflow 同款方案）
// 优先级：fact > long_term > summary → 默认 semantic
// =================================================================

function classifyIntent(userMessage) {
  const q = (userMessage || '').trim();
  if (!q) return 'semantic';

  // Long-term: 跨会话、长期记忆回溯（优先于fact——"以前看过什么书"是记忆回溯而非事实查询）
  const longTermMarkers = ['之前', '以前', '上次', '那次', '曾经', '长期', '一直', '还记得', '主线', '脉络'];
  if (longTermMarkers.some(m => q.includes(m))) {
    return 'long_term';
  }

  // Summary: 近期总结、状态回顾
  const summaryMarkers = ['最近', '这段时间', '这阵子', '近来', '进展', '总结', '回顾', '我们聊了什么'];
  if (summaryMarkers.some(m => q.includes(m))) {
    return 'summary';
  }

  // Fact: 精确事实查询（数字、时间、地点、价格等）——排在long_term/summary之后，避免误吞记忆回溯类查询
  const factMarkers = [
    '多少', '哪里', '什么时候', '谁', '有没有', '电话', '地址', '日期',
    '几点', '哪个', '多少钱', '为什么', '怎么', '什么'
  ];
  const numericFactRe = /\d+\s*(元|块|万|亿|%|岁|年|月|日|号|点|分钟|小时|天|个)/;
  if (factMarkers.some(m => q.includes(m)) || numericFactRe.test(q)) {
    return 'fact';
  }

  return 'semantic';
}

// 按空格/标点分词，过滤虚词和单字
function tokenize(userMessage) {
  if (!userMessage) return [];
  const stopWords = new Set(['的', '了', '在', '是', '我', '你', '他', '她', '它', '们', '和', '与', '或', '但', '而', '也', '都', '就', '把', '被', '让', '给', '从', '到', '对', '为', '以', '及', '等', '这', '那', '有', '没', '不', '很', '太', '更', '最', '会', '能', '要', '想', '说', '去', '来', '看', '做', '用', '中', '上', '下', '里', '外']);
  return userMessage.trim()
    .split(/[\s,，。.！!？?、；;：:\n\r]+/)
    .filter(t => t.length >= 2 && !stopWords.has(t));
}

// CJK单字分割（给memory_fragments_fts用，它的索引是单字粒度）
function tokenizeCJK(userMessage) {
  const wordTokens = tokenize(userMessage);
  const cjkRe = /[一-鿿㐀-䶿]/g;
  const tokens = [];
  for (const t of wordTokens) {
    const chars = t.match(cjkRe);
    if (chars) {
      for (const ch of chars) tokens.push(ch);
    } else {
      tokens.push(t);
    }
  }
  return tokens;
}

function searchFragments(userMessage, limit = 8) {
  if (!userMessage || userMessage.trim().length === 0) return [];

  try {
    const db = getDb();
    const results = [];

    // 查 memory_fragments — CJK单字粒度索引
    const cjkTokens = tokenizeCJK(userMessage);
    if (cjkTokens.length > 0) {
      try {
        const matchStr = cjkTokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
        const rows = db.prepare(`
          SELECT mf.id, mf.content, mf.emotional_weight AS weight,
                 mf.source_date AS date_label, mf.created_at,
                 mf.read_count, mf.layer,
                 'fragment' AS source_table,
                 rank
          FROM memory_fragments_fts fts
          JOIN memory_fragments mf ON mf.id = fts.rowid
          WHERE memory_fragments_fts MATCH ?
            AND mf.status = 'active'
            ${EXCLUDE_SOURCE_SQL}
          ORDER BY rank
          LIMIT ?
        `).all(matchStr, ...EXCLUDE_SOURCE_PARAMS, limit);
        results.push(...rows);
      } catch(e) {
        console.error('Librarian memory_fragments查询失败:', e.message);
      }
    }

    // v5.3: 重新启用 episode（memories 表）FTS5 检索
    // v5.0 退役旧冥想盆是因为 episode 来源（旧知识树）已废弃
    // v5.3 consolidateCategory 改为从 entity_profiles 星座产出，episode 质量可靠
    const wordTokens = tokenize(userMessage);
    if (wordTokens.length > 0) {
      try {
        const matchStr = wordTokens.map(t => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
        const rows = db.prepare(`
          SELECT m.id, m.title AS content, (m.weight / 10.0) AS weight,
                 m.valid_from AS date_label, m.created_at,
                 m.layer,
                 'memory' AS source_table,
                 rank
          FROM memories_fts fts
          JOIN memories m ON m.id = fts.rowid
          WHERE memories_fts MATCH ?
            AND m.layer = 'episode'
            AND m.status = 'permanent'
          ORDER BY rank
          LIMIT ?
        `).all(matchStr, limit);
        results.push(...rows);
      } catch(e) {
        console.error('Librarian memories查询失败:', e.message);
      }
    }

    // 合并去重，按 FTS5 rank（相关性）为主、weight 为次，取前limit条
    const seen = new Set();
    return results
      .filter(r => {
        const key = `${r.source_table}-${r.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (a.rank || 0) - (b.rank || 0))   // FTS5 rank: 越小越相关
      .slice(0, limit);

  } catch(e) {
    console.error('Librarian查询失败:', e.message);
    return [];
  }
}

function formatForContext(fragments) {
  if (!fragments || fragments.length === 0) return null;

  const db = getDb();
  const incRead = db.prepare("UPDATE memory_fragments SET read_count = COALESCE(read_count, 0) + 1, last_accessed_at = datetime('now') WHERE id = ?");
  const touchMemory = db.prepare("UPDATE memories SET last_accessed_at = datetime('now') WHERE id = ?");

  const lines = fragments.map(f => {
    const date = f.date_label ? `(${f.date_label})` : '';
    const preview = f.content ? f.content.slice(0, 30) : '';
    console.log(`Librarian命中: [#${f.id}/${f.source_table}] ${preview}...`);

    if (f.source_table === 'fragment') {
      try { incRead.run(f.id); } catch (e) { console.error(`Librarian: read_count更新失败 #${f.id}:`, e.message); }
    } else if (f.source_table === 'memory') {
      try { touchMemory.run(f.id); } catch (e) { console.error(`Librarian: last_accessed更新失败 #${f.id}:`, e.message); }
      try { f.content = encryption.decrypt(f.content); } catch (_) {}
    }

    return `- ${f.content} ${date}`.trim();
  });

  return `※ ${AI.name}的记忆碎片\n${lines.join('\n')}`;
}

// =================================================================
// 混合检索：FTS5（关键词）+ 向量（语义），RRF 融合
// =================================================================

async function searchHybrid(userMessage, limit = 6) {
  if (!userMessage || userMessage.trim().length === 0) return [];

  // 话题工作记忆 Boost
  let boostMap = new Map();
  try {
    const { getBoostMap } = require('./workingMemory');
    boostMap = await getBoostMap(userMessage);
  } catch (e) {
    console.error('Hybrid: workingMemory boost failed:', e.message);
  }

  // 意图路由：分类查询意图，调整后续检索权重
  const intent = classifyIntent(userMessage);
  if (intent !== 'semantic') {
    console.log(`Hybrid: 意图路由 → ${intent} (query: "${userMessage.slice(0, 50)}")`);
  }

  // 1. FTS5 关键词检索（同步）
  const ftsResults = searchFragments(userMessage, limit);

  // 1.5 实体聚合：识别消息中的已知实体 → 按 entity_id 全量捞碎片（实体时间线）
  const entityIds = lookupEntityIds(userMessage);
  const entityResults = entityIds.length > 0 ? getEntityFragments(entityIds, limit) : [];
  if (entityResults.length > 0) {
    console.log(`Hybrid: 实体聚合命中 ${entityResults.length} 条 (entity_ids=${entityIds.join(',')}) → "${userMessage.slice(0, 40)}"`);
  }

  // 2. 向量语义检索（异步）
  let vecResults = [];
  try {
    const { searchMemoriesByVector } = require('./memory');
    vecResults = await searchMemoriesByVector(userMessage, limit);
  } catch (e) {
    console.error('Hybrid: vector search failed:', e.message);
  }

  // 向量相似度地板：弱关联不进RRF（YantrikDB思路——信号弱则不参与融合）
  const filteredVec = vecResults.filter(v => (v._similarity || 0) >= VEC_SIMILARITY_FLOOR);
  if (filteredVec.length < vecResults.length) {
    console.log(`Hybrid: 向量地板过滤 ${vecResults.length - filteredVec.length}/${vecResults.length} 条弱结果 (sim<${VEC_SIMILARITY_FLOOR})`);
  }

  // 3. RRF 融合
  const kRRF = 60;
  const rrfScores = new Map();
  const itemMap = new Map();

  // 添加 FTS5 排名（意图权重调整）
  const ftsWeight = intent === 'fact' ? 1.5 : intent === 'summary' ? 0.6 : intent === 'long_term' ? 0.7 : 1.0;
  ftsResults.forEach((item, rank) => {
    const key = `${item.source_table}-${item.id}`;
    const rrf = 1 / (kRRF + rank + 1);
    rrfScores.set(key, (rrfScores.get(key) || 0) + rrf * ftsWeight);
    if (!itemMap.has(key)) {
      itemMap.set(key, {
        ...item,
        emotional_weight: item.weight || 0.5,
        _created_at: item.created_at || '',
        _read_count: item.read_count || 0,
      });
    }
  });

  // 添加实体聚合排名（固定中位 RRF，约等于 FTS5 rank 3-5）
  // 实体时间线是"关于这个人的所有碎片"，不是语义匹配——给中等权重，不冲淡主检索
  const ENTITY_RRF_RANK = 4;  // 虚拟排名，rrf = 1/(60+4+1) ≈ 0.015
  entityResults.forEach((item, i) => {
    const key = `${item.source_table}-${item.id}`;
    const rrf = 1 / (kRRF + ENTITY_RRF_RANK + i);
    rrfScores.set(key, (rrfScores.get(key) || 0) + rrf);
    if (!itemMap.has(key)) {
      itemMap.set(key, {
        id: item.id,
        content: item.content,
        weight: item.emotional_weight || 0.5,
        date_label: item.date_label || '',
        source_table: item.source_table,
        _similarity: 0,
        emotional_weight: item.emotional_weight || 0.5,
        _created_at: item.created_at || '',
        _read_count: item.read_count || 0,
        _entity_id: item.entity_id,
      });
    }
  });

  // 添加向量排名（意图权重调整 + episode加权）
  const episodeBoost = intent === 'summary' || intent === 'long_term' ? 2.0 : intent === 'fact' ? 1.0 : EPISODE_BOOST;
  const vecWeight = intent === 'summary' ? 1.4 : intent === 'long_term' ? 1.3 : intent === 'fact' ? 0.5 : 1.0;
  filteredVec.forEach((item, rank) => {
    const sourceTable = item._table === 'fragments' ? 'fragment' : 'memory';
    const key = `${sourceTable}-${item.id || item.memory_id}`;
    let rrf = 1 / (kRRF + rank + 1);
    if (sourceTable === 'memory') rrf *= episodeBoost;  // episode 加权
    rrfScores.set(key, (rrfScores.get(key) || 0) + rrf * vecWeight);
    if (!itemMap.has(key)) {
      itemMap.set(key, {
        id: item.id,
        content: item.content || item.title,
        weight: item._similarity || 0,
        date_label: item.source_date || item.valid_from || '',
        source_table: sourceTable,
        _similarity: item._similarity || 0,
        emotional_weight: item.emotional_weight || 0.5,
        _created_at: item.created_at || '',
        _read_count: item.read_count || 0,
      });
    } else {
      const existing = itemMap.get(key);
      existing._similarity = item._similarity || existing._similarity || 0;
      if (!existing._read_count && item.read_count) {
        existing._read_count = item.read_count;
      }
      if (!existing.emotional_weight || existing.emotional_weight === 0.5) {
        existing.emotional_weight = item.emotional_weight || 0.5;
      }
      if (!existing._created_at) {
        existing._created_at = item.created_at || '';
      }
    }
  });

  // 如果没有任何结果通过质量关卡，返回空（YantrikDB思路——宁可空返回）
  if (rrfScores.size === 0) {
    console.log('Hybrid: 无结果通过质量关卡，返回空');
    return [];
  }

  // 按 RRF 分数降序排列
  const ranked = Array.from(rrfScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, rrf]) => {
      const item = itemMap.get(key);
      const ftsRank = ftsResults.findIndex(f => `${f.source_table}-${f.id}` === key);
      const vecRank = filteredVec.findIndex(v => {
        const vt = v._table === 'fragments' ? 'fragment' : 'memory';
        return `${vt}-${v.id}` === key;
      });

      const isEntity = item._entity_id != null;

      let confidence = 'low';
      if (ftsRank >= 0 && vecRank >= 0) confidence = 'high';
      else if (item._similarity > 0.35) confidence = 'high';
      else if (rrf > 0.015 || item._similarity > 0.2) confidence = 'medium';
      else if (isEntity) confidence = 'medium';  // 实体聚合——确定性高但不是语义匹配
      else confidence = 'low';

      let source = ftsRank >= 0 && vecRank >= 0 ? 'BOTH'
        : isEntity && ftsRank >= 0 ? 'ENTITY+FTS5'
        : isEntity && vecRank >= 0 ? 'ENTITY+VEC'
        : isEntity ? 'ENTITY'
        : ftsRank >= 0 ? 'FTS5' : 'VEC';
      // FTS5单字索引太松散，无向量交叉验证 → 降权
      // CJK单字匹配噪音大（"猫"命中所有提到猫的碎片），fact意图同样需要控制
      if (source === 'FTS5') {
        rrf *= FTS5_ONLY_PENALTY;
        source = 'FTS5*';
      }
      return { ...item, _rrf: rrf, _confidence: confidence, _source: source };
    });

  // 时间衰减（分段：前3天新鲜度主导，3天后情绪主导）+ 重要性 + 新颖度
  const decayed = ranked.map(item => {
    const dateForDecay = item._created_at || item.date_label;
    const days = daysAgo(dateForDecay);
    const ew = item.emotional_weight || 0.5;
    const actualDays = intent === 'long_term' ? days * 0.4 : days;  // long_term 意图下时间走得慢
    const decay = segmentedDecay(actualDays, ew);
    const importance = 0.4 + ew * 0.6;
    const novelty = noveltyPenalty(item._read_count || 0);
    const wmBoost = boostMap.get(`${item.source_table}-${item.id}`) || 1.0;
    const combinedScore = item._rrf * decay * importance * novelty * wmBoost;
    return { ...item, _rrf: combinedScore, _decay: decay, _importance: importance, _novelty: novelty, _daysAgo: Math.round(days), _wmBoost: wmBoost };
  })
  .filter(item => item._rrf >= MIN_COMBINED_SCORE)
  .sort((a, b) => b._rrf - a._rrf);

  // 直接取 top-N，不强制保留向量结果（让质量说话，不做多样性配额）
  const finalResults = decayed.slice(0, limit);

  // 随机浮现（Ombre Brain 启发）：检索结果太少时，偶尔「突然想起」无关的旧事
  // 让从未被召回过的记忆也有机会浮出水面，模拟真人没来由的联想
  if (finalResults.length < 3 && Math.random() < 0.4) {
    try {
      const db = getDb();
      const floatCount = Math.min(3 - finalResults.length, 3);
      const floatFrags = db.prepare(`
        SELECT mf.id, mf.content, mf.emotional_weight, mf.source_date AS date_label,
               mf.created_at, mf.read_count, mf.layer, 'fragment' AS source_table
        FROM memory_fragments mf
        WHERE mf.status = 'active'
          AND (mf.read_count IS NULL OR mf.read_count = 0)
          AND mf.created_at < datetime('now', '-3 days')
        ORDER BY RANDOM()
        LIMIT ?
      `).all(floatCount);

      for (const f of floatFrags) {
        const daysOld = daysAgo(f.created_at);
        const ew = f.emotional_weight || 0.5;
        finalResults.push({
          ...f,
          weight: ew,
          _rrf: 0.002,  // 极低分，排在最后但不触发MIN_COMBINED_SCORE过滤
          _confidence: 'low',
          _source: 'FLOAT',
          _isFloated: true,
          _daysOld: Math.round(daysOld),
        });
      }

      if (floatFrags.length > 0) {
        const previews = floatFrags.map(f => f.content.slice(0, 30)).join(' | ');
        console.log(`Hybrid: 随机浮现 ${floatFrags.length} 条旧碎片 (${previews})`);
      }
    } catch (e) {
      console.error('Hybrid: 随机浮现查询失败:', e.message);
    }
  }

  // Filter excluded sources (e.g. music fragments — config in memory_config.json)
  if (EXCLUDED_SOURCES.length > 0) {
    const db2 = getDb();
    const fragIds = finalResults.filter(r => r.source_table === 'fragment').map(r => r.id);
    if (fragIds.length > 0) {
      const placeholders = fragIds.map(() => '?').join(',');
      const excludedFragIds = new Set(
        db2.prepare(`SELECT id FROM memory_fragments WHERE id IN (${placeholders}) AND source IN (${EXCLUDED_SOURCES.map(() => '?').join(',')})`)
          .all(...fragIds, ...EXCLUDED_SOURCES)
          .map(r => r.id)
      );
      const before = finalResults.length;
      const filtered = finalResults.filter(r => r.source_table !== 'fragment' || !excludedFragIds.has(r.id));
      if (filtered.length < before) {
        console.log(`Hybrid: 排除源过滤 ${before - filtered.length} 条 (${EXCLUDED_SOURCES.join(',')})`);
      }
      return filtered;
    }
  }

  return finalResults;
}

// 分类过滤的混合检索：在指定本体论类别内做语义搜索
async function searchHybridWithCategory(userMessage, categoryId, limit = 8) {
  const results = await searchHybrid(userMessage, limit * 2);
  const db = getDb();

  const catFragments = db.prepare(`
    WITH RECURSIVE subcats AS (
      SELECT id FROM memory_ontology WHERE id = ?
      UNION ALL
      SELECT o.id FROM memory_ontology o
      JOIN subcats s ON o.parent_id = s.id
    )
    SELECT fragment_id FROM fragment_categories
    WHERE category_id IN (SELECT id FROM subcats)
  `).all(categoryId);

  const catIdSet = new Set(catFragments.map(r => r.fragment_id));
  // 过滤：fragment需要在类别内，memory(episode)无法按fragment_id匹配，全部放行
  // 注意：放行的episode未经过分类过滤。如果memories表以后加了entity_id列，这里可以收紧。
  return results.filter(r =>
    r.source_table === 'memory' || (r.source_table === 'fragment' && catIdSet.has(r.id))
  ).slice(0, limit);
}

// 计算引用权限（确定性规则，不依赖 LLM）
function computePermission(f) {
  const days = f._daysAgo ?? f._daysOld ?? 999;
  const conf = f._confidence || 'low';
  const src = f._source || '?';

  if (f._isFloated) return '仅联想';
  if (days >= 90) return '仅联想';
  if (conf === 'low') return '仅联想';
  if (conf === 'high' && days < 30 && src === 'BOTH') return '可引用';
  // medium confidence, or 30-90 days, or single-source
  return '需谨慎';
}

function formatHybridContext(fragments) {
  if (!fragments || fragments.length === 0) return null;

  const db = getDb();
  const incRead = db.prepare("UPDATE memory_fragments SET read_count = COALESCE(read_count, 0) + 1, last_accessed_at = datetime('now') WHERE id = ?");
  const touchMemory = db.prepare("UPDATE memories SET last_accessed_at = datetime('now') WHERE id = ?");

  const lines = fragments.map(f => {
    const permission = computePermission(f);
    const days = f._daysAgo ?? f._daysOld;
    const daysStr = days != null ? `${days}天前` : '?';
    const preview = f.content ? f.content.slice(0, 30) : '';
    const srcTag = f._isFloated ? '[FLOAT]'
        : f._source === 'BOTH' ? '[BOTH]'
        : f._source === 'ENTITY+FTS5' ? '[ENT+FTS]'
        : f._source === 'ENTITY+VEC' ? '[ENT+VEC]'
        : f._source === 'ENTITY' ? '[ENTITY]'
        : f._source === 'FTS5' ? '[FTS5]'
        : f._source === 'FTS5*' ? '[FTS5*]'
        : '[VEC]';
    const ew = f.emotional_weight != null ? f.emotional_weight.toFixed(1) : '?';

    console.log(`Hybrid命中: [#${f.id}/${f.source_table}] ${srcTag} ew=${ew} ${daysStr} [${permission}] ${preview}...`);

    if (f.source_table === 'fragment') {
      try { incRead.run(f.id); } catch (e) { console.error(`Librarian: read_count更新失败 #${f.id}:`, e.message); }
    } else if (f.source_table === 'memory') {
      try { touchMemory.run(f.id); } catch (e) { console.error(`Librarian: last_accessed更新失败 #${f.id}:`, e.message); }
      try { f.content = encryption.decrypt(f.content); } catch (_) {}
    }

    // 权限标签前置，让 Draco 第一时间看到他能怎么用这条记忆
    return `※ ${permission} · #${f.id} · ${daysStr}\n${f.content}`.trim();
  });

  return lines.join('\n');
}

module.exports = { searchFragments, formatForContext, searchHybrid, searchHybridWithCategory, formatHybridContext, classifyIntent, lookupEntityIds, getEntityFragments };
