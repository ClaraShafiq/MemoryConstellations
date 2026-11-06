'use strict';

const readMode = require('./memoryReadMode');

let active = null;

const REVIEW_STAGES = Object.freeze([
    'claim_review', 'claim_recovery', 'claim_duty', 'claim_classification', 'node_review',
    'constellation_discovery', 'constellation_identity', 'constellation_admission',
    'episode_publish', 'profile_facts', 'profile_status', 'correction_review',
]);

function configuredBackend(options) {
    if (options.maintenanceBackend) return options.maintenanceBackend;
    if (process.env.ALLOW_MEMORY_CODEX_CLI !== '1') return null;
    return require('./memoryCodexBackend').createCliAdapter({
        cwd: process.env.MEMORY_CODEX_ISOLATED_CWD,
        executable: process.env.MEMORY_CODEX_EXECUTABLE || 'codex',
    });
}

async function drainReviews(db, backend, limit) {
    const result = {};
    for (const stage of REVIEW_STAGES) {
        const rows = await require('./memoryCodexExecutor').runLeased(db, stage, backend,
            { limit, priorityBand: 'current' });
        if (rows.length) result[stage] = rows;
    }
    return result;
}

function backlog(db) {
    const cursor = require('./memoryScribe').lastCursor(db);
    const messages = db.prepare(`SELECT COUNT(*) count FROM messages WHERE status='sent' AND message_type!='image'
        AND (COALESCE(picked_up_at,timestamp)>? OR (COALESCE(picked_up_at,timestamp)=? AND id>?))`)
        .get(cursor.at, cursor.at, cursor.id).count;
    const currentJobs = db.prepare(`SELECT COUNT(*) count FROM memory_jobs
        WHERE status IN('queued','retry') AND priority>=?`).get(require('./memoryProtocol').LIVE_JOB_PRIORITY).count;
    const vectors = db.prepare("SELECT COUNT(*) count FROM memory_vector_projection WHERE status IN('queued','retry')").get().count;
    return { messages, current_jobs: currentJobs, vectors };
}

async function execute(db, options = {}) {
    if (readMode.semanticMode(db) !== 'running') return { outcome: 'paused', reason: 'maintenance_not_running' };
    const pending = backlog(db);
    const result = { outcome: 'no_change', backlog: pending };
    if (pending.messages) result.scribe = await require('./memoryScribe').checkAndRun();
    const backend = configuredBackend(options);
    if (pending.current_jobs) {
        result.pipeline = await require('./memoryPipeline').tick(db);
        if (backend) {
            result.reviews = await drainReviews(db, backend, options.reviewLimit || 10);
            result.pipeline_after_reviews = await require('./memoryPipeline').tick(db);
        } else {
            result.reviewer_required = db.prepare(`SELECT COUNT(*) count FROM memory_jobs
                WHERE status IN('queued','retry') AND priority>=? AND stage IN (${REVIEW_STAGES.map(() => '?').join(',')})`)
                .get(require('./memoryProtocol').LIVE_JOB_PRIORITY, ...REVIEW_STAGES).count;
        }
    }
    if (pending.vectors) result.vectors = await require('./memoryVectorProjection').drain(db,
        { limit: options.vectorLimit || 16, ...(options.vectorOptions || {}) });
    if (result.scribe || result.pipeline || result.vectors) result.outcome = 'done';
    return result;
}

function tick(db, options = {}) {
    if (active) return Promise.resolve({ outcome: 'skipped', reason: 'single_flight_active' });
    active = execute(db, options).finally(() => { active = null; });
    return active;
}

function status() {
    return { active: !!active };
}

module.exports = { REVIEW_STAGES, backlog, configuredBackend, drainReviews, execute, tick, status };
