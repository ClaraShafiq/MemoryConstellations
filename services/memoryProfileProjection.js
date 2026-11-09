'use strict';

const protocol = require('./memoryProtocol');
const evidence = require('./memoryEvidenceResolution');
const { isCoreIdentity } = require('./memoryConfig');

function relevantClaim(claim, field) {
    if (!field) return true;
    const duty = claim.duty?.duty;
    if (field === 'facts') return !['current_state', 'event', 'opinion', 'fiction', 'unresolved'].includes(duty);
    if (field === 'status') return ['current_state', 'event'].includes(duty);
    if (field === 'judgment') return claim.domain === 'companion_opinion'
        && claim.sources.some(source => source.speaker === 'assistant');
    protocol.fail('profile_field_invalid');
}

function snapshot(db, entityId, field = null) {
    const entity = db.prepare('SELECT * FROM entity_profiles WHERE id=?').get(entityId);
    if (!entity) protocol.fail('profile_entity_missing');
    if (isCoreIdentity(entity)) protocol.fail('profile_core_identity_managed_separately');
    const claimRows = db.prepare(`SELECT DISTINCT c.id FROM memory_claims c
        JOIN memory_evidence_pool p ON p.claim_id=c.id
        JOIN memory_node_reviews n ON n.claim_id=c.id AND n.entity_id=?
        WHERE p.state='grounded' AND n.verdict='supported' AND n.role='subject'
          AND n.claim_revision=c.revision AND n.input_hash=c.input_hash
        ORDER BY c.id`).all(entityId);
    const claims = claimRows.map(row => {
        const claim = protocol.readClaim(db, row.id);
        const duty = db.prepare(`SELECT claim_revision,duty,context_scope,state FROM memory_claim_duties
            WHERE claim_id=?`).get(row.id);
        const roles = db.prepare(`SELECT entity_id,role,claim_revision,input_hash FROM memory_node_reviews
            WHERE claim_id=? AND entity_id=? AND verdict='supported' ORDER BY role`).all(row.id, entityId);
        return { ...claim, duty, node_roles: roles };
    }).filter(claim => protocol.eligible(db, claim.id)).filter(claim => relevantClaim(claim, field));
    const seeds = field === 'judgment' ? db.prepare(`SELECT id,source_message_id,source_fingerprint,state
        FROM memory_judgment_seeds WHERE entity_id=? AND state='approved' ORDER BY id`).all(entityId) : [];
    const inputHash = protocol.hash({ field, entity: { id: entity.id, name: entity.name }, claims: claims.map(claim => ({
        id: claim.id, revision: claim.revision, input_hash: claim.input_hash,
        temporal_state: claim.temporal_state, subject_kind: claim.subject_kind,
        duty: claim.duty, node_roles: claim.node_roles,
    })), seeds });
    return { entity, field, claims, seeds, input_hash: inputHash };
}

function validateField(db, entityId, field, draft) {
    const input = snapshot(db, entityId, field);
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
