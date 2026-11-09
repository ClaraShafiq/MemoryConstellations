'use strict';

const protocol = require('./memoryProtocol');
const { ROLES } = require('./memoryClassification');

function currentFragmentClaim(db, anchor, claimId) {
    const claim = protocol.readClaim(db, claimId);
    if (claim.fragment_id !== anchor.fragment_id || claim.claim_status !== 'active'
        || !protocol.eligible(db, claim.id)) protocol.fail('node_review_group_claim_invalid');
    return claim;
}

function decisionClaims(db, anchor, decision) {
    const ids = [...new Set([anchor.id, ...((decision.claimIds || []).map(Number))])];
    if (ids.length > 1) {
        if (decision.uniqueNamedObject !== true) protocol.fail('node_review_group_requires_unique_object');
        const entity = db.prepare('SELECT id,name,category,status FROM entity_profiles WHERE id=?').get(decision.entityId);
        if (!entity || entity.status !== 'active' || !['object', 'item', 'artifact'].includes(entity.category))
            protocol.fail('node_review_group_entity_invalid');
    }
    return ids.map(id => currentFragmentClaim(db, anchor, id));
}

function evidenceFor(claim, decision) {
    const item = (decision.evidence || []).find(row => Number(row.claimId) === Number(claim.id));
    const quote = String(item?.quote ?? (claim.id === decision.claimId ? decision.quote : '') ?? '');
    if (!quote || !claim.sources.some(source => source.quote.includes(quote) || quote.includes(source.quote)))
        protocol.fail('node_review_quote_invalid');
    return quote;
}

function commit(db, decision) {
    const anchor = protocol.readClaim(db, decision.claimId);
    if (decision.expectedRevision !== anchor.revision || decision.inputHash !== anchor.input_hash)
        protocol.fail('node_review_cas_failed');
    if (!protocol.sourcesCurrent(db, anchor)) protocol.fail('node_review_source_changed');
    if (!ROLES.has(decision.role) || !['supported','rejected','pending'].includes(decision.verdict))
        protocol.fail('node_review_invalid');
    const classification = db.prepare('SELECT * FROM memory_claim_classification WHERE claim_id=?').get(anchor.id);
    const links = classification ? JSON.parse(classification.links_json) : [];
    if (!links.some(link => link.entity_id === decision.entityId && link.role === decision.role))
        protocol.fail('node_review_not_offered');
    const claims = decisionClaims(db, anchor, decision);
    const evidence = new Map();
    if (decision.verdict === 'supported') for (const claim of claims) evidence.set(claim.id, evidenceFor(claim, decision));
    return db.transaction(() => {
        for (const claim of claims) {
            const quote = evidence.get(claim.id) || null;
            db.prepare(`INSERT INTO memory_node_reviews(
                claim_id,entity_id,role,verdict,claim_revision,input_hash,quote_enc,reviewer)
                VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(claim_id,entity_id,role) DO UPDATE SET
                verdict=excluded.verdict,claim_revision=excluded.claim_revision,input_hash=excluded.input_hash,
                quote_enc=excluded.quote_enc,reviewer=excluded.reviewer,updated_at=CURRENT_TIMESTAMP`).run(
                claim.id, decision.entityId, decision.role, decision.verdict, claim.revision,
                claim.input_hash, quote ? protocol.encrypt(quote) : null, decision.reviewer);
            const priority = protocol.resolveJobPriority(db, 'node_review', anchor.id,
                anchor.revision, anchor.input_hash, decision.priority);
            protocol.enqueueJob(db, { stage: 'evidence_resolution', targetType: 'claim', targetId: claim.id,
                inputRevision: claim.revision, inputHash: claim.input_hash, priority });
        }
        return { claim_id: anchor.id, claim_ids: claims.map(claim => claim.id),
            entity_id: decision.entityId, verdict: decision.verdict };
    })();
}

function supported(db, claimId) {
    return db.prepare(`SELECT entity_id,role,claim_revision,input_hash FROM memory_node_reviews
        WHERE claim_id=? AND verdict='supported'`).all(claimId).filter(row => {
        const claim = db.prepare('SELECT revision,input_hash FROM memory_claims WHERE id=?').get(claimId);
        return claim && Number(row.claim_revision) === Number(claim.revision) && row.input_hash === claim.input_hash;
    });
}

module.exports = { commit, supported };
