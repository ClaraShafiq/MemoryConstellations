'use strict';

const DUTIES = Object.freeze([
    'stable_fact', 'core_trait', 'partner_pattern', 'current_state', 'event',
    'preference', 'opinion', 'fiction', 'third_party', 'unresolved',
]);
const CONTEXT_SCOPES = Object.freeze([
    'general', 'with_draco', 'specific_event', 'reference_material', 'unknown',
]);
const NODE_ROLES = Object.freeze([
    'subject', 'participant', 'location', 'organization', 'work', 'topic', 'mention',
]);

const PREFERENCE_MARKERS = /(?:喜欢|偏爱|讨厌|不喜欢|习惯|总是|经常|一贯|长期|prefer|favorite|favourite|like|love|dislike|avoid|habit|usually|always)/i;
const ONE_OFF_EVALUATION = /(?:好吃|不错|还行|想吃|这次|今天|刚才|tasty|nice|good|want(?:s|ed)? to (?:eat|try)|today|this time)/i;
const UNCERTAINTY_MARKERS = /(?:可能|也许|大概|推测|猜测|似乎|\bmay\b|\bmight\b|\bcould\b|maybe|possibly|probably|suspect|guess|appears? to)/i;

function includes(list, value) {
    return list.includes(value);
}

function validateDutyDecision(claim, decision, fail) {
    if (!includes(DUTIES, decision.duty)) fail('memory_duty_invalid');
    if (!includes(CONTEXT_SCOPES, decision.contextScope || 'unknown')) fail('memory_context_scope_invalid');
    const body = String(claim?.body || '');
    if (decision.duty === 'preference' && ONE_OFF_EVALUATION.test(body) && !PREFERENCE_MARKERS.test(body))
        fail('memory_preference_evidence_insufficient');
    if ((decision.duty === 'partner_pattern' || decision.contextScope === 'with_draco')
        && decision.relationshipEvidence !== true) fail('memory_relationship_evidence_required');
    if (decision.duty === 'stable_fact' && decision.qualified === true && !UNCERTAINTY_MARKERS.test(body))
        fail('memory_qualified_attribute_marker_missing');
    if (decision.duty === 'current_state' && ['historical', 'completed', 'cancelled'].includes(claim?.temporal_state))
        fail('memory_current_state_temporal_invalid');
    if (decision.duty === 'fiction' && (decision.contextScope || 'unknown') !== 'reference_material')
        fail('memory_fiction_scope_invalid');
    return true;
}

module.exports = {
    DUTIES, CONTEXT_SCOPES, NODE_ROLES, PREFERENCE_MARKERS, ONE_OFF_EVALUATION,
    UNCERTAINTY_MARKERS, validateDutyDecision,
};
