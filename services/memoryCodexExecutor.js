'use strict';

const protocol = require('./memoryProtocol');
const policy = require('./memoryCodexReviewPolicy');
const claimReview = require('./memoryClaimReview');
const claimDuty = require('./memoryClaimDuty');
const classification = require('./memoryClassification');
const nodeReview = require('./memoryNodeReview');
const identity = require('./memoryConstellationIdentity');
const constellation = require('./memoryConstellation');
const episodes = require('./episodeWriter');
const profileFields = require('./memoryProfileFields');

function apply(db, proposed, { priority = protocol.BACKFILL_JOB_PRIORITY } = {}) {
    const action = policy.validate(proposed);
    switch (action.type) {
    case 'review_claim': return claimReview.commit(db, { ...action, priority });
    case 'set_claim_duty': return claimDuty.commit(db, { ...action, priority });
    case 'classify_claim': return classification.commit(db, { ...action, priority });
    case 'review_node': return nodeReview.commit(db, { ...action, priority });
    case 'resolve_identity': return identity.resolveIdentity(db, action);
    case 'admit_constellation': return constellation.admit(db, action);
    case 'publish_episode': return episodes.publish(db, action.candidateId, action.draft,
        { producer: action.producer, reviewer: action.reviewer, priority });
    case 'publish_profile_field': return profileFields.publish(db, action.entityId, action.field, action.draft,
        { producer: action.producer, modelRole: action.modelRole, personaHash: action.personaHash, priority });
    default: protocol.fail('codex_action_not_allowed');
    }
}

function assertMatchesJob(job, action) {
    const expectedType = {
        claim_review: 'review_claim', claim_duty: 'set_claim_duty', claim_classification: 'classify_claim',
        node_review: 'review_node', constellation_identity: 'resolve_identity',
        constellation_admission: 'admit_constellation', episode_publish: 'publish_episode',
        profile_facts: 'publish_profile_field', profile_status: 'publish_profile_field',
    }[job.stage];
    if (!expectedType || action.type !== expectedType) protocol.fail('codex_job_action_mismatch');
    const targetId = action.claimId ?? action.candidateId ?? action.entityId;
    if (Number(targetId) !== Number(job.target_id)) protocol.fail('codex_job_target_mismatch');
    if (job.stage === 'profile_facts' && action.field !== 'facts') protocol.fail('codex_job_field_mismatch');
    if (job.stage === 'profile_status' && action.field !== 'status') protocol.fail('codex_job_field_mismatch');
    if (action.expectedRevision !== undefined && Number(action.expectedRevision) !== Number(job.input_revision))
        protocol.fail('codex_job_revision_mismatch');
    const proposedHash = action.inputHash ?? action.draft?.input_hash;
    if (proposedHash !== undefined && proposedHash !== job.input_hash) protocol.fail('codex_job_hash_mismatch');
}

async function runLeased(db, stage, backend, { limit = 10, priorityBand = 'current' } = {}) {
    if (!backend || typeof backend.propose !== 'function') protocol.fail('codex_backend_invalid');
    const jobs = protocol.leaseJobs(db, stage, { limit, priorityBand });
    const results = [];
    for (const job of jobs) {
        try {
            if (stage === 'claim_classification') {
                const available = classification.availability(db, job.target_id);
                if (!available.available) {
                    protocol.finishJob(db, job, 'no_change', available.reason);
                    results.push({ job_id: job.id, status: 'no_change', error: available.reason });
                    continue;
                }
            }
            const action = await backend.propose(job);
            policy.validate(action);
            assertMatchesJob(job, action);
            const result = apply(db, action, { priority: job.priority });
            protocol.finishJob(db, job, 'done');
            results.push({ job_id: job.id, status: 'done', result });
        } catch (error) {
            protocol.finishJob(db, job, error.code?.includes('cas') ? 'skipped' : 'needs_review', error.code || 'review_failed');
            results.push({ job_id: job.id, status: 'needs_review', error: error.code || error.message });
        }
    }
    return results;
}

module.exports = { apply, assertMatchesJob, runLeased };
