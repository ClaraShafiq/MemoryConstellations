'use strict';

const protocol = require('./memoryProtocol');
const evidence = require('./memoryEvidenceResolution');
const candidates = require('./memoryEpisodeCandidates');
const profiles = require('./memoryProfileFields');
const search = require('./memorySearchProjection');
const readMode = require('./memoryReadMode');

function processStage(db, stage, handler, limit = 30) {
    const jobs = protocol.leaseJobs(db, stage, { limit });
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

async function tick(db) {
    if (readMode.semanticMode(db) !== 'running') return { state: 'paused', reason: 'backfill' };
    return protocol.tracked(db, 'deterministic_pipeline', () => {
        const resolved = processStage(db, 'evidence_resolution', job => evidence.reconcile(db, job.target_id));
        const episodeCandidates = processStage(db, 'episode_candidate', job => candidates.create(db, [job.target_id]));
        const profileQueue = processStage(db, 'profile_projection', job => profiles.enqueueFields(db, job.target_id));
        const projected = processStage(db, 'search_projection', job => {
            if (job.target_type === 'claim') return search.refreshClaim(db, job.target_id);
            if (job.target_type === 'memory') return search.refreshEpisode(db, job.target_id);
            if (job.target_type === 'entity') return search.refreshProfile(db, job.target_id);
            protocol.fail('search_projection_target_invalid');
        });
        return { resolved: resolved.length, episode_candidates: episodeCandidates.length,
            profile_queue: profileQueue.length, search_projection: projected.length };
    });
}

module.exports = { processStage, tick };
