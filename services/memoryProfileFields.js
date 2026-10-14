'use strict';

const protocol = require('./memoryProtocol');
const projection = require('./memoryProfileProjection');

const OBJECTIVE_PRODUCERS = new Set(['structured_reviewer', 'deterministic_rule', 'legacy_migration']);
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_profile_field_publications (
    entity_id INTEGER NOT NULL REFERENCES entity_profiles(id) ON DELETE CASCADE,
    field TEXT NOT NULL CHECK(field IN('facts','status','judgment')),
    input_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    value_enc TEXT,
    claim_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(claim_ids_json)),
    producer TEXT NOT NULL,
    model_role TEXT NOT NULL,
    persona_hash TEXT,
    published_at INTEGER NOT NULL,
    PRIMARY KEY(entity_id,field)
);
CREATE TABLE IF NOT EXISTS memory_profile_field_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    value_enc TEXT,
    claim_ids_json TEXT NOT NULL CHECK(json_valid(claim_ids_json)),
    producer TEXT NOT NULL,
    model_role TEXT NOT NULL,
    persona_hash TEXT,
    published_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_judgment_queue (
    entity_id INTEGER PRIMARY KEY REFERENCES entity_profiles(id) ON DELETE CASCADE,
    input_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN('queued','leased','published','insufficient_evidence','failed')),
    lease_token TEXT,
    lease_until INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    updated_at INTEGER NOT NULL
);
`;
const SOURCE_PRIORITY_SCHEMA = `ALTER TABLE memory_judgment_queue
    ADD COLUMN source_priority INTEGER NOT NULL DEFAULT ${protocol.BACKFILL_JOB_PRIORITY};`;

function assertProducer(field, value, meta) {
    if (!meta?.producer || !meta?.modelRole) protocol.fail('profile_actor_required');
    if (field === 'judgment') {
        if (!value) {
            if (meta.producer !== 'judgment_gate') protocol.fail('judgment_empty_gate_required');
            return;
        }
        if (meta.producer !== 'persona_writer' || meta.modelRole !== 'companion_persona')
            protocol.fail('judgment_persona_writer_required');
        if (!/^[a-f0-9]{64}$/i.test(meta.personaHash || '')) protocol.fail('judgment_persona_hash_required');
        return;
    }
    if (!OBJECTIVE_PRODUCERS.has(meta.producer) || meta.modelRole === 'companion_persona')
        protocol.fail('profile_objective_producer_invalid');
}

function publish(db, entityId, field, draft, meta) {
    const checked = projection.validateField(db, entityId, field, draft);
    assertProducer(field, checked.value, meta);
    return db.transaction(() => {
        const previous = db.prepare(`SELECT * FROM memory_profile_field_publications WHERE entity_id=? AND field=?`)
            .get(entityId, field);
        const expected = Number(draft.expected_revision || 0);
        if (expected !== Number(previous?.revision || 0)) protocol.fail('profile_field_cas_failed');
        const revision = expected + 1;
        const valueEnc = checked.value ? protocol.encrypt(checked.value) : null;
        const now = Date.now();
        db.prepare(`INSERT INTO memory_profile_field_publications(
            entity_id,field,input_hash,revision,value_enc,claim_ids_json,producer,model_role,persona_hash,published_at)
            VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entity_id,field) DO UPDATE SET
            input_hash=excluded.input_hash,revision=excluded.revision,value_enc=excluded.value_enc,
            claim_ids_json=excluded.claim_ids_json,producer=excluded.producer,model_role=excluded.model_role,
            persona_hash=excluded.persona_hash,published_at=excluded.published_at`).run(entityId, field,
            checked.input.input_hash, revision, valueEnc, JSON.stringify(checked.claimIds), meta.producer,
            meta.modelRole, meta.personaHash || null, now);
        db.prepare(`INSERT INTO memory_profile_field_history(
            entity_id,field,input_hash,revision,value_enc,claim_ids_json,producer,model_role,persona_hash,published_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`).run(entityId, field, checked.input.input_hash, revision, valueEnc,
            JSON.stringify(checked.claimIds), meta.producer, meta.modelRole, meta.personaHash || null, now);
        const column = field === 'status' ? 'current_status' : field;
        // entity_profiles is the legacy-compatible materialized view and its existing consumers expect text.
        // The authoritative publication/history rows keep the encrypted value.
        db.prepare(`UPDATE entity_profiles SET ${column}=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(checked.value || null, entityId);
        if (field === 'judgment') db.prepare(`INSERT INTO memory_judgment_queue(entity_id,input_hash,state,updated_at)
            VALUES(?,?,'published',?) ON CONFLICT(entity_id) DO UPDATE SET input_hash=excluded.input_hash,
            state='published',lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=excluded.updated_at`)
            .run(entityId, checked.input.input_hash, now);
        protocol.enqueueJob(db, { stage: 'search_projection', targetType: 'entity', targetId: entityId,
            inputRevision: revision, inputHash: checked.input.input_hash, priority: meta.priority });
        return { entity_id: entityId, field, revision, value: checked.value };
    })();
}

function enqueueJudgment(db, entityId, { priority = protocol.BACKFILL_JOB_PRIORITY } = {}) {
    const input = projection.snapshot(db, entityId);
    const evidence = input.claims.filter(claim => ['companion_opinion', 'interaction', 'user_statement'].includes(claim.domain));
    const state = evidence.length ? 'queued' : 'insufficient_evidence';
    db.prepare(`INSERT INTO memory_judgment_queue(entity_id,input_hash,state,updated_at,source_priority) VALUES(?,?,?,?,?)
        ON CONFLICT(entity_id) DO UPDATE SET input_hash=excluded.input_hash,state=excluded.state,
        lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=excluded.updated_at,
        source_priority=excluded.source_priority`).run(entityId, input.input_hash, state, Date.now(), priority);
    return { entity_id: entityId, input_hash: input.input_hash, state };
}

function enqueueFields(db, entityId, { priority = protocol.BACKFILL_JOB_PRIORITY } = {}) {
    const input = projection.snapshot(db, entityId);
    protocol.enqueueJob(db, { stage: 'profile_facts', targetType: 'entity', targetId: entityId,
        inputRevision: 1, inputHash: input.input_hash, priority });
    protocol.enqueueJob(db, { stage: 'profile_status', targetType: 'entity', targetId: entityId,
        inputRevision: 1, inputHash: input.input_hash, priority });
    return { ...enqueueJudgment(db, entityId, { priority }), objective_fields: ['facts', 'status'] };
}

module.exports = { SCHEMA, SOURCE_PRIORITY_SCHEMA, OBJECTIVE_PRODUCERS, publish, enqueueJudgment, enqueueFields };
