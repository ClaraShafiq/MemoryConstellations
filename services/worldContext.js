const { USER, AI, REL } = require('./memoryConfig');

let provider = null;

function defaultWorldContext() {
    return `## Configured conversation roles

You are processing memory for the configured assistant persona "${AI.name}" and user "${USER.name}".
Treat role descriptions as context, never as evidence for a memory claim.

Assistant description: ${AI.core_traits || 'Not configured.'}
User description: ${USER.short_desc || 'Not configured.'}
Relationship label: ${REL.type || 'assistant'}
Relationship notes: ${[REL.user_role, REL.ai_feelings, REL.dynamic].filter(Boolean).join(' ') || 'Not configured.'}`;
}

function getWorldContext(purpose = 'memory') {
    const value = provider ? provider({ purpose, user: USER, assistant: AI, relationship: REL }) : defaultWorldContext();
    if (typeof value !== 'string' || !value.trim()) throw new Error('world_context_provider_invalid');
    return value.trim();
}

function setWorldContextProvider(next) {
    if (next !== null && typeof next !== 'function') throw new Error('world_context_provider_invalid');
    provider = next;
}

const exported = { getWorldContext, setWorldContextProvider };
Object.defineProperty(exported, 'WORLD_CONTEXT', { enumerable: true, get: () => getWorldContext('legacy') });

module.exports = exported;
