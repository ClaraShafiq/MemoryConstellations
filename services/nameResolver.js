// services/nameResolver.js — v5.3 OSS
// Centralized user/AI display name resolution.
// All hardcoded "Clara"/"Draco" in prompts, display strings, and sender
// mappings should go through this module instead of being literals.
//
// After open-sourcing, users only need to edit memory_config.json
// and core-prompt.txt — the code auto-adapts to their chosen names.

const { USER, AI, SKIP_NAMES } = require('./memoryConfig');

/**
 * Replace hardcoded "Clara"/"Draco" with configured names in prompt strings.
 * Aligns with the existing fillPrompt pattern used across the codebase.
 */
function fillPrompt(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/\{user\}/g, USER.name)
        .replace(/\{ai\}/g, AI.name)
        .replace(/Clara/g, USER.name)      // 向后兼容旧版硬编码
        .replace(/Draco/g, AI.name);
}

/**
 * Map internal sender IDs to configured display names.
 * sender = 'user' → USER.name, 'draco'/'ai' → AI.name
 */
function senderName(sender) {
    if (sender === 'user') return USER.name;
    return AI.name;
}

/**
 * Map DB entity field values to display names.
 * Canonical DB values 'Clara'/'Draco' → configured names.
 * Unknown entities pass through unchanged.
 */
function entityDisplayName(entity) {
    if (entity === 'Clara') return USER.name;
    if (entity === 'Draco') return AI.name;
    return entity;
}

module.exports = { fillPrompt, senderName, entityDisplayName, USER, AI, SKIP_NAMES };
