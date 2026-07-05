// ========================================
// 记忆星图 v5 — 渲染层
// 双 canvas：#bg 静态层（离屏预渲染） + #mc 主层（每帧）
// 星云离屏缓存、双星核心、星点/星芒、桥线、相机（pan/zoom/视差）
// ========================================

import { GALAXIES, universe, hslToRgbStr, GALAXY_BY_ID, strHash, mulberry32 } from './data.js';
import { layoutUniverse, layoutGalaxy, layoutConstellation, universeBridgeSegments, galaxyBridgeSegments } from './layout.js';
import { view } from './state.js';
import { conById } from './data.js';

let W = 0, H = 0, dpr = 1;
let bgC, mc, bx, ctx;

// 相机（每个视图层级进入时重置）
export const camera = { scale: 1, panX: 0, panY: 0, tScale: 1, tPanX: 0, tPanY: 0 };
export function resetCamera() {
    camera.tScale = 1; camera.tPanX = 0; camera.tPanY = 0;
}
export function zoomBy(factor) {
    camera.tScale = Math.min(4, Math.max(0.4, camera.tScale * factor));
}
export function panBy(dx, dy) {
    camera.tPanX += dx; camera.tPanY += dy;
}

// 世界坐标 → 屏幕坐标（depth 视差：pan 乘 depth）
function w2s(wx, wy, depth = 1) {
    const s = camera.scale;
    return {
        x: W / 2 + (wx - W / 2) * s + camera.panX * depth,
        y: H / 2 + (wy - H / 2) * s + camera.panY * depth,
    };
}

// ── 布局缓存 ──
let uLayout = null, gLayout = null, cLayout = null;
let uBridges = [], gBridges = [];

export function rebuildLayouts() {
    if (!universe.loaded) return;
    uLayout = layoutUniverse(W, H);
    uBridges = universeBridgeSegments(uLayout);
    if (view.galaxyId) {
        gLayout = layoutGalaxy(view.galaxyId, W, H);
        gBridges = galaxyBridgeSegments(gLayout);
    } else { gLayout = null; gBridges = []; }
    if (view.conId) {
        const con = conById(view.conId);
        cLayout = con ? layoutConstellation(con, W, H) : null;
    } else cLayout = null;
}

// ── 背景层：深空 + 背景星，离屏预渲染一次 ──
let bgSprite = null;
let bgStars = [];

function prerenderBg() {
    bgSprite = document.createElement('canvas');
    bgSprite.width = W * dpr; bgSprite.height = H * dpr;
    const c = bgSprite.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 深空底色：多层暗色 radial
    c.fillStyle = '#020410'; c.fillRect(0, 0, W, H);
    const rng = mulberry32(7741);
    [[.18, .25, 232, .5], [.78, .6, 252, .42], [.45, .85, 215, .35], [.6, .15, 268, .3]].forEach(([nx, ny, hue, a]) => {
        const g = c.createRadialGradient(nx * W, ny * H, 0, nx * W, ny * H, Math.max(W, H) * .42);
        g.addColorStop(0, `hsla(${hue},55%,10%,${a})`);
        g.addColorStop(1, 'transparent');
        c.fillStyle = g; c.fillRect(0, 0, W, H);
    });
    // 银河带：对角暗淡光带
    c.save();
    c.translate(W / 2, H / 2); c.rotate(-0.42);
    const band = c.createLinearGradient(0, -H * .22, 0, H * .22);
    band.addColorStop(0, 'transparent');
    band.addColorStop(.5, 'rgba(120,135,200,0.05)');
    band.addColorStop(1, 'transparent');
    c.fillStyle = band;
    c.fillRect(-Math.max(W, H), -H * .25, Math.max(W, H) * 2, H * .5);
    c.restore();
    // 背景星
    bgStars = [];
    for (let i = 0; i < 460; i++) {
        bgStars.push({
            x: rng() * W, y: rng() * H,
            r: Math.pow(rng(), 2.4) * 1.3 + .12,
            a: rng() * .4 + .06,
            t: rng() * Math.PI * 2,
        });
    }
    bgStars.forEach(s => {
        c.beginPath(); c.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        c.fillStyle = `rgba(208,218,255,${s.a})`; c.fill();
    });
}

// 背景闪烁：每帧仅绘制 sprite + 少量亮星 twinkle
let twinkleSet = [];
function drawBgFrame(T) {
    bx.clearRect(0, 0, W, H);
    bx.drawImage(bgSprite, 0, 0, W, H);
    if (!twinkleSet.length && bgStars.length) {
        twinkleSet = bgStars.filter(s => s.r > .8).slice(0, 60);
    }
    twinkleSet.forEach(s => {
        const ta = s.a * (.4 + .6 * Math.abs(Math.sin(T * .7 + s.t)));
        bx.beginPath(); bx.arc(s.x, s.y, s.r * 1.2, 0, Math.PI * 2);
        bx.fillStyle = `rgba(215,225,255,${ta})`; bx.fill();
    });
}

// ── 星云：每星系离屏预渲染一张 sprite ──
const nebulaSprites = new Map(); // galaxyId → {canvas, size}

function prerenderNebula(galaxyId, radius) {
    const g = GALAXY_BY_ID[galaxyId];
    const size = Math.ceil(radius * 2.8);
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const c = cv.getContext('2d');
    const ctr = size / 2;
    const rng = mulberry32(strHash('nebula:' + galaxyId));
    // 6-10 个椭圆团块
    const blobs = 6 + Math.floor(rng() * 5);
    for (let i = 0; i < blobs; i++) {
        const ang = rng() * Math.PI * 2;
        const dist = rng() * radius * 0.55;
        const bxp = ctr + Math.cos(ang) * dist;
        const byp = ctr + Math.sin(ang) * dist;
        const br = radius * (0.35 + rng() * 0.5);
        const hueOff = (rng() - 0.5) * 30;
        const alpha = 0.05 + rng() * 0.06;
        c.save();
        c.translate(bxp, byp);
        c.rotate(rng() * Math.PI);
        c.scale(1, 0.55 + rng() * 0.45);
        const grad = c.createRadialGradient(0, 0, 0, 0, 0, br);
        grad.addColorStop(0, `hsla(${(g.hue + hueOff + 360) % 360},65%,58%,${alpha})`);
        grad.addColorStop(0.55, `hsla(${(g.hue + hueOff + 360) % 360},60%,45%,${alpha * 0.45})`);
        grad.addColorStop(1, 'transparent');
        c.fillStyle = grad;
        c.beginPath(); c.arc(0, 0, br, 0, Math.PI * 2); c.fill();
        c.restore();
    }
    // 尘埃带：一条贯穿的暗色带
    c.save();
    c.translate(ctr, ctr);
    c.rotate(rng() * Math.PI);
    const dust = c.createLinearGradient(0, -radius * 0.18, 0, radius * 0.18);
    dust.addColorStop(0, 'transparent');
    dust.addColorStop(0.5, 'rgba(4,6,16,0.32)');
    dust.addColorStop(1, 'transparent');
    c.fillStyle = dust;
    c.fillRect(-radius * 1.1, -radius * 0.2, radius * 2.2, radius * 0.4);
    c.restore();
    // 微尘颗粒
    const grains = 55 + Math.floor(rng() * 30);
    for (let i = 0; i < grains; i++) {
        const ang = rng() * Math.PI * 2;
        const dist = Math.sqrt(rng()) * radius * 0.9;
        c.beginPath();
        c.arc(ctr + Math.cos(ang) * dist, ctr + Math.sin(ang) * dist, rng() * 0.9 + 0.15, 0, Math.PI * 2);
        c.fillStyle = `hsla(${g.hue},50%,75%,${rng() * 0.22 + 0.04})`;
        c.fill();
    }
    nebulaSprites.set(galaxyId, { canvas: cv, size });
}

function ensureNebulae() {
    if (!uLayout) return;
    uLayout.galaxies.forEach(gl => {
        const cached = nebulaSprites.get(gl.galaxy.id);
        const want = Math.ceil(gl.nebulaR * 2.8);
        if (!cached || Math.abs(cached.size - want) > 40) prerenderNebula(gl.galaxy.id, gl.nebulaR);
    });
}

// ── 双星核心 ──
const UI = window.MEMORY_UI_CONFIG || { user: { name: 'User', color: '#ffe0aa' }, ai: { name: 'AI', color: '#aae6c8' } };
const CORE_STYLE = {
    [UI.user.name]: { rgb: hexToRgbStr(UI.user.color), label: UI.user.name },
    [UI.ai.name]:   { rgb: hexToRgbStr(UI.ai.color),   label: UI.ai.name },
};
let corePos = []; // 每帧更新，供 hitTest

function hexToRgbStr(hex) {
    const c = hex.replace('#', '');
    return `${parseInt(c.slice(0,2),16)},${parseInt(c.slice(2,4),16)},${parseInt(c.slice(4,6),16)}`;
}

function drawCore(T, cx, cy, orbitR, alpha, hovered) {
    corePos = [];
    const names = [UI.user.name, UI.ai.name];
    names.forEach((name, i) => {
        const ent = universe.core.find(e => e.name === name);
        const ang = T * 0.18 + i * Math.PI;
        const ex = cx + Math.cos(ang) * orbitR * 1.35;
        const ey = cy + Math.sin(ang) * orbitR * 0.7;
        const st = CORE_STYLE[name] || { rgb: '255,255,255', label: name };
        const r = i === 0 ? 7.5 : 6.5;
        const isHov = hovered && hovered.type === 'core' && hovered.name === name;
        const rr = r * (isHov ? 1.25 : 1);
        // 大光晕
        const halo = ctx.createRadialGradient(ex, ey, 0, ex, ey, rr * 14);
        halo.addColorStop(0, `rgba(${st.rgb},${0.10 * alpha})`);
        halo.addColorStop(0.4, `rgba(${st.rgb},${0.035 * alpha})`);
        halo.addColorStop(1, 'transparent');
        ctx.beginPath(); ctx.arc(ex, ey, rr * 14, 0, Math.PI * 2); ctx.fillStyle = halo; ctx.fill();
        // 核心
        const core = ctx.createRadialGradient(ex, ey, 0, ex, ey, rr * 2.4);
        core.addColorStop(0, `rgba(255,255,255,${0.95 * alpha})`);
        core.addColorStop(0.35, `rgba(${st.rgb},${0.7 * alpha})`);
        core.addColorStop(1, 'transparent');
        ctx.beginPath(); ctx.arc(ex, ey, rr * 2.4, 0, Math.PI * 2); ctx.fillStyle = core; ctx.fill();
        // 星芒
        for (let a = 0; a < 4; a++) spikeAt(ctx, ex, ey, rr * 0.5, a * Math.PI / 2 + T * 0.05, rr * 8, 0.5 * alpha, st.rgb);
        // 标签
        ctx.font = `500 11px 'Inter','PingFang SC',sans-serif`;
        ctx.fillStyle = `rgba(${st.rgb},${0.75 * alpha})`;
        ctx.textAlign = 'center';
        ctx.fillText(name, ex, ey + rr * 4.2);
        corePos.push({ name, x: ex, y: ey, r: rr * 3, ent });
    });
    // 双星间细弱光弧
    if (corePos.length === 2) {
        const [a, b] = corePos;
        const lg = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        lg.addColorStop(0, `rgba(${CORE_STYLE.Clara.rgb},${0.16 * alpha})`);
        lg.addColorStop(1, `rgba(${CORE_STYLE.Draco.rgb},${0.16 * alpha})`);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = lg; ctx.lineWidth = 0.7; ctx.stroke();
    }
}

// ── 通用绘制原语 ──
function spikeAt(c, x, y, fromR, ang, len, alpha, rgb) {
    c.save(); c.translate(x, y); c.rotate(ang);
    const g = c.createLinearGradient(fromR, 0, len, 0);
    g.addColorStop(0, `rgba(${rgb},${alpha})`); g.addColorStop(1, `rgba(${rgb},0)`);
    c.beginPath(); c.moveTo(fromR, 0); c.lineTo(len, 0);
    c.strokeStyle = g; c.lineWidth = 0.55; c.stroke();
    c.restore();
}

// 星点：小星走廉价路径（纯圆点），亮星/大星走光晕+星芒
// lifecycle: active=正常 / cooling=暗红余烬 / frozen=灰白残骸
function drawStar(x, y, r, rgb, conf, alpha, pulse, isHov, isSel, T, lifecycle) {
    if (lifecycle === 'cooling') {
        // 余烬：暗红、无星芒、缓慢呼吸
        const er = Math.max(0.8, r * 0.7);
        const breathe = 0.6 + 0.4 * Math.abs(Math.sin(T * 0.4 + x * 0.01));
        const eg = ctx.createRadialGradient(x, y, 0, x, y, er * 2.5);
        eg.addColorStop(0, `rgba(200,80,60,${0.35 * alpha * breathe})`);
        eg.addColorStop(1, 'transparent');
        ctx.beginPath(); ctx.arc(x, y, er * 2.5, 0, Math.PI * 2); ctx.fillStyle = eg; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, er * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,140,100,${0.5 * alpha * breathe})`; ctx.fill();
        if (isHov || isSel) {
            ctx.beginPath(); ctx.arc(x, y, er * 3, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(200,90,70,0.3)`; ctx.lineWidth = 0.6;
            ctx.setLineDash([2, 4]); ctx.stroke(); ctx.setLineDash([]);
        }
        return;
    }
    if (lifecycle === 'frozen') {
        // 残骸：灰白小点，几乎熄灭
        const fr = Math.max(0.5, r * 0.45);
        ctx.beginPath(); ctx.arc(x, y, fr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(150,155,170,${0.28 * alpha})`; ctx.fill();
        if (isHov || isSel) {
            ctx.beginPath(); ctx.arc(x, y, fr * 4, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(160,165,180,0.25)'; ctx.lineWidth = 0.5;
            ctx.setLineDash([2, 4]); ctx.stroke(); ctx.setLineDash([]);
        }
        return;
    }
    const rr = r * (isSel ? 1.9 : isHov ? 1.45 : 1) * pulse;
    if (rr < 1.6 && !isHov && !isSel) {
        ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, rr), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},${0.75 * alpha})`; ctx.fill();
        return;
    }
    const glow = ctx.createRadialGradient(x, y, 0, x, y, rr * 4);
    glow.addColorStop(0, `rgba(${rgb},${0.32 * alpha})`);
    glow.addColorStop(0.5, `rgba(${rgb},${0.08 * alpha})`);
    glow.addColorStop(1, 'transparent');
    ctx.beginPath(); ctx.arc(x, y, rr * 4, 0, Math.PI * 2); ctx.fillStyle = glow; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, rr * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${(isSel ? 1 : 0.92) * alpha})`; ctx.fill();
    // 亮星星芒（conf 高 = 记忆鲜活）
    if (conf > 0.62 || isHov || isSel) {
        const len = rr * (isSel ? 8 : isHov ? 6.5 : 5);
        const sa = (isSel ? 0.7 : isHov ? 0.55 : 0.38) * alpha;
        for (let a = 0; a < 4; a++) spikeAt(ctx, x, y, rr * 0.45, a * Math.PI / 2, len, sa, rgb);
        for (let a = 0; a < 4; a++) spikeAt(ctx, x, y, rr * 0.45, a * Math.PI / 2 + Math.PI / 4, len * 0.45, sa * 0.4, rgb);
    }
    // 选中/悬停轨道环
    if (isHov || isSel) {
        const ringR = rr * 4.2;
        ctx.beginPath(); ctx.arc(x, y, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb},${isSel ? 0.3 : 0.17})`;
        ctx.lineWidth = 0.6; ctx.setLineDash([3, 5]); ctx.stroke(); ctx.setLineDash([]);
        const bAng = T * 1.1;
        const bX = x + Math.cos(bAng) * ringR, bY = y + Math.sin(bAng) * ringR;
        const bg2 = ctx.createRadialGradient(bX, bY, 0, bX, bY, 3);
        bg2.addColorStop(0, `rgba(${rgb},0.85)`); bg2.addColorStop(1, 'transparent');
        ctx.beginPath(); ctx.arc(bX, bY, 3, 0, Math.PI * 2); ctx.fillStyle = bg2; ctx.fill();
    }
}

function drawBridge(x1, y1, x2, y2, weight, alpha) {
    const w = Math.min(1.6, 0.4 + weight * 0.06);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.strokeStyle = `rgba(150,170,230,${Math.min(0.3, 0.05 + weight * 0.012) * alpha})`;
    ctx.lineWidth = w;
    ctx.setLineDash([2, 7]);
    ctx.stroke();
    ctx.setLineDash([]);
}

function offScreen(x, y, m = 90) { return x < -m || x > W + m || y < -m || y > H + m; }

// ── 各视图渲染 ──

function drawUniverse(T, alpha, hovered) {
    // 星云（depth 0.6 视差）
    uLayout.galaxies.forEach(gl => {
        const sp = nebulaSprites.get(gl.galaxy.id);
        if (!sp) return;
        const p = w2s(gl.x, gl.y, 0.6);
        const drawSize = sp.size * camera.scale;
        const isHov = hovered && hovered.type === 'galaxy' && hovered.id === gl.galaxy.id;
        ctx.globalAlpha = alpha * (isHov ? 1 : 0.82);
        ctx.drawImage(sp.canvas, p.x - drawSize / 2, p.y - drawSize / 2, drawSize, drawSize);
        ctx.globalAlpha = 1;
    });
    // 星系间聚合桥
    uBridges.forEach(br => {
        const a = w2s(br.x1, br.y1, 0.6), b = w2s(br.x2, br.y2, 0.6);
        drawBridge(a.x, a.y, b.x, b.y, br.weight * 0.25, alpha * 0.8);
    });
    // 星系内星座（星团光点，depth 0.85）
    uLayout.galaxies.forEach(gl => {
        const isHovG = hovered && hovered.type === 'galaxy' && hovered.id === gl.galaxy.id;
        gl.points.forEach(pt => {
            const p = w2s(pt.x, pt.y, 0.85);
            if (offScreen(p.x, p.y)) return;
            const pulse = Math.sin(T * 1.2 + strHash(pt.con.id) % 7) * 0.15 + 0.92;
            drawStar(p.x, p.y, pt.r * camera.scale, pt.con.rgb, 0.5, alpha * (isHovG ? 1 : 0.85), pulse, false, false, T);
        });
        // 星系标签
        const lp = w2s(gl.x, gl.y + gl.nebulaR * 1.02, 0.85);
        ctx.font = `500 ${isHovG ? 14 : 12.5}px 'Inter','PingFang SC',sans-serif`;
        ctx.fillStyle = `hsla(${gl.galaxy.hue},70%,75%,${(isHovG ? 0.95 : 0.6) * alpha})`;
        ctx.textAlign = 'center';
        ctx.fillText(gl.galaxy.id + '星系', lp.x, lp.y);
        ctx.font = `400 9.5px 'Inter','PingFang SC',sans-serif`;
        ctx.fillStyle = `hsla(${gl.galaxy.hue},45%,70%,${0.32 * alpha})`;
        ctx.fillText(`${gl.points.length} 星座`, lp.x, lp.y + 15);
    });
    // 双星核心（depth 1.0）
    const cp = w2s(uLayout.cx, uLayout.cy, 1.0);
    drawCore(T, cp.x, cp.y, uLayout.coreOrbitR * camera.scale, alpha, hovered);
}

function drawGalaxy(T, alpha, hovered, selected) {
    if (!gLayout) return;
    const g = gLayout.galaxy;
    // 大星云背景（居中放大、低 alpha）
    const sp = nebulaSprites.get(g.id);
    if (sp) {
        const p = w2s(gLayout.cx, gLayout.cy, 0.5);
        const size = Math.max(W, H) * 1.15 * camera.scale;
        ctx.globalAlpha = alpha * 0.5;
        ctx.drawImage(sp.canvas, p.x - size / 2, p.y - size / 2, size, size);
        ctx.globalAlpha = 1;
    }
    // 星座间桥线
    gBridges.forEach(br => {
        const a = w2s(br.x1, br.y1, 0.9), b = w2s(br.x2, br.y2, 0.9);
        drawBridge(a.x, a.y, b.x, b.y, br.weight, alpha);
    });
    // 星座
    gLayout.cons.forEach(pc => {
        const cp = w2s(pc.x, pc.y, 0.9);
        if (offScreen(cp.x, cp.y, (pc.hitR || pc.r) * camera.scale + 120)) return;
        const isHov = hovered && hovered.type === 'con' && hovered.id === pc.con.id;
        const conAlpha = alpha * (isHov ? 1 : 0.88);
        // 星座连线（顺序链）
        const pts = pc.stars.map(st => w2s(st.x, st.y, 0.9));
        ctx.beginPath();
        pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.strokeStyle = `rgba(${pc.con.rgb},${0.10 * conAlpha})`;
        ctx.lineWidth = 0.5; ctx.stroke();
        // 星点
        pc.stars.forEach((st, i) => {
            const p = pts[i];
            if (offScreen(p.x, p.y)) return;
            const pulse = Math.sin(T * 1.25 + st.phase) * 0.18 + 0.9;
            drawStar(p.x, p.y, st.baseR * camera.scale, pc.con.rgb, st.star.conf || 0.5, conAlpha, pulse, false, false, T, st.star.lifecycle);
        });
        // hover 范围环（用点击半径 hitR）
        if (isHov) {
            const hr = (pc.hitR || pc.r) * camera.scale;
            ctx.beginPath(); ctx.arc(cp.x, cp.y, hr * 1.05, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(${pc.con.rgb},0.22)`; ctx.lineWidth = 0.8;
            ctx.setLineDash([4, 6]); ctx.stroke(); ctx.setLineDash([]);
        }
        // 标签（用视觉半径 r 定位）
        const lp = w2s(pc.x, pc.y - pc.r - 12, 0.9);
        ctx.font = `${isHov ? 500 : 400} ${isHov ? 12.5 : 11}px 'Inter','PingFang SC',sans-serif`;
        ctx.fillStyle = `rgba(${pc.con.rgb},${(isHov ? 0.95 : 0.62) * conAlpha})`;
        ctx.textAlign = 'center';
        ctx.fillText(pc.con.label, lp.x, lp.y);
    });
}

function drawConstellation(T, alpha, hovered, selected) {
    if (!cLayout) return;
    const con = cLayout.con;
    // 微弱星云底（该星系色）
    const sp = nebulaSprites.get(con.galaxyLabel);
    if (sp) {
        const p = w2s(cLayout.cx, cLayout.cy, 0.45);
        const size = Math.max(W, H) * 1.3 * camera.scale;
        ctx.globalAlpha = alpha * 0.3;
        ctx.drawImage(sp.canvas, p.x - size / 2, p.y - size / 2, size, size);
        ctx.globalAlpha = 1;
    }
    // 连线
    const pts = cLayout.stars.map(st => w2s(st.x, st.y, 1));
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = `rgba(${con.rgb},${0.13 * alpha})`;
    ctx.lineWidth = 0.6; ctx.stroke();
    // 连线流光
    if (pts.length > 1) {
        const ph = (T * 0.25) % 1;
        const segIdx = Math.floor(ph * (pts.length - 1));
        const segT = ph * (pts.length - 1) - segIdx;
        const a = pts[segIdx], b = pts[segIdx + 1] || a;
        const fx = a.x + (b.x - a.x) * segT, fy = a.y + (b.y - a.y) * segT;
        const fg = ctx.createRadialGradient(fx, fy, 0, fx, fy, 4);
        fg.addColorStop(0, `rgba(${con.rgb},0.6)`); fg.addColorStop(1, 'transparent');
        ctx.beginPath(); ctx.arc(fx, fy, 4, 0, Math.PI * 2); ctx.fillStyle = fg; ctx.fill();
    }
    // 星点
    cLayout.stars.forEach((st, i) => {
        const p = pts[i];
        if (offScreen(p.x, p.y)) return;
        const isHov = hovered && hovered.type === 'star' && hovered.id === st.star.id;
        const isSel = view.level === 'star' && view.starId === st.star.id;
        const dim = view.level === 'star' && !isSel ? 0.45 : 1;
        const pulse = Math.sin(T * 1.25 + st.phase) * 0.18 + 0.9;
        drawStar(p.x, p.y, st.baseR * camera.scale, con.rgb, st.star.conf || 0.5, alpha * dim, pulse, isHov, isSel, T, st.star.lifecycle);
    });
    // 星座名（顶部居中淡显示）
    ctx.font = `500 13px 'Inter','PingFang SC',sans-serif`;
    ctx.fillStyle = `rgba(${con.rgb},${0.4 * alpha})`;
    ctx.textAlign = 'center';
    ctx.fillText(con.label, W / 2, 64);
}

// ── 主绘制入口 ──
export function drawFrame(T, hovered) {
    // 相机缓动
    camera.scale += (camera.tScale - camera.scale) * 0.085;
    camera.panX += (camera.tPanX - camera.panX) * 0.085;
    camera.panY += (camera.tPanY - camera.panY) * 0.085;
    // 过渡淡入
    if (view.transition < 1) view.transition = Math.min(1, view.transition + 0.055);
    const alpha = 0.25 + view.transition * 0.75;

    drawBgFrame(T);
    ctx.clearRect(0, 0, W, H);
    if (!universe.loaded || !uLayout) return;

    switch (view.level) {
        case 'universe': drawUniverse(T, alpha, hovered); break;
        case 'galaxy': drawGalaxy(T, alpha, hovered); break;
        case 'constellation':
        case 'star': drawConstellation(T, alpha, hovered); break;
    }
}

// ── 命中测试（屏幕坐标），按视图层级 ──
export function hitTest(mx, my) {
    if (!universe.loaded || !uLayout) return null;
    if (view.level === 'universe') {
        // 双星核心
        for (const cs of corePos) {
            if (Math.hypot(mx - cs.x, my - cs.y) < cs.r + 8) return { type: 'core', name: cs.name, ent: cs.ent };
        }
        // 星系（星云圆域）
        for (const gl of uLayout.galaxies) {
            const p = w2s(gl.x, gl.y, 0.6);
            if (Math.hypot(mx - p.x, my - p.y) < gl.nebulaR * camera.scale) return { type: 'galaxy', id: gl.galaxy.id };
        }
        return null;
    }
    if (view.level === 'galaxy' && gLayout) {
        // 星座（星团圆域，从小到大检测避免大圆吞小圆）
        const sorted = [...gLayout.cons].sort((a, b) => (a.hitR || a.r) - (b.hitR || b.r));
        for (const pc of sorted) {
            const p = w2s(pc.x, pc.y, 0.9);
            const hr = (pc.hitR || pc.r) * camera.scale;
            if (Math.hypot(mx - p.x, my - p.y) < hr + 8) return { type: 'con', id: pc.con.id, con: pc.con };
        }
        return null;
    }
    if ((view.level === 'constellation' || view.level === 'star') && cLayout) {
        let best = null, bestD = 1e9;
        for (const st of cLayout.stars) {
            const p = w2s(st.x, st.y, 1);
            const d = Math.hypot(mx - p.x, my - p.y);
            if (d < st.baseR * camera.scale + 10 && d < bestD) { bestD = d; best = { type: 'star', id: st.star.id, star: st.star }; }
        }
        return best;
    }
    return null;
}

// ── 初始化 / resize ──
export function initRender(bgEl, mcEl) {
    bgC = bgEl; mc = mcEl;
    bx = bgC.getContext('2d');
    ctx = mc.getContext('2d');
    resizeRender();
}
export function resizeRender() {
    W = innerWidth; H = innerHeight;
    dpr = Math.min(devicePixelRatio || 1, 2);
    [bgC, mc].forEach(c => {
        c.width = W * dpr; c.height = H * dpr;
        c.style.width = W + 'px'; c.style.height = H + 'px';
    });
    bx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    prerenderBg();
    twinkleSet = [];
    rebuildLayouts();
    ensureNebulae();
}

export function onDataLoaded() {
    rebuildLayouts();
    ensureNebulae();
}

export function getSize() { return { W, H }; }
