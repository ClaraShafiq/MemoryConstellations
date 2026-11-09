'use strict';

const protocol = require('./memoryProtocol');
const vectors = require('./memoryVectorProjection');

const PREPARE_TTL_MS = 15 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_release_state (
    id INTEGER PRIMARY KEY CHECK(id=1),
    manifest_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN('ready','activated','stale')),
    prepared_at INTEGER NOT NULL,
    activated_at INTEGER
);
`;

async function prepare(db, options = {}) {
    const localBlockers = require('./memoryDerivedStateHealth').releaseBlockers(db, {
        runnerActive: require('./memoryBackgroundSupervisor').status().active,
    });
    if (localBlockers.length) {
        return { ready: false, blockers: localBlockers, manifest_digest: vectors.manifest(db).digest };
    }
    const remote = await vectors.verifyRemote(db, options);
    if (!remote.ready) return { ready: false, blockers: remote.blockers, manifest_digest: remote.digest };
    db.prepare(`INSERT INTO memory_release_state(id,manifest_digest,status,prepared_at,activated_at)
        VALUES(1,?,'ready',?,NULL) ON CONFLICT(id) DO UPDATE SET manifest_digest=excluded.manifest_digest,
        status='ready',prepared_at=excluded.prepared_at,activated_at=NULL`).run(remote.digest, Date.now());
    return { ready: true, blockers: [], manifest_digest: remote.digest };
}

function isReady(db) {
    const row = db.prepare('SELECT * FROM memory_release_state WHERE id=1').get();
    if (!row || !['ready', 'activated'].includes(row.status)) return false;
    if (row.status === 'ready' && Date.now() - Number(row.prepared_at) > PREPARE_TTL_MS) return false;
    try { return vectors.manifest(db).ready && vectors.manifest(db).digest === row.manifest_digest; }
    catch (_) { return false; }
}

function activate(db) {
    if (!isReady(db)) protocol.fail('verified_release_not_ready');
    db.transaction(() => {
        db.prepare(`INSERT INTO user_settings(setting_key,setting_value) VALUES('memory_chat_read_mode','verified')
            ON CONFLICT(setting_key) DO UPDATE SET setting_value='verified'`).run();
        db.prepare("UPDATE memory_release_state SET status='activated',activated_at=? WHERE id=1").run(Date.now());
    })();
    return { chat_read_mode: 'verified' };
}

function rollback(db) {
    db.prepare(`INSERT INTO user_settings(setting_key,setting_value) VALUES('memory_chat_read_mode','legacy')
        ON CONFLICT(setting_key) DO UPDATE SET setting_value='legacy'`).run();
    return { chat_read_mode: 'legacy' };
}

module.exports = { SCHEMA, PREPARE_TTL_MS, prepare, isReady, activate, rollback };
