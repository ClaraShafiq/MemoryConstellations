'use strict';

const protocol = require('./memoryProtocol');

function availability(db, claimId) {
    const claim = protocol.readClaim(db, claimId);
    if (!protocol.sourcesCurrent(db, claim)) return { available: false, reason: 'duty_source_changed' };
    if (claim.source_state !== 'supported' || claim.support_state !== 'supported'
        || claim.attribution_state !== 'supported') {
        return { available: false, reason: 'duty_no_supported_claims' };
    }
    return { available: true, claim };
}

function snapshot(db, claimId) {
    const checked = availability(db, claimId);
    if (!checked.available) protocol.fail(checked.reason);
    const claim = checked.claim;
    return { claim_id: claim.id, revision: claim.revision, input_hash: claim.input_hash,
        body: claim.body, domain: claim.domain, temporal_state: claim.temporal_state, sources: claim.sources };
}

function commit(db, decision) {
    const checked = availability(db, decision.claimId);
    if (!checked.available) protocol.fail(checked.reason);
    return protocol.setDuty(db, decision.claimId, {
        expectedRevision: decision.expectedRevision,
        inputHash: decision.inputHash,
        duty: decision.duty,
        contextScope: decision.contextScope,
        basis: decision.basis,
        state: decision.state,
        reviewer: decision.reviewer,
        priority: decision.priority,
    });
}

module.exports = { availability, snapshot, commit };
