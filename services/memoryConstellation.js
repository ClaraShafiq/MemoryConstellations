'use strict';

const protocol = require('./memoryProtocol');
const identity = require('./memoryConstellationIdentity');

const BASES = new Set(['lasting_identity','ongoing_theme','meaningful_place','bounded_event','cherished','ordinary_detail']);

function admit(db, decision) {
    const input = identity.snapshot(db, decision.candidateId);
    if (input.status !== 'identity_resolved' || !input.entity_id) protocol.fail('constellation_identity_required');
    if (!['admitted','contained','rejected'].includes(decision.outcome) || !BASES.has(decision.basis))
        protocol.fail('constellation_admission_invalid');
    if (decision.outcome === 'admitted' && decision.basis === 'ordinary_detail') protocol.fail('constellation_ordinary_detail_forbidden');
    if (decision.outcome === 'contained' && !Number.isSafeInteger(decision.parentEntityId)) protocol.fail('constellation_parent_required');
    return db.transaction(() => {
        const previous = db.prepare('SELECT * FROM memory_constellation_admissions WHERE entity_id=?').get(input.entity_id);
        const revision = Number(previous?.revision || 0) + 1;
        db.prepare(`INSERT INTO memory_constellation_admissions(
            entity_id,candidate_id,input_hash,outcome,basis,parent_entity_id,reviewer,revision,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(entity_id) DO UPDATE SET candidate_id=excluded.candidate_id,
            input_hash=excluded.input_hash,outcome=excluded.outcome,basis=excluded.basis,
            parent_entity_id=excluded.parent_entity_id,reviewer=excluded.reviewer,
            revision=excluded.revision,updated_at=excluded.updated_at`).run(input.entity_id, input.id, input.input_hash,
            decision.outcome, decision.basis, decision.parentEntityId || null, decision.reviewer, revision, Date.now());
        db.prepare(`UPDATE entity_profiles SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
            decision.outcome === 'admitted' ? 'active' : decision.outcome === 'contained' ? 'contained' : 'dormant', input.entity_id);
        const changed = db.prepare(`UPDATE memory_constellation_candidates SET status=?,updated_at=?
            WHERE id=? AND status='identity_resolved' AND input_hash=?`).run(decision.outcome, Date.now(), input.id, input.input_hash);
        if (changed.changes !== 1) protocol.fail('constellation_admission_cas_failed');
        protocol.recordAction(db, 'constellation', input.entity_id, revision, 'admission', previous || null,
            { outcome: decision.outcome, basis: decision.basis, parent_entity_id: decision.parentEntityId || null }, decision.reviewer);
        return { entity_id: input.entity_id, outcome: decision.outcome, revision };
    })();
}

function addRelation(db, decision) {
    if (!Number.isSafeInteger(decision.fromEntityId) || !Number.isSafeInteger(decision.toEntityId)
        || decision.fromEntityId === decision.toEntityId || !Array.isArray(decision.claimIds) || !decision.claimIds.length)
        protocol.fail('constellation_relation_invalid');
    for (const claimId of decision.claimIds) if (!protocol.eligible(db, claimId)) protocol.fail('constellation_relation_evidence_invalid');
    const inputHash = protocol.hash({ from: decision.fromEntityId, to: decision.toEntityId,
        relation: decision.relationType, claims: decision.claimIds.slice().sort((a, b) => a - b) });
    db.prepare(`INSERT INTO memory_constellation_relations(
        from_entity_id,to_entity_id,relation_type,claim_ids_json,input_hash,reviewer,created_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(from_entity_id,to_entity_id,relation_type) DO UPDATE SET
        claim_ids_json=excluded.claim_ids_json,input_hash=excluded.input_hash,reviewer=excluded.reviewer,
        created_at=excluded.created_at`).run(decision.fromEntityId, decision.toEntityId, decision.relationType,
        JSON.stringify(decision.claimIds), inputHash, decision.reviewer, Date.now());
    return { input_hash: inputHash };
}

module.exports = { BASES, admit, addRelation };
