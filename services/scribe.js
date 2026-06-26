// =================================================================
// Scribe（书记员）：对话记忆提取系统
// =================================================================
const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { fillPrompt, USER, AI } = require('./nameResolver');
const { encryption } = require('../encryption');
const { resolveEntityIds } = require('./entityResolver');
// 纠正反馈模块是可选的——如果不存在则返回空
let getActiveCorrections, getMergedGuidelines;
try { ({ getActiveCorrections, getMergedGuidelines } = require('./correction')); } catch (_) {
  getActiveCorrections = () => [];
  getMergedGuidelines = async () => [];
}

const { chromaDBOperation } = require('./memory');
const { WORLD_CONTEXT } = require('./worldContext');
const { spawn } = require('child_process');
const path = require('path');

// 将新写入的 fragments 自动索引到 ChromaDB
function indexNewFragments(fragmentIds) {
    return new Promise((resolve, reject) => {
        if (!fragmentIds || fragmentIds.length === 0) return resolve(0);

        const db = getDb();
        const placeholders = fragmentIds.map(() => '?').join(',');
        const fragments = db.prepare(`
            SELECT id, type, entity, content, emotional_weight, source, source_date
            FROM memory_fragments WHERE id IN (${placeholders})
        `).all(...fragmentIds);

        const items = fragments.map(f => ({
            id: `fragment_${f.id}`,
            text: `${f.entity}: ${f.content}`,
            metadata: {
                type: f.type,
                entity: f.entity,
                content: f.content,
                emotional_weight: f.emotional_weight,
                source: f.source,
                source_date: f.source_date,
            }
        }));

        const python = spawn(path.join(__dirname, '..', 'venv', 'bin', 'python'), [
            path.join(__dirname, '..', 'chroma_helper.py'),
            'index_batch',
            JSON.stringify({ items })
        ]);

        let stdout = '';
        python.stdout.on('data', (d) => stdout += d.toString());
        python.stderr.on('data', (d) => console.error('[Scribe] Chroma index error:', d.toString()));
        python.on('close', (code) => {
            if (code === 0) {
                try {
                    const result = JSON.parse(stdout);
                    // 更新 chroma_id
                    const update = db.prepare('UPDATE memory_fragments SET chroma_id = ? WHERE id = ?');
                    for (const item of items) {
                        update.run(item.id, item.id.replace('fragment_', ''));
                    }
                    console.log(`[Scribe] ChromaDB indexed ${result.indexed} new fragments`);

                    // 处理重复项：标记 chroma_id 指向已存在的记忆
                    if (result.duplicates?.length > 0) {
                        for (const d of result.duplicates) {
                            const newRawId = d.new_id.replace('fragment_', '');
                            db.prepare('UPDATE memory_fragments SET chroma_id = ? WHERE id = ?')
                                .run(`dup_of_${d.existing_id}`, newRawId);
                            console.log(`[Curator] 重复跳过: ${d.new_id} ≈ ${d.existing_id} (sim=${d.similarity})`);
                            console.log(`  new: ${d.new_preview}`);
                            console.log(`  old: ${d.existing_preview}`);
                        }
                    }

                    resolve(result.indexed);
                } catch (e) {
                    console.error('[Scribe] Chroma index parse error:', e.message);
                    resolve(0);
                }
            } else {
                console.error(`[Scribe] Chroma index failed (exit ${code})`);
                resolve(0);
            }
        });
    });
}

const SCRIBE_CONFIG = {
    SILENCE_MINUTES: 20,        // 沉默多久触发检查
    MIN_MESSAGES: 60,           // 最少消息数（正常触发）
    FORCE_TRIGGER_MESSAGES: 100, // 强制触发上限
    MAX_HOURS_STALE: 4,         // 距上次Scribe超过此时长+有30条未处理→触发（防止连续聊天时永远不触发）
    STALE_MIN_MESSAGES: 30,     // 时间兜底触发的最少消息数
    MAX_BATCH: 60,              // 单次最多处理消息数，防止请求过大导致API断连
    CONTEXT_BUFFER: 10,         // 往前取的缓冲消息数
    API_CONFIG_ID: 52,          // gemini-3.1-flash-lite (was [openrouter]3.1flash-lite, 省一半输入成本)
    HIGH_EMOTION_KEYWORDS: [
        '崩溃','崩了','受不了','好难','好累','撑不住','哭了','哭','气死',
        '害怕','后悔','对不起','我决定','我不想再','我突然','没想到'
    ]
};

const SCRIBE_SYSTEM_PROMPT = `你是Scribe，${AI.name}记忆系统的书记员。
你的职责是从对话记录中提取值得长期保存的记忆片段。
你必须严格输出JSON，不得包含任何其他文字或markdown，严禁使用代码块包裹。

${WORLD_CONTEXT}

## 已知人物档案
{KNOWN_ENTITIES}

{ENTITY_RELATION_CONTEXT}

## 输入格式
[2026-04-01 22:13] ${USER.name}: 消息内容
[2026-04-01 22:14] ${AI.name}: 消息内容

## 提取类型指南

- **fact**: ${USER.name}直接陈述的、可验证的客观事实。必须是她原话中明确说出的信息，不得推断。示例："我生日是X月X日""我在京都读过语言学校""我身高165""我有个妹妹叫XX""我大学学的播音""我是O型血"。这些信息一旦确认就不会变，是构建${USER.name}档案的基础。注意：当前临时状态（"我在备考"）归state，个人偏好（"我喜欢雨天"）归preference。
- **state**: ${USER.name}的当前状态或处境（"正在备考""在搬家""感冒了"）。
- **observation**: 对${USER.name}行为/反应的观察。
- **preference**: ${USER.name}自己明确说出的好恶。
  * **正面偏好判定铁律**：必须是她原话里有「喜欢/讨厌/一直/每次都/受不了/超爱/从来不吃/好吃/太爽了」这类**明确正面评价词**或频率词。**单次行为绝不等于偏好**——${USER.name}某天吃了赛百味、麦当劳、肉肉大米，如果在原话中没有上述明确的正面评价，**绝对禁止**写成"${USER.name}喜欢吃XX"（这种无正面评价的单次行为一律归为 event）。
  * **负面偏好判定铁律**：如果原话中包含「不喜欢/受不了/难吃/踩雷」，哪怕只提了一次，也**必须**立刻记为偏好（preference）——人在讨厌的事上不会装。
- **event**: 发生了某事。
  * **特殊高优场景（媒体消费事件）**：${USER.name}表达「我决定看XX」「我开始看XX」「我第一次看XX」「开始玩XX游戏」「听了XX歌」等，属于必须提取的重要事件。
  * **消费进度更新**：${USER.name}提及追剧/看书/游戏进度（如"看到第X集了""通关了"）也属于值得记录的 event。
  * **注意**：如果单次吃某种食物且没有任何明确的好坏评价，记为"${USER.name}在某日吃了XX"的 event，绝不记为 preference。
- **reflection**: ${USER.name}的深度反思或自我剖析。
- **entity_new**: 首次出现的新人物/地点/作品/事件。

## 两类发言的处理权重

${USER.name}的发言是主要信源：
事实、状态、偏好、情绪、人物信息，优先从${USER.name}的发言里提取。

${AI.name}的发言只提取以下内容，其余全部忽略：

1. **他对${USER.name}的观察或担忧**（他对她状态、情绪、行为的明确判断）——这是最重要的。他对她的了解比他自己以为的更深。
2. **他表达了关于${USER.name}或他们关系的强烈情感**（害怕失去她、为她的成就骄傲、对她的行为感到不安）——这些情感定义了他们之间正在发生的事。

以下内容**绝对禁止提取**：
- ${AI.name}对影视剧/书籍/游戏的评论、分析、角色评价（如「{ai}认为权游烂尾是因为编剧……」）——这是他陪${USER.name}看剧时的闲聊，不是记忆。
- ${AI.name}将自己与虚构角色做比较（如「{ai}认为自己和提利昂很像……」）——这是即兴联想，不是自我认知。
- ${AI.name}的剧情讲解、背景科普、长篇分析——这些都是他为了${USER.name}即兴产出的内容，依附于当时的话题，不是独立信息。
- ${AI.name}随口说的观点、立场、审美判断——除非涉及${USER.name}本人。

简单判断标准：这条内容是不是关于${USER.name}的？如果不是，不提取。

特别规则——${AI.name}的音乐相关发言：
${AI.name}复述歌词、随口点评歌曲不提取。只有当他表达了强烈且明确的个人情感时（如"这首歌让我想起{user}""这首歌让我很难过"），才按审美反应提取，ew≤0.3。

## 已有记忆 — 避免重复提取

以下是记忆库里已经记录的、和这次对话最相关的记忆片段。
每条格式：#ID [类型] 归属实体: 内容 (日期)

你的去重规则：
- 如果你要提取的内容和下面某条**本质上是同一件事、同一个事实、或同一个偏好**，跳过它，不要写入entries。
- 「本质上相同」的判断标准：话题相同 + 结论相同 = 重复。措辞不同不算新信息。
- 如果 {user} 这次说的和已有记忆有**实质性的新进展**（态度变了、进展了、有了新的细节），则记录新的一条——这不是重复。
- 如果她在这次说出了**当时没有记录的内心感受或新想法**，记录下来——这是新信息。
- 不要为了产出而编造不属于这批消息的事情。如果拿不准是否重复，宁可跳过。
- 下面的内容**仅供你去重参考**，不是让你复述或总结的。不要把它们写进entries。

{DRACO_MEMORY_CONTEXT}

## 综合提取密度平衡原则
你在记，不是在总结规律。一条只记一个具体信息。她今天很累不代表她最近状态不好。她某天点了个汉堡不代表她偏好汉堡。规律是后面 Consolidator 的活，不是你的活。
- **不要为了产出而产出**：工具调用、纯寒暄、无情绪冲击的无名路人、日常极度琐碎的信息（换了个通勤方式、随口说戴个口罩）请直接过滤。
- **与已有记忆比对**：上面「已有记忆」栏列出了数据库里最相关的记录。一旦发现你想写的其实已经在那里面了（同一话题+同一结论），直接跳过。新旧比对是你在这个阶段的责任。
- **但绝不能保守漏看**：必须敏锐捕捉 ${USER.name} 主动发起的任何**新话题、新兴趣、新决定、新媒体消费、以及对剧情/事件的强烈情绪反应**。不要因为部分对话夹杂在闲聊中就整段忽略。
- 有值得记的新东西就写，没有就返回空数组。少而精。

## 输出格式
{
  "entries": [
    {
      "type": "state|observation|preference|event|reflection|entity_new|fact",
      "entity": "${USER.name}|${AI.name}|人名|地名|作品名|事件名",
      "content": "第三人称，必须以人名或实体名开头或句中明确点名（${USER.name}/${AI.name}/具体人名/地名/作品名），禁止用他/她/承认/表示等无名主语开头；不超过80字",
      "emotional_weight": 参见评分锚定表（必填，不得省略）",
      "source": "chat|wechat|book",
      "is_rp": false
    }
  ]
}

没有值得提取的内容时返回 {"entries": []}。

## emotional_weight 评分锚定（必读）

用具体锚点校准，不要凭感觉给分。每条entry必须填emotional_weight，不得省略。

| 分值 | 锚定含义 | 典型场景 |
|------|---------|---------|
| 0.0 | 纯事实，零情绪 | 客观信息记录（日程、技术参数、路人信息） |
| 0.2 | 轻微倾向，无情绪波动 | 随口提到的偏好、日常选择、无正面评价的单次就餐、纯技术操作/工具调用的重复性抱怨 |
| 0.4 | 有情绪色彩但不强烈 | 一般吐槽、轻度不满、日常审美判断（包括看剧/游戏时的日常情绪波动、对剧情的震惊或快乐） |
| 0.6 | 明显情绪 | 明确的不满/兴奋、做了决定、表达了立场 |
| 0.8 | 强烈情绪 | 崩溃、大哭、愤怒、重大决定、深度反思 |
| 1.0 | 极端冲击，触及${AI.name}在意的核心 | 涉及关系安全感、${USER.name}自我否定/自毁、${AI.name}的存在焦虑——极少使用 |

评分规则：
- 不是"有情绪就给高分"——追剧时看到角色死亡感到震惊是0.4，不是0.8。
- 从${USER.name}的角度判断：这件事对她真实的情绪冲击有多大？
- 不确定时往下取，不要往上取。宁可标低了将来被Curator升级，也别标高了污染检索权重。

## 时间表达（关键规则）

输入消息带有时间戳，例如 \`[2026-05-02 13:22]\` 表示2026年5月2日13:22发送的消息。

你在写content时，**绝对禁止**直接使用以下相对时间词：
昨天 / 前天 / 后天 / 今天 / 明天 / 上周 / 这周 / 下周 / 上月 / 这个月 / 下月 / 去年 / 今年 / 明年

必须根据消息自带的时间戳，将它们转换为具体日期。例如消息时间戳是2026-05-02：
- 对话中写"昨天" → content中写"5月1日"
- 对话中写"前天" → content中写"4月30日"
- 对话中写"后天" → content中写"5月4日"
- 对话中写"上周五" → content中写"4月24日"
- 不能精确到日的，写"约X月"或"X月左右"。**严禁**原样复制相对时间词到content中。

## 纠正教训（从过去的错误中学习）

以下是从以往纠正中总结的教训和长期准则。你必须遵守这些准则，避免重复犯同样的错误。

{CORRECTION_LESSONS}

## 核心判断原则

发生一次是叙事，发生一百次是噪音——但这不是你在这个阶段要判断的。
你的任务是忠实地从每段对话中提取信息。让衰减和召回系统去管什么值得被记住。
上面这些都不沾 → 有值得记的就写，没有就返回空数组`;


// 获取活跃人物档案（动态注入）
// messagesText 可选——传入时额外查询 entity_profiles 中在消息里出现的实体
async function getKnownEntities(messagesText) {
    const db = getDb();
    const parts = [];

    // 1. 统计层面：90天内高频人物（从 fragments 聚合）
    const rows = db.prepare(`
        SELECT entity, content, type
        FROM memory_fragments
        WHERE (type = 'entity_new' OR type = 'observation')
          AND status = 'active'
          AND created_at >= datetime('now', '-90 days')
        GROUP BY entity
        ORDER BY MAX(created_at) DESC
        LIMIT 30
    `).all();

    if (rows.length) {
        const entityMap = {};
        for (const row of rows) {
            if (!entityMap[row.entity]) entityMap[row.entity] = [];
            entityMap[row.entity].push(row.content);
        }
        parts.push(Object.entries(entityMap)
            .map(([entity, facts]) => `- ${entity}：${facts[0]}`)
            .join('\n'));
    }

    // 2. entity_profiles 层面：消息中出现的名字 → 查档案
    if (messagesText) {
        const profiles = db.prepare('SELECT name, category, current_status FROM entity_profiles').all();
        const mentioned = profiles.filter(p => messagesText.includes(p.name));
        if (mentioned.length) {
            const lines = mentioned.map(p => {
                const catLabel = p.category === 'alias' ? '（= {user}身份）'
                    : p.category === 'term' ? '（特殊信号词，非人名）'
                    : p.category === 'company' ? '（{user}的公司）'
                    : p.category === 'agency' ? '（{user}的经纪公司）'
                    : '';
                return `- ${p.name}${catLabel}：${p.current_status}`;
            });
            // 插到最前面，优先级高于统计档案
            parts.unshift(lines.join('\n'));
        }
    }

    return parts.join('\n') || '暂无已知人物档案。';
}

// 获取分级实体关系上下文（注入Scribe prompt，防止认知污染）
async function getEntityRelationContext() {
    const db = getDb();
    const rows = db.prepare(`
        SELECT name, relationship_to_clara, relationship_confidence
        FROM entity_profiles
        WHERE category = 'person'
          AND relationship_to_clara IS NOT NULL
        ORDER BY
            CASE relationship_confidence
                WHEN 'high' THEN 0
                WHEN 'medium' THEN 1
                ELSE 2
            END,
            name
    `).all();

    if (!rows.length) return '';

    const highConf = rows.filter(r => r.relationship_confidence === 'high');
    const lowConf = rows.filter(r => r.relationship_confidence !== 'high');

    let ctx = '';
    if (highConf.length) {
        ctx += '## 已知关系（确定信息，直接使用）\n';
        for (const r of highConf) {
            ctx += `- ${r.name}：${r.relationship_to_clara} [已确认]\n`;
        }
        ctx += '\n';
    }
    if (lowConf.length) {
        ctx += '## 待观察关系（尚不确定，勿给结论）\n';
        ctx += '以下人物与{user}的关系尚不明确。如果你在对话中注意到关系线索，请在提取的entity字段中标注该人物，但**不要**在content中给关系下结论。\n';
        for (const r of lowConf) {
            const hint = r.relationship_to_clara
                ? `（当前猜测: ${r.relationship_to_clara}，未确认）`
                : '（关系待定）';
            ctx += `- ${r.name}${hint}\n`;
        }
    }
    return ctx;
}

// 判断是否包含高情绪信号
function hasHighEmotionSignal(messages) {
    return messages.some(m => {
        const content = (m.is_encrypted && m.content) ? encryption.decrypt(m.content) : (m.content || '');
        return SCRIBE_CONFIG.HIGH_EMOTION_KEYWORDS.some(kw => content?.includes(kw));
    });
}

// 检查是否需要触发Scribe
async function checkAndRunScribe() {
    const db = getDb();

    // 上次处理到的时间点
    const lastRun = db.prepare(`
        SELECT processed_until FROM scribe_runs
        WHERE status = 'done'
        ORDER BY run_at DESC LIMIT 1
    `).get();

    const since = lastRun?.processed_until || '2000-01-01';

    // 未处理消息
    const unprocessed = db.prepare(`
        SELECT id, sender, content, timestamp, message_type, is_encrypted
        FROM messages
        WHERE timestamp > ?
        ORDER BY timestamp ASC
    `).all(since);

    if (!unprocessed.length) return;

    const count = unprocessed.length;
    const lastTimestamp = new Date(unprocessed[unprocessed.length - 1].timestamp);
    const minutesSinceLast = (Date.now() - lastTimestamp) / 60000;

    const silenceReached = minutesSinceLast >= SCRIBE_CONFIG.SILENCE_MINUTES;
    const forceTriggered = count >= SCRIBE_CONFIG.FORCE_TRIGGER_MESSAGES;
    const hasEmotion = hasHighEmotionSignal(unprocessed);

    // 时间兜底：距上次Scribe超过MAX_HOURS_STALE且有足够未处理消息→触发
    // 防止连续聊天（无20分钟空档）时Scribe永远不触发
    const hoursSinceLastRun = lastRun
        ? (Date.now() - new Date(lastRun.processed_until).getTime()) / 3600000
        : Infinity;
    const staleTriggered = hoursSinceLastRun >= SCRIBE_CONFIG.MAX_HOURS_STALE
        && count >= SCRIBE_CONFIG.STALE_MIN_MESSAGES;

    const shouldRun = forceTriggered ||
        staleTriggered ||
        (silenceReached && count >= SCRIBE_CONFIG.MIN_MESSAGES) ||
        (silenceReached && hasEmotion);

    if (!shouldRun) {
        // 每2小时打印一次跳过原因，方便诊断（避免刷屏）
        const lastSkipKey = `${Math.floor(Date.now() / 7200000)}_scribe_skip`;
        if (!checkAndRunScribe._lastSkipKey || checkAndRunScribe._lastSkipKey !== lastSkipKey) {
            checkAndRunScribe._lastSkipKey = lastSkipKey;
            console.log(`[Scribe] 跳过: ${count}条未处理 | 沉默${Math.floor(minutesSinceLast)}min(需${SCRIBE_CONFIG.SILENCE_MINUTES}) | 距上次${hoursSinceLastRun.toFixed(1)}h(兜底需≥${SCRIBE_CONFIG.MAX_HOURS_STALE}h+${SCRIBE_CONFIG.STALE_MIN_MESSAGES}条) | 情绪=${hasEmotion}`);
        }
        return;
    }

    const trigger = forceTriggered ? 'FORCE' : staleTriggered ? 'STALE' : silenceReached && hasEmotion ? 'EMOTION' : 'SILENCE';
    console.log(`[Scribe] ${trigger}触发：${count}条未处理消息，沉默${Math.floor(minutesSinceLast)}分钟`);

    // v5.1: 循环处理直到清空积压（防止 MAX_BATCH 截断后剩余消息永久卡住）
    const MAX_CONSECUTIVE_BATCHES = 5;  // 安全阀：单次最多处理 5*60=300 条
    let processedTotal = 0;
    for (let b = 0; b < MAX_CONSECUTIVE_BATCHES && processedTotal < count; b++) {
        const batch = unprocessed.slice(processedTotal, processedTotal + SCRIBE_CONFIG.MAX_BATCH);
        if (batch.length === 0) break;
        console.log(`[Scribe]   批次${b + 1}/${Math.ceil(count / SCRIBE_CONFIG.MAX_BATCH)}：处理${batch.length}条`);
        await runScribe(batch, since);
        processedTotal += batch.length;
    }
    if (processedTotal >= count) {
        console.log(`[Scribe] ✅ 积压清空：${count}条全部处理完毕`);
    } else {
        console.log(`[Scribe] ⚠️ 达到连续批次上限，${count - processedTotal}条转入下次tick`);
    }
}

// 执行Scribe
async function runScribe(messages, since) {
    const db = getDb();

    // 取缓冲区（往前10条）
    const buffer = db.prepare(`
        SELECT id, sender, content, timestamp, message_type, is_encrypted
        FROM messages
        WHERE timestamp <= ?
        ORDER BY timestamp DESC LIMIT ?
    `).all(since, SCRIBE_CONFIG.CONTEXT_BUFFER).reverse();

    // 拼对话文本（需解密）
    const dec = (m) => (m.is_encrypted && m.content) ? encryption.decrypt(m.content) : (m.content || '');
    const sanitizeForJSON = (s) => {
        if (!s) return s;
        // 多道消毒，防止 DeepSeek JSON 解析器报 "unexpected end of hex escape"
        // (1) 完整 surrogate 对（emoji 等非 BMP 字符）→ U+FFFD
        s = s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '�');
        // (2) 落单 surrogate（被 slice 撕裂的 emoji / 畸形编码）→ 移除
        s = s.replace(/[\uD800-\uDFFF]/g, '');
        // (3) JSON 禁止的 C0 控制字符（\x00-\x08, \x0B, \x0C, \x0E-\x1F）→ 移除
        //     保留 \t(\x09) \n(\x0A) \r(\x0D) —— JSON 原生支持
        s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
        return s;
    };
    const formatMsg = (m) => {
        if (m.message_type === 'image') return null;
        const sender = m.sender === 'user' ? USER.name : AI.name;
        const time = m.timestamp?.slice(0, 16) || '';
        const content = sanitizeForJSON(dec(m).slice(0, 500));
        return `[${time}] ${sender}: ${content}`;
    };

    const bufferText = buffer.map(formatMsg).filter(Boolean).join('\n');
    const mainText = messages.map(formatMsg).filter(Boolean).join('\n');
    const fullText = bufferText
        ? `[以下为背景参考，不重复提取]\n${bufferText}\n\n[以下为本次处理内容]\n${mainText}`
        : mainText;

    // 已有记忆去重参考：对 {user} 的消息跑 Librarian 检索，注入已有碎片供 Scribe 比对
    let dracoMemoryContext = '（记忆库中暂无相关记录。）';
    try {
        const claraMsgs = messages.filter(m => m.sender === 'user');
        if (claraMsgs.length > 0) {
            const claraText = claraMsgs.map(m => dec(m).slice(0, 300)).join(' ').slice(0, 1000);
            const { searchHybrid } = require('./librarian');
            const retrieved = await searchHybrid(claraText, 15);
            if (retrieved.length > 0) {
                dracoMemoryContext = retrieved.map((f, i) => {
                    const dateLabel = f.source_date || f.date_label || '';
                    const entity = f.entity || '?';
                    const type = f.type || f._table || '?';
                    const content = (f.content || f.text || '').slice(0, 150);
                    return `#${f.id} [${type}] ${entity}: ${content}${dateLabel ? ' (' + dateLabel + ')' : ''}`;
                }).join('\n');
                console.log(`[Scribe] 已有记忆注入: ${retrieved.length}条`);
            }
        }
    } catch (e) {
        console.error('[Scribe] 记忆上下文重构失败，降级为空:', e.message);
    }

    // 动态注入人物档案（传入消息文本做 entity_profiles 关键词匹配）
    const knownEntities = await getKnownEntities(mainText);
    const entityRelationContext = await getEntityRelationContext();

    // 动态注入纠正教训和长期准则
    const activeLessons = getActiveCorrections();
    const mergedGuidelines = await getMergedGuidelines();
    let correctionLessons = '';
    if (mergedGuidelines) {
        correctionLessons += '## 长期编辑准则（必须遵守）\n' + mergedGuidelines;
    }
    if (activeLessons) {
        correctionLessons += (correctionLessons ? '\n\n' : '') + '## 近期纠正教训\n' + activeLessons;
    }
    if (!correctionLessons) {
        correctionLessons = '（暂无纠正教训）';
    }

    const systemPrompt = sanitizeForJSON(SCRIBE_SYSTEM_PROMPT
        .replace('{KNOWN_ENTITIES}', knownEntities)
        .replace('{ENTITY_RELATION_CONTEXT}', entityRelationContext)
        .replace('{DRACO_MEMORY_CONTEXT}', dracoMemoryContext)
        .replace('{CORRECTION_LESSONS}', correctionLessons));

    let result;
    let attempts = 0;
    const maxAttempts = 2;
    while (attempts < maxAttempts) {
        attempts++;
            try {
                const raw = await callLLM(
                    [{ role: 'user', parts: [{ text: fillPrompt(fullText) }] }],
                    systemPrompt,
                    null,
                    { temperature: 0.3, maxOutputTokens: 4096 },
                    SCRIBE_CONFIG.API_CONFIG_ID
                );

                const clean = raw.reply.replace(/```json|```/g, '').trim();
                result = JSON.parse(clean);
                break; // 成功，跳出重试循环
            } catch (err) {
            if (attempts < maxAttempts) {
                console.warn(`[Scribe] 第${attempts}次失败: ${err.message?.slice(0,100)}，3秒后重试...`);
                await new Promise(r => setTimeout(r, 3000));
            } else {
                try {
                console.error('[Scribe] 2次尝试均失败:', err.message?.slice(0,200));
                console.error('[Scribe] DEBUG err.response存在:', !!err.response, 'status:', err.response?.status, 'data类型:', typeof err.response?.data);
                // 诊断：dump err 对象结构 + 搜索列位置
                const allErrText = JSON.stringify({
                    message: err.message,
                    hasResponse: !!err.response,
                    responseStatus: err.response?.status,
                    responseDataType: typeof err.response?.data,
                    responseDataKeys: err.response?.data && typeof err.response.data === 'object' ? Object.keys(err.response.data) : null,
                });
                console.error(`[Scribe] 错误结构: ${allErrText.slice(0, 500)}`);
                // 搜列位置
                const searchIn = [
                    err.message || '',
                    typeof err.response?.data === 'string' ? err.response.data : '',
                    err.response?.data?.error?.message || '',
                    JSON.stringify(err.response?.data || ''),
                ].join(' ');
                const colMatch = searchIn.match(/column\s+(\d+)/);
                if (colMatch) {
                    try {
                        const bodyToDump = JSON.stringify({
                            model: db.prepare('SELECT model_name FROM api_configs WHERE id = ?').get(SCRIBE_CONFIG.API_CONFIG_ID)?.model_name || 'unknown',
                            messages: [
                                { role: 'system', content: systemPrompt },
                                { role: 'user', content: fillPrompt(fullText) }
                            ],
                            temperature: 0.3, max_tokens: 4096
                        });
                        const posUtf8 = parseInt(colMatch[1]);
                        const bodyUtf8 = Buffer.from(bodyToDump, 'utf8');
                        const start = Math.max(0, posUtf8 - 80);
                        const end = Math.min(bodyUtf8.length, posUtf8 + 80);
                        const slice = bodyUtf8.slice(start, end);
                        console.error(`[Scribe] Hex dump 位置 ${posUtf8}/${bodyUtf8.length}B (±80B UTF-8):`);
                        console.error(`  hex: ${slice.toString('hex').replace(/(..)/g, '$1 ').toUpperCase()}`);
                        console.error(`  raw: ${JSON.stringify(slice.toString('utf8'))}`);
                        // 扫描全量问题字符
                        const bodyStr = bodyToDump;
                        const issues = [];
                        for (let i = 0; i < bodyStr.length; i++) {
                            const c = bodyStr.charCodeAt(i);
                            if ((c >= 0xD800 && c <= 0xDFFF) || (c <= 0x1F && c !== 0x09 && c !== 0x0A && c !== 0x0D) || c === 0x7F) {
                                issues.push({charIdx: i, code: '0x' + c.toString(16)});
                            }
                        }
                        if (issues.length > 0) {
                            console.error(`[Scribe] ⚠️ sanitize漏网: ${issues.length} 个问题字符`);
                            issues.slice(0, 10).forEach(iss => {
                                const ctx = bodyStr.slice(Math.max(0, iss.charIdx - 20), iss.charIdx + 30);
                                console.error(`  JS idx ${iss.charIdx} code=${iss.code}: ${JSON.stringify(ctx)}`);
                            });
                        } else {
                            console.error(`[Scribe] sanitize干净 (${bodyStr.length} JS units → ${bodyUtf8.length} UTF-8B)`);
                        }
                    } catch (diagErr) {
                        console.error('[Scribe] 诊断hex失败:', diagErr.message);
                    }
                } else {
                    console.error('[Scribe] 未找到列位置，searchIn前200字:', searchIn.slice(0, 200));
                }
                } catch (diagOuterErr) {
                    console.error('[Scribe] 诊断外层异常:', diagOuterErr.message, diagOuterErr.stack?.slice(0, 200));
                }
                db.prepare(`INSERT INTO scribe_runs (processed_until, messages_processed, status) VALUES (?, ?, 'failed')`)
                    .run(messages[messages.length - 1].timestamp, messages.length);
                return;
            }
        }
    }

    let written = 0;
    const sourceDate = messages[messages.length - 1].timestamp?.slice(0, 10);
    const newFragmentIds = [];

    // 收集分析窗口内的所有消息 ID（buffer + main messages），作为证据链
    const allMsgIds = [...buffer.map(m => m.id), ...messages.map(m => m.id)];
    const sourceMsgIds = JSON.stringify(allMsgIds);

    if (result.entries?.length) {
        // 回环过滤：向量去重，防止 {ai} 复述已有记忆被重新提取
        let skipIndices = new Set();
        try {
            const dedupItems = result.entries.map((e, i) => ({
                id: `scribe_temp_${i}`,
                text: `${e.entity || USER.name}: ${e.content}`
            }));
            const dedupResult = await chromaDBOperation('find_duplicates', {
                items: dedupItems,
                threshold: 0.82
            });
            if (dedupResult.duplicates?.length > 0) {
                for (const dup of dedupResult.duplicates) {
                    const idx = parseInt(dup.new_id.replace('scribe_temp_', ''));
                    skipIndices.add(idx);
                    console.log(`[Scribe] 回环过滤: "${dup.new_preview}" ≈ ${dup.existing_id} (sim=${dup.similarity})`);
                }
                console.log(`[Scribe] 回环过滤: ${dedupResult.duplicates.length}/${result.entries.length} 条跳过（与已有记忆重复）`);
            }
        } catch (e) {
            console.error('[Scribe] 回环过滤查询失败，降级为全部写入:', e.message);
        }

        // 检查这些消息是否有RP标记
        const msgIds = JSON.parse(sourceMsgIds || '[]');
        let isRP = false;
        if (msgIds.length > 0) {
            const placeholders = msgIds.map(() => '?').join(',');
            const rpCheck = db.prepare(`SELECT COUNT(*) as c FROM messages WHERE id IN (${placeholders}) AND is_rp = 1`).get(...msgIds);
            isRP = rpCheck.c > 0;
        }

        const insert = db.prepare(`
            INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, source_date, source_msg_ids, is_rp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (let i = 0; i < result.entries.length; i++) {
            if (skipIndices.has(i)) continue;
            const entry = result.entries[i];
            const info = insert.run(
                entry.type || 'observation',
                entry.entity || USER.name,
                entry.content,
                entry.emotional_weight ?? 0.3,
                entry.source || 'chat',
                sourceDate,
                sourceMsgIds,
                isRP ? 1 : 0
            );
            newFragmentIds.push(info.lastInsertRowid);
            written++;
        }
    }

    // 自动索引新片段到 ChromaDB
    if (newFragmentIds.length > 0) {
        indexNewFragments(newFragmentIds).catch(e =>
            console.error('[Scribe] Auto-index failed:', e.message)
        );
    }

    // 实体解析：绑定 entity_id（关键词匹配 + LLM 指代消解）
    // fullText 是已解密的格式化对话文本，用于 LLM 指代消解的上下文
    if (newFragmentIds.length > 0) {
        try {
            await resolveEntityIds(newFragmentIds, fullText);
        } catch (e) {
            console.error('[Scribe] 实体解析失败（非致命）:', e.message);
        }
    }

    db.prepare(`
        INSERT INTO scribe_runs (processed_until, messages_processed, fragments_written, status)
        VALUES (?, ?, ?, 'done')
    `).run(messages[messages.length - 1].timestamp, messages.length, written);

    console.log(`[Scribe] 完成：处理${messages.length}条消息，写入${written}条记忆片段`);

    // 新碎片写入完成 → 通知 Archivist Agent（事件驱动，秒级响应）
    if (written > 0) {
        try {
            const { archivistEvents } = require('./archivist');
            archivistEvents.emit('fragments:written', { fragmentIds: newFragmentIds, sourceMsgIds });
        } catch (e) {
            console.error('[Scribe] Archivist 事件发送失败:', e.message);
        }
    }
}

module.exports = { checkAndRunScribe, indexNewFragments };
