// ========================================
// 记忆星图 v5 — 数据层
// fetch universe API、星系定义、颜色分配（hash hue 偏移）、跨星系桥推导
// ========================================

const TOKEN = () => localStorage.getItem('token');
const AUTH = () => ({ headers: { 'Authorization': `Bearer ${TOKEN()}` } });

// ── 五固定星系（方位角：上/右上/右下/左下/左上） ──
// 「{{user}}的」星系 ID 由 memory_config.json 动态生成
const UI = window.MEMORY_UI_CONFIG || { user: { name: 'User' } };
export const OWN_GALAXY_ID = UI.user.name + '的';

export const GALAXIES = [
    { id: '爱好',       hue: 0,   azimuth: -90,  desc: OWN_GALAXY_ID + '星系——音乐、书籍、电影等兴趣爱好' },
    { id: '社交',       hue: 22,  azimuth: -18,  desc: '人际关系网' },
    { id: OWN_GALAXY_ID, hue: 275, azimuth: 54,   desc: '创作产出与项目' },
    { id: '事件',       hue: 152, azimuth: 126,  desc: '有时间跨度的经历' },
    { id: '地点',       hue: 215, azimuth: 198,  desc: '走过的物理空间' },
];
export const GALAXY_BY_ID = Object.fromEntries(GALAXIES.map(g => [g.id, g]));

// ── 确定性 hash / PRNG ──
export function strHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── 星系色相家族：基准 hue + 名字 hash 偏移 ±25° ──
export function colorFor(galaxyId, name) {
    const g = GALAXY_BY_ID[galaxyId] || GALAXIES[0];
    const h = strHash(name);
    const hue = (g.hue + (h % 51) - 25 + 360) % 360;
    const sat = 62 + ((h >>> 8) % 18);          // 62-79%
    const lit = 62 + ((h >>> 16) % 14);         // 62-75%
    return { hue, sat, lit, css: `hsl(${hue},${sat}%,${lit}%)` };
}

export function hslToRgbStr(hue, sat, lit) {
    const s = sat / 100, l = lit / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (hue < 60) [r, g, b] = [c, x, 0];
    else if (hue < 120) [r, g, b] = [x, c, 0];
    else if (hue < 180) [r, g, b] = [0, c, x];
    else if (hue < 240) [r, g, b] = [0, x, c];
    else if (hue < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return `${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)}`;
}

// ── 宇宙数据（模块内单例） ──
export const universe = {
    constellations: [],   // 普通星座（不含 Clara/Draco）
    core: [],             // 双星核心档案
    cognitiveModel: [],
    archlog: [],
    mergeProposals: [],   // 待 Clara 裁决的合并提案
    bridges: [],          // 星座桥 [{a, b, weight}]（conId 对）
    galaxyBridges: [],    // 星系聚合桥 [{a, b, weight}]（galaxyId 对）
    totalFragments: 0,
    loaded: false,
};

// 桥推导，两个来源：
// 1) 后端 related_entities（Archivist 维护，带关系描述）— 优先
// 2) 共享碎片推导（前端兜底，无语义标签）
function deriveBridges(cons) {
    const conByEntId = new Map(); // 数字实体id → con
    cons.forEach(c => conByEntId.set(parseInt(c.id.slice(1), 10), c));

    // 来源1：related_entities
    const labeled = new Map(); // "a|b" → {weight, relation}
    cons.forEach(c => (c.relatedEntities || []).forEach(r => {
        if (!r || !r.id || !conByEntId.has(r.id)) return;
        const other = conByEntId.get(r.id);
        const key = c.id < other.id ? c.id + '|' + other.id : other.id + '|' + c.id;
        if (!labeled.has(key)) labeled.set(key, { weight: r.shared_count || 2, relation: r.relation || '' });
    }));
    if (labeled.size > 0) {
        const conById = Object.fromEntries(cons.map(c => [c.id, c]));
        const bridges = [];
        labeled.forEach((v, key) => {
            const [a, b] = key.split('|');
            bridges.push({ a, b, weight: v.weight, relation: v.relation });
        });
        const gPair = new Map();
        bridges.forEach(br => {
            const ga = conById[br.a]?.galaxyLabel, gb = conById[br.b]?.galaxyLabel;
            if (!ga || !gb || ga === gb) return;
            const k = ga < gb ? ga + '|' + gb : gb + '|' + ga;
            gPair.set(k, (gPair.get(k) || 0) + br.weight);
        });
        const galaxyBridges = [];
        gPair.forEach((weight, k) => { const [a, b] = k.split('|'); galaxyBridges.push({ a, b, weight }); });
        return { bridges, galaxyBridges };
    }
    // 来源2：兜底推导
    return deriveBridgesFromSharedFragments(cons);
}

function deriveBridgesFromSharedFragments(cons) {
    const fragMap = new Map(); // fragId → [conId]
    cons.forEach(c => c.stars.forEach(s => {
        if (!fragMap.has(s.id)) fragMap.set(s.id, []);
        fragMap.get(s.id).push(c.id);
    }));
    const pairCount = new Map(); // "a|b" → count
    fragMap.forEach(conIds => {
        if (conIds.length < 2) return;
        for (let i = 0; i < conIds.length; i++)
            for (let j = i + 1; j < conIds.length; j++) {
                const key = conIds[i] < conIds[j] ? conIds[i] + '|' + conIds[j] : conIds[j] + '|' + conIds[i];
                pairCount.set(key, (pairCount.get(key) || 0) + 1);
            }
    });
    const conById = Object.fromEntries(cons.map(c => [c.id, c]));
    const bridges = [];
    pairCount.forEach((count, key) => {
        if (count < 2) return; // 共享碎片 ≥2 才画桥
        const [a, b] = key.split('|');
        bridges.push({ a, b, weight: count });
    });
    // 星系级聚合
    const gPair = new Map();
    bridges.forEach(br => {
        const ga = conById[br.a]?.galaxyLabel, gb = conById[br.b]?.galaxyLabel;
        if (!ga || !gb || ga === gb) return;
        const key = ga < gb ? ga + '|' + gb : gb + '|' + ga;
        gPair.set(key, (gPair.get(key) || 0) + br.weight);
    });
    const galaxyBridges = [];
    gPair.forEach((weight, key) => {
        const [a, b] = key.split('|');
        galaxyBridges.push({ a, b, weight });
    });
    return { bridges, galaxyBridges };
}

export async function loadUniverse() {
    const resp = await fetch('/api/memory/universe', AUTH());
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();

    const cons = (data.constellations || []).map(c => {
        const galaxyLabel = c.galaxyLabel || OWN_GALAXY_ID;
        const col = colorFor(galaxyLabel, c.label);
        return {
            ...c,
            galaxyLabel,
            color: col.css,
            rgb: hslToRgbStr(col.hue, col.sat, col.lit),
            stars: (c.stars || []).map(s => ({
                ...s,
                conId: c.id,
                conLabel: c.label,
            })),
        };
    });

    const { bridges, galaxyBridges } = deriveBridges(cons);

    universe.constellations = cons;
    universe.core = data.core || [];
    universe.cognitiveModel = data.cognitiveModel || [];
    universe.patterns = data.patterns || [];
    universe.archlog = data.archlog || [];
    universe.mergeProposals = data.mergeProposals || [];
    universe.bridges = bridges;
    universe.galaxyBridges = galaxyBridges;
    universe.totalFragments = data.total_fragments || 0;
    universe.loaded = true;
    return universe;
}

export function consOfGalaxy(galaxyId) {
    return universe.constellations.filter(c => c.galaxyLabel === galaxyId);
}

export function conById(id) {
    return universe.constellations.find(c => c.id === id) || null;
}

// 碎片访问打点（刷新 decay 亮度），fire-and-forget
export function bumpAccess(starId) {
    if (starId && starId.startsWith('f')) {
        fetch('/api/memory/trace/' + starId.slice(1), AUTH()).catch(() => {});
    }
}

// 合并提案裁决（CSRF 由页面 meta 注入；memory.html 不走 api.js 的 fetch 补丁）
export async function decideMergeProposal(proposalId, decision) {
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    const resp = await fetch('/api/memory/merge-proposal/' + proposalId, {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${TOKEN()}`,
            'X-CSRF-Token': csrfMeta ? csrfMeta.getAttribute('content') : '',
        },
        body: JSON.stringify({ decision }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    universe.mergeProposals = universe.mergeProposals.filter(p => p.id !== proposalId);
    return resp.json();
}
