// =================================================================
// services/tagRouting.js — 「可路由的值标」的唯一定义
//
// 有些记忆值得单独成一颗星座，而不是等着分类器去认领——比如"两人之间的亲密互动"、
// "身体上的客观状况"。这些走**代码路由**：Scribe 提取时打一个值标，代码在碎片
// **入库那一刻**直接建链。
//
// 为什么必须入库即建、不能等分类管线：分类入口要求 `status='active'`，而整合
// （Consolidator）会把跑过的碎片改成 `consolidated`——两条管线抢同一批碎片，谁先到
// 谁说了算。碎片一旦被写成 episode 就永久退出分类，链接再也不会建立。
// 实测：consolidated 的碎片里有一千多条没有任何星座链接，而先被整合的恰恰是
// "一条完整的故事"。（`linkTaggedFragment` 的注释里有更细的账。）
//
// ── 用户怎么用 ────────────────────────────────────────────────
// 在 memory_config.json 里挑要哪几个，值是想给这颗星座起的名字：
//
//     "tag_routing": { "intimacy": "亲密时刻", "health": "健康" }
//
// 不填 = 一颗都不建（默认）。可选的标、默认名字、以及它们本来放在哪个星系，
// 见下面这张表——**这是唯一的可选项清单**，想知道"能开哪几颗"看这里。
//
// ── 加一个新标的步骤 ──────────────────────────────────────────
// ① 在这张表里加一条（tag / label / desc / exclude / category / galaxy）
// ② 跑 `scripts/probes/probe_tag_routing.js` 验证**两个方向**：
//    该标的标了没（别漏）、不该标的标了没（别宽）——prompt 里的措辞改动
//    单跑一次看不出差别，必须重复跑。
// ③ Scribe 的 value_tags 说明段是从这张表生成的，不用另外改 prompt。
// =================================================================

const ROUTABLE_TAGS = [
    {
        tag: 'intimacy',
        label: '亲密',
        category: 'intimacy_aggregate',
        galaxy: '亲密',
        color: '#ff7ba8',
        defaultName: '亲密时刻',
        desc: '这条碎片**来自一次亲密互动本身**：两人之间的情欲交流、身体与欲望的袒露、亲密过程中的对话与反应。',
        exclude: '只标"互动本身"。**不标**事后对它的复盘分析、日常的依赖表达、单纯提到身体不适或健康问题（那些走各自的路）。',
    },
    {
        tag: 'health',
        label: '健康',
        category: 'health_aggregate',
        galaxy: '社交',
        color: '#ff9966',
        defaultName: '健康',
        desc: '这条碎片讲的是**身体本身的客观状况**：症状、诊断、就医、用药、体检结果、身体劳损与皮肤问题。',
        exclude: '只标"身体本身"。**不标**情绪起伏（那是 emotional_critical 的事）、不标对身材的主观焦虑、不标"今天吃了什么"这类日常饮食记录。',
    },
];

// 读 memory_config.json 的 tag_routing，返回 [{ tag, name, category, galaxy }]。
// 只认表里有的标——配置里写了表外的标会被忽略（Scribe 根本吐不出那个标，
// 路由它等于建一颗永远不长的空星座）。
function getTagRouting() {
    let routing = {};
    try {
        routing = require('./memoryConfig').config.tag_routing || {};
    } catch (_) { return []; }
    if (typeof routing !== 'object' || Array.isArray(routing)) return [];

    const out = [];
    for (const def of ROUTABLE_TAGS) {
        const name = routing[def.tag];
        if (typeof name !== 'string' || !name.trim()) continue;
        out.push({ tag: def.tag, name: name.trim(), category: def.category, galaxy: def.galaxy, label: def.label });
    }
    return out;
}

// 给 prompt 用的说明段（Scribe 的 value_tags 那一节直接从这儿拼）。
//
// ⚠️ 只在**已经配置了**的标才写进 prompt：没配的标让模型吐出来也没地方去，
// 只会白占注意力、还可能挤掉别的标签的判断。
function renderTagSpecForPrompt() {
    const active = new Set(getTagRouting().map(d => d.tag));
    const rows = ROUTABLE_TAGS.filter(def => active.has(def.tag));
    if (rows.length === 0) return '';
    return rows.map(def =>
        `- **${def.tag}** — ${def.desc}\n` +
        `  ⚠️ ${def.exclude}\n` +
        `  标了就意味着这条会**单独进一颗星座**（系统按标直连），所以**宁可漏标不可误标**。`
    ).join('\n');
}

module.exports = { ROUTABLE_TAGS, getTagRouting, renderTagSpecForPrompt };
