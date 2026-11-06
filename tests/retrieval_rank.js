'use strict';

const assert = require('node:assert/strict');
const { POLICY, computeRetrievalRank } = require('../services/retrievalRank');

const NOW = Date.parse('2026-11-05T12:00:00Z');

function utc(daysAgo, hour = 12) {
    const d = new Date(Date.UTC(2026, 10, 5, hour, 0, 0));
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d.toISOString();
}

// 1. 刚访问过 → 接近上限
{
    const r = computeRetrievalRank({ lastAccessedAt: utc(0, 11) }, NOW);
    assert.ok(r > 0.95 && r <= POLICY.MAX_RANK, `fresh=${r}`);
}

// 2. 一个半衰期 → 0.5
{
    const r = computeRetrievalRank({ lastAccessedAt: utc(30) }, NOW);
    assert.ok(Math.abs(r - 0.5) < 0.01, `half=${r}`);
}

// 3. 两个半衰期 → 0.25
{
    const r = computeRetrievalRank({ lastAccessedAt: utc(60) }, NOW);
    assert.ok(Math.abs(r - 0.25) < 0.02, `twoHalf=${r}`);
}

// 4. 没有 last_accessed_at 时回退 created_at
{
    const r = computeRetrievalRank({ createdAt: utc(30) }, NOW);
    assert.ok(Math.abs(r - 0.5) < 0.01, `createdFallback=${r}`);
}

// 5. 锚点在未来（时钟回拨）→ 按 0 天处理，不衰减
{
    const r = computeRetrievalRank({ lastAccessedAt: utc(-10) }, NOW);
    assert.ok(r > 0.95, `clockSkew=${r}`);
}

// 6. 读次数加成封顶，且不会让权重下降
{
    const low = computeRetrievalRank({ lastAccessedAt: utc(0), readCount: 0 }, NOW);
    const high = computeRetrievalRank({ lastAccessedAt: utc(0), readCount: 10000 }, NOW);
    assert.equal(high, POLICY.MAX_RANK, `readCap=${high}`);
    assert.ok(low <= high, 'read boost must not decrease rank');
}

// 7. 下界：极旧数据不会变成 0
{
    const r = computeRetrievalRank({ lastAccessedAt: utc(3650) }, NOW);
    assert.equal(r, POLICY.MIN_RANK, `floor=${r}`);
}

// 8. nowMs 非有限值抛错
{
    assert.throws(() => computeRetrievalRank({ lastAccessedAt: utc(0) }, NaN), TypeError);
}

// 9. 脏数据不炸，仍返回有限数
{
    const r = computeRetrievalRank({ lastAccessedAt: 'not-a-date', createdAt: null }, NOW);
    assert.ok(Number.isFinite(r), `dirty=${r}`);
}

// 10. 计算结果单调：越近越大
{
    const d0 = computeRetrievalRank({ lastAccessedAt: utc(0) }, NOW);
    const d10 = computeRetrievalRank({ lastAccessedAt: utc(10) }, NOW);
    const d100 = computeRetrievalRank({ lastAccessedAt: utc(100) }, NOW);
    assert.ok(d0 > d10 && d10 > d100, `monotonic ${d0} ${d10} ${d100}`);
}

console.log('retrieval rank: ok');
