'use strict';

const protocol = require('./memoryProtocol');

const ACTIONS = Object.freeze({
    review_claim: ['claimId', 'expectedRevision', 'inputHash', 'support', 'attribution', 'reviewer'],
    set_claim_duty: ['claimId', 'expectedRevision', 'inputHash', 'duty', 'reviewer'],
    classify_claim: ['claimId', 'expectedRevision', 'inputHash', 'outcome', 'reviewer'],
    review_node: ['claimId', 'entityId', 'role', 'expectedRevision', 'inputHash', 'verdict', 'reviewer'],
    resolve_identity: ['candidateId', 'outcome', 'reviewer'],
    admit_constellation: ['candidateId', 'outcome', 'basis', 'reviewer'],
    publish_episode: ['candidateId', 'draft', 'producer', 'reviewer'],
    publish_profile_field: ['entityId', 'field', 'draft', 'producer', 'modelRole'],
});

function validate(action) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) protocol.fail('codex_action_invalid');
    const required = ACTIONS[action.type];
    if (!required) protocol.fail('codex_action_not_allowed');
    for (const key of required) if (action[key] === undefined || action[key] === null) protocol.fail(`codex_action_missing_${key}`);
    if (action.field === 'judgment' && String(action.draft?.value || '').trim()) protocol.fail('codex_judgment_forbidden');
    if ('sql' in action || 'command' in action || 'shell' in action) protocol.fail('codex_raw_execution_forbidden');
    return action;
}

module.exports = { ACTIONS, validate };
