// ========================================
// 记忆星图 v5 — 布局层
// 三套确定性布局：universe / galaxy 俯瞰 / constellation 展开
// 所有随机量来自 mulberry32(seed)，刷新零抖动
// ========================================

import { GALAXIES, GALAXY_BY_ID, strHash, mulberry32, consOfGalaxy, universe } from './data.js';

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

// ── universe 视图 ──
// 双星核心居中；四星系按固定方位角环绕；星系内星座做种子化 spiral 摆位（星团点）
export function layoutUniverse(W, H) {
    const cx = W / 2, cy = H / 2;
    const orbitR = Math.min(W, H) * 0.32;
    const galaxies = GALAXIES.map(g => {
        const ang = g.azimuth * Math.PI / 180;
        const gx = cx + Math.cos(ang) * orbitR * (W > H ? 1.25 : 0.9);
        const gy = cy + Math.sin(ang) * orbitR;
        const cons = consOfGalaxy(g.id);
        const nebulaR = Math.min(W, H) * 0.17 + Math.sqrt(cons.length + 1) * 6;
        // 星系内星座：种子化 sunflower spiral（按碎片数降序，大的居中）
        const sorted = [...cons].sort((a, b) => (b.fragment_count || 0) - (a.fragment_count || 0));
        const rng = mulberry32(strHash(g.id));
        const points = sorted.map((c, i) => {
            const angle = i * GOLDEN + rng() * 0.5;
            const r = nebulaR * 0.78 * Math.sqrt((i + 0.5) / Math.max(sorted.length, 1));
            return {
                con: c,
                x: gx + Math.cos(angle) * r,
                y: gy + Math.sin(angle) * r,
                r: Math.max(2.2, Math.min(7, 2 + Math.sqrt(c.stars.length) * 0.9)),
            };
        });
        return { galaxy: g, x: gx, y: gy, nebulaR, points };
    });
    return { cx, cy, coreOrbitR: Math.min(W, H) * 0.035, galaxies };
}

// ── galaxy 俯瞰视图 ──
// 该星系星座全屏 spiral 铺开，星座半径 ∝ sqrt(star数)，星座内有个体星点
export function layoutGalaxy(galaxyId, W, H) {
    const cons = [...consOfGalaxy(galaxyId)].sort((a, b) => (b.fragment_count || 0) - (a.fragment_count || 0));
    const cx = W / 2, cy = H / 2;
    const maxR = Math.min(W, H) * 0.40;
    const placed = [];
    cons.forEach((c, i) => {
        const seed = strHash(c.id + c.label);
        const rng = mulberry32(seed);
        const angle = i * GOLDEN + rng() * 0.6;
        const r = maxR * Math.sqrt((i + 0.5) / Math.max(cons.length, 1));
        const conX = cx + Math.cos(angle) * r * (W > H ? 1.35 : 1);
        const conY = cy + Math.sin(angle) * r;
        const conR = Math.min(110, 26 + Math.sqrt(c.stars.length) * 13);
        placed.push({ con: c, x: conX, y: conY, r: conR, stars: layoutStarsInCon(c, conX, conY, conR) });
    });
    return { galaxy: GALAXY_BY_ID[galaxyId], cx, cy, cons: placed };
}

// ── constellation 展开视图 ──
// 星星全屏环绕分布：亮星（conf 高）靠内大，暗星靠外小
export function layoutConstellation(con, W, H) {
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) * 0.36;
    const stars = layoutStarsInCon(con, cx, cy, R, true);
    return { con, cx, cy, R, stars };
}

// 星座内星点排布（共用）：seed=fragment id；expanded 模式按 conf 排序内亮外暗
function layoutStarsInCon(con, cx, cy, R, expanded = false) {
    const list = expanded
        ? [...con.stars].sort((a, b) => (b.conf || 0) - (a.conf || 0))
        : con.stars;
    const n = Math.max(list.length, 1);
    return list.map((s, i) => {
        const seed = strHash(s.id);
        const rng = mulberry32(seed);
        const angle = i * GOLDEN + rng() * (expanded ? 0.9 : 1.6);
        // expanded: 排序后 spiral 半径自然内→外；cluster: 全随机散布
        const rNorm = expanded ? Math.sqrt((i + 0.5) / n) : (0.25 + rng() * 0.75);
        const r = R * (expanded ? (0.18 + rNorm * 0.82) : rNorm);
        const baseR = Math.max(1.4, 6.2 - (s.mag || 4) * 0.72) * (expanded ? 1.5 : 0.55);
        return {
            star: s,
            x: cx + Math.cos(angle) * r,
            y: cy + Math.sin(angle) * r,
            baseR,
            phase: rng() * Math.PI * 2,
        };
    });
}

// ── 桥线查询 ──
// universe 层级：星系间聚合桥端点
export function universeBridgeSegments(uLayout) {
    const gPos = Object.fromEntries(uLayout.galaxies.map(g => [g.galaxy.id, g]));
    return universe.galaxyBridges.map(br => {
        const a = gPos[br.a], b = gPos[br.b];
        if (!a || !b) return null;
        return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, weight: br.weight, r1: a.nebulaR, r2: b.nebulaR };
    }).filter(Boolean);
}

// galaxy 层级：该星系内部星座间的桥 + 跨星系桥只画到屏幕边缘方向的提示（省略，画内部桥即可）
export function galaxyBridgeSegments(gLayout) {
    const pos = Object.fromEntries(gLayout.cons.map(p => [p.con.id, p]));
    return universe.bridges.map(br => {
        const a = pos[br.a], b = pos[br.b];
        if (!a || !b) return null; // 只画两端都在本星系的桥
        return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, weight: br.weight, r1: a.r, r2: b.r };
    }).filter(Boolean);
}

// constellation 层级：与当前星座有桥的其他星座（供面板/提示显示）
export function bridgesOfCon(conId) {
    return universe.bridges
        .filter(br => br.a === conId || br.b === conId)
        .map(br => ({ otherId: br.a === conId ? br.b : br.a, weight: br.weight, relation: br.relation || '' }));
}
