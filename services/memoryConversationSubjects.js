'use strict';

const { USER, AI, normalizeIdentityName } = require('./memoryConfig');

const SUBJECTS = Object.freeze(['user', 'assistant', 'third_party', 'unknown']);

function sourceSpeaker(sender) {
    return sender === 'user' ? 'user' : 'assistant';
}

function explicitRoleMentions(text) {
    const normalized = normalizeIdentityName(text);
    const roles = [];
    if (normalized.includes(normalizeIdentityName(USER.name))) roles.push('user');
    if (normalized.includes(normalizeIdentityName(AI.name))) roles.push('assistant');
    return roles;
}

function validateSubject(subject, sources) {
    if (!SUBJECTS.includes(subject)) throw Object.assign(new Error('scribe_subject_invalid'), { code: 'scribe_subject_invalid' });
    if (subject === 'unknown' || subject === 'third_party') return subject;
    const supported = (sources || []).some(source => source.speaker === subject
        || explicitRoleMentions(source.quote).includes(subject));
    if (!supported) throw Object.assign(new Error('scribe_subject_not_supported'), { code: 'scribe_subject_not_supported' });
    return subject;
}

module.exports = { SUBJECTS, sourceSpeaker, explicitRoleMentions, validateSubject };
