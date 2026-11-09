'use strict';

const { randomUUID } = require('node:crypto');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_foreground_leases (
    token TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    lease_until INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_runtime_state (
    id INTEGER PRIMARY KEY CHECK(id=1),
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO memory_runtime_state(id,cooldown_until,updated_at) VALUES(1,0,0);
`;

function boundedTtl(value) {
    return Math.max(1000, Math.min(Number(value) || DEFAULT_TTL_MS, 10 * 60 * 1000));
}

function prune(db, now = Date.now()) {
    return db.prepare('DELETE FROM memory_foreground_leases WHERE lease_until<=?').run(now).changes;
}

function acquire(db, { owner = 'external-chat', ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
    prune(db, now);
    const token = randomUUID();
    const leaseUntil = now + boundedTtl(ttlMs);
    db.prepare(`INSERT INTO memory_foreground_leases(token,owner,lease_until,created_at)
        VALUES(?,?,?,?)`).run(token, String(owner).slice(0, 80), leaseUntil, now);
    return { token, lease_until: leaseUntil };
}

function release(db, token, { now = Date.now(), cooldownMs = COOLDOWN_MS } = {}) {
    const changed = db.prepare('DELETE FROM memory_foreground_leases WHERE token=?').run(String(token || '')).changes;
    if (changed) db.prepare(`UPDATE memory_runtime_state SET cooldown_until=MAX(cooldown_until,?),updated_at=?
        WHERE id=1`).run(now + Math.max(0, Number(cooldownMs) || 0), now);
    return { released: changed === 1 };
}

function status(db, now = Date.now()) {
    prune(db, now);
    const active = Number(db.prepare('SELECT COUNT(*) count FROM memory_foreground_leases').get().count);
    const state = db.prepare('SELECT cooldown_until FROM memory_runtime_state WHERE id=1').get();
    const cooldownUntil = Number(state?.cooldown_until || 0);
    return { active, cooldown_until: cooldownUntil,
        blocked: active > 0 || cooldownUntil > now,
        reason: active > 0 ? 'foreground_active' : cooldownUntil > now ? 'foreground_cooldown' : null };
}

module.exports = { DEFAULT_TTL_MS, COOLDOWN_MS, SCHEMA, prune, acquire, release, status };
