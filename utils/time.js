// =================================================================
// 时间工具函数
// =================================================================

function validTimeZone(value) {
    if (!value) return false;
    try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date(0));
        return true;
    } catch (_) {
        return false;
    }
}

function resolveAppTimeZone() {
    if (validTimeZone(process.env.TZ)) return process.env.TZ;
    const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return validTimeZone(systemTimeZone) ? systemTimeZone : 'UTC';
}

const APP_TIME_ZONE = resolveAppTimeZone();

function partsInAppTimeZone(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: APP_TIME_ZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

const getAppTime = () => {
    try {
        const parts = partsInAppTimeZone();
        return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    } catch (error) {
        console.error('getAppTime failed:', error);
        return sqlNow();
    }
};

function parseUtcTimestamp(value) {
    if (value instanceof Date) return value;
    const text = String(value || '');
    return new Date(text + (/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? '' : 'Z'));
}

function formatUtcInAppTimeZone(value, locale = 'zh-CN', options = {}) {
    const date = parseUtcTimestamp(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(locale, { ...options, timeZone: APP_TIME_ZONE });
}

const getTimeOfDay = () => {
    try {
        const hour = Number(partsInAppTimeZone().hour);
        
        if (hour >= 5 && hour < 11) return '早上';
        if (hour >= 11 && hour < 13) return '中午';
        if (hour >= 13 && hour < 17) return '下午';
        if (hour >= 17 && hour < 19) return '傍晚';
        if (hour >= 19 && hour < 23) return '晚上';
        return '深夜';
    } catch (error) {
        console.error('getTimeOfDay failed:', error);
        return '';
    }
};

// ── 写库用的时间：必须和 SQLite 的 datetime('now') 同格式 ──
// datetime('now') 是 UTC 的 "YYYY-MM-DD HH:MM:SS"（空格分隔、不带 Z）。
// 别用 new Date().toISOString()——那是 "2026-09-15T13:00:00.000Z"，
// 跟 datetime('now') 做字符串比较时，会在第 11 个字符上按 'T'(0x54) vs ' '(0x20) 分出胜负，
// 同一天的时间于是被静默地当成"更晚"，误差最多一天，而且一句报错都没有。
// 一列里混进两种格式之后，就再也没法回答"这列到底是什么单位"——所以写入口统一放这里。
const DAY_MS = 24 * 3600 * 1000;

/** N 毫秒前，SQLite datetime('now') 同格式（UTC） */
const sqlTimeAgo = (ms) => new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);

/** 当前时间，同上格式 */
const sqlNow = () => sqlTimeAgo(0);

/** N 天前，同上格式——用来跟 datetime('now', '-N days') 对齐 */
const sqlDaysAgo = (days) => sqlTimeAgo(days * DAY_MS);

/** N 毫秒后，同上格式（有效期上限之类的未来时间点） */
const sqlTimeAhead = (ms) => sqlTimeAgo(-ms);

module.exports = {
    APP_TIME_ZONE,
    getAppTime,
    getTimeOfDay,
    formatUtcInAppTimeZone,
    sqlNow,
    sqlTimeAgo,
    sqlDaysAgo,
    sqlTimeAhead,
    DAY_MS,
};
