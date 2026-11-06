'use strict';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_model_call_budget (
    day TEXT NOT NULL,
    role TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    call_limit INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(day,role)
);
`;

function utcDay(now = Date.now()) {
    return new Date(now).toISOString().slice(0, 10);
}

function configuredLimit(role) {
    const specific = process.env[`MEMORY_${String(role).toUpperCase()}_DAILY_CALL_LIMIT`];
    const value = Number(specific ?? process.env.MEMORY_DAILY_MODEL_CALL_LIMIT ?? 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function reserve(db, role, { limit = configuredLimit(role), now = Date.now() } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('memory_model_budget_invalid');
    if (limit === 0) throw Object.assign(new Error('memory_model_calls_disabled'), { code: 'memory_model_calls_disabled' });
    return db.transaction(() => {
        const day = utcDay(now);
        db.prepare(`INSERT INTO memory_model_call_budget(day,role,used,call_limit,updated_at)
            VALUES(?,?,0,?,?) ON CONFLICT(day,role) DO UPDATE SET call_limit=excluded.call_limit,
            updated_at=excluded.updated_at`).run(day, role, limit, now);
        const changed = db.prepare(`UPDATE memory_model_call_budget SET used=used+1,updated_at=?
            WHERE day=? AND role=? AND used<call_limit`).run(now, day, role);
        if (!changed.changes) throw Object.assign(new Error('memory_model_budget_exhausted'), { code: 'memory_model_budget_exhausted' });
        return db.prepare('SELECT * FROM memory_model_call_budget WHERE day=? AND role=?').get(day, role);
    })();
}

module.exports = { SCHEMA, utcDay, configuredLimit, reserve };
