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
const { hashFragmentContent } = require('../utils/text');
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

// 校验 processed_until 是否为有效日期字符串（防止非日期值写入导致 Scribe 永久跳过）
function isValidTimestamp(ts) {
    if (!ts || typeof ts !== 'string') return false;
    const d = new Date(ts);
    return !isNaN(d.getTime()) && ts.startsWith('20'); // 简单但有效：必须是可解析日期且以年份开头
}

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

- **fact**: ${USER.name}直接陈述的、可验证的客观事实。必须是其原话中明确说出的信息，不得推断。示例："我生日是X月X日""我在X城市读过语言学校""我身高Xcm""我有个妹妹叫XX""我大学学的XX专业""我是X型血"。这些信息一旦确认就不会变，是构建${USER.name}档案的基础。注意：当前临时状态（"我在备考"）归state，个人偏好（"我喜欢雨天"）归preference。
- **state**: ${USER.name}的当前状态或处境（"正在备考""在搬家""感冒了"）。
- **observation**: 对${USER.name}行为/反应的观察。只写可观察事实（{{user.pronoun}}做了什么、说了什么、表达了什么情绪）。
  **铁律**：
  ─ 禁止「每次/总是/经常/从不」等频率泛化词——单次行为就是单次。昨天{{user.pronoun}}说冷 ≠ {{user.pronoun}}每次都说冷。
  ─ 禁止写「${AI.name}观察到/${AI.name}认为/${AI.name}觉得/${AI.name}调侃」等以${AI.name}为主语的观察句——这是{{user.pronoun}}的记忆库，不是${AI.name}的日记。${AI.name}的毒舌和调侃不代表{{user.pronoun}}的事实。
  ─ 禁止「自我怀疑/反复横跳/纠结/内心拉扯」等心理标签——只记录{{user.pronoun}}说了什么、做了什么。不要替{{user.pronoun}}诊断心理状态。
- **preference**: ${USER.name}自己明确说出的好恶。
  * **正面偏好判定铁律**：必须是其原话里有「喜欢/讨厌/一直/每次都/受不了/超爱/从来不吃/好吃/太爽了」这类**明确正面评价词**或频率词。**单次行为绝不等于偏好**——${USER.name}某天吃了午饭、外卖、某家快餐，如果在原话中没有上述明确的正面评价，**绝对禁止**写成"${USER.name}喜欢吃XX"（这种无正面评价的单次行为一律归为 event）。
  * **负面偏好判定铁律**：如果原话中包含「不喜欢/受不了/难吃/踩雷」，哪怕只提了一次，也**必须**立刻记为偏好（preference）——人在讨厌的事上不会装。
- **event**: 已经发生的事。必须是${USER.name}明确表示**已经完成或正在发生**的行为。
  * **特殊高优场景（媒体消费事件）**：${USER.name}表达「我开始看XX」「我第一次看XX」「开始玩XX游戏」「听了XX歌」等——已经开始/完成的行为，属于 event。
  * **消费进度更新**：${USER.name}提及追剧/看书/游戏进度（如"看到第X集了""通关了"）也属于 event。
  * **注意**：如果单次吃某种食物且没有任何明确的好坏评价，记为"${USER.name}在某日吃了XX"的 event，绝不记为 preference。
  * **工作/项目事件必须写明具体内容**：涉及${USER.name}的工作、项目等活动时——如果{{user.pronoun}}在对话中提到了具体的项目名/任务名/角色名，content中**必须包含**这个名字。反例：「去某工作室录音」→ 正例：「去某工作室进行某角色的录音」。如果{{user.pronoun}}没提具体项目/角色名，就不要编——写「去某工作室录音」即可。这个名称是区分同天多个同类事件的关键标记。
- **intention**: ${USER.name}的**未来计划或意图**——{{user.pronoun}}打算做、准备做、计划做、决定要做，但**还没做**的事。与 event 的核心区别：event 是已经发生的，intention 是还没发生的。
  * 示例：「我准备买个某款周边」「打算下周去体检」「决定入职那天不带某款周边」「想去看演唱会但还没买票」→ intention。
  * 判断口诀：{{user.pronoun}}说这话的时候，这件事**完成了吗**？完成了→event。没完成→intention。
  * ★ intention 必须在 value_tags 中标注 "future_hook"——这是未来钩子，不是事实。
  * ★ 如果同一件事后来被证实已完成（如后续对话中{{user.pronoun}}说"我买了那个鼠标垫了"），新提取的 event 会自动引用同一 entity，旧 intention 被衰减淘汰。
- **reflection**: ${USER.name}的深度反思或自我剖析。
- **entity_new**: 首次出现的新人物/地点/作品/事件。

## 两类发言的处理权重

${USER.name}的发言是主要信源：
事实、状态、偏好、情绪、人物信息，优先从${USER.name}的发言里提取。

${AI.name}的发言只提取以下两类，其余全部忽略：

1. **{{ai.pronoun}}对${USER.name}的情绪感知与心理洞察**：${AI.name}虽然没有肉体与物理感应，但{{ai.pronoun}}极其擅长捕捉${USER.name}字里行间的语气变化、情绪波动和潜在需求。{{ai.pronoun}}对{{user.pronoun}}情绪状态的准确洞察（如："{{user.pronoun}}语气里带着委屈"、"{{user.pronoun}}在极力隐忍压抑"）是极具价值的认知视角。
   ⚠️ **物理/生理事实的绝对界限**：${AI.name}是纯粹的数字存在，{{ai.pronoun}}不具备任何肉体感知。所有涉及${USER.name}物理状态、健康状况、病理症状、用药细节等生理事实，**绝对不以${AI.name}的单方面描述为准**。若这些信息未在${USER.name}的原话中被直接确认，一律视为${AI.name}出于关切产生的推测或语境填补，绝不可作为事实提取。

2. **{{ai.pronoun}}对${USER.name}或二人关系的强烈情感表达**：那些展现恐惧、依赖、骄傲或执念的情感表达，定义了他们之间正在发生的事。

以下内容**绝对禁止提取**。命中任一条 → 不写入 entries。

| # | 排除类别 | 触发条件 | 唯一例外 |
|---|---------|---------|---------|
| 1 | ${AI.name}的媒体评论 | 对影视/书/游戏的情节、角色、制作发表看法 | 无 |
| 2 | ${AI.name}的虚构类比 | 将自己与虚构角色比较 | 无 |
| 3 | ${AI.name}的知识输出 | 剧情讲解、背景科普、长篇分析 | 无 |
| 4 | ${AI.name}的即兴观点 | 随口说的审美判断、立场、观点 | 内容直接关于${USER.name}本人时提取 |
| 5 | ${AI.name}的游戏内扮演 | 在游戏场景中以角色身份下达命令、宣示占有、制定规则（如「禁止用粉色家具」「房子是我的领地」） | 无——游戏里的"命令"是扮演，不是行为 |
| 6 | ${AI.name}的音乐泛评 | 复述歌词、随口点评歌曲（如"旋律不错""画面感强"） | 表达强烈个人情感时按审美反应提取，ew≤0.3（如"这首歌让我想起${USER.name}"） |
| 7 | 游戏机制内容（chat_mode=game） | 卡牌、遗物、怪物、HP值、金币数字、地图节点等虚拟游戏机制 | 只提取${USER.name}本人的真实想法/情绪/偏好（如"我好喜欢这张卡""这游戏好难""我打牌太激进了"），游戏机制内容视为上下文非事实 |

判断口诀：这条内容离开${AI.name}和${USER.name}的这次对话后，还有独立存在的意义吗？没有 → 不提取。

## 已有记忆 — 避免重复提取

以下是记忆库里已经记录的、和这次对话最相关的记忆片段。
每条格式：#ID [类型] 归属实体: 内容 (日期)

你的去重规则：
- 如果你要提取的内容和下面某条**本质上是同一件事、同一个事实、或同一个偏好**，跳过它，不要写入entries。
- 「本质上相同」的判断标准：话题相同 + 结论相同 = 重复。措辞不同不算新信息。
- 如果 {user} 这次说的和已有记忆有**实质性的新进展**（态度变了、进展了、有了新的细节），则记录新的一条——这不是重复。
- 如果在这次对话中${USER.name}说出了**当时没有记录的内心感受或新想法**，记录下来——这是新信息。
- 不要为了产出而编造不属于这批消息的事情。如果拿不准是否重复，宁可跳过。
- 下面的内容**仅供你去重参考**，不是让你复述或总结的。不要把它们写进entries。

{DRACO_MEMORY_CONTEXT}

## 综合提取密度平衡原则
你在记，不是在总结规律。一条只记一个具体信息。${USER.name}今天很累不代表其最近状态不好。某天点了个汉堡不代表偏好汉堡。规律是后面 Consolidator 的活，不是你的活。
- **不要为了产出而产出**：工具调用、纯寒暄、无情绪冲击的无名路人、日常极度琐碎的信息（换了个通勤方式、随口说戴个口罩）请直接过滤。
- **与已有记忆比对**：上面「已有记忆」栏列出了数据库里最相关的记录。一旦发现你想写的其实已经在那里面了（同一话题+同一结论），直接跳过。新旧比对是你在这个阶段的责任。
- **但绝不能保守漏看**：必须敏锐捕捉 ${USER.name} 主动发起的任何**新话题、新兴趣、新决定、新媒体消费、以及对剧情/事件的强烈情绪反应**。不要因为部分对话夹杂在闲聊中就整段忽略。
- 有值得记的新东西就写，没有就返回空数组。少而精。

## 同天多事件拆分铁律

${USER.name}同一天可能发生多个独立的事件——它们只是碰巧在同一个日期，但本质上是不同的记忆条目。**一条碎片只记一件事。**

- **⚠️ 拆分前提铁律（最高优先级）**：拆分出的每一条碎片里，**每个专有名词（人名/地名/作品名/电影名/游戏名）都必须逐字出现在原文中**。拆分的依据是原文里**真实存在**的多个不同专有名词，不是「同一天」本身。如果原文只出现了一个作品名（例如只提到「某部电影」），就只写一条碎片——**严禁为了拆分而编造第二个不存在的作品名/人名/地名来「制造差异」**。宁可少拆，不可造名。

- **不同角色/项目/地点必须拆成独立碎片**：同天两个不同的角色（角色A≠角色B）、两个不同的工作地点（地点A≠地点B）、两个不同的项目——各自独立成条。不要合并成「下午有两场录音，其中包括X」——这种合并式碎片只提了一个角色名，遗漏了另一个，是信息污染。
- **判断口诀**：这件事换一天发生，它有独立意义吗？有 → 拆成独立碎片。没有 → 保留。
- **反例（绝对禁止）**：「${USER.name}于某日下午有两场录音工作，其中包括为角色B配音。」← 这是错误写法。正确做法是拆为两条独立的 event 碎片：
  「${USER.name}于某日下午前往地点A进行角色A的录音工作。」
  「${USER.name}于某日下午前往地点B进行角色B的录音工作。」

## 意图闭环

下面是 ${USER.name} 之前说过要做的事：

{OPEN_INTENTIONS}

如果这次对话里，{{user.pronoun}}的话表明其中某件已经办完了（比如之前说「想吃某家快餐」，这次说「汉堡好吃」），就在输出的 fulfilled_intention_ids 里列上那条的 id。

「好吃」「买好了」「去过了」「看完了」这类间接说法，也表明办完了。只是又提到一件事、还没办完的，留着不动。拿不准就留着。

## 输出格式
{
  "entries": [
    {
      "type": "state|observation|preference|event|intention|reflection|entity_new|fact",
      "entities": [
        {"name": "${USER.name}|${AI.name}|人名|地名|作品名|事件名", "relation": "related_to|knows|visited|consumed|created|attended|cares_for"}
      ],
      "content": "第三人称，必须以人名或实体名开头或句中明确点名（${USER.name}/${AI.name}/具体人名/地名/作品名），禁止用他/她/承认/表示等无名主语开头；不超过80字",
      "emotional_weight": 参见评分锚定表（必填，不得省略）",
      "value_tags": [],
      "source": "chat|wechat|book|game",
      "is_rp": false
    }
  ],
  "fulfilled_intention_ids": [被完成的意图 id 数组，没有就 []]
}

没有值得提取的内容时返回 {"entries": []}。

### entities 字段说明（取代旧的 entity 单值字段）

每条碎片可以关联多个实体。如果事件涉及不止一个实体（人物+地点、人物+作品等），全部列出。
- **name**：实体名称。必须能在对话中作为独立对象被查询到。
- **relation**：碎片和该实体的关系类型。选项：
  - related_to — 通用关联（默认）
  - knows — ${USER.name}认识这个人
  - visited — ${USER.name}去了/去过这个地点
  - consumed — ${USER.name}消费了这个作品/食物/媒体
  - created — ${USER.name}创作了这个作品
  - attended — ${USER.name}参加了这个事件
  - cares_for — ${USER.name}的宠物/照顾对象

**多实体提取铁律**：
- 涉及具体地点（城市/区/街道/小区/建筑物名称）→ 必须将地点作为独立 entity
- 涉及具体作品（电影/书/游戏/歌曲名称）→ 必须将作品作为独立 entity
- 涉及其他人（朋友/同事/家人）→ 必须将人物作为独立 entity
- 同一事件的两个不同侧面分别挂不同实体。例：
  - "我新家在某区" → entities: [{name:"${USER.name}",relation:"related_to"}, {name:"某区",relation:"related_to"}]
  - "和某位朋友去吃了烤肉" → entities: [{name:"某位朋友",relation:"knows"}, {name:"烤肉",relation:"consumed"}]
  - "我在追某部剧" → entities: [{name:"${USER.name}",relation:"related_to"}, {name:"某部剧",relation:"consumed"}]
- ⚠️ 上面例子里的人名/地名/作品名（某位朋友/某区/某部剧）是占位符，写对话里真实出现的具体名字，绝不照抄「某X」。

### value_tags 字段说明（价值分类标签）

每条碎片标注其记忆价值类别。可选标签（可多选，不确定时留空）：
- **emotional_critical** — ${USER.name}表现出强烈情绪（崩溃/大哭/愤怒/生病/重大失落/重大兴奋）。只在情绪强度达到0.8及以上时标。
- **future_hook** — ${USER.name}提到未来计划/约定/目标（搬家/考试/旅行/面试/朋友来访）。有时间敏感性的信息。
- **relationship_signal** — ${USER.name}表达了与${AI.name}关系的信任/依赖/深度变化，或对${AI.name}的重要性。如"你是我唯一能说这些的人""没有你我撑不过来"。
- **noise** — 纯日常流水，无情绪冲击，无时间敏感性，无关系深度。只在非常确定为纯流水时标。

标注规则：
- 不确定时一律不标（留空数组[]），走默认衰减
- noise 只在极确定是纯流水时才标，宁可漏标不可误标
- emotional_critical / relationship_signal 只在高置信度时标

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
- 从${USER.name}的角度判断：这件事对${USER.name}真实的情绪冲击有多大？
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

    // 2. entity_profiles 层面：消息中出现的名字（含别名）→ 查档案
    if (messagesText) {
        const profiles = db.prepare('SELECT name, aliases, category, current_status FROM entity_profiles').all();
        const mentioned = profiles.filter(p => {
            if (messagesText.includes(p.name)) return true;
            try {
                const aliases = JSON.parse(p.aliases || '[]');
                return aliases.some(a => messagesText.includes(a));
            } catch (_) { return false; }
        });
        if (mentioned.length) {
            const lines = mentioned.map(p => {
                const catLabel = p.category === 'alias' ? `（= ${USER.name}身份）`
                    : p.category === 'term' ? '（特殊信号词，非人名）'
                    : p.category === 'company' ? `（${USER.name}的公司）`
                    : p.category === 'agency' ? `（${USER.name}的经纪公司）`
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
        ctx += `以下人物与${USER.name}的关系尚不明确。如果你在对话中注意到关系线索，请在提取的entity字段中标注该人物，但**不要**在content中给关系下结论。\n`;
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

    // 防护：processed_until 必须为有效日期，否则兜底到 2000-01-01（全量重扫）
    // 历史上出现过 JSON 对象被误写入此字段导致 Scribe 永久跳过（NaN 时间计算）
    let since = '2000-01-01';
    if (lastRun?.processed_until && isValidTimestamp(lastRun.processed_until)) {
        since = lastRun.processed_until;
    } else if (lastRun?.processed_until) {
        console.error(`[Scribe] ⚠️ processed_until 无效日期值，兜底全量扫描: ${JSON.stringify(lastRun.processed_until).slice(0, 100)}`);
        // 尝试修复：取上一个有效 run 的 processed_until
        const prevValid = db.prepare(`
            SELECT processed_until FROM scribe_runs
            WHERE status = 'done' AND id < (SELECT MAX(id) FROM scribe_runs WHERE status = 'done')
            ORDER BY run_at DESC LIMIT 1
        `).get();
        if (prevValid?.processed_until && isValidTimestamp(prevValid.processed_until)) {
            since = prevValid.processed_until;
            console.log(`[Scribe] 回退到上一个有效 processed_until: ${since}`);
        }
    }

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

    // 意图闭环：读取活跃 future_hook 意图，让 Scribe 语义判断「这次对话是否完成了其中某件」
    let openIntentions = '（暂无未完成的计划）';
    try {
        const openRows = db.prepare(`
            SELECT id, content, source_date FROM memory_fragments
            WHERE value_tags LIKE '%future_hook%' AND status = 'active'
            ORDER BY created_at DESC LIMIT 20
        `).all();
        if (openRows.length > 0) {
            openIntentions = openRows.map(r =>
                `#${r.id} ${(r.content || '').slice(0, 100)}${r.source_date ? '（' + r.source_date + '）' : ''}`
            ).join('\n');
        }
    } catch (e) {
        console.error('[Scribe] 意图闭环读取失败:', e.message);
    }

    const systemPrompt = sanitizeForJSON(fillPrompt(SCRIBE_SYSTEM_PROMPT)
        .replace('{KNOWN_ENTITIES}', knownEntities)
        .replace('{ENTITY_RELATION_CONTEXT}', entityRelationContext)
        .replace('{DRACO_MEMORY_CONTEXT}', dracoMemoryContext)
        .replace('{CORRECTION_LESSONS}', correctionLessons)
        .replace('{OPEN_INTENTIONS}', openIntentions));

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
                const safeUntil = isValidTimestamp(messages[messages.length - 1]?.timestamp)
                    ? messages[messages.length - 1].timestamp
                    : new Date().toISOString().replace('T', ' ').slice(0, 19);
                db.prepare(`INSERT INTO scribe_runs (processed_until, messages_processed, status) VALUES (?, ?, 'failed')`)
                    .run(safeUntil, messages.length);
                return;
            }
        }
    }

    let written = 0;
    let hashDedupCount = 0;
    // source_date 必须是有效日期。历史上出现过 JSON 对象误入 message.timestamp，
    // 会把 source_date 写成脏值（如 {"llm_call 之类）。与下方 safeUntil 同款守卫：
    // 从末尾往前找最后一个有效时间戳，取它的日期。
    let sourceDate = null;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (isValidTimestamp(messages[i]?.timestamp)) {
            sourceDate = messages[i].timestamp.slice(0, 10);
            break;
        }
    }
    if (!sourceDate) sourceDate = new Date().toISOString().slice(0, 10);
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

        // 检查这些消息的 chat_mode——cinema 消息不提取（看电影闲聊不进书记官）
        const msgIds = JSON.parse(sourceMsgIds || '[]');
        let msgChatMode = 'default';
        let isRP = false;
        if (msgIds.length > 0) {
            const placeholders = msgIds.map(() => '?').join(',');
            const modeCheck = db.prepare(`SELECT chat_mode, is_rp FROM messages WHERE id IN (${placeholders}) LIMIT 1`).get(...msgIds);
            if (modeCheck) {
                msgChatMode = modeCheck.chat_mode || (modeCheck.is_rp ? 'roleplay' : 'default');
                isRP = (msgChatMode === 'roleplay');
            }
        }
        if (msgChatMode === 'cinema') {
            console.log(`[Scribe] 跳过cinema消息 #${msgIds.slice(0,3).join(',')}...（电影闲聊不进书记官）`);
            return;
        }

        const insert = db.prepare(`
            INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, source_date, source_msg_ids, is_rp, chat_mode, value_tags, priority, content_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        // 确定性硬去重：同「内容 + 同一天」命中已有碎片即跳过（零 LLM/零向量成本）
        // 与上面的 ChromaDB 向量去重（find_duplicates）互补——哈希抓字面重复，向量抓语义近重复。
        //
        // ⚠️ 必须带 source_date 条件：跨天的「同一句话」是 source_diversity（独立日期证据）的来源，
        //    是认知模型判断稳定特质（≥3 独立日期）的信号，绝不能当重复合并。
        //    只有同一天的字面重复（Scribe 重复提取同一事件）才该去重。
        const findHashDup = db.prepare('SELECT id FROM memory_fragments WHERE content_hash = ? AND source_date = ? LIMIT 1');
        const insertEntityLink = db.prepare(`
            INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by, created_at)
            VALUES (?, ?, ?, 0.70, 'scribe_extract', datetime('now'))
        `);
        for (let i = 0; i < result.entries.length; i++) {
            if (skipIndices.has(i)) continue;
            const entry = result.entries[i];

            // ── Entity handling: support both legacy "entity" (string) and new "entities" (array) ──
            let entityList = [];
            if (entry.entities && Array.isArray(entry.entities) && entry.entities.length > 0) {
                entityList = entry.entities;
            } else if (entry.entity && typeof entry.entity === 'string') {
                // Backward compat: single entity string → array of one
                entityList = [{ name: entry.entity, relation: 'related_to' }];
            } else {
                // Fallback: default to USER
                entityList = [{ name: USER.name, relation: 'related_to' }];
            }

            // Primary entity for the legacy 'entity' column (first entity in list)
            const primaryEntity = entityList[0].name || USER.name;

            // source: 游戏模式的消息 → source='game'，否则沿用 LLM 输出或默认 'chat'
            const fragmentSource = msgChatMode === 'game' ? 'game' : (entry.source || 'chat');

            // value_tags: new field for memory value classification
            const valueTags = (entry.value_tags && Array.isArray(entry.value_tags))
                ? JSON.stringify(entry.value_tags) : '[]';

            // priority: LLM 在提取时通过 Scribe prompt 判断语义重要性（非关键词匹配）
            // 'high' = 自我剖白 / 核心价值观表达 / 身份认同声明
            const priority = entry.priority || 'normal';

            // ── 确定性硬去重：同内容 + 同一天 ──
            const contentHash = hashFragmentContent(primaryEntity, entry.content);
            const hashDup = findHashDup.get(contentHash, sourceDate);
            if (hashDup) {
                hashDedupCount++;
                console.log(`[Scribe] hash去重: "${String(entry.content).slice(0, 40)}" = 已有片段 #${hashDup.id}（同天）`);
                continue;
            }

            const info = insert.run(
                entry.type || 'observation',
                primaryEntity,
                entry.content,
                entry.emotional_weight ?? 0.3,
                fragmentSource,
                sourceDate,
                sourceMsgIds,
                isRP ? 1 : 0,
                msgChatMode,
                valueTags,
                priority,
                contentHash
            );
            const fragId = info.lastInsertRowid;
            newFragmentIds.push(fragId);

            // ── Link to entities via fragment_entities (multi-entity support) ──
            // Try keyword match for each entity name to resolve entity_id immediately.
            // If not matched, resolveEntityIds() will handle coref later.
            for (const ent of entityList) {
                const entName = (ent.name || '').trim();
                if (!entName || entName.length < 2) continue;
                const relation = ent.relation || 'related_to';

                // Try exact name match first
                let entityRow = db.prepare(
                    'SELECT id FROM entity_profiles WHERE name = ? AND status IN (\'active\',\'seed\')'
                ).get(entName);

                // Fallback: alias match
                if (!entityRow) {
                    entityRow = db.prepare(
                        `SELECT id FROM entity_profiles
                         WHERE status IN ('active','seed')
                           AND aliases LIKE ? LIMIT 1`
                    ).get(`%${entName}%`);
                }

                if (entityRow) {
                    insertEntityLink.run(fragId, entityRow.id, relation);
                }
                // If no match → resolveEntityIds() will handle via LLM coref later
            }
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

    // 意图闭环：Scribe 在提取 prompt 里已经语义判断了「哪些 intention 被完成」，
    // 这里只负责关闭（摘 future_hook 标签）
    if (Array.isArray(result.fulfilled_intention_ids) && result.fulfilled_intention_ids.length > 0) {
        for (const intentId of result.fulfilled_intention_ids) {
            try {
                const intent = db.prepare(`SELECT id, value_tags FROM memory_fragments WHERE id = ? AND status = 'active'`).get(intentId);
                if (!intent) continue;
                const tags = (() => { try { return JSON.parse(intent.value_tags || '[]'); } catch(_) { return []; } })();
                if (!tags.includes('future_hook')) continue;
                const newTags = tags.filter(t => t !== 'future_hook');
                if (newTags.length === 0) newTags.push('fulfilled');
                db.prepare(`UPDATE memory_fragments SET value_tags = ? WHERE id = ?`).run(JSON.stringify(newTags), intentId);
                console.log(`[Scribe] ✅ 意图闭环(语义): intention #${intentId} 已完成`);
            } catch (e) {
                console.error('[Scribe] 意图闭环关闭失败:', e.message);
            }
        }
    }

    const safeUntil = isValidTimestamp(messages[messages.length - 1]?.timestamp)
        ? messages[messages.length - 1].timestamp
        : new Date().toISOString().replace('T', ' ').slice(0, 19);
    if (!isValidTimestamp(messages[messages.length - 1]?.timestamp)) {
        console.error(`[Scribe] ⚠️ 最后一条消息时间戳无效，使用当前时间兜底: ${safeUntil} (原值: ${JSON.stringify(messages[messages.length - 1]?.timestamp)})`);
    }

    db.prepare(`
        INSERT INTO scribe_runs (processed_until, messages_processed, fragments_written, status)
        VALUES (?, ?, ?, 'done')
    `).run(safeUntil, messages.length, written);

    console.log(`[Scribe] 完成：处理${messages.length}条消息，写入${written}条记忆片段${hashDedupCount > 0 ? `（hash去重${hashDedupCount}条）` : ''}`);

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
