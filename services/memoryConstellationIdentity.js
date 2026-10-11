'use strict';

const protocol = require('./memoryProtocol');
const resolution = require('./memoryEvidenceResolution');

const CATEGORIES = Object.freeze(['person','pet','organization','place','event','consumed','hobby','project','object','term']);
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_constellation_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL DEFAULT 'default' CHECK(scope='default'),
    input_hash TEXT NOT NULL,
    claim_ids_json TEXT NOT NULL CHECK(json_valid(claim_ids_json)),
    proposed_name TEXT,
    proposed_category TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','identity_resolved','admitted','contained','rejected','deferred')),
    entity_id INTEGER REFERENCES entity_profiles(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_constellation_candidate_input
    ON memory_constellation_candidates(input_hash,scope);
CREATE TABLE IF NOT EXISTS memory_identity_alias_evidence (
    entity_id INTEGER NOT NULL REFERENCES entity_profiles(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    normalized_alias TEXT NOT NULL,
    claim_id INTEGER NOT NULL REFERENCES memory_claims(id),
    claim_revision INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    quote_enc TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(entity_id,normalized_alias,claim_id,message_id)
);
CREATE TABLE IF NOT EXISTS memory_constellation_admissions (
    entity_id INTEGER PRIMARY KEY REFERENCES entity_profiles(id) ON DELETE CASCADE,
    candidate_id INTEGER NOT NULL REFERENCES memory_constellation_candidates(id),
    input_hash TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN('admitted','contained','rejected')),
    basis TEXT NOT NULL,
    parent_entity_id INTEGER REFERENCES entity_profiles(id),
    reviewer TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_constellation_relations (
    from_entity_id INTEGER NOT NULL REFERENCES entity_profiles(id) ON DELETE CASCADE,
    to_entity_id INTEGER NOT NULL REFERENCES entity_profiles(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,
    claim_ids_json TEXT NOT NULL CHECK(json_valid(claim_ids_json)),
    input_hash TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(from_entity_id,to_entity_id,relation_type)
);
`;

function normalize(value) {
    return String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
}

function claimsForCandidate(db, claimIds) {
    const ids = [...new Set(claimIds)].sort((a, b) => a - b);
    if (!ids.length) protocol.fail('constellation_claims_required');
    return ids.map(id => {
        const claim = protocol.readClaim(db, id);
        const state = resolution.current(db, id);
        if (!protocol.eligible(db, id) || !state || !['grounded','unassigned'].includes(state.state))
            protocol.fail('constellation_claim_not_ready');
        return claim;
    });
}

function createCandidate(db, input) {
    const claims = claimsForCandidate(db, input.claimIds || []);
    const inputHash = protocol.hash(claims.map(claim => ({ id: claim.id, revision: claim.revision,
        input_hash: claim.input_hash, body: claim.body })));
    const now = Date.now();
    db.prepare(`INSERT OR IGNORE INTO memory_constellation_candidates(
        input_hash,claim_ids_json,proposed_name,proposed_category,status,created_at,updated_at)
        VALUES(?,?,?,?, 'pending',?,?)`).run(inputHash, JSON.stringify(claims.map(claim => claim.id)),
        input.name || null, input.category || null, now, now);
    return db.prepare('SELECT * FROM memory_constellation_candidates WHERE input_hash=? AND scope=\'default\'').get(inputHash);
}

function snapshot(db, candidateId) {
    const row = db.prepare('SELECT * FROM memory_constellation_candidates WHERE id=?').get(candidateId);
    if (!row) protocol.fail('constellation_candidate_missing');
    const claims = claimsForCandidate(db, JSON.parse(row.claim_ids_json));
    const currentHash = protocol.hash(claims.map(claim => ({ id: claim.id, revision: claim.revision,
        input_hash: claim.input_hash, body: claim.body })));
    if (currentHash !== row.input_hash) protocol.fail('constellation_candidate_stale');
    return { ...row, claim_ids: JSON.parse(row.claim_ids_json), claims };
}

function validateAliases(claims, aliases) {
    const seen = new Set();
    return (aliases || []).map(alias => {
        const value = String(alias.value || '').trim();
        const normalized = normalize(value);
        const claim = claims.find(item => item.id === alias.claim_id);
        if (!value || !normalized || seen.has(normalized) || !claim) protocol.fail('identity_alias_invalid');
        const source = claim.sources.find(item => item.message_id === alias.message_id && item.quote.includes(value));
        if (!source) protocol.fail('identity_alias_not_exact');
        seen.add(normalized);
        return { value, normalized, claim, source };
    });
}

function resolveIdentity(db, decision) {
    const input = snapshot(db, decision.candidateId);
    if (input.status !== 'pending') protocol.fail('identity_candidate_not_pending');
    if (!['identity','defer','reject'].includes(decision.outcome)) protocol.fail('identity_outcome_invalid');
    if (decision.outcome !== 'identity') {
        const status = decision.outcome === 'defer' ? 'deferred' : 'rejected';
        const changed = db.prepare(`UPDATE memory_constellation_candidates SET status=?,updated_at=?
            WHERE id=? AND status='pending' AND input_hash=?`).run(status, Date.now(), input.id, input.input_hash);
        if (changed.changes !== 1) protocol.fail('identity_cas_failed');
        return { outcome: decision.outcome, entity_id: null };
    }
    const name = String(decision.name || '').trim();
    if (!name || !CATEGORIES.includes(decision.category)) protocol.fail('identity_invalid');
    const aliases = validateAliases(input.claims, decision.aliases || []);
    return db.transaction(() => {
        let entity = db.prepare(`SELECT id,name,aliases FROM entity_profiles
            WHERE LOWER(name)=LOWER(?) AND COALESCE(memory_scope,'default')='default'`).get(name);
        if (!entity) {
            const inserted = db.prepare(`INSERT INTO entity_profiles(name,category,status,aliases,memory_scope)
                VALUES(?,?,'seed','[]','default')`).run(name, decision.category);
            entity = { id: Number(inserted.lastInsertRowid), name, aliases: '[]' };
        }
        const merged = JSON.parse(entity.aliases || '[]');
        const known = new Set(merged.map(normalize));
        for (const alias of aliases) if (!known.has(alias.normalized)) {
            merged.push(alias.value);
            known.add(alias.normalized);
        }
        db.prepare('UPDATE entity_profiles SET aliases=?,category=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
            .run(JSON.stringify(merged), decision.category, entity.id);
        const insertEvidence = db.prepare(`INSERT OR IGNORE INTO memory_identity_alias_evidence(
            entity_id,alias,normalized_alias,claim_id,claim_revision,message_id,quote_enc,reviewer,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)`);
        for (const alias of aliases) insertEvidence.run(entity.id, alias.value, alias.normalized,
            alias.claim.id, alias.claim.revision, alias.source.message_id, protocol.encrypt(alias.source.quote),
            decision.reviewer, Date.now());
        const changed = db.prepare(`UPDATE memory_constellation_candidates SET status='identity_resolved',entity_id=?,updated_at=?
            WHERE id=? AND status='pending' AND input_hash=?`).run(entity.id, Date.now(), input.id, input.input_hash);
        if (changed.changes !== 1) protocol.fail('identity_cas_failed');
        protocol.recordAction(db, 'constellation_identity', entity.id, 1, 'resolve',
            { candidate_id: input.id }, { name, category: decision.category, aliases: aliases.map(alias => alias.value) }, decision.reviewer);
        return { outcome: 'identity', entity_id: entity.id, aliases_added: aliases.map(alias => alias.value) };
    })();
}

module.exports = { SCHEMA, CATEGORIES, normalize, createCandidate, snapshot, resolveIdentity };
