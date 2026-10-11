'use strict';

const protocol = require('./memoryProtocol');

function snapshot(db, claimId) {
    const claim = protocol.readClaim(db, claimId);
    return { claim_id: claim.id, revision: claim.revision, input_hash: claim.input_hash,
        body: claim.body, domain: claim.domain, temporal_state: claim.temporal_state, sources: claim.sources };
}

function commit(db, decision) {
    return protocol.setDuty(db, decision.claimId, {
        expectedRevision: decision.expectedRevision,
        inputHash: decision.inputHash,
        duty: decision.duty,
        contextScope: decision.contextScope,
        basis: decision.basis,
        state: decision.state,
        reviewer: decision.reviewer,
    });
}

module.exports = { snapshot, commit };
