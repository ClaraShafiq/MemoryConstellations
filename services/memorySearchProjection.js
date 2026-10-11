'use strict';

const protocol = require('./memoryProtocol');
const policy = require('./memoryReadPolicy');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_search_projection (
    projection_key TEXT PRIMARY KEY,
    target_type TEXT NOT NULL CHECK(target_type IN('claim','episode','profile')),
    target_id INTEGER NOT NULL,
    field TEXT,
    revision INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    text_enc TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_search_projection_target
    ON memory_search_projection(target_type,target_id);
`;

function put(db, key, type, id, field, revision, inputHash, text, metadata) {
    db.prepare(`INSERT INTO memory_search_projection(
        projection_key,target_type,target_id,field,revision,input_hash,text_enc,metadata_json,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(projection_key) DO UPDATE SET target_type=excluded.target_type,
        target_id=excluded.target_id,field=excluded.field,revision=excluded.revision,input_hash=excluded.input_hash,
        text_enc=excluded.text_enc,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`).run(
        key, type, id, field || null, revision, inputHash, protocol.encrypt(text), JSON.stringify(metadata || {}), Date.now());
}

function refreshClaim(db, claimId) {
    const claim = protocol.readClaim(db, claimId);
    if (!policy.readableClaim(db, claimId)) {
        db.prepare("DELETE FROM memory_search_projection WHERE projection_key=?").run(`claim:${claimId}`);
        return false;
    }
    put(db, `claim:${claimId}`, 'claim', claimId, null, claim.revision, claim.input_hash, claim.body,
        { domain: claim.domain, temporal_state: claim.temporal_state });
    return true;
}

function refreshEpisode(db, memoryId) {
    const row = db.prepare(`SELECT p.*,m.title,m.content,m.status FROM memory_episode_publications p
        JOIN memories m ON m.id=p.memory_id WHERE p.memory_id=?`).get(memoryId);
    if (!row) return false;
    put(db, `episode:${memoryId}`, 'episode', memoryId, null, row.revision, row.input_hash,
        `${row.title}\n${protocol.decrypt(row.content)}`, { status: row.status });
    return true;
}

function refreshProfile(db, entityId) {
    const entity = db.prepare('SELECT name FROM entity_profiles WHERE id=?').get(entityId);
    if (!entity) return 0;
    const rows = db.prepare('SELECT * FROM memory_profile_field_publications WHERE entity_id=? ORDER BY field').all(entityId);
    let count = 0;
    for (const row of rows) if (policy.readableProfileField(row)) {
        put(db, `profile:${entityId}:${row.field}`, 'profile', entityId, row.field, row.revision, row.input_hash,
            `${entity.name}: ${row.value_enc ? protocol.decrypt(row.value_enc) : ''}`, { field: row.field });
        count++;
    }
    return count;
}

function search(db, query, limit = 8) {
    const terms = String(query || '').normalize('NFKC').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return db.prepare('SELECT * FROM memory_search_projection ORDER BY updated_at DESC LIMIT 500').all()
        .map(row => ({ ...row, text: protocol.decrypt(row.text_enc), metadata: JSON.parse(row.metadata_json) }))
        .map(row => ({ ...row, score: terms.reduce((n, term) => n + (row.text.toLocaleLowerCase().includes(term) ? 1 : 0), 0) }))
        .filter(row => row.score > 0).sort((a, b) => b.score - a.score || b.updated_at - a.updated_at)
        .slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)));
}

module.exports = { SCHEMA, refreshClaim, refreshEpisode, refreshProfile, search };
