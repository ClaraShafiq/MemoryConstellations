'use strict';

const protocol = require('./memoryProtocol');
const evidence = require('./memoryEvidenceResolution');

function snapshot(db, entityId) {
    const entity = db.prepare('SELECT * FROM entity_profiles WHERE id=?').get(entityId);
    if (!entity) protocol.fail('profile_entity_missing');
    const claimRows = db.prepare(`SELECT c.id FROM memory_claims c
        JOIN memory_evidence_pool p ON p.claim_id=c.id
        WHERE p.state='grounded' AND EXISTS (
            SELECT 1 FROM json_each(p.entity_ids_json) WHERE CAST(value AS INTEGER)=?
        ) ORDER BY c.id`).all(entityId);
    const claims = claimRows.map(row => protocol.readClaim(db, row.id)).filter(claim => protocol.eligible(db, claim.id));
    const inputHash = protocol.hash({ entity: { id: entity.id, name: entity.name }, claims: claims.map(claim => ({
        id: claim.id, revision: claim.revision, input_hash: claim.input_hash,
        temporal_state: claim.temporal_state,
    })) });
    return { entity, claims, input_hash: inputHash };
}

function validateField(db, entityId, field, draft) {
    const input = snapshot(db, entityId);
    if (draft.input_hash !== input.input_hash) protocol.fail('profile_projection_cas_failed');
    if (!['facts', 'status', 'judgment'].includes(field)) protocol.fail('profile_field_invalid');
    const claimIds = [...new Set(draft.claim_ids || [])].sort((a, b) => a - b);
    const available = new Set(input.claims.map(claim => claim.id));
    if (claimIds.some(id => !available.has(id))) protocol.fail('profile_evidence_invalid');
    const value = draft.value == null ? '' : String(draft.value).trim();
    if (value && claimIds.length === 0) protocol.fail('profile_evidence_required');
    return { input, value, claimIds };
}

module.exports = { snapshot, validateField };
