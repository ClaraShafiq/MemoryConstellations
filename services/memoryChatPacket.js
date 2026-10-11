'use strict';

function build(results, { maxChars = 6000 } = {}) {
    const units = [];
    let used = 0;
    for (const row of results || []) {
        const text = String(row.text || '').trim();
        if (!text || used + text.length > maxChars) continue;
        units.push({ type: row.target_type, id: row.target_id, field: row.field || null,
            text, revision: row.revision, input_hash: row.input_hash });
        used += text.length;
    }
    return { schema: 'memory-chat-packet/v1', units, char_count: used };
}

function format(packet) {
    if (!packet.units.length) return '记忆库中没有找到已验证的相关记忆。';
    return `【已验证记忆】\n${packet.units.map(unit => `- ${unit.text}`).join('\n')}`;
}

module.exports = { build, format };
