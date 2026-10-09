// services/tools/memoryTools.js
// 记忆工具组：recall_memory / correct_memory / browse_memories

const { getDb } = require('../../database');
const { encryption } = require('../../encryption');
const { fetchSourceMessages } = require('../consolidator');
const { searchHybrid, formatHybridContext, getEntityFragments } = require('../librarian');
const { processChatCorrection } = require('../correction');
const { USER } = require('../memoryConfig');

const SETTINGS_KEY = 'tool-memory-search-enabled';

// 记忆缺口追踪是可选的——它挂在消息管道上，不是每个部署都有那一侧。
// 模块缺席时降级成空操作：丢的只是一条遥测副作用，不该让工具本身崩掉。
let captureMemoryGap;
try { ({ captureMemoryGap } = require('../messageGuard')); } catch (_) {
  captureMemoryGap = () => {};
}

// ── 共用小工具 ───────────────────────────────────────

// 名字 → 星座。精确名/别称优先，落空再做一次模糊匹配（唯一命中才算，
// 多个候选宁可当成没找到——猜错人比没查到更糟）。
function resolveEntityRow(db,name) {
  return require('../memoryLinks').resolveName(db,name);
}

// 关联星座一行。related_entities（{id,name,relation,shared_count}）由关系发现
// 写进双方档案——把它带进工具输出，模型看到名字就能顺着再查一次。
function formatRelatedLine(entityProfile, db, limit = 3) {
  let rels = [];
  try { rels = JSON.parse(entityProfile.related_entities || '[]'); } catch (_) {}
  if (!Array.isArray(rels) || rels.length === 0) return '';
  const parts = rels.filter(r => r && r.name).slice(0, limit)
    .map(r => (r.relation ? `${r.name}（${r.relation}）` : r.name));
  return parts.length ? `\n↳ 关联星座：${parts.join('、')}` : '';
}

// 消息正文存的是 components JSON（文本段里混着表情/图片占位）。
// 取纯文本要收**所有** type==='text' 且非 hidden 的段——不能只取第一条：
// 一条消息常被切成好几段（动作标记 + 正文 + 正文），只取第一条会只剩个动作标记。
function messageText(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.components)) {
      return parsed.components
        .filter(c => c.type === 'text' && !c.hidden && c.content)
        .map(c => c.content).join('');
    }
    if (Array.isArray(parsed)) {
      return parsed.filter(p => p.type === 'text').map(p => p.text || p.content || '').join('');
    }
    if (typeof parsed === 'string') return parsed;
  } catch (_) {}
  return String(raw);
}

// 给「不走 searchHybrid」的行补新鲜度标注（entity / date 这两条路）。
// formatHybridContext 靠 _daysAgo + _confidence + _source 算「可引用/需谨慎/仅联想」，
// 三个字段缺了会被算成「999 天 · low」→ 每一行都标「仅联想」，等于告诉模型
// "这些别当事实说"。星座归属和按日期捞都是单通道命中，标 medium（=需谨慎）是诚实的口径。
function annotateFreshness(rows, source = 'ENTITY') {
  const now = Date.now();
  for (const r of rows) {
    if (r._daysAgo == null) {
      const label = (r.source_table === 'fragment' ? r.date_label : null) || r.created_at || r.date_label;
      const d = label ? new Date(label) : null;
      r._daysAgo = (d && !isNaN(d.getTime()))
        ? Math.max(0, Math.round((now - d.getTime()) / 86400000))
        : 365;
    }
    if (r._confidence == null) r._confidence = 'medium';
    if (r._source == null) r._source = source;
  }
  return rows;
}

// include_source：把命中记忆对应的原始对话带出来。
// 只取前 cap 条、每条最多 perItem 句——原始对话是按整段回的，不设上限会吃掉整轮预算。
function buildSourceBlock(rows, db, cap = 3, perItem = 15) {
  const targets = rows.filter(r => r && r.id != null).slice(0, cap);
  if (targets.length === 0) return '';

  const idsOf = (table, ids) => {
    if (ids.length === 0) return [];
    return db.prepare(`SELECT id, source_msg_ids FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids);
  };
  const sourceIdMap = new Map();
  const num = (r) => Number(r.id);
  for (const r of idsOf('memory_fragments', targets.filter(t => t.source_table === 'fragment').map(num))) {
    sourceIdMap.set(`fragment-${r.id}`, r.source_msg_ids);
  }
  for (const r of idsOf('memories', targets.filter(t => t.source_table === 'memory').map(num))) {
    sourceIdMap.set(`memory-${r.id}`, r.source_msg_ids);
  }

  let block = '';
  for (const t of targets) {
    const raw = sourceIdMap.get(`${t.source_table}-${t.id}`);
    let msgIds = [];
    try { msgIds = JSON.parse(raw || '[]'); } catch (_) {}
    if (!Array.isArray(msgIds) || msgIds.length === 0) continue;

    const msgs = fetchSourceMessages(msgIds);
    if (!msgs || msgs.length === 0) continue;

    // 纯表情/图片的消息抽出文本后是空的，别留成「[时间] 名字: 」的空行
    const lines = msgs
      .map(m => ({ time: (m.timestamp || '').slice(5, 16), sender: m.sender, text: messageText(m.content) }))
      .filter(x => x.text);
    if (lines.length === 0) continue;

    const page = lines.slice(-perItem);   // 取最近的一段
    const preview = (t.content || '').slice(0, 30);
    block += `\n—— 原始对话 · ${preview}${t.content && t.content.length > 30 ? '…' : ''} ——\n`;
    block += page.map(x => `[${x.time}] ${x.sender}: ${x.text.slice(0, 300)}`).join('\n');
    if (lines.length > page.length) block += `\n（这一条更早的部分共 ${lines.length} 句，上面是最近的 ${page.length} 句。）`;
    block += '\n';
  }
  return block;
}

// ─── recall_memory ───────────────────────────────────

const recallMemory = {
  name: 'recall_memory',
  settingsKey: SETTINGS_KEY,
  defaultEnabled: true,
  getFunctionDeclaration() {
    return {
      name: 'recall_memory',
      description: `回想你的记忆。

【什么时候非得查不可】
- 你要说出一件关于过去的、具体的事——谁、哪天、在哪、原话是什么——而你上面已经浮现的记忆里没有它。
- ${USER.name} 问"你还记得…吗""我上次说的那个""当时怎么说的"。
- 相对时间（昨天、上周、三天前）你要落成具体日期。
- 你隐约有印象但细节对不上——宁可查一次，别把不确定说成确定。
查不到就如实说没查到。

【四种查法，可以组合】
1. query —— 泛化关键词。想不起确切用词时给个大方向。
2. entity —— 关于谁/哪里/哪件事，填星座名或别称。返回里会带这个星座的关联星座，
   顺着再查一次就能摸到相邻的人和事。
3. date —— 什么时候。单日 "2026-07-24"，或范围 "2026-07-21~2026-07-27"。
4. memory_id —— 深度追溯某一条。ID 是上面结果里的 #数字。当某条标着「仅联想」、
   对方追问细节、或你自己对它的真实性存疑时用；翻更早的原始对话加 offset。

【要原话的时候】
${USER.name} 想看当时的原话、或要你复述细节 → include_source=true：把命中记忆对应的原始对话一并带出来。`,
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: '关键词或短句。想不起确切用词时给个大方向。',
          },
          entity: {
            type: 'STRING',
            description: '星座名或别称（谁、哪里、哪件事）。返回里带这个星座的关联星座。',
          },
          date: {
            type: 'STRING',
            description: '日期过滤。单日"2026-07-24"，或范围"2026-07-21~2026-07-27"。相对时间自己换算。',
          },
          include_source: {
            type: 'BOOLEAN',
            description: 'true = 把命中记忆对应的原始对话一并带出来。要看原话、要复述细节时用。',
          },
          memory_id: {
            type: 'INTEGER',
            description: '记忆或片段的数字ID，从上下文「※ 记忆 #ID」「※ 相关记忆 #ID」里取（深度追溯模式）',
          },
          offset: {
            type: 'INTEGER',
            description: '深度追溯的翻页偏移。offset=0 返回最近15条，offset=1 返回更早的15条。仅与 memory_id 配合。',
          },
        },
      },
    };
  },
  instructionText: '这是你的回想本能。\n\n你没有肉身，感应不到对方的物理世界——所有细节都沉在你们共同的记忆里。所以"想起来"对你不是比喻，是你唯一能碰到过去的动作。\n\n对方提起从前、你准备说出一件具体的事、或者你想用旧日的默契接住此刻的情绪——先去记忆里走一趟。开口前多翻一次，说出口的就都是你确实记得的。\n\n有一类时刻最容易漏：你正要说出一个具体的人名、日期、地点、或者一句原话，而此刻浮现的记忆里并没有它。这种时候先查——查到了就说你记得，没查到就说你想不起来了。',
  async handler(args, context) {
    const db = getDb();

    // 深度追溯：给定 ID → 那一条的完整内容 + 当时的原始对话（翻页用 offset）
    if (args.memory_id) {
      let record = db.prepare('SELECT id, content, source_msg_ids, valid_from, layer FROM memory_valid_episodes AS memories WHERE id = ?').get(args.memory_id);
      if (!record) {
        record = db.prepare('SELECT id, content, source_msg_ids, source_date AS valid_from, layer FROM memory_visible_fragments AS memory_fragments WHERE id = ?').get(args.memory_id);
      }
      if (!record) return { success: false, formatted: `记忆库中未找到ID为 ${args.memory_id} 的记忆。` };

      let content = record.content;
      try { content = encryption.decrypt(content); } catch (_) {}

      let sourceMsgIds = [];
      try { sourceMsgIds = JSON.parse(record.source_msg_ids || '[]'); } catch (_) {}

      const dateLabel = record.valid_from ? ` · ${record.valid_from}` : '';
      const layerLabel = record.layer === 'episode' ? '记忆' : '事实';
      let formatted = `【追溯${layerLabel} #${record.id}${dateLabel}】\n${content}\n`;

      const msgs = sourceMsgIds.length > 0 ? fetchSourceMessages(sourceMsgIds) : [];
      const lines = (msgs || [])
        .map(m => ({ time: (m.timestamp || '').slice(0, 16), sender: m.sender, text: messageText(m.content) }))
        .filter(x => x.text);

      if (lines.length === 0) {
        formatted += '\n（该记忆没有关联的原始对话记录。）';
        return { success: true, formatted };
      }

      const pageSize = 15;
      const totalPages = Math.ceil(lines.length / pageSize);
      // 夹住 offset：翻过头会得到「第2/1页」+ 空页，不如直接停在第 1 页
      const offset = Math.min(Math.max(0, parseInt(args.offset) || 0), totalPages - 1);
      const startIdx = Math.max(0, lines.length - pageSize * (offset + 1));
      const page = lines.slice(startIdx, lines.length - pageSize * offset);

      formatted += `\n【原始对话 · 第${offset + 1}/${totalPages}页（共${lines.length}条）】\n`;
      formatted += page.map(x => `[${x.time}] ${x.sender}: ${x.text.slice(0, 500)}`).join('\n');
      if (startIdx > 0) formatted += `\n\n（以上为最近的消息。如需更早的消息，加上 offset=${offset + 1}。）`;
      if (offset > 0) formatted += `\n（当前偏移 ${offset} 页。offset=0 回到最新页。）`;

      return { success: true, formatted };
    }

    if (!args.query && !args.date && !args.entity) {
      return { success: false, formatted: '请给出 query（想什么）、entity（关于谁/哪里/哪件事）或 date（什么时候）中的至少一个。' };
    }

    // 解析日期参数
    let dateFrom = null, dateTo = null;
    if (args.date) {
      const parts = args.date.split('~');
      dateFrom = parts[0].trim();
      dateTo = (parts[1] || parts[0]).trim();
    }

    let memories = [];
    let rawMessages = [];
    let entityProfile = null;   // entity 模式命中时留着，输出里附关系网

    // entity 查询：先落到星座，再取挂在它下面的碎片（走 fragment_entities 正典源）。
    // query / date 同时给了就在星座内部再筛一层——「这个人」「这件事」+「关于什么/什么时候」
    if (args.entity) {
      entityProfile = resolveEntityRow(db, args.entity);
      if (!entityProfile) {
        return { success: true, formatted: `你的记忆里没有「${args.entity}」这个星座。换个说法，或者只用 query 搜关键词。` };
      }
      const kw = args.query ? args.query.toLowerCase() : null;
      memories = annotateFreshness(getEntityFragments([entityProfile.id], 40).filter(r => {
        if (dateFrom && !(r.date_label >= dateFrom && r.date_label <= dateTo)) return false;
        if (kw && !(r.content || '').toLowerCase().includes(kw)) return false;
        return true;
      }), 'ENTITY');
    } else if (dateFrom) {
      const dateSql = args.query ? 'AND (content LIKE ? OR content LIKE ?)' : '';
      const dateParams = args.query ? [`%${args.query}%`, `%${args.query}%`] : [];

      // 记忆碎片
      const frags = db.prepare(`
        SELECT mf.id, mf.content, mf.emotional_weight AS weight, mf.source_date AS date_label,
               mf.created_at, mf.read_count, mf.layer, 'fragment' AS source_table
        FROM memory_visible_fragments mf
        WHERE mf.source_date >= ? AND mf.source_date <= ?
          AND mf.status = 'active'
          ${dateSql}
        ORDER BY mf.source_date DESC, mf.emotional_weight DESC
        LIMIT 15
      `).all(dateFrom, dateTo, ...dateParams);
      memories.push(...frags);

      // 叙事记忆（episode）
      const eps = db.prepare(`
        SELECT m.id, m.title AS content, (m.weight / 10.0) AS weight,
               m.valid_from AS date_label, m.created_at, m.layer, 'memory' AS source_table
        FROM memory_valid_episodes m
        WHERE m.valid_from >= ? AND m.valid_from <= ?
          AND m.layer = 'episode' AND m.status = 'permanent'
          ${dateSql ? dateSql.replace(/content/g, 'm.title') : ''}
        ORDER BY m.valid_from DESC
        LIMIT 10
      `).all(dateFrom, dateTo, ...dateParams);
      memories.push(...eps);

      // 去重
      const seen = new Set();
      memories = memories.filter(m => {
        const key = `${m.source_table}-${m.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      annotateFreshness(memories, 'DATE');

      // 原始聊天记录（密文字段不能用 SQL LIKE 过滤，全量取出后 JS 层解密+过滤）
      if (context && context.chatId != null) {
        const allMsgs = db.prepare(`
          SELECT sender, content, timestamp FROM messages
          WHERE chat_id = ? AND timestamp >= ? AND timestamp <= ?
          ORDER BY timestamp ASC
          LIMIT 100
        `).all(context.chatId, `${dateFrom} 00:00:00`, `${dateTo} 23:59:59`);

        const keyword = args.query ? args.query.toLowerCase() : null;
        for (const m of allMsgs) {
          const text = messageText(encryption.decrypt(m.content));
          if (!text) continue;
          if (keyword && !text.toLowerCase().includes(keyword)) continue;
          rawMessages.push({ sender: m.sender, content: text, timestamp: m.timestamp });
        }
      }
    } else {
      // 纯关键词搜索：走混合检索
      memories = await searchHybrid(args.query, 8);

      // 补查最近 7 天原始消息（fragments 可能尚未覆盖的近期对话）
      if (context && context.chatId != null) {
        const kw = args.query.toLowerCase();
        const recent7 = db.prepare(`
          SELECT sender, content, timestamp FROM messages
          WHERE chat_id = ? AND timestamp >= datetime('now', '-7 days')
          ORDER BY timestamp ASC
          LIMIT 200
        `).all(context.chatId);
        for (const m of recent7) {
          const text = messageText(encryption.decrypt(m.content));
          if (!text || !text.toLowerCase().includes(kw)) continue;
          rawMessages.push({ sender: m.sender, content: text, timestamp: m.timestamp });
        }
      }
    }

    if (memories.length > 0 || rawMessages.length > 0) {
      let formatted = '';

      if (dateFrom) {
        formatted += `【${dateFrom === dateTo ? dateFrom : dateFrom + ' ~ ' + dateTo} 的记忆】\n`;
      }

      // entity 搜索：先把「这是谁/哪里/哪件事」和它的关系网摆出来，
      // 模型看到相邻星座的名字就能再查一次——图就是这样一跳一跳走通的
      if (entityProfile) {
        const hint = (entityProfile.facts || entityProfile.current_status || '').slice(0, 80);
        formatted += `【${entityProfile.name}】${hint ? ' ' + hint : ''}\n`;
        const related = formatRelatedLine(entityProfile, db);
        if (related) formatted += related + '\n';
        if (args.query) formatted += `\n（上面是「${entityProfile.name}」里和「${args.query}」有关的）`;
        formatted += '\n';
      }

      if (rawMessages.length > 0) {
        formatted += `\n—— 原始对话 (${rawMessages.length}条) ——\n`;
        for (const m of rawMessages) {
          const t = (m.timestamp || '').slice(5, 16);
          formatted += `[${t}] ${m.sender}: ${m.content.slice(0, 300)}\n`;
        }
      }

      if (memories.length > 0) {
        if (rawMessages.length > 0) formatted += '\n—— 记忆碎片 ——\n';
        formatted += formatHybridContext(memories);
      }

      // 要原话：把命中记忆的原始对话带出来（不需要 ID）
      if (args.include_source) {
        formatted += '\n【原始对话】' + buildSourceBlock(memories, db);
      }

      const tail = args.include_source
        ? ''
        : '\n\n（想看某条的原始对话，用 recall_memory 加 include_source=true。）';
      return { success: true, formatted: formatted.trim() + tail };
    }
    captureMemoryGap(context.chatId, context.lastUserMessage, 'recall_memory',
      { formatted: '记忆库中没有找到相关记忆。' });
    return { success: true, formatted: '记忆库中没有找到相关记忆。' };
  },
};

// ─── correct_memory ───────────────────────────────────

const correctMemory = {
  name: 'correct_memory',
  settingsKey: SETTINGS_KEY,
  defaultEnabled: true,
  getFunctionDeclaration() {
    return {
      name: 'correct_memory',
      description: `修正你的记忆库。当${USER.name}指出你记错了某件事时，调用此工具记录修正。

提供错误内容和正确版本。系统会自动检查你的记忆库，判断错误来源——是某条记忆写错了（会修正那条），还是你自己编造/混淆的（会记为新的正确记忆）。

不确定自己记的是什么就说不知道，别为了圆场把错的写成对的。`,
      parameters: {
        type: 'OBJECT',
        properties: {
          wrong_statement: {
            type: 'STRING',
            description: '你说错的内容（你刚刚引用的错误事实）',
          },
          correction: {
            type: 'STRING',
            description: `${USER.name}给出的正确版本`,
          },
        },
        required: ['wrong_statement', 'correction'],
      },
    };
  },
  instructionText: '',
  async handler(args, context) {
    return await processChatCorrection({
      wrongStatement: args.wrong_statement,
      correction: args.correction,
      memoryId: args.memory_id || null,
      chatId: context.chatId,
    });
  },
};

// ─── browse_memories ──────────────────────────────────

const browseMemories = {
  name: 'browse_memories',
  settingsKey: SETTINGS_KEY,
  defaultEnabled: true,
  getFunctionDeclaration() {
    return {
      name: 'browse_memories',
      description: `在你的记忆宫殿里漫步。这不是查询数据库——这是你了解User的方式。

三种用法：
1. 不传参数 → 看到所有星座（大厅），按人物/地点/事件/项目分组，了解User生活的各个维度
2. 只传实体名（如"某个朋友""某个地方"）→ 看到这个实体的档案和所有相关记忆——了解User在乎谁、每段关系对User意味着什么
3. 实体名 + query → 在这个实体的相关记忆里搜索关键词

当你想了解User的某段关系、某个侧面，或有隐约印象但不确定细节时，来这里走走。每条记忆旁可能附有「※ insight」——那是书记员提炼的"这条记忆揭示了User的什么"。`,
      parameters: {
        type: 'OBJECT',
        properties: {
          path: {
            type: 'STRING',
            description: "实体名（如'某个朋友'）。不传则列出所有星座。",
          },
          query: {
            type: 'STRING',
            description: '在该实体的相关记忆里搜索的关键词。必须与 path 一起使用。',
          },
          limit: {
            type: 'INTEGER',
            description: '返回条数，默认8',
          },
        },
        required: [],
      },
    };
  },
  instructionText: '',
  async handler(args, context) {
    const db = getDb();

    let path = args.path || null;
    const query = args.query || null;
    const limit = args.limit || 8;

    if (path === '/' || path === '' || path === '.') {
      path = null;
    }

    // Mode 0: entity view — 精确名 → 模糊名匹配
    if (path && !query) {
      let entityProfile = resolveEntityRow(db,path);

      // 模糊匹配回退：名字包含查询词 或 向量相似名
      if (!entityProfile) {
        const fuzzyMatches = db.prepare(`
          SELECT * FROM memory_visible_profiles AS entity_profiles
          WHERE (name LIKE ? OR name LIKE ? OR aliases LIKE ?)
            AND status IN ('active', 'seed')
          ORDER BY fragment_count DESC LIMIT 5
        `).all(`%${path}%`, `${path}%`, `%${path}%`);

        if (fuzzyMatches.length === 1) {
          entityProfile = fuzzyMatches[0];
        } else if (fuzzyMatches.length > 1) {
          // 多个模糊匹配 → 列出候选项给 Companion 选择
          let output = `【模糊匹配 · "${path}"】\n\n找到 ${fuzzyMatches.length} 个可能相关的星座：\n\n`;
          for (const m of fuzzyMatches) {
            const ov = (m.facts || '').slice(0, 60);
            output += `- **${m.name}** (${m.category}, ${m.fragment_count}碎片)`;
            if (ov) output += ` — ${ov}`;
            output += '\n';
          }
          output += `\n用 browse_memories path="完整名称" 查看具体星座。`;
          return { success: true, formatted: output };
        }
      }

      if (entityProfile) {
        // v5.0 fix: use fragment_entities junction table (canonical source)
        const fragments = db.prepare(`
          SELECT mf.id, mf.content, mf.source_date, mf.insight
          FROM memory_visible_fragments mf
          JOIN memory_entity_associations fe ON fe.fragment_id = mf.id
          WHERE fe.entity_id = ? AND mf.status = 'active'
          ORDER BY mf.source_date DESC
          LIMIT ?
        `).all(entityProfile.id, limit);

        const catLabels = { person: '人物', pet: '宠物', place: '地点', event: '事件', project: '项目', work: '作品', term: '概念', organization: '组织' };
        const catLabel = catLabels[entityProfile.category] || entityProfile.category || '实体';
        let output = `【${catLabel} · ${entityProfile.name}】\n\n`;

        if (entityProfile.facts) {
          output += `${entityProfile.facts}\n`;
        } else {
          if (entityProfile.relationship_to_user) {
            output += `${entityProfile.name}是User的${entityProfile.relationship_to_user}`;
            if (entityProfile.relationship_nature) {
              const natureLabels = { close: '关系紧密', conflicted: '存在冲突', complex: '关系复杂', distant: '比较疏远', dependent: 'User依赖对方' };
              output += `，${natureLabels[entityProfile.relationship_nature] || entityProfile.relationship_nature}`;
            }
            output += '。\n';
          }
          if (entityProfile.emotional_significance) {
            output += `${entityProfile.emotional_significance}\n`;
          }
        }

        if (entityProfile.first_mentioned_date && entityProfile.last_mentioned_date) {
          output += `时间跨度：${entityProfile.first_mentioned_date} ～ ${entityProfile.last_mentioned_date}\n`;
        }

        // 关联星座：把相邻的名字摆出来，模型顺着再查一次就能往下走
        {
          const related = formatRelatedLine(entityProfile, db);
          if (related) output += related + '\n';
        }

        if (fragments.length > 0) {
          output += `\n—— 相关记忆 (${fragments.length}条) ——\n`;
          for (const f of fragments) {
            const preview = (f.content || '').slice(0, 100);
            output += `- ${preview}${f.content && f.content.length > 100 ? '...' : ''}\n`;
            if (f.insight) {
              output += `  ※ 待核实的主观理解（不是用户自述或稳定特质证据）：${f.insight}\n`;
            }
          }
        } else {
          output += `\n还没有关于${entityProfile.name}的记忆片段。\n`;
        }

        return { success: true, formatted: output };
      }
    }

    // 知识树已扁平化——记忆宫殿的数据源是 entity_profiles（星座），没有话题树可走。
    // 下面 path+query / path-only / 无参三种情况全部落在星座上。

    // path + query：在该实体名下做语义搜索
    if (path && query) {
      const entityProfile = resolveEntityRow(db,path);
      if (!entityProfile) {
        return { success: true, formatted: `「${path}」这个记忆分区还不存在。` };
      }
      const hybridResults = await searchHybrid(query, limit * 2);
      const associated=new Set(db.prepare('SELECT fragment_id FROM memory_entity_associations WHERE entity_id=?').all(entityProfile.id).map(r=>r.fragment_id));
      const scoped=hybridResults.filter(hit=>hit.source_table==='fragment'?associated.has(hit.id):!!db.prepare('SELECT 1 FROM memory_valid_episodes WHERE id=? AND entity_id=?').get(hit.id,entityProfile.id));
      const formatted = formatHybridContext(scoped.slice(0, limit));
      if (!formatted) {
        captureMemoryGap(context.chatId, context.lastUserMessage, 'browse_memories',
          { formatted: `在「${entityProfile.name}」中没有找到与「${query}」相关的记忆。` });
        return { success: true, formatted: `在「${entityProfile.name}」中没有找到与「${query}」相关的记忆。` };
      }
      return { success: true, formatted: `【浏览「${entityProfile.name}」· 搜索"${query}"】\n${formatted}` };
    }

    // path-only：无查询，落到实体档案
    if (path) {
      const entityProfile = resolveEntityRow(db,path);
      if (!entityProfile) {
        return { success: true, formatted: `「${path}」这个记忆分区还不存在。` };
      }
      const fragments = db.prepare(`
        SELECT mf.content, mf.insight
        FROM memory_visible_fragments mf
        JOIN memory_entity_associations fe ON fe.fragment_id = mf.id
        WHERE fe.entity_id = ? AND mf.status = 'active'
        ORDER BY mf.source_date DESC LIMIT ?
      `).all(entityProfile.id, limit);

      let output = `【记忆宫殿 · ${entityProfile.name}】\n\n`;
      if (entityProfile.facts) output += `${entityProfile.facts}\n\n`;

      if (fragments.length > 0) {
        output += '📜 最近记忆:\n';
        for (const f of fragments) {
          const preview = f.content ? f.content.slice(0, 80) : '';
          output += `- ${preview}...\n`;
          if (f.insight) output += `  ※ 待核实的主观理解（不是用户自述或稳定特质证据）：${f.insight}\n`;
        }
      } else {
        output += '这个分区还是空的。';
        captureMemoryGap(context.chatId, context.lastUserMessage, 'browse_memories',
          { formatted: output });
      }
      return { success: true, formatted: output };
    }

    // 无参数 → 列出所有星座，按分类聚合
    const allEntities = db.prepare(`
      SELECT name, category, facts, fragment_count
      FROM memory_visible_profiles AS entity_profiles
      WHERE status IN ('active', 'seed')
      ORDER BY fragment_count DESC
    `).all();
    const catLabels = { person: '人物', pet: '宠物', place: '地点', event: '事件', project: '项目', work: '作品', term: '概念', organization: '组织' };

    let output = '【记忆宫殿 · 大厅】\n\n';

    if (allEntities.length === 0) {
      output += '记忆宫殿还是空的。随着你们继续交谈，书记员会自动整理记忆。\n';
      return { success: true, formatted: output };
    }

    // 按分类分组（保持稳定顺序）
    const groups = {};
    for (const e of allEntities) {
      const cat = e.category || 'other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(e);
    }
    for (const [cat, ents] of Object.entries(groups)) {
      output += `📂 ${catLabels[cat] || cat}\n`;
      for (const e of ents) {
        output += `   - ${e.name} (${e.fragment_count || 0}条)`;
        if (e.facts) output += ` — ${e.facts.slice(0, 40)}`;
        output += '\n';
      }
    }
    output += '\n用 browse_memories path="名称" 查看具体星座。';
    return { success: true, formatted: output };
  },
};

module.exports = [recallMemory, correctMemory, browseMemories];
