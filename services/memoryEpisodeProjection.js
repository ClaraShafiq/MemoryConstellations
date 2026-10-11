'use strict';

const protocol = require('./memoryProtocol');
const candidates = require('./memoryEpisodeCandidates');

function snapshot(db, candidateId) {
    const input = candidates.snapshot(db, candidateId);
    return {
        candidate_id: input.id,
        input_hash: input.input_hash,
        transient: input.temporal_state === 'in_progress',
        entity_ids: input.entity_ids,
        claims: input.claims.map(claim => ({
            id: claim.id, body: claim.body, domain: claim.domain,
            temporal_state: claim.temporal_state, sources: claim.sources,
        })),
    };
}

function validate(db, candidateId, draft) {
    const input = snapshot(db, candidateId);
    if (draft.input_hash !== input.input_hash) protocol.fail('episode_projection_cas_failed');
    const title = String(draft.title || '').trim();
    const content = String(draft.content || '').trim();
    if (!title || !content) protocol.fail('episode_projection_empty');
    const claimIds = [...new Set(draft.claim_ids || [])].sort((a, b) => a - b);
    if (JSON.stringify(claimIds) !== JSON.stringify(input.claims.map(item => item.id).sort((a, b) => a - b)))
        protocol.fail('episode_projection_evidence_mismatch');
    return { input, title, content, tags: Array.isArray(draft.tags) ? draft.tags.map(String).slice(0, 20) : [] };
}

module.exports = { snapshot, validate };
