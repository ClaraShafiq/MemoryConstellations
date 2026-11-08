'use strict';

const { config } = require('./memoryConfig');
const vectors = require('./memoryVectorProjection');
const legacyFts = require('./memoryLegacyFts');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_derived_health_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL CHECK(scope IN('local','remote')),
    status TEXT NOT NULL CHECK(status IN('healthy','drift','unverifiable')),
    issue_codes_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(issue_codes_json)),
    checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_derived_health_runs_checked
    ON memory_derived_health_runs(scope,checked_at DESC);
`;

const DEFAULT_STALE_MS = 30 * 60 * 1000;
const DEFAULT_MESSAGE_STALE_MS = 4 * 60 * 60 * 1000;

function tableExists(db, name) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function ageMs(value, now) {
    if (value == null) return null;
    const numeric = Number(value);
    const timestamp = Number.isFinite(numeric) && numeric > 10_000_000_000 ? numeric : Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
}

function rank(status) {
    return status === 'unverifiable' ? 2 : status === 'drift' ? 1 : 0;
}

function mergeStatus(...statuses) {
    return statuses.reduce((current, status) => rank(status) > rank(current) ? status : current, 'healthy');
}

function requestedReadMode(db) {
    const row = db.prepare("SELECT setting_value FROM user_settings WHERE setting_key='memory_chat_read_mode'").get();
    return row?.setting_value === 'verified' ? 'verified' : 'legacy';
}

function semanticMode(db) {
    const row = db.prepare("SELECT setting_value FROM user_settings WHERE setting_key='memory_semantic_maintenance_mode'").get();
    return row?.setting_value === 'running' ? 'running' : 'backfill';
}

function inspectJobs(db, now, staleMs) {
    const rows = db.prepare(`SELECT stage,status,COUNT(*) count,MIN(updated_at) oldest_updated_at
        FROM memory_jobs WHERE status IN('queued','retry','running') GROUP BY stage,status ORDER BY stage,status`).all();
    const expiredLeases = db.prepare(`SELECT COUNT(*) count FROM memory_jobs
        WHERE status='running' AND lease_until IS NOT NULL AND lease_until<=?`).get(now).count;
    const stale = rows.filter(row => ['queued', 'retry'].includes(row.status)
        && ageMs(row.oldest_updated_at, now) > staleMs)
        .map(row => ({ stage: row.stage, status: row.status, count: row.count,
            age_ms: ageMs(row.oldest_updated_at, now) }));
    return { rows, expired_leases: expiredLeases, stale };
}

function inspectMessages(db, now, messageStaleMs) {
    const cursor = require('./memoryScribe').lastCursor(db);
    const row = db.prepare(`SELECT COUNT(*) count,MIN(COALESCE(picked_up_at,timestamp)) oldest
        FROM messages WHERE status='sent' AND message_type!='image'
        AND (COALESCE(picked_up_at,timestamp)>? OR (COALESCE(picked_up_at,timestamp)=? AND id>?))`)
        .get(cursor.at, cursor.at, cursor.id);
    return { count: row.count, oldest_age_ms: ageMs(row.oldest, now),
        stale: row.count > 0 && ageMs(row.oldest, now) > messageStaleMs };
}

function releaseBlockers(db, { runnerActive = false } = {}) {
    const blockers = [];
    if (runnerActive) blockers.push('maintenance_runner_active');
    const expired = db.prepare(`SELECT COUNT(*) count FROM memory_jobs
        WHERE status='running' AND lease_until IS NOT NULL AND lease_until<=?`).get(Date.now()).count;
    if (expired) blockers.push('job_leases_expired');
    try {
        const manifest = vectors.manifest(db);
        blockers.push(...manifest.blockers);
        if (!manifest.expected) blockers.push('projection_empty');
    } catch (_) {
        blockers.push('vector_manifest_unverifiable');
    }
    return [...new Set(blockers)];
}

function inspectLocal(db, options = {}) {
    const now = options.now || Date.now();
    const staleMs = Number(options.staleMs || process.env.MEMORY_HEALTH_STALE_MS || DEFAULT_STALE_MS);
    const messageStaleMs = Number(options.messageStaleMs
        || process.env.MEMORY_HEALTH_MESSAGE_STALE_MS || DEFAULT_MESSAGE_STALE_MS);
    const issues = [];
    let status = 'healthy';
    const maintenance = semanticMode(db);
    const jobs = inspectJobs(db, now, staleMs);
    if (jobs.expired_leases) issues.push('job_leases_expired');
    if (maintenance === 'running') {
        issues.push(...jobs.stale.map(row => `job_backlog_stale:${row.stage}`));
    }
    const messages = inspectMessages(db, now, messageStaleMs);
    if (maintenance === 'running' && messages.stale) issues.push('scribe_backlog_stale');

    let manifest;
    try {
        manifest = vectors.manifest(db);
        if (!manifest.ready) issues.push(...manifest.blockers);
    } catch (_) {
        manifest = { ready: false, expected: 0, done: 0, blockers: ['vector_manifest_unverifiable'] };
        issues.push('vector_manifest_unverifiable');
        status = 'unverifiable';
    }

    let legacy = { status: 'not_applicable', reason: 'modern_pipeline_authoritative' };
    if (config.pipeline?.mode !== 'modern') {
        try {
            legacy = legacyFts.inspect(db, { deep: !!options.deep });
            issues.push(...legacy.issues);
        } catch (_) {
            legacy = { status: 'unverifiable', issues: ['legacy_fts_unverifiable'] };
            issues.push('legacy_fts_unverifiable');
            status = 'unverifiable';
        }
    }
    if (issues.length && status !== 'unverifiable') status = 'drift';
    return {
        status,
        checked_at: now,
        pipeline_mode: config.pipeline?.mode === 'modern' ? 'modern' : 'legacy',
        requested_read_mode: requestedReadMode(db),
        semantic_maintenance: maintenance,
        issues: [...new Set(issues)],
        messages,
        jobs,
        vector_manifest: { ready: manifest.ready, expected: manifest.expected,
            done: manifest.done, blockers: manifest.blockers },
        legacy_fts: legacy,
        coverage: {
            covers: ['freshness', 'leases', 'receipt_counts', 'manifest_digest', 'legacy_fts_when_applicable'],
            does_not_cover: ['content_semantics', 'model_judgment_quality', 'unknown_design_gaps'],
        },
    };
}

async function inspectRemote(db, options = {}) {
    const local = inspectLocal(db, options);
    const remote = await vectors.verifyRemote(db, options);
    return { ...local, status: mergeStatus(local.status, remote.status),
        issues: [...new Set([...local.issues, ...(remote.blockers || [])])], remote_vector: remote };
}

function record(db, report, scope = 'local') {
    if (!tableExists(db, 'memory_derived_health_runs')) return null;
    return Number(db.prepare(`INSERT INTO memory_derived_health_runs(scope,status,issue_codes_json,checked_at)
        VALUES(?,?,?,?)`).run(scope, report.status, JSON.stringify(report.issues || []), report.checked_at || Date.now()).lastInsertRowid);
}

module.exports = { SCHEMA, inspectLocal, inspectRemote, releaseBlockers, record, mergeStatus };
