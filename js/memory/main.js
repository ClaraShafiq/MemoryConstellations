// ========================================
// 记忆星图 v5 — 入口
// 初始化、交互事件、主 rAF 循环、定时刷新
// ========================================

import { loadUniverse, universe, conById, bumpAccess, GALAXIES, OWN_GALAXY_ID } from './data.js';
import { view, onViewChange, gotoUniverse, gotoGalaxy, gotoConstellation, gotoStar, goUp } from './state.js';
import {
    initRender, resizeRender, drawFrame, hitTest, onDataLoaded,
    camera, resetCamera, zoomBy, panBy, rebuildLayouts,
} from './render.js';
import {
    renderBreadcrumb, renderTopCount, showConnectionLost,
    showStarPanel, showConPanel, showCorePanel, hidePanel,
    showTooltip, hideTooltip, renderArchlog, renderModelPanel, initPanelEvents,
    renderMergeProposals, renderCoreInsight,
} from './panels.js';

const mc = document.getElementById('mc');
let hovered = null;
let lastInteraction = Date.now();
let frameSkip = false;
function markInteraction() { lastInteraction = Date.now(); frameSkip = false; }

// ── 视图切换响应 ──
onViewChange(v => {
    resetCamera();
    rebuildLayouts();
    renderBreadcrumb();
    updateGalaxyPills();
    hovered = null;
    hideTooltip();
    // 面板联动
    if (v.level === 'constellation') {
        const con = conById(v.conId);
        if (con) showConPanel(con);
    } else if (v.level !== 'star') {
        hidePanel();
    }
});

// ── 交互：滚轮缩放 / 拖拽平移 ──
let isDrag = false, didDrag = false, lmx = 0, lmy = 0;

mc.addEventListener('wheel', e => {
    e.preventDefault();
    markInteraction();
    zoomBy(e.deltaY < 0 ? 1.11 : 0.9);
}, { passive: false });

mc.addEventListener('mousedown', e => {
    markInteraction();
    isDrag = true; didDrag = false;
    lmx = e.clientX; lmy = e.clientY;
});
window.addEventListener('mousemove', e => {
    if (isDrag) {
        markInteraction();
        const dx = e.clientX - lmx, dy = e.clientY - lmy;
        if (Math.abs(dx) + Math.abs(dy) > 3) didDrag = true;
        panBy(dx, dy);
        lmx = e.clientX; lmy = e.clientY;
    }
    onHover(e.clientX, e.clientY);
});
window.addEventListener('mouseup', () => { isDrag = false; });

// 触屏
let t0d = 0, t0s = 1;
mc.addEventListener('touchstart', e => {
    markInteraction();
    if (e.touches.length === 1) {
        isDrag = true; didDrag = false;
        lmx = e.touches[0].clientX; lmy = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
        isDrag = false;
        t0d = Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY);
        t0s = camera.tScale;
    }
}, { passive: false });
mc.addEventListener('touchmove', e => {
    e.preventDefault();
    markInteraction();
    if (e.touches.length === 1 && isDrag) {
        const dx = e.touches[0].clientX - lmx, dy = e.touches[0].clientY - lmy;
        if (Math.abs(dx) + Math.abs(dy) > 3) didDrag = true;
        panBy(dx, dy);
        lmx = e.touches[0].clientX; lmy = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY);
        camera.tScale = Math.min(4, Math.max(0.4, t0s * (d / t0d)));
    }
}, { passive: false });
mc.addEventListener('touchend', () => { isDrag = false; });

// ── hover ──
function onHover(mx, my) {
    hovered = hitTest(mx, my);
    mc.style.cursor = hovered ? 'pointer' : 'default';
    if (!hovered) { hideTooltip(); return; }
    switch (hovered.type) {
        case 'core': showTooltip(mx, my, hovered.name + ' · 双星核心'); break;
        case 'galaxy': showTooltip(mx, my, hovered.id + '星系'); break;
        case 'con': showTooltip(mx, my, `${hovered.con.label} · ${hovered.con.stars.length} 颗记忆`); break;
        case 'star': showTooltip(mx, my, `${hovered.star.title || '…'} · ${(hovered.star.mag || 4).toFixed(1)}等`); break;
    }
}

// ── click：状态机驱动 ──
mc.addEventListener('click', e => {
    if (didDrag) { didDrag = false; return; } // 拖拽结束不算点击
    markInteraction();
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) { goUp(); return; }
    switch (hit.type) {
        case 'core':
            showCorePanel(hit.name, hit.ent);
            break;
        case 'galaxy':
            gotoGalaxy(hit.id);
            break;
        case 'con':
            gotoConstellation(hit.id);
            break;
        case 'star':
            gotoStar(hit.id, view.conId);
            showStarPanel(hit.star, view.conId);
            bumpAccess(hit.id);
            break;
    }
});

// ── 键盘 ──
window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    markInteraction();
    const idx = parseInt(e.key);
    if (idx >= 1 && idx <= 4) gotoGalaxy(GALAXIES[idx - 1].id);
    if (e.key === '0' || e.key === '`') gotoUniverse();
    if (e.key === 'Escape') {
        if (view.level === 'universe') hidePanel();
        else goUp();
    }
});

// ── galaxy pills ──
const GALAXY_COLORS = {
    '社交': '#ff9966', '地点': '#6699ff', '事件': '#66cc99', '爱好': '#ff6666',
};
GALAXY_COLORS[OWN_GALAXY_ID] = '#cc99ff'; // user's galaxy uses configurable name

function initGalaxyPills() {
    const nav = document.getElementById('galaxy-pills');
    // Remove old dynamic pills (keep "全部")
    nav.querySelectorAll('.gpill:not([data-galaxy=""])').forEach(b => b.remove());
    // Build pill for each galaxy
    GALAXIES.forEach(g => {
        const btn = document.createElement('button');
        btn.className = 'gpill';
        btn.dataset.galaxy = g.id;
        btn.textContent = g.id;
        btn.style.setProperty('--gc', GALAXY_COLORS[g.id] || '#8ab4ff');
        btn.addEventListener('click', e => {
            e.stopPropagation(); markInteraction();
            if (view.galaxyId === g.id && view.level === 'galaxy') gotoUniverse();
            else gotoGalaxy(g.id);
        });
        nav.appendChild(btn);
    });
    // "全部" button
    const allBtn = nav.querySelector('[data-galaxy=""]');
    if (allBtn) {
        allBtn.addEventListener('click', e => {
            e.stopPropagation(); markInteraction();
            gotoUniverse();
        });
    }
}

function updateGalaxyPills() {
    document.querySelectorAll('.gpill').forEach(btn => {
        const g = btn.dataset.galaxy || '';
        btn.classList.toggle('active', g === (view.galaxyId || ''));
    });
}

// ── 数据加载 ──
async function refresh() {
    try {
        await loadUniverse();
        onDataLoaded();
        renderTopCount();
        renderBreadcrumb();
        renderArchlog();
        renderModelPanel();
        renderMergeProposals();
        renderCoreInsight();
    } catch (err) {
        console.error('[memory] load error:', err);
        showConnectionLost();
    }
}

// ── 主循环 ──
let T = 0;
function loop() {
    // 空闲降帧：>3s 无交互 → 隔帧渲染（~30fps）
    if (Date.now() - lastInteraction > 3000) {
        frameSkip = !frameSkip;
        if (frameSkip) { requestAnimationFrame(loop); return; }
    }
    T += 0.012;
    drawFrame(T, hovered);
    requestAnimationFrame(loop);
}

// ── 启动 ──
// ── 星尘透镜 ──
const TYPE_MAP = {
    observation: { cls:'obs', label:'观察', emoji:'✦' },
    preference: { cls:'pref', label:'偏好', emoji:'◇' },
    reflection: { cls:'refl', label:'反思', emoji:'◈' },
    event: { cls:'event', label:'事件', emoji:'○' },
    state: { cls:'state', label:'状态', emoji:'▽' },
    music: { cls:'music', label:'音乐', emoji:'♪' },
};
function starStr(ew) {
    if (ew >= 0.8) return '★★★';
    if (ew >= 0.6) return '★★';
    if (ew >= 0.4) return '★';
    return '☆';
}

async function loadStardust(days, query) {
    const token = localStorage.getItem('token');
    const params = new URLSearchParams();
    params.set('limit', '80');
    try {
        const res = await fetch('/api/fragments?' + params.toString(), { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) return [];
        const data = await res.json();
        let frags = data.fragments || data || [];
        // Client-side date filter
        if (days) {
            const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
            frags = frags.filter(f => (f.created_at || '').slice(0, 10) >= cutoff);
        }
        if (query) {
            const q = query.toLowerCase();
            frags = frags.filter(f => (f.content || '').toLowerCase().includes(q) || (f.entity || '').toLowerCase().includes(q));
        }
        return frags;
    } catch (_) { return []; }
}

async function loadFragmentConstellations(fragIds) {
    if (!fragIds.length) return {};
    const token = localStorage.getItem('token');
    try {
        const res = await fetch('/api/memory/universe', { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) return {};
        const data = await res.json();
        const map = {};
        for (const c of data.constellations || []) {
            for (const s of c.stars || []) {
                if (fragIds.includes(s.id)) {
                    if (!map[s.id]) map[s.id] = [];
                    map[s.id].push({ id: c.id, name: c.label, galaxy: c.galaxyLabel });
                }
            }
        }
        return map;
    } catch (_) { return {}; }
}

function renderStardustEntries(frags, conMap) {
    const body = document.getElementById('stardust-body');
    if (!frags.length) {
        body.innerHTML = '<div class="sd-empty">✦<br>没有捕获到任何信号</div>';
        return;
    }
    body.innerHTML = frags.map(f => {
        const typeInfo = TYPE_MAP[f.type] || TYPE_MAP.observation;
        const time = (() => {
            const t = f.created_at || '';
            try { const d = new Date(t + (t.endsWith('Z') ? '' : 'Z')); if (!isNaN(d.getTime())) return d.toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Shanghai' }); } catch(_){}
            return t.slice(5, 16) || '';
        })();
        const cons = conMap[f.id] || [];
        const conStr = cons.length
            ? '↳ ' + cons.map(c => '<span data-cid="' + c.id + '">' + c.name + '</span>').join(' · ')
            : '';
        const typeLabel = typeInfo.label + (f.subtype ? ' · ' + f.subtype : '');
        return '<div class="sd-entry" data-fid="' + f.id + '">'
            + '<div class="sd-bar ' + typeInfo.cls + '"></div>'
            + '<div class="sd-main">'
            + '<div class="sd-meta">'
            + '<span class="sd-time">' + time + '</span>'
            + '<span class="sd-type">' + typeLabel + '</span>'
            + '<span class="sd-entity">' + (f.entity || '') + '</span>'
            + '<span class="sd-stars">' + starStr(f.emotional_weight || 0) + '</span>'
            + '</div>'
            + '<div class="sd-content">' + (f.content || '') + '</div>'
            + '<div class="sd-detail">'
            + (conStr ? '<div class="sd-constellations">' + conStr + '</div>' : '')
            + '<div class="sd-actions">'
            + '<button class="sd-act danger" data-act="delete" data-fid="' + f.id + '">删除</button>'
            + '</div></div></div></div>';
    }).join('');

    // Click handlers
    body.querySelectorAll('.sd-entry').forEach(el => {
        el.addEventListener('click', e => {
            if (e.target.closest('.sd-act') || e.target.closest('.sd-constellations span')) return;
            el.classList.toggle('expanded');
        });
    });
    body.querySelectorAll('.sd-constellations span').forEach(sp => {
        sp.addEventListener('click', e => {
            e.stopPropagation();
            const cid = parseInt(sp.dataset.cid);
            if (cid) { closeStardust(); gotoConstellation(cid); }
        });
    });
    body.querySelectorAll('.sd-act[data-act="delete"]').forEach(btn => {
        btn.addEventListener('click', async e => {
            e.stopPropagation();
            const fid = parseInt(btn.dataset.fid);
            if (!confirm('删除碎片 #' + fid + '？')) return;
            const token = localStorage.getItem('token');
            try {
                const res = await fetch('/api/fragment/' + fid, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
                if (res.ok) { btn.closest('.sd-entry').remove(); }
            } catch (_) {}
        });
    });
}

async function refreshStardust() {
    const body = document.getElementById('stardust-body');
    const lens = document.getElementById('stardust-lens');
    const filter = document.getElementById('sd-filter');
    const search = document.getElementById('sd-search');
    const days = parseInt(filter.value) || 7;
    const query = (search.value || '').trim();

    // Scanning state
    lens.classList.add('sd-scanning');
    body.innerHTML = '<div class="sd-scanning-hint"><span class="sd-scan-pulse">✦</span><br>扫描信号中...</div>';
    try {
        const frags = await loadStardust(days, query);
        const fragIds = frags.map(f => f.id);
        const conMap = await loadFragmentConstellations(fragIds);
        renderStardustEntries(frags, conMap);
    } finally {
        lens.classList.remove('sd-scanning');
    }
}

function openStardust() {
    document.getElementById('stardust-overlay').classList.add('show');
    document.getElementById('stardust-btn').classList.add('active');
    refreshStardust();
}
function closeStardust() {
    document.getElementById('stardust-overlay').classList.remove('show');
    document.getElementById('stardust-btn').classList.remove('active');
}

function initStardustLens() {
    document.getElementById('stardust-btn').addEventListener('click', () => {
        if (document.getElementById('stardust-overlay').classList.contains('show')) closeStardust();
        else openStardust();
    });
    document.getElementById('sd-close').addEventListener('click', closeStardust);
    document.getElementById('sd-filter').addEventListener('change', refreshStardust);
    let searchTimer;
    document.getElementById('sd-search').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(refreshStardust, 300);
    });
    // Click overlay background (outside lens) to close
    document.getElementById('stardust-overlay').addEventListener('click', e => {
        if (e.target === document.getElementById('stardust-overlay')) closeStardust();
    });
    // ESC to close
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeStardust();
    });
}

initRender(document.getElementById('bg'), mc);
initPanelEvents();
initGalaxyPills();
renderBreadcrumb();
initStardustLens();
window.addEventListener('resize', () => { markInteraction(); resizeRender(); });
window.addEventListener('memory-refresh', () => refresh());
refresh();
setInterval(refresh, 5 * 60 * 1000);
loop();
