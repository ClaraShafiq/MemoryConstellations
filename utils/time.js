// =================================================================
// 时间工具函数（某城市时区 UTC+8）
// =================================================================

const getShanghaiTime = () => {
    try {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const shanghaiTime = new Date(utc + (8 * 3600000));
        
        const year = shanghaiTime.getFullYear();
        const month = String(shanghaiTime.getMonth() + 1).padStart(2, '0');
        const day = String(shanghaiTime.getDate()).padStart(2, '0');
        const hour = String(shanghaiTime.getHours()).padStart(2, '0');
        const minute = String(shanghaiTime.getMinutes()).padStart(2, '0');
        const second = String(shanghaiTime.getSeconds()).padStart(2, '0');
        
        return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
    } catch (error) {
        console.error('getShanghaiTime failed:', error);
        return new Date().toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        }).replace(/\//g, '-').replace(/,/g, '');
    }
};

const getTimeOfDay = () => {
    try {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const shanghaiTime = new Date(utc + (8 * 3600000));
        const hour = shanghaiTime.getHours();
        
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

module.exports = { getShanghaiTime, getTimeOfDay, sqlNow, sqlTimeAgo, sqlDaysAgo, sqlTimeAhead, DAY_MS };