// ========================================
// 记忆星图 v5 — 视图状态机
// 单一状态对象，4 层级：universe / galaxy / constellation / star
// 所有转换走本模块函数，渲染层只读 view
// ========================================

import { conById } from './data.js';

export const view = {
    level: 'universe',     // universe | galaxy | constellation | star
    galaxyId: null,
    conId: null,
    starId: null,
    // 过渡动画：0→1 的交叉淡入进度
    transition: 1,
    prevLevel: null,
};

const listeners = [];
export function onViewChange(fn) { listeners.push(fn); }
function emit() {
    view.prevLevel = view._pending || null;
    view.transition = 0;
    listeners.forEach(fn => fn(view));
}

export function gotoUniverse() {
    if (view.level === 'universe') return;
    view._pending = view.level;
    view.level = 'universe';
    view.galaxyId = null; view.conId = null; view.starId = null;
    emit();
}

export function gotoGalaxy(galaxyId) {
    if (view.level === 'galaxy' && view.galaxyId === galaxyId) return;
    view._pending = view.level;
    view.level = 'galaxy';
    view.galaxyId = galaxyId;
    view.conId = null; view.starId = null;
    emit();
}

export function gotoConstellation(conId) {
    const con = conById(conId);
    if (!con) return;
    view._pending = view.level;
    view.level = 'constellation';
    view.galaxyId = con.galaxyLabel;
    view.conId = conId;
    view.starId = null;
    emit();
}

export function gotoStar(starId, conId) {
    view._pending = view.level;
    view.level = 'star';
    if (conId) {
        const con = conById(conId);
        if (con) { view.conId = conId; view.galaxyId = con.galaxyLabel; }
    }
    view.starId = starId;
    emit();
}

// Esc / 点空白：上退一级
export function goUp() {
    switch (view.level) {
        case 'star': gotoConstellation(view.conId); break;
        case 'constellation': gotoGalaxy(view.galaxyId); break;
        case 'galaxy': gotoUniverse(); break;
        // universe: 无操作
    }
}

// 面包屑数据
export function breadcrumb() {
    const items = [{ label: '宇宙', action: gotoUniverse, active: view.level === 'universe' }];
    if (view.galaxyId) {
        const gid = view.galaxyId;
        items.push({ label: gid + '星系', action: () => gotoGalaxy(gid), active: view.level === 'galaxy' });
    }
    if (view.conId) {
        const con = conById(view.conId);
        const cid = view.conId;
        if (con) items.push({ label: con.label, action: () => gotoConstellation(cid), active: view.level === 'constellation' });
    }
    if (view.starId && view.level === 'star') {
        items.push({ label: '记忆碎片', action: () => {}, active: true });
    }
    return items;
}
