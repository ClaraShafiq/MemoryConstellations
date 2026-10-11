'use strict';

const protocol = require('./memoryProtocol');

function snapshot(db, claimId) {
    const claim = protocol.readClaim(db, claimId);
    return {
        claim_id: claim.id, revision: claim.revision, input_hash: claim.input_hash,
        body: claim.body, domain: claim.domain, temporal_state: claim.temporal_state,
        sources: claim.sources.map(source => ({ message_id: source.message_id, quote: source.quote,
            speaker: source.speaker, source_time: source.source_time })),
    };
}

function commit(db, decision) {
    return protocol.reviewClaim(db, decision.claimId, {
        expectedRevision: decision.expectedRevision,
        inputHash: decision.inputHash,
        support: decision.support,
        attribution: decision.attribution,
        temporalState: decision.temporalState,
        reviewer: decision.reviewer,
        reason: decision.reason,
    });
}

module.exports = { snapshot, commit };
