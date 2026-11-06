'use strict';

/**
 * 检索投影排序权重（retrieval_rank）
 *
 * 这是**可重建的投影字段**：只参与 librarian 的检索排序，
 * 不参与碎片状态流转，也不写入消息 / Observation / Claim / 来源链。
 *
 * 数据来源：memory_fragments.last_accessed_at、created_at、read_count
 * 重算入口：refreshRetrievalRanks(db, nowMs) —— 从当前列原样重算，无外部状态
 * 失效方式：DROP COLUMN 或整表重建后再跑一次 refresh 即可复原
 */

const POLICY = Object.freeze({
    HALF_LIFE_DAYS: 30,      // 30 天衰减一半
    MIN_RANK: 0.01,          // 下界，避免 0 权重把结果直接钉死
    MAX_RANK: 1.0,           // 上界
    READ_BOOST_CAP: 1.5,     // 读次数加成上限
    READ_BOOST_STEP: 0.1,    // 每 sqrt(reads) 增加 0.1
});

const MS_PER_DAY = 86400000;

/**
 * 把库里的时间列解析成毫秒。这两列都是 SQLite UTC 的 "YYYY-MM-DD HH:MM:SS"，
 * 不带时区标记，所以补一个 Z 再解析；已带 Z 或 ±hh:mm 的原样使用。
 */
function toMs(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value).trim();
    if (!text) return null;
    const normalized = text.includes('T') ? text : text.replace(' ', 'T');
    const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`;
    const ms = Date.parse(withZone);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * 纯函数：算单条碎片的排序权重。
 * @param {{lastAccessedAt?: string|number|null, createdAt?: string|number|null, readCount?: number}} input
 * @param {number} nowMs 调用方时钟，毫秒
 * @returns {number} 0.01 ~ 1.0
 */
function computeRetrievalRank(input, nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : Number(nowMs);
    if (!Number.isFinite(now)) {
        throw new TypeError('computeRetrievalRank: nowMs must be a finite timestamp');
    }

    const { lastAccessedAt, createdAt, readCount } = input || {};
    const anchor = toMs(lastAccessedAt) ?? toMs(createdAt) ?? now;

    // 锚点在未来（时钟回拨 / 脏数据）时按 0 天处理，不让它拿到超额权重
    const elapsedDays = Math.max(0, (now - anchor) / MS_PER_DAY);
    let rank = Math.pow(0.5, elapsedDays / POLICY.HALF_LIFE_DAYS);

    const reads = Math.max(0, Number(readCount) || 0);
    const readBoost = Math.min(
        POLICY.READ_BOOST_CAP,
        1 + POLICY.READ_BOOST_STEP * Math.sqrt(reads),
    );
    rank *= readBoost;

    if (!Number.isFinite(rank)) return POLICY.MIN_RANK;
    return Math.min(POLICY.MAX_RANK, Math.max(POLICY.MIN_RANK, rank));
}

/**
 * 把整表 retrieval_rank 重算一遍（可重复执行、幂等）。
 * @param {import('better-sqlite3').Database} db
 * @param {number} nowMs
 * @returns {{scanned:number, updated:number}}
 */
function refreshRetrievalRanks(db, nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : Number(nowMs);
    if (!Number.isFinite(now)) {
        throw new TypeError('refreshRetrievalRanks: nowMs must be a finite timestamp');
    }

    const rows = db.prepare(`
        SELECT id, last_accessed_at, created_at, read_count
        FROM memory_fragments
    `).all();
    const update = db.prepare(
        'UPDATE memory_fragments SET retrieval_rank = ? WHERE id = ?',
    );

    let updated = 0;
    const tx = db.transaction(() => {
        for (const row of rows) {
            update.run(computeRetrievalRank({
                lastAccessedAt: row.last_accessed_at,
                createdAt: row.created_at,
                readCount: row.read_count,
            }, now), row.id);
            updated += 1;
        }
    });
    tx();

    return { scanned: rows.length, updated };
}

module.exports = { POLICY, computeRetrievalRank, refreshRetrievalRanks };
