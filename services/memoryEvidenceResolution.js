'use strict';

const protocol = require('./memoryProtocol');
const nodes = require('./memoryNodeReview');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_evidence_pool (
    claim_id INTEGER PRIMARY KEY REFERENCES memory_claims(id) ON DELETE CASCADE,
    claim_revision INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN('ineligible','needs_resolution','deferred','unassigned','topic_only','node_candidate','grounded')),
    reason_code TEXT NOT NULL,
    entity_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(entity_ids_json)),
    attempts INTEGER NOT NULL DEFAULT 0,
    evidence_fingerprint TEXT NOT NULL,
    next_review_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_evidence_pool_state ON memory_evidence_pool(state,next_review_at,updated_at);
CREATE TABLE IF NOT EXISTS memory_evidence_resolution_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id INTEGER NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    evidence_fingerprint TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
`;

function evidenceFingerprint(db, claimId) {
    const claim = protocol.readClaim(db, claimId);
    const duty = db.prepare('SELECT * FROM memory_claim_duties WHERE claim_id=?').get(claimId) || null;
    const classification = db.prepare('SELECT * FROM memory_claim_classification WHERE claim_id=?').get(claimId) || null;
    const reviews = db.prepare('SELECT entity_id,role,verdict,input_hash FROM memory_node_reviews WHERE claim_id=? ORDER BY entity_id,role').all(claimId);
    return protocol.hash({ claim: { revision: claim.revision, input_hash: claim.input_hash,
        source_state: claim.source_state, support_state: claim.support_state,
        attribution_state: claim.attribution_state }, duty, classification, reviews });
}

function derive(db, claimId, now = Date.now()) {
    const claim = protocol.readClaim(db, claimId);
    if (!protocol.sourcesCurrent(db, claim)) return { state: 'ineligible', reason: 'source_changed', entityIds: [] };
    if (!protocol.eligible(db, claimId)) {
        const duty = db.prepare('SELECT state,duty FROM memory_claim_duties WHERE claim_id=?').get(claimId);
        if (!duty) return { state: 'ineligible', reason: 'duty_missing', entityIds: [] };
        return { state: 'ineligible', reason: 'claim_not_verified', entityIds: [] };
    }
    const classification = db.prepare('SELECT * FROM memory_claim_classification WHERE claim_id=?').get(claimId);
    if (!classification) return { state: 'needs_resolution', reason: 'classification_missing', entityIds: [] };
    if (classification.input_hash !== claim.input_hash || classification.claim_revision !== claim.revision)
        return { state: 'needs_resolution', reason: 'classification_stale', entityIds: [] };
    if (classification.outcome === 'needs_resolution') {
        const previous = db.prepare('SELECT * FROM memory_evidence_pool WHERE claim_id=?').get(claimId);
        const fingerprint = evidenceFingerprint(db, claimId);
        if (previous && previous.evidence_fingerprint === fingerprint && previous.next_review_at && now >= previous.next_review_at)
            return { state: 'deferred', reason: 'evidence_unchanged_after_review', entityIds: [] };
        return { state: 'needs_resolution', reason: 'ambiguous_assignment', entityIds: [] };
    }
    if (classification.outcome === 'no_independent_node') return { state: 'unassigned', reason: 'no_independent_node', entityIds: [] };
    if (classification.outcome === 'topic_only') return { state: 'topic_only', reason: 'topic_navigation_only', entityIds: [] };
    const offered = JSON.parse(classification.links_json);
    const supported = nodes.supported(db, claimId);
    const pending = offered.filter(link => !supported.some(row => row.entity_id === link.entity_id && row.role === link.role));
    if (pending.length) return { state: 'node_candidate', reason: 'node_review_pending', entityIds: [] };
    return { state: 'grounded', reason: 'grounded', entityIds: [...new Set(supported.map(row => row.entity_id))] };
}

function reconcile(db, claimId, { now = Date.now(), priority = protocol.BACKFILL_JOB_PRIORITY } = {}) {
    const claim = protocol.readClaim(db, claimId);
    const fingerprint = evidenceFingerprint(db, claimId);
    const next = derive(db, claimId, now);
    const previous = db.prepare('SELECT * FROM memory_evidence_pool WHERE claim_id=?').get(claimId);
    const attempts = previous && previous.evidence_fingerprint === fingerprint && next.state === 'deferred'
        ? previous.attempts + 1 : previous?.attempts || 0;
    const nextReviewAt = next.state === 'needs_resolution' ? now + 24 * 60 * 60 * 1000 : 0;
    db.prepare(`INSERT INTO memory_evidence_pool(claim_id,claim_revision,input_hash,state,reason_code,
        entity_ids_json,attempts,evidence_fingerprint,next_review_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(claim_id) DO UPDATE SET claim_revision=excluded.claim_revision,input_hash=excluded.input_hash,
        state=excluded.state,reason_code=excluded.reason_code,entity_ids_json=excluded.entity_ids_json,
        attempts=excluded.attempts,evidence_fingerprint=excluded.evidence_fingerprint,
        next_review_at=excluded.next_review_at,updated_at=excluded.updated_at`).run(
        claimId, claim.revision, claim.input_hash, next.state, next.reason,
        JSON.stringify(next.entityIds), attempts, fingerprint, nextReviewAt, now,
    );
    if (!previous || previous.state !== next.state || previous.reason_code !== next.reason) {
        db.prepare(`INSERT INTO memory_evidence_resolution_history(
            claim_id,from_state,to_state,reason_code,evidence_fingerprint,created_at) VALUES(?,?,?,?,?,?)`).run(
            claimId, previous?.state || null, next.state, next.reason, fingerprint, now,
        );
    }
    if (next.state === 'grounded' || next.state === 'unassigned') {
        protocol.enqueueJob(db, { stage: 'episode_candidate', targetType: 'claim', targetId: claimId,
            inputRevision: claim.revision, inputHash: claim.input_hash, priority });
    }
    if (next.state === 'grounded') {
        for (const entityId of next.entityIds) protocol.enqueueJob(db, { stage: 'profile_projection', targetType: 'entity',
            targetId: entityId, inputRevision: claim.revision, inputHash: fingerprint, priority });
    }
    return { claim_id: claimId, state: next.state, reason_code: next.reason, entity_ids: next.entityIds };
}

function current(db, claimId) {
    const row = db.prepare('SELECT * FROM memory_evidence_pool WHERE claim_id=?').get(claimId);
    return row ? { ...row, entity_ids: JSON.parse(row.entity_ids_json) } : null;
}

module.exports = { SCHEMA, evidenceFingerprint, derive, reconcile, current };
