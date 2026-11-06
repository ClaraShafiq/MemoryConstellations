'use strict';

const protocol = require('./memoryProtocol');
const identity = require('./memoryConstellationIdentity');
const { isCoreIdentity } = require('./memoryConfig');

const KINDS = Object.freeze(['lasting_identity', 'ongoing_theme', 'meaningful_place', 'bounded_event', 'cherished']);
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_constellation_discovery_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anchor_claim_id INTEGER NOT NULL REFERENCES memory_claims(id),
    input_hash TEXT NOT NULL UNIQUE,
    proposed_name TEXT NOT NULL,
    proposed_category TEXT NOT NULL,
    basis TEXT NOT NULL,
    identity_candidate_id INTEGER REFERENCES memory_constellation_candidates(id),
    status TEXT NOT NULL CHECK(status IN('pending_identity','contained','rejected','needs_resolution')),
    reviewer TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
`;

function snapshot(db, claimId) {
    const claim = protocol.readClaim(db, claimId);
    const pool = db.prepare('SELECT state,evidence_fingerprint FROM memory_evidence_pool WHERE claim_id=?').get(claimId);
    if (!protocol.eligible(db, claimId) || !pool || !['grounded', 'unassigned', 'topic_only'].includes(pool.state))
        protocol.fail('constellation_discovery_claim_not_ready');
    return { claim_id: claim.id, revision: claim.revision, input_hash: claim.input_hash,
        body: claim.body, domain: claim.domain, subject_kind: claim.subject_kind,
        temporal_state: claim.temporal_state, sources: claim.sources, evidence_fingerprint: pool.evidence_fingerprint };
}

function commit(db, decision) {
    const input = snapshot(db, decision.claimId);
    if (Number(decision.expectedRevision) !== Number(input.revision)
        || decision.inputHash !== input.evidence_fingerprint) protocol.fail('constellation_discovery_cas_failed');
    const name = String(decision.name || '').normalize('NFKC').trim();
    if (!name || isCoreIdentity(name)) protocol.fail('constellation_discovery_name_invalid');
    if (!identity.CATEGORIES.includes(decision.category) || !KINDS.includes(decision.basis))
        protocol.fail('constellation_discovery_type_invalid');
    if (!['candidate', 'contained', 'rejected', 'needs_resolution'].includes(decision.outcome))
        protocol.fail('constellation_discovery_outcome_invalid');
    const evidenceText = [input.body, ...input.sources.map(source => source.quote)].join('\n').normalize('NFKC');
    if (decision.outcome === 'candidate' && !evidenceText.includes(name))
        protocol.fail('constellation_discovery_name_not_in_evidence');
    const candidateHash = protocol.hash({ claim_id: input.claim_id, revision: input.revision,
        claim_hash: input.input_hash, evidence_fingerprint: input.evidence_fingerprint,
        name, category: decision.category, basis: decision.basis });
    return db.transaction(() => {
        let candidateId = null;
        let status = decision.outcome;
        if (decision.outcome === 'candidate') {
            const candidate = identity.createCandidate(db, { claimIds: [input.claim_id], name, category: decision.category });
            candidateId = candidate.id;
            status = 'pending_identity';
            protocol.enqueueJob(db, { stage: 'constellation_identity', targetType: 'candidate', targetId: candidate.id,
                inputRevision: input.revision, inputHash: candidate.input_hash, priority: decision.priority });
        }
        const now = Date.now();
        db.prepare(`INSERT INTO memory_constellation_discovery_candidates(
            anchor_claim_id,input_hash,proposed_name,proposed_category,basis,identity_candidate_id,status,reviewer,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(input_hash) DO UPDATE SET reviewer=excluded.reviewer,
            updated_at=excluded.updated_at`).run(input.claim_id, candidateHash, name, decision.category,
            decision.basis, candidateId, status, decision.reviewer, now, now);
        return { outcome: decision.outcome, identity_candidate_id: candidateId, input_hash: candidateHash };
    })();
}

module.exports = { SCHEMA, KINDS, snapshot, commit };
