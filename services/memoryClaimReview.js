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
    const result = protocol.reviewClaim(db, decision.claimId, {
        expectedRevision: decision.expectedRevision,
        inputHash: decision.inputHash,
        support: decision.support,
        attribution: decision.attribution,
        temporalState: decision.temporalState,
        reviewer: decision.reviewer,
        reason: decision.reason,
        priority: decision.priority,
    });
    if (decision.support === 'rejected' || decision.attribution === 'rejected') {
        const priority = protocol.resolveJobPriority(db, 'claim_review', result.id,
            result.revision, result.input_hash, decision.priority);
        const recoveryInput = require('./memoryClaimRecovery').snapshot(db, result.fragment_id);
        protocol.enqueueJob(db, { stage: 'claim_recovery', targetType: 'fragment', targetId: result.fragment_id,
            inputRevision: result.revision, inputHash: recoveryInput.input_hash, priority });
    }
    return result;
}

module.exports = { snapshot, commit };
