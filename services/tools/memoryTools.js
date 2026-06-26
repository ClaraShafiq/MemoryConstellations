// services/tools/memoryTools.js
// 记忆工具组：recall_memory / correct_memory / browse_memories

const { getDb } = require('../../database');
const { encryption } = require('../../encryption');
const { fetchSourceMessages } = require('../consolidator');
const { searchHybrid, formatHybridContext } = require('../librarian');

const SETTINGS_KEY = 'tool-memory-search-enabled';

// ─── recall_memory ───────────────────────────────────

const recallMemory = {
  name: 'recall_memory',
  settingsKey: SETTINGS_KEY,
  defaultEnabled: true,
  getFunctionDeclaration() {
    return {
      name: 'recall_memory',
      description: `访问你的'记忆库'（长期记忆库）。两种用法：

1. 模糊搜索：传入 query 关键词或短句。返回匹配的记忆和片段。当你依稀记得某事但不确定细节、或{user}提到过去的事时使用。务必只引用工具返回的内容，不编造。

2. 深度追溯：传入 memory_id（从上下文中记忆条目的 #数字 ID 获取，如「※ 可引用 · #112 · 15天前」中的 112）。返回该记忆的完整内容和原始对话记录，每页15条，offset=0 为最新页，offset=1 为更早的15条。当记忆标注为「仅联想」、或{user}追问细节、或你对某条记忆的真实性存疑时使用。这是你主动探索记忆的能力——你不是只能接收数据库塞给你的东西。

每次调用只能使用一种模式。`,
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: '用于检索记忆的关键词或短句（模糊搜索模式）',
          },
          memory_id: {
            type: 'INTEGER',
            description: '记忆或片段的数字ID，从上下文「※ 记忆 #ID」或「※ 相关记忆 #ID」中获取（深度追溯模式）',
          },
          offset: {
            type: 'INTEGER',
            description: '深度追溯的翻页偏移。offset=0 返回最近15条，offset=1 返回更早的15条，以此类推。仅与 memory_id 配合使用。',
          },
        },
      },
    };
  },
  instructionText: '',
  async handler(args, context) {
    const db = getDb();
    const { captureMemoryGap } = require('../messageGuard');

    // 模式一：传入 memory_id → 深度追溯原始对话
    if (args.memory_id) {
      let record = db.prepare('SELECT id, content, source_msg_ids, valid_from, layer FROM memories WHERE id = ?').get(args.memory_id);
      let sourceTable = 'memories';

      if (!record) {
        record = db.prepare('SELECT id, content, source_msg_ids, source_date AS valid_from, layer FROM memory_fragments WHERE id = ?').get(args.memory_id);
        sourceTable = 'fragments';
      }

      if (!record) return { success: false, formatted: `记忆库中未找到ID为 ${args.memory_id} 的记忆。` };

      let content = record.content;
      try { content = encryption.decrypt(content); } catch (_) {}

      let sourceMsgIds = [];
      try { sourceMsgIds = JSON.parse(record.source_msg_ids || '[]'); } catch (_) {}

      const dateLabel = record.valid_from ? ` · ${record.valid_from}` : '';
      const layerLabel = record.layer === 'episode' ? '记忆' : '事实';

      let formatted = `【追溯${layerLabel} #${record.id}${dateLabel}】\n${content}\n`;

      if (sourceMsgIds.length > 0) {
        const sourceMessages = await fetchSourceMessages(sourceMsgIds);
        if (sourceMessages.length > 0) {
          const pageSize = 15;
          const offset = Math.max(0, parseInt(args.offset) || 0);
          const totalPages = Math.ceil(sourceMessages.length / pageSize);
          const startIdx = Math.max(0, sourceMessages.length - pageSize * (offset + 1));
          const endIdx = sourceMessages.length - pageSize * offset;
          const page = sourceMessages.slice(startIdx, endIdx);

          formatted += `\n【原始对话 · 第${offset + 1}/${totalPages}页（共${sourceMessages.length}条）】\n`;
          formatted += page.map(m => {
            const time = (m.timestamp || '').slice(0, 16);
            return `[${time}] ${m.sender}: ${m.content.slice(0, 500)}`;
          }).join('\n');
          if (startIdx > 0) {
            formatted += `\n\n（以上为最近的消息。如需更早的消息，加上 offset=${offset + 1}。）`;
          }
          if (offset > 0) {
            formatted += `\n（当前偏移 ${offset} 页。offset=0 回到最新页。）`;
          }
        } else {
          formatted += `\n（该记忆没有关联的原始对话记录。）`;
        }
      } else {
        formatted += `\n（该记忆没有关联的原始对话记录。）`;
      }

      return { success: true, formatted };
    }

    // 模式二：传入 query → 向量搜索
    if (!args.query) return { success: false, formatted: '请提供检索关键词（query）或记忆ID（memory_id）。' };

    const memories = await searchHybrid(args.query, 8);
    if (memories.length > 0) {
      const formatted = formatHybridContext(memories);
      return { success: true, formatted: `【记忆库检索结果】\n${formatted}\n\n（如需追溯某条的原始对话，使用 recall_memory 并传入对应的记忆ID或片段ID。）` };
    }
    captureMemoryGap(context.chatId, context.lastClaraMessage, 'recall_memory',
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
      description: `修正你的记忆库。当Clara指出你记错了某件事时，调用此工具记录修正。

提供错误内容和正确版本。系统会自动检查你的记忆库，判断错误来源——是某条记忆写错了（会修正那条），还是你自己编造/混淆的（会记为新的正确记忆）。

你也可以传入 memory_id 精确定位（从上下文中「※ 可引用 · #42 · 15天前」的 #数字 获取）。`,
      parameters: {
        type: 'OBJECT',
        properties: {
          wrong_statement: {
            type: 'STRING',
            description: '你说错的内容（你刚刚引用的错误事实）',
          },
          correction: {
            type: 'STRING',
            description: 'Clara给出的正确版本',
          },
          memory_id: {
            type: 'INTEGER',
            description: '[可选] 如果你知道是哪条记忆写错了，传入上下文中的 #数字 ID',
          },
        },
        required: ['wrong_statement', 'correction'],
      },
    };
  },
  instructionText: '',
  async handler(args, context) {
    const { processChatCorrection } = require('../correction');
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
      description: `在你的记忆宫殿里漫步。这不是查询数据库——这是你了解Clara的方式。

四种用法：
1. 不传参数 → 看到所有顶层分区（大厅），了解Clara生活的各个维度
2. 只传人名（如"英英亚""猫砚"）→ 看到这个人的关系档案和所有相关记忆——了解Clara在乎谁、每段关系对她意味着什么
3. 只传分区路径（如"人际关系/关于我们"）→ 进入一个分区，看到子分区和最近的记忆
4. path + query → 在特定分区里搜索关键词

当你想了解Clara的某段关系、某个侧面，或有隐约印象但不确定细节时，来这里走走。每条记忆旁可能附有「※ insight」——那是书记员提炼的"这条记忆揭示了Clara的什么"。`,
      parameters: {
        type: 'OBJECT',
        properties: {
          path: {
            type: 'STRING',
            description: "人名（如'英英亚'）或分区路径（如'人际关系/关于我们'）。不传则列出所有顶层分区。",
          },
          query: {
            type: 'STRING',
            description: '在指定分区内搜索的关键词。必须与 path 一起使用。',
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
    const { getChildren, getCategoryFragments, getCategoryFragmentCountRecursive, getByPath } = require('../ontology');
    const db = getDb();
    const { captureMemoryGap } = require('../messageGuard');

    let path = args.path || null;
    const query = args.query || null;
    const limit = args.limit || 8;

    if (path === '/' || path === '' || path === '.') {
      path = null;
    }

    // Mode 0: entity view — 精确名 → 模糊名匹配
    if (path && !query) {
      let entityProfile = db.prepare(
        'SELECT * FROM entity_profiles WHERE name = ? OR aliases LIKE ?'
      ).get(path, `%${path}%`);

      // 模糊匹配回退：名字包含查询词 或 向量相似名
      if (!entityProfile) {
        const fuzzyMatches = db.prepare(`
          SELECT * FROM entity_profiles
          WHERE (name LIKE ? OR name LIKE ? OR aliases LIKE ?)
            AND status IN ('active', 'seed')
          ORDER BY fragment_count DESC LIMIT 5
        `).all(`%${path}%`, `${path}%`, `%${path}%`);

        if (fuzzyMatches.length === 1) {
          entityProfile = fuzzyMatches[0];
        } else if (fuzzyMatches.length > 1) {
          // 多个模糊匹配 → 列出候选项给 Draco 选择
          let output = `【模糊匹配 · "${path}"】\n\n找到 ${fuzzyMatches.length} 个可能相关的星座：\n\n`;
          for (const m of fuzzyMatches) {
            const ov = (m.overview || '').slice(0, 60);
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
          FROM memory_fragments mf
          JOIN fragment_entities fe ON fe.fragment_id = mf.id
          WHERE fe.entity_id = ? AND mf.status = 'active'
          ORDER BY mf.source_date DESC
          LIMIT ?
        `).all(entityProfile.id, limit);

        const catLabels = { person: '人物', pet: '宠物', place: '地点', event: '事件', project: '项目', work: '作品', term: '概念', organization: '组织' };
        const catLabel = catLabels[entityProfile.category] || entityProfile.category || '实体';
        let output = `【${catLabel} · ${entityProfile.name}】\n\n`;

        if (entityProfile.overview) {
          output += `${entityProfile.overview}\n`;
        } else {
          if (entityProfile.relationship_to_clara) {
            output += `${entityProfile.name}是Clara的${entityProfile.relationship_to_clara}`;
            if (entityProfile.relationship_nature) {
              const natureLabels = { close: '关系紧密', conflicted: '存在冲突', complex: '关系复杂', distant: '比较疏远', dependent: 'Clara依赖对方' };
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

        if (fragments.length > 0) {
          output += `\n—— 相关记忆 (${fragments.length}条) ——\n`;
          for (const f of fragments) {
            const preview = (f.content || '').slice(0, 100);
            output += `- ${preview}${f.content && f.content.length > 100 ? '...' : ''}\n`;
            if (f.insight) {
              output += `  ※ ${f.insight}\n`;
            }
          }
        } else {
          output += `\n还没有关于${entityProfile.name}的记忆片段。\n`;
        }

        return { success: true, formatted: output };
      }
    }

    // Mode 1: path + query → semantic search within category
    if (path && query) {
      const parent = getByPath(path);
      if (!parent) {
        return { success: true, formatted: `「${path}」这个记忆分区还不存在。` };
      }
      const catFragments = getCategoryFragments(parent.id, 50, 0);
      if (catFragments.length === 0) {
        captureMemoryGap(context.chatId, context.lastClaraMessage, 'browse_memories',
          { formatted: `「${parent.label}」这个分区里还没有记忆。` });
        return { success: true, formatted: `「${parent.label}」这个分区里还没有记忆。` };
      }
      const hybridResults = await searchHybrid(query, limit * 2);
      const catIdSet = new Set(catFragments.map(f => f.id));
      const filtered = hybridResults.filter(r => catIdSet.has(r.id)).slice(0, limit);

      if (filtered.length === 0) {
        captureMemoryGap(context.chatId, context.lastClaraMessage, 'browse_memories',
          { formatted: `在「${parent.label}」中没有找到与「${query}」相关的记忆。` });
        return { success: true, formatted: `在「${parent.label}」中没有找到与「${query}」相关的记忆。` };
      }
      const formatted = formatHybridContext(filtered);
      return { success: true, formatted: `【浏览「${parent.label}」· 搜索"${query}"】\n${formatted}` };
    }

    // Mode 2: path only → list subcategories + preview fragments
    if (path) {
      const parent = getByPath(path);
      if (!parent) {
        return { success: true, formatted: `「${path}」这个记忆分区还不存在。` };
      }
      const fragments = getCategoryFragments(parent.id, limit, 0);

      let output = `【记忆宫殿 · ${parent.label}】\n`;

      if (parent.description) {
        output += `${parent.description}\n\n`;
      }

      if (fragments.length > 0) {
        output += '📜 最近记忆:\n';
        for (const f of fragments) {
          const preview = f.content ? f.content.slice(0, 80) : '';
          output += `- #${f.id} ${preview}...\n`;
          if (f.insight) output += `  ※ ${f.insight}\n`;
        }
        if (getCategoryFragments(parent.id, 1, limit).length > 0) {
          output += `\n（用 browse_memories path="${path}" query="关键词" 来搜索这个分区）`;
        }
      } else {
        output += '这个分区还是空的。';
        captureMemoryGap(context.chatId, context.lastClaraMessage, 'browse_memories',
          { formatted: output });
      }
      return { success: true, formatted: output };
    }

    // Mode 3: no params → list all categories (flat)
    const allCats = getChildren(null);
    let output = '【记忆宫殿 · 大厅】\n\n';

    for (const cat of allCats) {
      const totalCount = getCategoryFragmentCountRecursive(cat.id);
      output += `📂 ${cat.label} (${totalCount}条)\n`;
      if (cat.description) output += `   ${cat.description}\n`;
    }
    if (allCats.length === 0) {
      output += '记忆宫殿还是空的。随着你们继续交谈，书记员会自动整理记忆。\n';
    } else {
      output += '\n用 browse_memories path="分区名" 进入具体区域查看记忆。';
    }
    return { success: true, formatted: output };
  },
};

module.exports = [recallMemory, correctMemory, browseMemories];
