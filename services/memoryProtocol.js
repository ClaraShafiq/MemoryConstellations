'use strict';

// Public, provider-neutral memory protocol. Models may propose typed actions;
// only this host module writes authoritative state.
const { createHash, randomUUID } = require('node:crypto');
const { encryption } = require('../encryption');

const SCOPE = 'default';
const DOMAINS = Object.freeze([
    'user_statement', 'observed_activity', 'interaction', 'companion_opinion',
    'inference', 'fiction', 'third_party', 'legacy_unverified',
]);
const TEMPORAL_STATES = Object.freeze([
    'unknown', 'planned', 'in_progress', 'completed', 'cancelled', 'historical',
]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fragment_id INTEGER NOT NULL REFERENCES memory_fragments(id),
    claim_key TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL DEFAULT 'default' CHECK(scope='default'),
    body_enc TEXT NOT NULL,
    domain TEXT NOT NULL,
    subject_entity_id INTEGER REFERENCES entity_profiles(id),
    temporal_state TEXT NOT NULL DEFAULT 'unknown',
    event_from TEXT,
    event_until TEXT,
    time_precision TEXT NOT NULL DEFAULT 'unknown',
    source_state TEXT NOT NULL DEFAULT 'pending',
    support_state TEXT NOT NULL DEFAULT 'pending',
    attribution_state TEXT NOT NULL DEFAULT 'pending',
    input_hash TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    reviewer TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_memory_claims_fragment ON memory_claims(fragment_id, revision);
CREATE TABLE IF NOT EXISTS memory_claim_sources (
    claim_id INTEGER NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    message_fingerprint TEXT NOT NULL,
    quote_enc TEXT NOT NULL,
    speaker TEXT NOT NULL CHECK(speaker IN('user','companion')),
    source_time TEXT,
    PRIMARY KEY(claim_id, message_id)
);
CREATE TABLE IF NOT EXISTS memory_claim_reviews (
    claim_id INTEGER NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
    claim_revision INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    support_state TEXT NOT NULL,
    attribution_state TEXT NOT NULL,
    temporal_state TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    reason TEXT,
    reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(claim_id, claim_revision)
);
CREATE TABLE IF NOT EXISTS memory_claim_duties (
    claim_id INTEGER PRIMARY KEY REFERENCES memory_claims(id) ON DELETE CASCADE,
    claim_revision INTEGER NOT NULL,
    duty TEXT NOT NULL,
    context_scope TEXT NOT NULL,
    basis TEXT NOT NULL,
    state TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS memory_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    input_revision INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(stage, target_type, target_id, input_revision, input_hash)
);
CREATE INDEX IF NOT EXISTS idx_memory_jobs_ready
    ON memory_jobs(stage, status, next_attempt_at, priority DESC, created_at);
CREATE TABLE IF NOT EXISTS memory_review_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    action TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS memory_pipeline_runs (
    stage TEXT PRIMARY KEY,
    last_started_at TEXT,
    last_success_at TEXT,
    last_failure_at TEXT,
    last_error_code TEXT,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0
);
`;

function fail(code) {
    const error = new Error(code);
    error.code = code;
    throw error;
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function hash(value) {
    return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function encrypt(value) {
    const result = encryption.encrypt(String(value));
    if (typeof result !== 'string' || !result.startsWith('enc:')) fail('memory_encryption_failed');
    return result;
}

function decrypt(value) {
    const result = encryption.decrypt(value, { silent: true });
    if (typeof result !== 'string' || result.startsWith('[解密失败')) fail('memory_decryption_failed');
    return result;
}

function messageText(row) {
    if (!row) fail('memory_source_missing');
    return row.is_encrypted ? decrypt(row.content) : String(row.content || '');
}

function messageFingerprint(row) {
    return hash({
        id: Number(row.id), sender: row.sender, content: messageText(row),
        timestamp: row.timestamp, status: row.status, chat_id: row.chat_id,
    });
}

function normalizeSpeaker(sender) {
    return sender === 'user' ? 'user' : 'companion';
}

function captureSource(db, messageId, quote) {
    const row = db.prepare('SELECT id,chat_id,sender,content,is_encrypted,timestamp,status FROM messages WHERE id=?').get(messageId);
    const text = messageText(row);
    const exact = String(quote || '');
    if (!exact || !text.includes(exact)) fail('memory_quote_not_exact');
    return {
        message_id: Number(row.id), message_fingerprint: messageFingerprint(row),
        quote: exact, speaker: normalizeSpeaker(row.sender), source_time: row.timestamp,
    };
}

function claimInput(body, domain, temporal, sources, subjectEntityId = null) {
    return hash({ body, domain, temporal, sources: sources.map(source => ({
        message_id: source.message_id, message_fingerprint: source.message_fingerprint,
        quote: source.quote, speaker: source.speaker, source_time: source.source_time,
    })), subject_entity_id: subjectEntityId });
}

function createClaim(db, input) {
    if (!Number.isSafeInteger(input.fragmentId) || input.fragmentId <= 0) fail('memory_fragment_invalid');
    if (!DOMAINS.includes(input.domain)) fail('memory_domain_invalid');
    if (!TEMPORAL_STATES.includes(input.temporal?.state || 'unknown')) fail('memory_temporal_invalid');
    if (!Array.isArray(input.sources) || input.sources.length === 0) fail('memory_sources_required');
    const fragment = db.prepare('SELECT id,status FROM memory_fragments WHERE id=?').get(input.fragmentId);
    if (!fragment) fail('memory_fragment_missing');
    const body = String(input.body || '').trim();
    if (!body) fail('memory_claim_body_required');
    const inputHash = claimInput(body, input.domain, input.temporal || {}, input.sources, input.subjectEntityId || null);
    const key = input.claimKey || hash({ fragment_id: input.fragmentId, input_hash: inputHash });
    return db.transaction(() => {
        const existing = db.prepare('SELECT * FROM memory_claims WHERE claim_key=?').get(key);
        if (existing) {
            if (existing.input_hash !== inputHash) fail('memory_claim_identity_conflict');
            return readClaim(db, existing.id);
        }
        const result = db.prepare(`INSERT INTO memory_claims(
            fragment_id,claim_key,scope,body_enc,domain,subject_entity_id,temporal_state,
            event_from,event_until,time_precision,input_hash)
            VALUES(?,?,'default',?,?,?,?,?,?,?,?)`).run(
            input.fragmentId, key, encrypt(body), input.domain, input.subjectEntityId || null,
            input.temporal?.state || 'unknown', input.temporal?.event_from || null,
            input.temporal?.event_until || null, input.temporal?.precision || 'unknown', inputHash,
        );
        const claimId = Number(result.lastInsertRowid);
        const insertSource = db.prepare(`INSERT INTO memory_claim_sources(
            claim_id,message_id,message_fingerprint,quote_enc,speaker,source_time) VALUES(?,?,?,?,?,?)`);
        for (const source of input.sources) insertSource.run(
            claimId, source.message_id, source.message_fingerprint, encrypt(source.quote),
            source.speaker, source.source_time || null,
        );
        enqueueJob(db, { stage: 'claim_review', targetType: 'claim', targetId: claimId, inputRevision: 1, inputHash });
        return readClaim(db, claimId);
    })();
}

function readClaim(db, claimId) {
    const row = db.prepare('SELECT * FROM memory_claims WHERE id=?').get(claimId);
    if (!row) fail('memory_claim_missing');
    const sources = db.prepare('SELECT * FROM memory_claim_sources WHERE claim_id=? ORDER BY message_id').all(claimId).map(source => ({
        message_id: source.message_id, message_fingerprint: source.message_fingerprint,
        quote: decrypt(source.quote_enc), speaker: source.speaker, source_time: source.source_time,
    }));
    return { ...row, body: decrypt(row.body_enc), sources };
}

function sourcesCurrent(db, claim) {
    return claim.sources.every(source => {
        const row = db.prepare('SELECT id,chat_id,sender,content,is_encrypted,timestamp,status FROM messages WHERE id=?').get(source.message_id);
        if (!row || messageFingerprint(row) !== source.message_fingerprint) return false;
        const text = messageText(row);
        return text.includes(source.quote) && normalizeSpeaker(row.sender) === source.speaker;
    });
}

function reviewClaim(db, claimId, decision) {
    const claim = readClaim(db, claimId);
    if (decision.expectedRevision !== claim.revision || decision.inputHash !== claim.input_hash) fail('memory_claim_cas_failed');
    if (!sourcesCurrent(db, claim)) fail('memory_claim_source_changed');
    if (!['supported','rejected','pending'].includes(decision.support)) fail('memory_review_invalid');
    if (!['supported','rejected','pending'].includes(decision.attribution)) fail('memory_review_invalid');
    const temporal = decision.temporalState || claim.temporal_state;
    if (!TEMPORAL_STATES.includes(temporal)) fail('memory_review_invalid');
    return db.transaction(() => {
        const before = readClaim(db, claimId);
        const changed = db.prepare(`UPDATE memory_claims SET support_state=?,attribution_state=?,source_state='supported',
            temporal_state=?,reviewer=?,verified_at=CASE WHEN ?='supported' AND ?='supported' THEN CURRENT_TIMESTAMP ELSE NULL END,
            updated_at=CURRENT_TIMESTAMP WHERE id=? AND revision=? AND input_hash=?`).run(
            decision.support, decision.attribution, temporal, decision.reviewer,
            decision.support, decision.attribution, claimId, decision.expectedRevision, decision.inputHash,
        );
        if (changed.changes !== 1) fail('memory_claim_cas_failed');
        db.prepare(`INSERT OR REPLACE INTO memory_claim_reviews(
            claim_id,claim_revision,input_hash,support_state,attribution_state,temporal_state,reviewer,reason)
            VALUES(?,?,?,?,?,?,?,?)`).run(claimId, claim.revision, claim.input_hash, decision.support,
            decision.attribution, temporal, decision.reviewer, decision.reason || null);
        const after = readClaim(db, claimId);
        recordAction(db, 'claim', claimId, claim.revision, 'review', before, after, decision.reviewer);
        enqueueJob(db, { stage: 'claim_duty', targetType: 'claim', targetId: claimId, inputRevision: claim.revision, inputHash: claim.input_hash });
        return after;
    })();
}

function setDuty(db, claimId, decision) {
    const claim = readClaim(db, claimId);
    if (decision.expectedRevision !== claim.revision || decision.inputHash !== claim.input_hash) fail('memory_claim_cas_failed');
    if (!sourcesCurrent(db, claim)) fail('memory_claim_source_changed');
    const allowed = ['stable_fact','core_trait','partner_pattern','current_state','event','preference','opinion','fiction','third_party','unresolved'];
    if (!allowed.includes(decision.duty)) fail('memory_duty_invalid');
    db.prepare(`INSERT INTO memory_claim_duties(claim_id,claim_revision,duty,context_scope,basis,state,reviewer)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(claim_id) DO UPDATE SET
        claim_revision=excluded.claim_revision,duty=excluded.duty,context_scope=excluded.context_scope,
        basis=excluded.basis,state=excluded.state,reviewer=excluded.reviewer,updated_at=CURRENT_TIMESTAMP`).run(
        claimId, claim.revision, decision.duty, decision.contextScope || 'unknown',
        decision.basis || 'none', decision.state || 'supported', decision.reviewer,
    );
    enqueueJob(db, { stage: 'evidence_resolution', targetType: 'claim', targetId: claimId, inputRevision: claim.revision, inputHash: claim.input_hash });
    return { claim_id: claimId, duty: decision.duty };
}

function eligible(db, claimId) {
    const claim = readClaim(db, claimId);
    const duty = db.prepare('SELECT * FROM memory_claim_duties WHERE claim_id=?').get(claimId);
    return sourcesCurrent(db, claim)
        && claim.source_state === 'supported'
        && claim.support_state === 'supported'
        && claim.attribution_state === 'supported'
        && duty?.state === 'supported' && duty.duty !== 'unresolved';
}

function enqueueJob(db, job) {
    const now = Date.now();
    db.prepare(`INSERT OR IGNORE INTO memory_jobs(
        stage,target_type,target_id,input_revision,input_hash,status,priority,created_at,updated_at)
        VALUES(?,?,?,?,?,'queued',?,?,?)`).run(
        job.stage, job.targetType, job.targetId, job.inputRevision, job.inputHash,
        Number(job.priority || 0), now, now,
    );
    return db.prepare(`SELECT * FROM memory_jobs WHERE stage=? AND target_type=? AND target_id=?
        AND input_revision=? AND input_hash=?`).get(job.stage, job.targetType, job.targetId, job.inputRevision, job.inputHash);
}

function leaseJobs(db, stage, { limit = 20, leaseMs = 120000, now = Date.now() } = {}) {
    const token = randomUUID();
    return db.transaction(() => {
        const rows = db.prepare(`SELECT * FROM memory_jobs WHERE stage=? AND status IN('queued','retry')
            AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<?)
            ORDER BY priority DESC,created_at LIMIT ?`).all(stage, now, now, Math.max(1, Math.min(limit, 100)));
        const claim = db.prepare(`UPDATE memory_jobs SET status='running',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=?
            WHERE id=? AND status IN('queued','retry') AND (lease_until IS NULL OR lease_until<?)`);
        return rows.filter(row => claim.run(token, now + leaseMs, now, row.id, now).changes === 1)
            .map(row => ({ ...row, lease_token: token, lease_until: now + leaseMs }));
    })();
}

function finishJob(db, job, outcome, errorCode = null) {
    const allowed = ['done','retry','needs_review','failed','skipped'];
    if (!allowed.includes(outcome)) fail('memory_job_outcome_invalid');
    const changed = db.prepare(`UPDATE memory_jobs SET status=?,error_code=?,lease_token=NULL,lease_until=NULL,
        next_attempt_at=?,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND input_hash=?`).run(
        outcome, errorCode, outcome === 'retry' ? Date.now() + 60000 : 0, Date.now(),
        job.id, job.lease_token, job.input_hash,
    );
    if (changed.changes !== 1) fail('memory_job_lease_lost');
}

function recordAction(db, type, id, revision, action, before, after, actor) {
    db.prepare(`INSERT INTO memory_review_actions(target_type,target_id,revision,action,before_json,after_json,actor)
        VALUES(?,?,?,?,?,?,?)`).run(type, id, revision, action, JSON.stringify(before), JSON.stringify(after), actor);
}

function tracked(db, stage, fn) {
    db.prepare(`INSERT INTO memory_pipeline_runs(stage,last_started_at) VALUES(?,CURRENT_TIMESTAMP)
        ON CONFLICT(stage) DO UPDATE SET last_started_at=CURRENT_TIMESTAMP`).run(stage);
    return Promise.resolve().then(fn).then(result => {
        db.prepare(`UPDATE memory_pipeline_runs SET last_success_at=CURRENT_TIMESTAMP,last_error_code=NULL,
            success_count=success_count+1 WHERE stage=?`).run(stage);
        return result;
    }, error => {
        db.prepare(`UPDATE memory_pipeline_runs SET last_failure_at=CURRENT_TIMESTAMP,last_error_code=?,
            failure_count=failure_count+1 WHERE stage=?`).run(error.code || 'stage_failed', stage);
        throw error;
    });
}

module.exports = {
    SCHEMA, SCOPE, DOMAINS, TEMPORAL_STATES, fail, hash, encrypt, decrypt,
    messageText, messageFingerprint, captureSource, createClaim, readClaim,
    sourcesCurrent, reviewClaim, setDuty, eligible, enqueueJob, leaseJobs,
    finishJob, recordAction, tracked,
};
