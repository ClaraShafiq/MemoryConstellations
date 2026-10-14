'use strict';

const protocol = require('./memoryProtocol');
const { ROLES } = require('./memoryClassification');

function commit(db, decision) {
    const claim = protocol.readClaim(db, decision.claimId);
    if (decision.expectedRevision !== claim.revision || decision.inputHash !== claim.input_hash) protocol.fail('node_review_cas_failed');
    if (!protocol.sourcesCurrent(db, claim)) protocol.fail('node_review_source_changed');
    if (!ROLES.has(decision.role) || !['supported','rejected','pending'].includes(decision.verdict)) protocol.fail('node_review_invalid');
    const classification = db.prepare('SELECT * FROM memory_claim_classification WHERE claim_id=?').get(claim.id);
    const links = classification ? JSON.parse(classification.links_json) : [];
    if (!links.some(link => link.entity_id === decision.entityId && link.role === decision.role)) protocol.fail('node_review_not_offered');
    let quote = null;
    if (decision.verdict === 'supported') {
        quote = String(decision.quote || '');
        if (!claim.sources.some(source => source.quote.includes(quote) || quote.includes(source.quote))) protocol.fail('node_review_quote_invalid');
    }
    db.prepare(`INSERT INTO memory_node_reviews(claim_id,entity_id,role,verdict,claim_revision,input_hash,quote_enc,reviewer)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(claim_id,entity_id,role) DO UPDATE SET verdict=excluded.verdict,
        claim_revision=excluded.claim_revision,input_hash=excluded.input_hash,quote_enc=excluded.quote_enc,
        reviewer=excluded.reviewer,updated_at=CURRENT_TIMESTAMP`).run(claim.id, decision.entityId, decision.role,
        decision.verdict, claim.revision, claim.input_hash, quote ? protocol.encrypt(quote) : null, decision.reviewer);
    const priority = protocol.resolveJobPriority(db, 'node_review', claim.id,
        claim.revision, claim.input_hash, decision.priority);
    protocol.enqueueJob(db, { stage: 'evidence_resolution', targetType: 'claim', targetId: claim.id,
        inputRevision: claim.revision, inputHash: claim.input_hash, priority });
    return { claim_id: claim.id, entity_id: decision.entityId, verdict: decision.verdict };
}

function supported(db, claimId) {
    return db.prepare(`SELECT entity_id,role FROM memory_node_reviews
        WHERE claim_id=? AND verdict='supported'`).all(claimId);
}

module.exports = { commit, supported };
