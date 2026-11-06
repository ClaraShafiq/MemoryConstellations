'use strict';

const { randomUUID } = require('node:crypto');
const protocol = require('./memoryProtocol');

const COLLECTION = 'memory_constellations_verified';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_vector_projection (
    projection_key TEXT PRIMARY KEY,
    vector_id TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL,
    source_hash TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN('upsert','delete')),
    status TEXT NOT NULL CHECK(status IN('queued','running','done','retry','obsolete')),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER,
    error_code TEXT,
    acknowledged_at INTEGER,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_vector_projection_ready
    ON memory_vector_projection(status,updated_at);
`;

function ready(db) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_vector_projection'").get();
}

function ensureReady(db) {
    if (!ready(db)) {
        const error = new Error('vector_projection_schema_missing');
        error.code = error.message;
        throw error;
    }
}

function vectorId(key) {
    return `verified_${protocol.hash(key).slice(0, 32)}`;
}

function schedule(db, key) {
    ensureReady(db);
    const row = db.prepare('SELECT * FROM memory_search_projection WHERE projection_key=?').get(key);
    const current = db.prepare('SELECT * FROM memory_vector_projection WHERE projection_key=?').get(key);
    if (!row && !current) return null;
    const revision = Number(row?.revision || current.revision);
    const sourceHash = row?.input_hash || protocol.hash({ key, revision, deleted: true });
    const operation = row ? 'upsert' : 'delete';
    if (current && current.revision === revision && current.source_hash === sourceHash
        && current.operation === operation && current.status === 'done') return current;
    db.prepare(`INSERT INTO memory_vector_projection(
        projection_key,vector_id,revision,source_hash,operation,status,attempts,updated_at)
        VALUES(?,?,?,?,?,'queued',0,?) ON CONFLICT(projection_key) DO UPDATE SET
        revision=excluded.revision,source_hash=excluded.source_hash,operation=excluded.operation,
        status='queued',attempts=0,lease_token=NULL,lease_until=NULL,error_code=NULL,
        acknowledged_at=NULL,updated_at=excluded.updated_at`).run(key, vectorId(key), revision, sourceHash, operation, Date.now());
    return db.prepare('SELECT * FROM memory_vector_projection WHERE projection_key=?').get(key);
}

function lease(db, { now = Date.now(), leaseMs = 120000 } = {}) {
    ensureReady(db);
    return db.transaction(() => {
        db.prepare(`UPDATE memory_vector_projection SET status='retry',lease_token=NULL,lease_until=NULL,
            error_code='lease_expired',updated_at=? WHERE status='running' AND lease_until<=?`).run(now, now);
        const row = db.prepare(`SELECT * FROM memory_vector_projection
            WHERE status IN('queued','retry') ORDER BY updated_at,projection_key LIMIT 1`).get();
        if (!row) return null;
        const token = randomUUID();
        const changed = db.prepare(`UPDATE memory_vector_projection SET status='running',lease_token=?,lease_until=?,
            attempts=attempts+1,updated_at=? WHERE projection_key=? AND status IN('queued','retry')`)
            .run(token, now + leaseMs, now, row.projection_key);
        return changed.changes ? { ...row, lease_token: token, lease_until: now + leaseMs, attempts: row.attempts + 1 } : null;
    })();
}

function current(db, item) {
    const row = db.prepare('SELECT * FROM memory_search_projection WHERE projection_key=?').get(item.projection_key);
    if (item.operation === 'delete') return !row;
    return !!row && Number(row.revision) === Number(item.revision) && row.input_hash === item.source_hash;
}

async function drain(db, { limit = 32, transport = require('./memory').chromaDBOperation,
    embed = require('./memory').getLocalEmbedding } = {}) {
    let done = 0;
    for (let i = 0; i < limit; i++) {
        const item = lease(db);
        if (!item) break;
        try {
            if (!current(db, item)) {
                schedule(db, item.projection_key);
                db.prepare(`UPDATE memory_vector_projection SET status='obsolete',lease_token=NULL,lease_until=NULL,
                    error_code='input_changed',updated_at=? WHERE projection_key=? AND lease_token=?`)
                    .run(Date.now(), item.projection_key, item.lease_token);
                continue;
            }
            if (item.operation === 'delete') await transport('delete', { id: item.vector_id, collection_name: COLLECTION });
            else {
                const row = db.prepare('SELECT * FROM memory_search_projection WHERE projection_key=?').get(item.projection_key);
                const text = protocol.decrypt(row.text_enc);
                const embedding = await embed(text);
                await transport('upsert', { id: item.vector_id, embedding, collection_name: COLLECTION,
                    metadata: { projection_key: item.projection_key, revision: item.revision,
                        source_hash: item.source_hash, target_type: row.target_type, target_id: row.target_id } });
            }
            const changed = db.prepare(`UPDATE memory_vector_projection SET status='done',lease_token=NULL,lease_until=NULL,
                error_code=NULL,acknowledged_at=?,updated_at=? WHERE projection_key=? AND lease_token=?`)
                .run(Date.now(), Date.now(), item.projection_key, item.lease_token);
            if (!changed.changes) protocol.fail('vector_projection_lease_lost');
            done++;
        } catch (error) {
            db.prepare(`UPDATE memory_vector_projection SET status='retry',lease_token=NULL,lease_until=NULL,
                error_code=?,updated_at=? WHERE projection_key=? AND lease_token=?`)
                .run(String(error.code || error.message).slice(0, 80), Date.now(), item.projection_key, item.lease_token);
        }
    }
    return { done };
}

function manifest(db) {
    ensureReady(db);
    const rows = db.prepare(`SELECT projection_key,vector_id,revision,source_hash,operation,status,acknowledged_at
        FROM memory_vector_projection ORDER BY projection_key`).all();
    const expected = db.prepare('SELECT COUNT(*) count FROM memory_search_projection').get().count;
    const active = rows.filter(row => row.operation === 'upsert');
    const blockers = [];
    if (active.length !== expected) blockers.push('projection_receipt_count_mismatch');
    if (rows.some(row => row.status !== 'done' || !row.acknowledged_at)) blockers.push('projection_receipts_incomplete');
    for (const row of active) if (!current(db, row)) blockers.push(`projection_stale:${row.projection_key}`);
    const payload = { collection: COLLECTION, rows: rows.map(row => ({ projection_key: row.projection_key,
        vector_id: row.vector_id, revision: row.revision, source_hash: row.source_hash, operation: row.operation })) };
    return { ready: expected > 0 && blockers.length === 0, expected, done: rows.filter(row => row.status === 'done').length,
        blockers, digest: protocol.hash(payload), rows };
}

async function verifyRemote(db, { transport = require('./memory').chromaDBOperation } = {}) {
    const state = manifest(db);
    if (!state.ready) return { ready: false, digest: state.digest, blockers: state.blockers };
    const upserts = state.rows.filter(row => row.operation === 'upsert');
    const response = await transport('get_batch', { ids: upserts.map(row => row.vector_id), collection_name: COLLECTION });
    const remote = new Map((response.items || []).map(item => [item.id, item.metadata || {}]));
    const blockers = [];
    for (const row of upserts) {
        const metadata = remote.get(row.vector_id);
        if (!metadata) blockers.push(`remote_missing:${row.projection_key}`);
        else if (Number(metadata.revision) !== Number(row.revision) || metadata.source_hash !== row.source_hash
            || metadata.projection_key !== row.projection_key) blockers.push(`remote_stale:${row.projection_key}`);
    }
    return { ready: blockers.length === 0, digest: state.digest, blockers };
}

async function query(db, text, limit = 8, { transport = require('./memory').chromaDBOperation,
    embed = require('./memory').getLocalEmbedding } = {}) {
    const embedding = await embed(text);
    const response = await transport('query', { embedding, query_text: text, n_results: limit,
        min_similarity: 0.15, collection_name: COLLECTION });
    const ids = response.ids?.[0] || [];
    const metadata = response.metadatas?.[0] || [];
    const rows = [];
    for (let i = 0; i < ids.length; i++) {
        const receipt = db.prepare(`SELECT * FROM memory_vector_projection
            WHERE vector_id=? AND status='done' AND operation='upsert'`).get(ids[i]);
        if (!receipt || !current(db, receipt)) continue;
        const meta = metadata[i] || {};
        if (meta.projection_key !== receipt.projection_key || meta.source_hash !== receipt.source_hash
            || Number(meta.revision) !== Number(receipt.revision)) continue;
        const row = db.prepare('SELECT * FROM memory_search_projection WHERE projection_key=?').get(receipt.projection_key);
        if (row) rows.push({ ...row, text: protocol.decrypt(row.text_enc), metadata: JSON.parse(row.metadata_json) });
    }
    return rows;
}

module.exports = { COLLECTION, SCHEMA, ready, vectorId, schedule, drain, manifest, verifyRemote, query };
