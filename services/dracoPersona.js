// Companion personality base — for open-source deployment
// In Sanctuary, this reads from persona_model table (dynamic, editable via UI).
// For OSS, the companion personality lives in core-prompt.txt — return empty.
// Users who want dynamic companion profiles: create a persona_model table
// with 5 sections (identity, personality, relationship, ai_self, sanctuary)
// and this function will read from it automatically.

const { getDb } = require('../database');

function getCompanionPersonaBase() {
    try {
        const db = getDb();
        // Check if persona_model table exists (opt-in feature)
        const tableExists = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='persona_model'"
        ).get();
        if (!tableExists) return '';
        
        const rows = db.prepare('SELECT section, content FROM persona_model').all();
        if (!rows.length) return '';
        
        const SECTION_LABELS = {
            identity:     '身份',
            personality:  '性格',
            relationship:'与用户的关系',
            ai_self:      '作为AI的自我认识',
            sanctuary:    '{{project.name}} — 你的世界',
        };
        const parts = [];
        for (const row of rows) {
            const label = SECTION_LABELS[row.section];
            if (label && row.content) {
                parts.push(`[${label}]\n${row.content}`);
            }
        }
        return parts.join('\n\n');
    } catch (e) {
        return '';
    }
}

module.exports = { getCompanionPersonaBase };
