'use strict';

const protocol = require('./memoryProtocol');
const policy = require('./memoryCodexReviewPolicy');
const classification = require('./memoryClassification');
const nodeReview = require('./memoryNodeReview');
const identity = require('./memoryConstellationIdentity');
const constellation = require('./memoryConstellation');
const episodes = require('./episodeWriter');
const profileFields = require('./memoryProfileFields');
const discovery = require('./memoryConstellationDiscovery');
const corrections = require('./memoryCorrection');

function publicJob(job) {
    return Object.freeze({
        id: job.id, stage: job.stage, target_type: job.target_type,
        target_id: job.target_id, input_revision: job.input_revision,
        input_hash: job.input_hash, priority: job.priority,
    });
}

function snapshotForJob(db, job) {
    let input;
    switch (job.stage) {
    case 'fragment_classification': input = classification.snapshot(db, job.target_id); break;
    case 'constellation_discovery': input = discovery.snapshot(db, job.target_id); break;
    case 'constellation_identity':
    case 'constellation_admission': input = identity.snapshot(db, job.target_id); break;
    case 'episode_publish': input = require('./memoryEpisodeProjection').snapshot(db, job.target_id); break;
    case 'profile_facts':
    case 'profile_status': {
        const field = job.stage === 'profile_facts' ? 'facts' : 'status';
        input = { field, projection: require('./memoryProfileProjection').snapshot(db, job.target_id, field),
            current: profileFields.readField(db, job.target_id, field) };
        break;
    }
    case 'correction_review': input = corrections.snapshot(db, job.target_id); break;
    case 'node_review': {
        const claim = protocol.readClaim(db, job.target_id);
        const row = db.prepare('SELECT links_json FROM memory_claim_classification WHERE claim_id=?').get(claim.id);
        const links = row ? JSON.parse(row.links_json) : [];
        const fragmentClaims = protocol.claimsForFragment(db, claim.fragment_id)
            .filter(item => protocol.eligible(db, item.id))
            .map(item => ({ id: item.id, body: item.body, domain: item.domain,
                temporal_state: item.temporal_state, sources: item.sources,
                duty: { duty: item.duty, context_scope: item.context_scope, state: item.duty_state } }));
        input = { claim, fragment_claims: fragmentClaims, node_roles: [...classification.ROLES],
            offered_links: links.map(link => ({ ...link,
                entity: db.prepare('SELECT id,name,category,status FROM entity_profiles WHERE id=?').get(link.entity_id) || null })) };
        break;
    }
    default: protocol.fail('codex_job_snapshot_not_supported');
    }
    return Object.freeze({ job: publicJob(job), input });
}

function apply(db, proposed, { priority = protocol.BACKFILL_JOB_PRIORITY } = {}) {
    const action = policy.validate(proposed);
    switch (action.type) {
    case 'classify_claim': return classification.commit(db, { ...action, priority });
    case 'review_node': return nodeReview.commit(db, { ...action, priority });
    case 'resolve_identity': return identity.resolveIdentity(db, action);
    case 'admit_constellation': return constellation.admit(db, action);
    case 'publish_episode': return episodes.publish(db, action.candidateId, action.draft,
        { producer: action.producer, reviewer: action.reviewer, priority });
    case 'publish_profile_field': return profileFields.publish(db, action.entityId, action.field, action.draft,
        { producer: action.producer, modelRole: action.modelRole, personaHash: action.personaHash, priority });
    case 'discover_constellation': return discovery.commit(db, { ...action, priority });
    case 'review_correction': return corrections.review(db, action);
    default: protocol.fail('codex_action_not_allowed');
    }
}

function assertMatchesJob(job, action) {
    const expectedType = {
        fragment_classification: 'classify_claim',
        node_review: 'review_node', constellation_identity: 'resolve_identity',
        constellation_admission: 'admit_constellation', episode_publish: 'publish_episode',
        profile_facts: 'publish_profile_field', profile_status: 'publish_profile_field',
        constellation_discovery: 'discover_constellation',
        correction_review: 'review_correction',
    }[job.stage];
    if (!expectedType || action.type !== expectedType) protocol.fail('codex_job_action_mismatch');
    const targetId = action.claimId ?? action.candidateId ?? action.entityId ?? action.fragmentId ?? action.receiptId;
    if (Number(targetId) !== Number(job.target_id)) protocol.fail('codex_job_target_mismatch');
    if (job.stage === 'profile_facts' && action.field !== 'facts') protocol.fail('codex_job_field_mismatch');
    if (job.stage === 'profile_status' && action.field !== 'status') protocol.fail('codex_job_field_mismatch');
    if (action.expectedRevision !== undefined && Number(action.expectedRevision) !== Number(job.input_revision))
        protocol.fail('codex_job_revision_mismatch');
    const proposedHash = action.inputHash ?? action.draft?.input_hash;
    if (proposedHash !== undefined && proposedHash !== job.input_hash) protocol.fail('codex_job_hash_mismatch');
}

async function runLeased(db, stage, backend, { limit = 10, priorityBand = 'current',
    targetType = null, targetId = null } = {}) {
    if (!backend || typeof backend.propose !== 'function') protocol.fail('codex_backend_invalid');
    const jobs = protocol.leaseJobs(db, stage, { limit, priorityBand, targetType, targetId });
    const results = [];
    for (const job of jobs) {
        try {
            if (stage === 'fragment_classification') {
                const available = classification.availability(db, job.target_id);
                if (!available.available) {
                    protocol.finishJob(db, job, 'no_change', available.reason);
                    results.push({ job_id: job.id, status: 'no_change', error: available.reason });
                    continue;
                }
            }
            require('./memoryModelBudget').reserve(db, 'maintenance');
            const action = await backend.propose(snapshotForJob(db, job));
            policy.validate(action);
            assertMatchesJob(job, action);
            const result = apply(db, action, { priority: job.priority });
            const unresolved = result?.outcome === 'needs_review';
            protocol.finishJob(db, job, unresolved ? 'needs_review' : 'done',
                unresolved ? result.reason : null);
            results.push({ job_id: job.id, status: unresolved ? 'needs_review' : 'done', result });
        } catch (error) {
            protocol.finishJob(db, job, error.code?.includes('cas') ? 'skipped' : 'needs_review', error.code || 'review_failed');
            results.push({ job_id: job.id, status: 'needs_review', error: error.code || error.message });
        }
    }
    return results;
}

module.exports = { apply, assertMatchesJob, snapshotForJob, runLeased };
