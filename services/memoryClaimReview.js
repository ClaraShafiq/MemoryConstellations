'use strict';

const protocol = require('./memoryProtocol');

const CONTRACT_VERSION = 'claim-review-v2';
const QUESTION_RE = /(?:[?？]\s*$|^(?:是不是|是否|会不会|难道)|吗\s*$)/i;

function sourceKind(source) {
    return QUESTION_RE.test(String(source.quote || '').trim()) ? 'question_anchor' : 'declarative_evidence';
}

function snapshot(db, claimId, pass = null) {
    const claim = protocol.readClaim(db, claimId);
    return {
        contract_version: CONTRACT_VERSION, review_pass: pass,
        claim_id: claim.id, revision: claim.revision, input_hash: claim.input_hash,
        body: claim.body, domain: claim.domain, temporal_state: claim.temporal_state,
        sources: claim.sources.map(source => ({ message_id: source.message_id, quote: source.quote,
            speaker: source.speaker, source_time: source.source_time, evidence_kind: sourceKind(source) })),
        rule: 'Questions may establish the current object anchor, but only a declarative source can prove a proposition.',
    };
}

function validateDecision(claim, decision) {
    if (!['supported', 'rejected', 'pending'].includes(decision.support)
        || !['supported', 'rejected', 'pending'].includes(decision.attribution))
        protocol.fail('memory_review_invalid');
    if (decision.support === 'supported'
        && claim.sources.every(source => sourceKind(source) === 'question_anchor'))
        protocol.fail('memory_review_question_not_fact_evidence');
}

function queueRecovery(db, result, priority) {
    const recoveryInput = require('./memoryClaimRecovery').snapshot(db, result.fragment_id, {
        disputedClaimIds: [result.id],
    });
    protocol.enqueueJob(db, { stage: 'claim_recovery', targetType: 'fragment', targetId: result.fragment_id,
        inputRevision: result.revision, inputHash: recoveryInput.input_hash, priority });
}

function finalize(db, claim, decision, upstreamStage) {
    validateDecision(claim, decision);
    const result = protocol.reviewClaim(db, claim.id, {
        expectedRevision: claim.revision, inputHash: claim.input_hash,
        support: decision.support, attribution: decision.attribution,
        temporalState: decision.temporalState, reviewer: decision.reviewer,
        reason: decision.reason, priority: decision.priority, upstreamStage,
    });
    if (decision.support === 'rejected' || decision.attribution === 'rejected') {
        const priority = protocol.resolveJobPriority(db, upstreamStage, result.id,
            result.revision, result.input_hash, decision.priority);
        queueRecovery(db, result, priority);
    }
    return result;
}

function submitPass(db, decision) {
    const pass = String(decision.pass || '').toLowerCase();
    if (!['a', 'b'].includes(pass)) protocol.fail('memory_review_pass_invalid');
    if (decision.contractVersion && decision.contractVersion !== CONTRACT_VERSION)
        protocol.fail('memory_review_contract_changed');
    const claim = protocol.readClaim(db, decision.claimId);
    if (Number(decision.expectedRevision) !== Number(claim.revision) || decision.inputHash !== claim.input_hash)
        protocol.fail('memory_claim_cas_failed');
    if (!protocol.sourcesCurrent(db, claim)) protocol.fail('memory_claim_source_changed');
    validateDecision(claim, decision);
    if (!decision.reviewer) protocol.fail('memory_review_reviewer_required');
    db.prepare(`INSERT INTO memory_claim_review_passes(
        claim_id,claim_revision,input_hash,contract_version,pass,support_state,attribution_state,
        temporal_state,reviewer,reason) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(claim_id,claim_revision,input_hash,contract_version,pass) DO UPDATE SET
        support_state=excluded.support_state,attribution_state=excluded.attribution_state,
        temporal_state=excluded.temporal_state,reviewer=excluded.reviewer,reason=excluded.reason,
        reviewed_at=CURRENT_TIMESTAMP`).run(claim.id, claim.revision, claim.input_hash, CONTRACT_VERSION,
        pass, decision.support, decision.attribution, decision.temporalState || claim.temporal_state,
        decision.reviewer, decision.reason || null);
    const rows = db.prepare(`SELECT * FROM memory_claim_review_passes WHERE claim_id=? AND claim_revision=?
        AND input_hash=? AND contract_version=? ORDER BY pass`).all(
        claim.id, claim.revision, claim.input_hash, CONTRACT_VERSION);
    if (rows.length < 2) return { outcome: 'awaiting_peer', claim_id: claim.id, pass };
    const [a, b] = rows;
    const agreement = a.support_state === b.support_state
        && a.attribution_state === b.attribution_state
        && a.temporal_state === b.temporal_state;
    if (!agreement) {
        if (claim.support_state !== 'pending' || claim.attribution_state !== 'pending') {
            protocol.reviewClaim(db, claim.id, { expectedRevision: claim.revision, inputHash: claim.input_hash,
                support: 'pending', attribution: 'pending', temporalState: claim.temporal_state,
                reviewer: 'host:independent-review', reason: 'independent_review_disagreement',
                priority: decision.priority, upstreamStage: `claim_review_${pass}` });
        }
        return { outcome: 'needs_review', claim_id: claim.id, reason: 'independent_review_disagreement' };
    }
    const merged = { support: a.support_state, attribution: a.attribution_state,
        temporalState: a.temporal_state, reviewer: 'host:independent-review',
        reason: [a.reason, b.reason].filter(Boolean).join(' | ') || null, priority: decision.priority };
    return { outcome: 'finalized', claim: finalize(db, protocol.readClaim(db, claim.id), merged,
        `claim_review_${pass}`) };
}

// Human overrides and deterministic fixtures may finalize explicitly. Runtime model
// adapters must submit independent A and B passes through submitPass().
function commit(db, decision) {
    if (decision.pass) return submitPass(db, decision);
    if (!/^(?:manual:|test-|fixture-)/.test(String(decision.reviewer || '')))
        protocol.fail('memory_independent_review_required');
    const claim = protocol.readClaim(db, decision.claimId);
    return finalize(db, claim, decision, 'claim_review_a');
}

module.exports = { CONTRACT_VERSION, QUESTION_RE, sourceKind, snapshot, submitPass, commit };
