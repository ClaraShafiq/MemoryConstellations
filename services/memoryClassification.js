'use strict';

const protocol = require('./memoryProtocol');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_claim_classification (
    claim_id INTEGER PRIMARY KEY REFERENCES memory_claims(id) ON DELETE CASCADE,
    claim_revision INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN('linked','topic_only','no_independent_node','needs_resolution')),
    links_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(links_json)),
    topics_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(topics_json)),
    reviewer TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS memory_node_reviews (
    claim_id INTEGER NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES entity_profiles(id),
    role TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK(verdict IN('supported','rejected','pending')),
    claim_revision INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    quote_enc TEXT,
    reviewer TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(claim_id,entity_id,role)
);
`;

const ROLES = new Set(['subject','participant','location','organization','work','mention']);

function snapshot(db, claimId) {
    const claim = protocol.readClaim(db, claimId);
    return { claim_id: claim.id, revision: claim.revision, input_hash: claim.input_hash,
        body: claim.body, domain: claim.domain, temporal_state: claim.temporal_state, sources: claim.sources };
}

function commit(db, decision) {
    const claim = protocol.readClaim(db, decision.claimId);
    if (decision.expectedRevision !== claim.revision || decision.inputHash !== claim.input_hash) protocol.fail('classification_cas_failed');
    if (!protocol.sourcesCurrent(db, claim)) protocol.fail('classification_source_changed');
    const outcomes = ['linked','topic_only','no_independent_node','needs_resolution'];
    if (!outcomes.includes(decision.outcome)) protocol.fail('classification_outcome_invalid');
    const links = Array.isArray(decision.links) ? decision.links : [];
    if (links.some(link => !Number.isSafeInteger(link.entity_id) || !ROLES.has(link.role))) protocol.fail('classification_link_invalid');
    if (decision.outcome === 'linked' && links.length === 0) protocol.fail('classification_links_required');
    if (decision.outcome !== 'linked' && links.length) protocol.fail('classification_links_forbidden');
    db.transaction(() => {
        db.prepare(`INSERT INTO memory_claim_classification(claim_id,claim_revision,input_hash,outcome,links_json,topics_json,reviewer)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(claim_id) DO UPDATE SET claim_revision=excluded.claim_revision,
            input_hash=excluded.input_hash,outcome=excluded.outcome,links_json=excluded.links_json,
            topics_json=excluded.topics_json,reviewer=excluded.reviewer,updated_at=CURRENT_TIMESTAMP`).run(
            claim.id, claim.revision, claim.input_hash, decision.outcome, JSON.stringify(links),
            JSON.stringify(decision.topics || []), decision.reviewer,
        );
        protocol.enqueueJob(db, { stage: 'evidence_resolution', targetType: 'claim', targetId: claim.id,
            inputRevision: claim.revision, inputHash: claim.input_hash });
    })();
    return { claim_id: claim.id, outcome: decision.outcome, links };
}

module.exports = { SCHEMA, ROLES, snapshot, commit };
