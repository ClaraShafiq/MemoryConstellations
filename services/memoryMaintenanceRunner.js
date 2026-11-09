'use strict';

const readMode = require('./memoryReadMode');
const protocol = require('./memoryProtocol');

let active = null;

const REVIEW_STAGES = Object.freeze([
    'claim_review_a', 'claim_review_b', 'claim_recovery', 'claim_duty', 'claim_classification', 'node_review',
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

async function drainReviews(db, backend, limit, target = {}) {
    const result = {};
    for (const stage of REVIEW_STAGES) {
        const rows = await require('./memoryCodexExecutor').runLeased(db, stage, backend,
            { limit, priorityBand: 'current', ...target });
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
    const vectors = db.prepare(`SELECT COUNT(*) count FROM memory_vector_projection
        WHERE status IN('queued','retry') OR (status='running' AND (lease_until IS NULL OR lease_until<=?))`)
        .get(Date.now()).count;
    return { messages, current_jobs: currentJobs, vectors };
}

async function execute(db, options = {}) {
    const targeted = options.targetId != null;
    if (targeted && !options.targetType) protocol.fail('memory_target_type_required');
    if (readMode.semanticMode(db) !== 'running') return { outcome: 'paused', reason: 'maintenance_not_running' };
    const pending = backlog(db);
    const target = targeted ? { targetId: options.targetId, targetType: options.targetType } : {};
    const result = { outcome: 'no_change', backlog: pending, target: targeted ? target : null };
    const ensureForegroundIdle = () => {
        if (!options.childProcess) return;
        const state = require('./memoryForegroundGate').status(db);
        if (state.blocked) protocol.fail(state.reason);
    };
    ensureForegroundIdle();
    if (pending.messages && !targeted) result.scribe = await require('./memoryScribe').checkAndRun();
    const backend = configuredBackend(options);
    if (pending.current_jobs) {
        ensureForegroundIdle();
        result.pipeline = await require('./memoryPipeline').tick(db, target);
        if (backend) {
            ensureForegroundIdle();
            result.reviews = await drainReviews(db, backend, options.reviewLimit || 10, target);
            ensureForegroundIdle();
            result.pipeline_after_reviews = await require('./memoryPipeline').tick(db, target);
        } else {
            const targetSql = targeted ? ' AND target_type=? AND target_id=?' : '';
            result.reviewer_required = db.prepare(`SELECT COUNT(*) count FROM memory_jobs
                WHERE status IN('queued','retry') AND priority>=? AND stage IN (${REVIEW_STAGES.map(() => '?').join(',')})${targetSql}`)
                .get(require('./memoryProtocol').LIVE_JOB_PRIORITY, ...REVIEW_STAGES,
                    ...(targeted ? [options.targetType, Number(options.targetId)] : [])).count;
        }
    }
    if (pending.vectors && !targeted) {
        ensureForegroundIdle();
        result.vectors = await require('./memoryVectorProjection').drain(db,
        { limit: options.vectorLimit || 16, ...(options.vectorOptions || {}) });
    }
    if (result.scribe || result.pipeline || result.reviews || result.vectors) result.outcome = 'done';
    return result;
}

function tick(db, options = {}) {
    if (active) return Promise.resolve({ outcome: 'skipped', reason: 'single_flight_active' });
    active = require('./memoryProtocol').tracked(db, 'maintenance_runner', () => execute(db, options))
        .finally(() => { active = null; });
    return active;
}

function status() {
    return { active: !!active };
}

module.exports = { REVIEW_STAGES, backlog, configuredBackend, drainReviews, execute, tick, status };
