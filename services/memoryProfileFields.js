'use strict';

const protocol = require('./memoryProtocol');
const projection = require('./memoryProfileProjection');
const { isCoreIdentity } = require('./memoryConfig');

const OBJECTIVE_PRODUCERS = new Set(['structured_reviewer', 'deterministic_rule', 'legacy_migration']);
const FACET_LIMIT = 3;
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
CREATE TABLE IF NOT EXISTS memory_judgment_seeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES entity_profiles(id) ON DELETE CASCADE,
    text_enc TEXT NOT NULL,
    source_message_id INTEGER REFERENCES messages(id),
    source_fingerprint TEXT,
    reviewer TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN('approved','withdrawn')),
    created_at INTEGER NOT NULL
);
`;
const SOURCE_PRIORITY_SCHEMA = `ALTER TABLE memory_judgment_queue
    ADD COLUMN source_priority INTEGER NOT NULL DEFAULT ${protocol.BACKFILL_JOB_PRIORITY};`;

function fieldId(field, text, claimIds = [], seedIds = []) {
    return `${field}:${protocol.hash({ text: String(text).trim(), claim_ids: claimIds, seed_ids: seedIds }).slice(0, 16)}`;
}

function decodeItems(row) {
    if (!row?.value_enc) return [];
    const plain = protocol.decrypt(row.value_enc);
    try {
        const parsed = JSON.parse(plain);
        if (parsed?.schema === 'profile-field/v2' && Array.isArray(parsed.items)) return parsed.items;
    } catch (_) {}
    const claimIds = JSON.parse(row.claim_ids_json || '[]');
    return [{ id: fieldId(row.field, plain, claimIds), text: plain, claim_ids: claimIds, seed_ids: [] }];
}

function readField(db, entityId, field) {
    const row = db.prepare(`SELECT * FROM memory_profile_field_publications WHERE entity_id=? AND field=?`)
        .get(entityId, field);
    if (!row) return null;
    const items = decodeItems(row);
    return { ...row, items, value: items.map(item => item.text).join('\n') };
}

function recordJudgmentSeed(db, entityId, input) {
    const entity = db.prepare('SELECT * FROM entity_profiles WHERE id=?').get(entityId);
    if (!entity || isCoreIdentity(entity)) protocol.fail('judgment_seed_entity_invalid');
    const text = String(input.text || '').trim();
    if (!text || !input.reviewer) protocol.fail('judgment_seed_invalid');
    let fingerprint = null;
    if (input.sourceMessageId) {
        const row = db.prepare('SELECT * FROM messages WHERE id=?').get(input.sourceMessageId);
        fingerprint = protocol.messageFingerprint(row);
    }
    return Number(db.prepare(`INSERT INTO memory_judgment_seeds(
        entity_id,text_enc,source_message_id,source_fingerprint,reviewer,state,created_at)
        VALUES(?,?,?,?,?,'approved',?)`).run(entityId, protocol.encrypt(text), input.sourceMessageId || null,
        fingerprint, input.reviewer, Date.now()).lastInsertRowid);
}

function selectedClaims(input, ids) {
    const unique = [...new Set((ids || []).map(Number))].sort((a, b) => a - b);
    const available = new Map(input.claims.map(claim => [claim.id, claim]));
    if (!unique.length || unique.some(id => !available.has(id))) protocol.fail('profile_evidence_invalid');
    return unique.map(id => available.get(id));
}

function selectedSeeds(db, entityId, ids) {
    return [...new Set((ids || []).map(Number))].sort((a, b) => a - b).map(id => {
        const row = db.prepare(`SELECT * FROM memory_judgment_seeds
            WHERE id=? AND entity_id=? AND state='approved'`).get(id, entityId);
        if (!row) protocol.fail('judgment_seed_invalid');
        if (row.source_message_id) {
            const message = db.prepare('SELECT * FROM messages WHERE id=?').get(row.source_message_id);
            if (!message || protocol.messageFingerprint(message) !== row.source_fingerprint)
                protocol.fail('judgment_seed_source_changed');
        }
        return row;
    });
}

function requireObjectiveEvidence(db, field, claims) {
    for (const claim of claims) {
        const duty = db.prepare('SELECT duty,state FROM memory_claim_duties WHERE claim_id=?').get(claim.id);
        if (duty?.state !== 'supported') protocol.fail('profile_duty_missing');
        if (field === 'facts' && ['current_state', 'opinion', 'fiction', 'unresolved'].includes(duty.duty))
            protocol.fail('profile_fact_duty_invalid');
        if (field === 'status') {
            if (!['current_state', 'event'].includes(duty.duty)) protocol.fail('profile_status_duty_invalid');
            if (['historical', 'cancelled'].includes(claim.temporal_state)) protocol.fail('profile_status_temporal_invalid');
            if (claim.temporal_state === 'completed') {
                const latest = claim.sources.map(source => Date.parse(source.source_time)).filter(Number.isFinite).sort((a, b) => b - a)[0];
                if (!latest || Date.now() - latest > 120 * 24 * 60 * 60 * 1000) protocol.fail('profile_status_not_recent');
            }
        }
    }
}

function requireCorrection(claims) {
    if (!claims.some(claim => claim.domain === 'correction')) protocol.fail('profile_revision_requires_correction');
}

function applyObjectiveOperations(db, input, field, current, operations) {
    const items = current.map(item => ({ ...item, claim_ids: [...(item.claim_ids || [])], seed_ids: [] }));
    for (const operation of operations) {
        if (!['add', 'revise', 'withdraw'].includes(operation.action)) protocol.fail('profile_operation_invalid');
        const index = operation.action === 'add' ? -1 : items.findIndex(item => item.id === operation.target_id);
        if (operation.action !== 'add' && index < 0) protocol.fail('profile_operation_target_missing');
        const claims = selectedClaims(input, operation.claim_ids);
        requireObjectiveEvidence(db, field, claims);
        if (operation.action === 'add') {
            const text = String(operation.text || '').trim();
            if (!text) protocol.fail('profile_operation_text_required');
            items.push({ id: fieldId(field, text, claims.map(claim => claim.id)), text,
                claim_ids: claims.map(claim => claim.id), seed_ids: [] });
        } else {
            requireCorrection(claims);
            if (operation.action === 'withdraw') items.splice(index, 1);
            else {
                const text = String(operation.text || '').trim();
                if (!text) protocol.fail('profile_operation_text_required');
                items[index] = { id: items[index].id, text, claim_ids: claims.map(claim => claim.id), seed_ids: [] };
            }
        }
    }
    return items;
}

function requireJudgmentEvidence(db, input, entityId, claimIds, seedIds) {
    const claims = claimIds?.length ? selectedClaims(input, claimIds) : [];
    const seeds = seedIds?.length ? selectedSeeds(db, entityId, seedIds) : [];
    if (!claims.length && !seeds.length) protocol.fail('judgment_evidence_required');
    for (const claim of claims) {
        if (claim.domain !== 'companion_opinion'
            || !claim.sources.some(source => source.speaker === 'assistant')) protocol.fail('judgment_attitude_evidence_required');
    }
    return { claimIds: claims.map(claim => claim.id), seedIds: seeds.map(seed => seed.id) };
}

function applyJudgmentOperations(db, input, entityId, current, operations) {
    const items = current.map(item => ({ ...item, claim_ids: [...(item.claim_ids || [])], seed_ids: [...(item.seed_ids || [])] }));
    for (const operation of operations) {
        if (!['add', 'reinforce', 'revise', 'withdraw'].includes(operation.action)) protocol.fail('judgment_operation_invalid');
        const index = operation.action === 'add' ? -1 : items.findIndex(item => item.id === operation.target_id);
        if (operation.action !== 'add' && index < 0) protocol.fail('judgment_facet_missing');
        const evidence = requireJudgmentEvidence(db, input, entityId, operation.claim_ids, operation.seed_ids);
        if (operation.action === 'withdraw') items.splice(index, 1);
        else if (operation.action === 'reinforce') {
            items[index] = { ...items[index], claim_ids: [...new Set([...items[index].claim_ids, ...evidence.claimIds])],
                seed_ids: [...new Set([...items[index].seed_ids, ...evidence.seedIds])] };
        } else {
            const text = String(operation.text || '').trim();
            if (!text) protocol.fail('judgment_facet_text_required');
            const item = { id: operation.action === 'add' ? fieldId('judgment', text, evidence.claimIds, evidence.seedIds)
                : items[index].id, text, claim_ids: evidence.claimIds, seed_ids: evidence.seedIds };
            if (operation.action === 'add') items.push(item); else items[index] = item;
        }
    }
    if (items.length > FACET_LIMIT) protocol.fail('judgment_facet_limit');
    return items;
}

function assertProducer(field, items, meta) {
    if (!meta?.producer || !meta?.modelRole) protocol.fail('profile_actor_required');
    if (field === 'judgment') {
        if (!items.length) {
            if (!['judgment_gate', 'persona_writer'].includes(meta.producer)) protocol.fail('judgment_empty_gate_required');
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
    const input = projection.snapshot(db, entityId);
    if (draft.input_hash !== input.input_hash) protocol.fail('profile_projection_cas_failed');
    if (!['facts', 'status', 'judgment'].includes(field)) protocol.fail('profile_field_invalid');
    if (field === 'judgment' && !['persona_writer', 'judgment_gate'].includes(meta?.producer))
        protocol.fail('judgment_persona_writer_required');
    const previous = readField(db, entityId, field);
    if (Number(draft.expected_revision || 0) !== Number(previous?.revision || 0)) protocol.fail('profile_field_cas_failed');
    const operations = Array.isArray(draft.operations) ? draft.operations : [];
    let items;
    if (!operations.length && !String(draft.value || '').trim()) items = [];
    else if (!operations.length) {
        const claims = selectedClaims(input, draft.claim_ids || []);
        if (field === 'judgment') {
            const evidence = requireJudgmentEvidence(db, input, entityId, draft.claim_ids, draft.seed_ids);
            items = [{ id: fieldId(field, draft.value, evidence.claimIds, evidence.seedIds), text: String(draft.value).trim(),
                claim_ids: evidence.claimIds, seed_ids: evidence.seedIds }];
        } else {
            requireObjectiveEvidence(db, field, claims);
            items = [{ id: fieldId(field, draft.value, claims.map(claim => claim.id)), text: String(draft.value).trim(),
                claim_ids: claims.map(claim => claim.id), seed_ids: [] }];
        }
    } else if (field === 'judgment') items = applyJudgmentOperations(db, input, entityId, previous?.items || [], operations);
    else items = applyObjectiveOperations(db, input, field, previous?.items || [], operations);
    assertProducer(field, items, meta);
    return db.transaction(() => {
        const live = readField(db, entityId, field);
        if (Number(live?.revision || 0) !== Number(previous?.revision || 0)) protocol.fail('profile_field_cas_failed');
        const revision = Number(previous?.revision || 0) + 1;
        const claimIds = [...new Set(items.flatMap(item => item.claim_ids || []))].sort((a, b) => a - b);
        const value = items.map(item => item.text).join('\n');
        const valueEnc = items.length ? protocol.encrypt(JSON.stringify({ schema: 'profile-field/v2', items })) : null;
        const now = Date.now();
        db.prepare(`INSERT INTO memory_profile_field_publications(
            entity_id,field,input_hash,revision,value_enc,claim_ids_json,producer,model_role,persona_hash,published_at)
            VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entity_id,field) DO UPDATE SET input_hash=excluded.input_hash,
            revision=excluded.revision,value_enc=excluded.value_enc,claim_ids_json=excluded.claim_ids_json,
            producer=excluded.producer,model_role=excluded.model_role,persona_hash=excluded.persona_hash,
            published_at=excluded.published_at`).run(entityId, field, input.input_hash, revision, valueEnc,
            JSON.stringify(claimIds), meta.producer, meta.modelRole, meta.personaHash || null, now);
        db.prepare(`INSERT INTO memory_profile_field_history(
            entity_id,field,input_hash,revision,value_enc,claim_ids_json,producer,model_role,persona_hash,published_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`).run(entityId, field, input.input_hash, revision, valueEnc,
            JSON.stringify(claimIds), meta.producer, meta.modelRole, meta.personaHash || null, now);
        const column = field === 'status' ? 'current_status' : field;
        db.prepare(`UPDATE entity_profiles SET ${column}=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(value || null, entityId);
        if (field === 'judgment') db.prepare(`INSERT INTO memory_judgment_queue(entity_id,input_hash,state,updated_at)
            VALUES(?,?,'published',?) ON CONFLICT(entity_id) DO UPDATE SET input_hash=excluded.input_hash,
            state='published',lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=excluded.updated_at`)
            .run(entityId, input.input_hash, now);
        protocol.enqueueJob(db, { stage: 'search_projection', targetType: 'entity', targetId: entityId,
            inputRevision: revision, inputHash: input.input_hash, priority: meta.priority });
        return { entity_id: entityId, field, revision, value, items };
    })();
}

function enqueueJudgment(db, entityId, { priority = protocol.BACKFILL_JOB_PRIORITY } = {}) {
    const input = projection.snapshot(db, entityId);
    const evidence = input.claims.filter(claim => claim.domain === 'companion_opinion'
        && claim.sources.some(source => source.speaker === 'assistant'));
    const seeds = db.prepare(`SELECT COUNT(*) count FROM memory_judgment_seeds
        WHERE entity_id=? AND state='approved'`).get(entityId).count;
    const state = evidence.length || seeds ? 'queued' : 'insufficient_evidence';
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

module.exports = { SCHEMA, SOURCE_PRIORITY_SCHEMA, OBJECTIVE_PRODUCERS, FACET_LIMIT,
    fieldId, decodeItems, readField, recordJudgmentSeed, publish, enqueueJudgment, enqueueFields };
