'use strict';

const protocol = require('./memoryProtocol');
const evidence = require('./memoryEvidenceResolution');
const candidates = require('./memoryEpisodeCandidates');
const profiles = require('./memoryProfileFields');
const search = require('./memorySearchProjection');
const readMode = require('./memoryReadMode');

function processStage(db, stage, handler, limit = 30, { priorityBand = 'current',
    targetType = null, targetId = null } = {}) {
    const jobs = protocol.leaseJobs(db, stage, { limit, priorityBand, targetType, targetId });
    const results = [];
    for (const job of jobs) {
        try {
            const result = handler(job);
            protocol.finishJob(db, job, 'done');
            results.push(result);
        } catch (error) {
            protocol.finishJob(db, job, error.code?.includes('stale') || error.code?.includes('changed') ? 'skipped' : 'needs_review',
                error.code || 'pipeline_stage_failed');
        }
    }
    return results;
}

async function tick(db, options = {}) {
    if (readMode.semanticMode(db) !== 'running') return { state: 'paused', reason: 'backfill' };
    return protocol.tracked(db, 'deterministic_pipeline', () => {
        if (options.targetId != null && !options.targetType) protocol.fail('memory_target_type_required');
        const filter = options.targetId == null ? {} : { targetType: options.targetType, targetId: options.targetId };
        const resolved = processStage(db, 'evidence_resolution', job => evidence.reconcile(db, job.target_id,
            { priority: job.priority }), 30, filter);
        const episodeCandidates = processStage(db, 'episode_candidate', job => {
            const candidate = candidates.create(db, [job.target_id]);
            protocol.enqueueJob(db, { stage: 'episode_publish', targetType: 'candidate', targetId: candidate.id,
                inputRevision: 1, inputHash: candidate.input_hash, priority: job.priority });
            return candidate;
        }, 30, filter);
        const profileQueue = processStage(db, 'profile_projection', job => profiles.enqueueFields(db, job.target_id,
            { priority: job.priority }), 30, filter);
        const projected = processStage(db, 'search_projection', job => {
            if (job.target_type === 'claim') return search.refreshClaim(db, job.target_id);
            if (job.target_type === 'memory') return search.refreshEpisode(db, job.target_id);
            if (job.target_type === 'saga') return search.refreshSaga(db, job.target_id);
            if (job.target_type === 'entity') return search.refreshProfile(db, job.target_id);
            protocol.fail('search_projection_target_invalid');
        }, 30, filter);
        return { resolved: resolved.length, episode_candidates: episodeCandidates.length,
            profile_queue: profileQueue.length, search_projection: projected.length };
    });
}

module.exports = { processStage, tick };
