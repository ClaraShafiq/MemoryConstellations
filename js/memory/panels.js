// ========================================
// 记忆星图 v5 — DOM 面板层
// 详情面板、面包屑、观星手记、Clara 认知模型、tooltip
// ========================================

import { universe, conById, decideMergeProposal } from './data.js';
import { view, breadcrumb, gotoConstellation } from './state.js';
import { bridgesOfCon } from './layout.js';

const TOKEN = () => localStorage.getItem('token');
const authHeaders = () => {
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    return {
        'Authorization': `Bearer ${TOKEN()}`,
        'X-CSRF-Token': csrfMeta ? csrfMeta.getAttribute('content') : '',
    };
};

const $ = id => document.getElementById(id);

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// ── 面包屑 ──
export function renderBreadcrumb() {
    const el = $('breadcrumb');
    el.innerHTML = '';
    breadcrumb().forEach((item, i, arr) => {
        if (i > 0) {
            const sep = document.createElement('span');
            sep.className = 'bc-sep'; sep.textContent = '›';
            el.appendChild(sep);
        }
        const btn = document.createElement('button');
        btn.className = 'bc-item' + (item.active ? ' active' : '');
        btn.textContent = item.label;
        if (!item.active) btn.addEventListener('click', item.action);
        el.appendChild(btn);
    });
}

// ── 顶部统计 ──
export function renderTopCount() {
    $('tb-count').textContent = `${universe.totalFragments} fragments · ${universe.constellations.length} constellations`;
}
export function showConnectionLost() {
    $('tb-count').textContent = 'connection lost';
}

// ── 详情面板 ──
function panelBase(color) {
    const p = $('panel');
    p.style.setProperty('--pc', color);
    $('p-accent').style.cssText = `background:${color};box-shadow:0 0 7px ${color}`;
    $('p-tags').innerHTML = '';
    $('p-meta').innerHTML = '';
    p.classList.add('visible');
    return p;
}

function addTag(text) {
    const el = document.createElement('span');
    el.className = 'tag'; el.textContent = text;
    $('p-tags').appendChild(el);
}

function addMeta(label, valuePct, valueText) {
    const row = document.createElement('div');
    row.className = 'p-mag-row';
    row.innerHTML = `<span class="p-mag-label">${esc(label)}</span>
      <div class="mag-track"><div class="mag-fill" style="width:${Math.max(0, Math.min(100, valuePct))}%"></div></div>
      <span class="mag-val">${esc(valueText)}</span>`;
    $('p-meta').appendChild(row);
}

// 星星（碎片）详情
export function showStarPanel(star, viewConId) {
    const con = conById(viewConId);
    const color = con?.color || '#7c9dff';
    panelBase(color);
    $('p-cat').textContent = (con?.galaxyLabel || '') + ' · ' + (con?.label || '');
    $('p-title').textContent = star.title || '…';
    $('p-body').textContent = star.content || '';
    if (con) addTag('✦ ' + con.label);
    if (star.relation) addTag(star.relation);
    if (star.lifecycle === 'cooling') addTag('冷却中 — 很久没被想起');
    else if (star.lifecycle === 'frozen') addTag('已冻结 — 即将归档');
    addMeta('鲜活度', (star.conf || 0) * 100, ((star.conf || 0) * 100).toFixed(0) + '%');
    addMeta('视星等', Math.max(0, (6.5 - (star.mag || 4)) / 5.5 * 100), (star.mag || 4).toFixed(1) + '等');
    $('p-date').textContent = star.date || '';

    // v5.0: 星星操作 — 解除与该星座的关联
    // star.id = "f12345" → fragId = 12345, con needs real id (strip 'e' prefix)
    const fragId = parseInt(String(star.id).replace('f', ''));
    const entityId = con ? parseInt(String(con.id).replace('e', '')) : null;
    if (con && fragId && entityId) {
        const actions = document.createElement('div');
        actions.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.04)';
        const unlink = document.createElement('button');
        unlink.textContent = '解除与「' + con.label + '」的关联';
        unlink.style.cssText = 'background:rgba(255,80,80,0.06);border:1px solid rgba(255,80,80,0.12);border-radius:6px;color:rgba(255,120,120,0.5);font-family:inherit;font-size:10px;cursor:pointer;padding:4px 10px;transition:all .2s';
        unlink.addEventListener('mouseenter', () => { unlink.style.background = 'rgba(255,80,80,0.12)'; unlink.style.borderColor = 'rgba(255,80,80,0.3)'; });
        unlink.addEventListener('mouseleave', () => { unlink.style.background = 'rgba(255,80,80,0.06)'; unlink.style.borderColor = 'rgba(255,80,80,0.12)'; });
        unlink.addEventListener('click', async () => {
            unlink.disabled = true;
            unlink.textContent = '…';
            try {
                const r = await fetch('/api/memory/unlink-fragment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify({ entity_id: entityId, fragment_id: fragId }),
                });
                const d = await r.json();
                if (d.ok) {
                    unlink.textContent = '已解除';
                    unlink.style.color = 'rgba(120,200,120,0.5)';
                    unlink.style.borderColor = 'rgba(120,200,120,0.15)';
                    unlink.style.background = 'rgba(120,200,120,0.04)';
                    window.dispatchEvent(new CustomEvent('memory-refresh'));
                } else {
                    unlink.textContent = '解除失败';
                    unlink.disabled = false;
                }
            } catch (_) {
                unlink.textContent = '解除失败';
                unlink.disabled = false;
            }
        });
        actions.appendChild(unlink);
        $('p-meta').appendChild(actions);
    }
}

// 星座（实体）详情
export function showConPanel(con) {
    panelBase(con.color);
    $('p-cat').textContent = (con.galaxyLabel || '') + '星系';
    $('p-title').textContent = con.label;
    let body = con.description || '';
    $('p-body').textContent = body;
    if (con.category) {
        const catLabel = con.subcategory ? `${con.category} · ${con.subcategory}` : con.category;
        addTag(catLabel);
    }
    // v5.1: 别称（精准触发，蓝色标签）
    if (con.aliases && con.aliases.length > 0) {
        con.aliases.forEach(a => {
            const el = document.createElement('span');
            el.className = 'tag tag-alias';
            el.textContent = a;
            $('p-tags').appendChild(el);
        });
    }
    // v5.1: 向量标签（语义关联，紫色标签）
    if (con.tags && con.tags.length > 0) {
        con.tags.forEach(t => {
            const el = document.createElement('span');
            el.className = 'tag tag-label';
            el.textContent = t;
            $('p-tags').appendChild(el);
        });
    }
    if (con.relationship) addTag(con.relationship.slice(0, 40));
    // v5.3: Tab切换 — 关联星座 / 叙事片段（二选一显示，防止面板过长）
    const bridges = bridgesOfCon(con.id);
    const hasEpisodes = con.episodes && con.episodes.length > 0;
    const hasBridges = bridges.length > 0;

    if (hasBridges || hasEpisodes) {
        const tabBar = document.createElement('div');
        tabBar.className = 'p-tab-bar';

        const bridgeTab = document.createElement('button');
        bridgeTab.className = 'p-tab-btn active';
        bridgeTab.textContent = '关联星座' + (hasBridges ? ` · ${bridges.length}` : '');
        bridgeTab.dataset.tab = 'bridges';

        const epTab = document.createElement('button');
        epTab.className = 'p-tab-btn';
        epTab.textContent = '叙事片段' + (hasEpisodes ? ` · ${con.episodes.length}` : '');
        epTab.dataset.tab = 'episodes';

        // Default: show bridges if any, else episodes
        const defaultTab = hasBridges ? 'bridges' : 'episodes';
        if (defaultTab === 'episodes') {
            bridgeTab.classList.remove('active');
            epTab.classList.add('active');
        }

        tabBar.appendChild(bridgeTab);
        tabBar.appendChild(epTab);
        $('p-meta').appendChild(tabBar);

        // Tab content container
        const tabContent = document.createElement('div');
        tabContent.className = 'p-tab-content';

        // Bridges panel
        if (hasBridges) {
            const linksDiv = document.createElement('div');
            linksDiv.className = 'p-bridges' + (defaultTab === 'bridges' ? '' : ' hidden');
            linksDiv.dataset.panel = 'bridges';
            bridges.sort((a, b) => b.weight - a.weight).slice(0, 6).forEach(br => {
                const other = conById(br.otherId);
                if (!other) return;
                const a = document.createElement('button');
                a.className = 'p-bridge-link';
                a.style.color = other.color;
                a.textContent = br.relation
                    ? `${other.label} — ${br.relation}`
                    : `${other.label} · ${br.weight}条共享记忆`;
                a.addEventListener('click', () => gotoConstellation(other.id));
                linksDiv.appendChild(a);
            });
            tabContent.appendChild(linksDiv);
        }

        // Episodes panel
        if (hasEpisodes) {
            const epDiv = document.createElement('div');
            epDiv.className = 'p-episodes' + (defaultTab === 'episodes' ? '' : ' hidden');
            epDiv.dataset.panel = 'episodes';
            const epList = document.createElement('div');
            epList.className = 'p-episodes-list';
            con.episodes.forEach(ep => {
                const card = document.createElement('div');
                card.className = 'p-episode-card';
                const wStars = ep.weight >= 8 ? '★★★' : ep.weight >= 6 ? '★★☆' : ep.weight >= 4 ? '★☆☆' : '☆☆☆';
                card.innerHTML = `<div class="p-episode-header">
                    <span class="p-episode-weight">${wStars}</span>
                    <span class="p-episode-date">${esc(ep.date || '')}</span>
                </div>
                <div class="p-episode-content">${esc(ep.content)}</div>`;
                epList.appendChild(card);
            });
            epDiv.appendChild(epList);
            tabContent.appendChild(epDiv);
        }

        $('p-meta').appendChild(tabContent);

        // Tab switch handler
        tabBar.addEventListener('click', (e) => {
            const btn = e.target.closest('.p-tab-btn');
            if (!btn) return;
            const target = btn.dataset.tab;
            tabBar.querySelectorAll('.p-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            tabContent.querySelectorAll('[data-panel]').forEach(p => p.classList.add('hidden'));
            const targetPanel = tabContent.querySelector(`[data-panel="${target}"]`);
            if (targetPanel) targetPanel.classList.remove('hidden');
        });
    }

    const coolingN = con.coolingCount || 0;
    addMeta('记忆碎片', Math.min(100, con.stars.length / 40 * 100),
        coolingN > 0 ? `${con.stars.length} 颗 · ${coolingN} 冷却` : con.stars.length + ' 颗');
    $('p-date').textContent = con.updatedAt ? '更新于 ' + (con.updatedAt || '').slice(0, 10) : '';
}

// 双星核心档案（颜色从API读取）
export function showCorePanel(name, ent) {
    const color = ent?.color || '#7c9dff';
    const isUser = ent?.role === 'user';
    panelBase(color);
    $('p-cat').textContent = '双星核心';
    $('p-title').textContent = name;
    $('p-body').textContent = ent?.overview || (isUser ? '这个宇宙的创造者。' : '这个宇宙的守护者。');
    addTag(isUser ? '恒星 · 暖金' : '恒星 · 银绿');
    if (ent?.relationship) addTag(ent.relationship.slice(0, 40));
    addMeta('记忆碎片', 100, (ent?.fragment_count || 0) + ' 条');
    $('p-date').textContent = ent?.updatedAt ? '更新于 ' + (ent.updatedAt || '').slice(0, 10) : '';
}

export function hidePanel() { $('panel').classList.remove('visible'); }

// ── tooltip ──
export function showTooltip(mx, my, text) {
    const tt = $('tt');
    tt.style.opacity = '1';
    tt.style.left = (mx + 14) + 'px';
    tt.style.top = (my - 8) + 'px';
    tt.textContent = text;
}
export function hideTooltip() { $('tt').style.opacity = '0'; }

// ── 观星手记 ──
export function renderArchlog() {
    const body = $('arch-body');
    body.innerHTML = '';
    const data = universe.archlog || [];
    if (!data.length) {
        body.innerHTML = '<div class="arch-empty">尚无活动记录</div>';
        return;
    }
    data.slice(0, 15).forEach((e, i, arr) => {
        const div = document.createElement('div');
        div.className = 'arch-entry';
        div.innerHTML = `<span class="arch-time">${esc(e.time)}</span>
          <div class="arch-dot-col"><div class="arch-edot" style="background:${e.color};box-shadow:0 0 5px ${e.color}"></div>${i < Math.min(arr.length, 15) - 1 ? '<div class="arch-line"></div>' : ''}</div>
          <span class="arch-text">${e.text || ''}</span>`;
        body.appendChild(div);
    });
}

// ── Clara 认知模型 ──
// immutable_fact v4.8 退役。stable_trait/active_hypothesis v5.2 退役，由 clara_patterns 替代。
const MODEL_LAYERS = [
    { type: 'current_state', label: '● 当前状态', cls: 'state' },
    { type: 'pattern', label: '◇ 观察模式', cls: 'pat' },
];

export function renderModelPanel() {
    const counts = {};
    universe.cognitiveModel.forEach(e => counts[e.type] = (counts[e.type] || 0) + 1);
    const patCount = (universe.patterns || []).filter(p => p.status === 'active').length;
    counts['pattern'] = patCount;
    $('mp-body').innerHTML = MODEL_LAYERS.map(l => `
      <div class="mp-layer" data-type="${l.type}">
        <div class="mp-dot-s ${l.cls}"></div>
        <span class="mp-label">${l.label}</span>
        <span class="mp-count">${counts[l.type] || 0}</span>
      </div>`).join('');
    document.querySelectorAll('.mp-layer').forEach(el => {
        el.addEventListener('click', e => { e.stopPropagation(); showModelDetail(el.dataset.type); });
    });
}

// Add pattern dot class CSS
const MP_DOT_STYLE = document.createElement('style');
MP_DOT_STYLE.textContent = '.mp-dot-s.pat { background: rgba(255,179,212,0.7); box-shadow: 0 0 6px rgba(255,150,200,0.5); }';
document.head.appendChild(MP_DOT_STYLE);

function showModelDetail(filterType) {
    const detail = $('model-detail');
    const content = $('md-content');
    let html = '<button class="md-close" id="md-close">✕</button>';

    // ── Current State ──
    if (!filterType || filterType === 'current_state') {
        const states = universe.cognitiveModel.filter(e => e.type === 'current_state');
        html += `<div class="md-section"><div class="md-section-title">● 当前状态 (${states.length})</div>`;
        if (!states.length) html += '<div class="md-empty">暂无</div>';
        else states.forEach(e => {
            let extra = '';
            if (e.expires_at) {
                const remainMs = new Date(e.expires_at) - Date.now();
                if (remainMs <= 0) extra = '<span class="md-ttl md-expired">已过期</span>';
                else {
                    const remainH = Math.round(remainMs / 3600000);
                    const remainText = remainH < 1 ? '即将过期' : remainH < 24 ? `约${remainH}h` : `约${Math.round(remainH/24)}d`;
                    extra = `<span class="md-ttl">${remainText}</span>`;
                }
            }
            if (e.created_by === 'chat_draco') extra += '<span class="md-source">🖊️ Draco</span>';
            else if (e.created_by === 'deep_cycle') extra += '<span class="md-source">🌙 深循环</span>';
            html += `<div class="md-row"><span class="mdot mp-dot-s state"></span><span style="flex:1">${esc(e.content)}</span>${extra}</div>`;
        });
        html += '</div>';
    }

    // ── Patterns (v5.2) ──
    if (!filterType || filterType === 'pattern') {
        const patterns = (universe.patterns || []).filter(p => p.status === 'active');
        html += `<div class="md-section"><div class="md-section-title">◇ 观察模式 (${patterns.length})</div>`;
        if (!patterns.length) html += '<div class="md-empty">暂无。深循环会在观察积累足够后自动生成。</div>';
        else patterns.forEach(p => {
            const conf = Math.round((p.confidence || 0) * 100);
            const spanDays = p.first_seen && p.last_seen
                ? Math.round((new Date(p.last_seen) - new Date(p.first_seen)) / (1000*60*60*24))
                : 0;
            const tags = (p.tags || []).slice(0, 5).map(t => `<span class="md-tag">${esc(t)}</span>`).join('');
            html += `<div class="md-row"><span class="mdot mp-dot-s pat"></span>
              <span style="flex:1">${esc(p.content)}</span>
              <span class="mconf">${p.evidence_count}次 · ${spanDays}d · ${conf}%</span></div>
              <div class="md-row-sub">${tags}</div>`;
        });
        html += '</div>';
    }

    content.innerHTML = html;
    detail.classList.add('show');
    document.getElementById('md-close')?.addEventListener('click', closeModelDetail);
    detail.addEventListener('click', (e) => { if (e.target === detail) closeModelDetail(); });
}
export function closeModelDetail() { $('model-detail').classList.remove('show'); }

// ── v5.2: Patterns (日积月累的行为观察) ──
export function renderPatterns() {
    const box = $('patterns-box');
    const body = $('pat-body');
    const patterns = universe.patterns || [];
    if (!patterns.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    $('pat-count').textContent = patterns.length + ' 个模式';
    body.innerHTML = patterns.slice(0, 5).map(p => {
        const conf = Math.round((p.confidence || 0) * 100);
        const tags = (p.tags || []).slice(0, 4).map(t => `<span class="pat-tag">${esc(t)}</span>`).join('');
        return `<div class="pat-item" onclick="document.querySelector('[data-type=pattern]').click()" title="点击查看全部模式">
          <div class="pat-content">${esc(p.content.slice(0, 60))}${p.content.length>60?'…':''}</div>
          <div class="pat-meta">
            <span class="pat-stat">${p.evidence_count}次 · 置信${conf}%</span>
            ${tags}
          </div>
        </div>`;
    }).join('');
    if (patterns.length > 5) {
        body.innerHTML += `<div class="pat-more" onclick="document.querySelector('[data-type=pattern]').click()">查看全部 ${patterns.length} 个模式 →</div>`;
    }
}

// ── 合并提案队列（Draco 的疑问 → Clara 裁决）──
export function renderMergeProposals() {
    const box = $('merge-proposals');
    const body = $('mq-body');
    const proposals = universe.mergeProposals || [];
    if (!proposals.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    $('mq-count').textContent = proposals.length + ' 待裁决';
    body.innerHTML = '';
    proposals.forEach(p => {
        const item = document.createElement('div');
        item.className = 'mq-item';
        const q = document.createElement('div');
        q.className = 'mq-q';
        q.innerHTML = `<strong>${esc(p.a_name)}</strong>（${p.a_fc || 0}星）和 <strong>${esc(p.b_name)}</strong>（${p.b_fc || 0}星）是同一个吗？`;
        const reason = document.createElement('div');
        reason.className = 'mq-reason';
        reason.textContent = `依据：${p.reason || '?'}${p.shared ? ` · 共享${p.shared}条记忆` : ''}`;
        const actions = document.createElement('div');
        actions.className = 'mq-actions';
        const mkBtn = (label, cls, decision) => {
            const b = document.createElement('button');
            b.className = 'mq-btn ' + cls;
            b.textContent = label;
            b.addEventListener('click', async () => {
                b.disabled = true;
                try {
                    await decideMergeProposal(p.id, decision);
                    item.remove();
                    const left = universe.mergeProposals.length;
                    if (!left) box.style.display = 'none';
                    else $('mq-count').textContent = left + ' 待裁决';
                } catch (e) {
                    b.disabled = false;
                    b.textContent = '失败，重试';
                }
            });
            return b;
        };
        actions.appendChild(mkBtn('是，合并', 'approve', 'approve'));
        actions.appendChild(mkBtn('不是', 'reject', 'reject'));
        item.appendChild(q); item.appendChild(reason); item.appendChild(actions);
        body.appendChild(item);
    });
}

// ── v5.0: 核心洞察编辑 ──
async function loadCoreInsight() {
    try {
        const r = await fetch('/api/memory/core-insight', { headers: authHeaders() });
        const d = await r.json();
        if (d.ok) {
            $('ci-editor').value = d.insight || '';
            if (d.updated_at) {
                $('ci-updated').textContent = '更新于 ' + new Date(d.updated_at).toLocaleString('zh-CN');
            }
        }
    } catch (_) {}
}
export async function renderCoreInsight() {
    await loadCoreInsight();
    $('ci-save').addEventListener('click', async () => {
        const insight = $('ci-editor').value.trim();
        if (!insight) return;
        $('ci-save').disabled = true;
        $('ci-save').textContent = '保存中…';
        try {
            const r = await fetch('/api/memory/core-insight', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ insight }),
            });
            const d = await r.json();
            if (d.ok) {
                $('ci-save').textContent = '已保存';
                $('ci-updated').textContent = '更新于 ' + new Date().toLocaleString('zh-CN');
            } else {
                $('ci-save').textContent = '失败，重试';
            }
        } catch (_) {
            $('ci-save').textContent = '失败，重试';
        }
        $('ci-save').disabled = false;
    });
}

// ── 折叠面板初始化 ──
export function initPanelEvents() {
    $('panel-close').addEventListener('click', hidePanel);
    $('arch-header').addEventListener('click', () => {
        const al = $('archlog');
        al.classList.toggle('collapsed'); al.classList.toggle('expanded');
        $('model-panel').style.bottom = al.classList.contains('expanded') ? '272px' : '68px';
        closeModelDetail();
    });
    $('mp-header').addEventListener('click', () => {
        const mp = $('model-panel');
        mp.classList.toggle('collapsed'); mp.classList.toggle('expanded');
    });
    // Core insight panel toggle
    $('ci-header').addEventListener('click', () => {
        const ci = $('core-insight-panel');
        ci.classList.toggle('collapsed'); ci.classList.toggle('expanded');
        $('ci-body').style.display = ci.classList.contains('expanded') ? 'block' : 'none';
    });
    // Load core insight on init
    loadCoreInsight();
}
