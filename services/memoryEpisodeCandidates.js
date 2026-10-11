'use strict';

const protocol = require('./memoryProtocol');
const evidence = require('./memoryEvidenceResolution');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_episode_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL DEFAULT 'default' CHECK(scope='default'),
    claim_ids_json TEXT NOT NULL CHECK(json_valid(claim_ids_json)),
    entity_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(entity_ids_json)),
    temporal_state TEXT NOT NULL,
    input_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN('ready','transient','published','stale','rejected')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_episode_candidates_status
    ON memory_episode_candidates(status,updated_at);
`;

function create(db, claimIds) {
    const ids = [...new Set(claimIds || [])].sort((a, b) => a - b);
    if (!ids.length) protocol.fail('episode_claims_required');
    const claims = ids.map(id => {
        const claim = protocol.readClaim(db, id);
        const state = evidence.current(db, id);
        if (!protocol.eligible(db, id) || !state || !['grounded', 'unassigned'].includes(state.state))
            protocol.fail('episode_claim_not_ready');
        return { claim, state };
    });
    const entities = [...new Set(claims.flatMap(item => item.state.entity_ids))].sort((a, b) => a - b);
    const transient = entities.length === 0 || claims.some(item => ['planned', 'in_progress'].includes(item.claim.temporal_state));
    const inputHash = protocol.hash(claims.map(item => ({
        id: item.claim.id, revision: item.claim.revision, input_hash: item.claim.input_hash,
        evidence_state: item.state.state, entity_ids: item.state.entity_ids,
    })));
    const now = Date.now();
    db.prepare(`INSERT OR IGNORE INTO memory_episode_candidates(
        claim_ids_json,entity_ids_json,temporal_state,input_hash,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`).run(JSON.stringify(ids), JSON.stringify(entities),
        transient ? 'in_progress' : 'completed', inputHash, transient ? 'transient' : 'ready', now, now);
    return db.prepare('SELECT * FROM memory_episode_candidates WHERE input_hash=?').get(inputHash);
}

function snapshot(db, candidateId) {
    const row = db.prepare('SELECT * FROM memory_episode_candidates WHERE id=?').get(candidateId);
    if (!row) protocol.fail('episode_candidate_missing');
    const current = create(db, JSON.parse(row.claim_ids_json));
    if (current.input_hash !== row.input_hash) {
        db.prepare("UPDATE memory_episode_candidates SET status='stale',updated_at=? WHERE id=?").run(Date.now(), row.id);
        protocol.fail('episode_candidate_stale');
    }
    return {
        ...row,
        claim_ids: JSON.parse(row.claim_ids_json),
        entity_ids: JSON.parse(row.entity_ids_json),
        claims: JSON.parse(row.claim_ids_json).map(id => protocol.readClaim(db, id)),
    };
}

module.exports = { SCHEMA, create, snapshot };
