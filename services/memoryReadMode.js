'use strict';

function get(db) {
    const row = db.prepare("SELECT setting_value FROM user_settings WHERE setting_key='memory_chat_read_mode'").get();
    return row?.setting_value === 'verified' ? 'verified' : 'legacy';
}

function semanticMode(db) {
    const row = db.prepare("SELECT setting_value FROM user_settings WHERE setting_key='memory_semantic_maintenance_mode'").get();
    return row?.setting_value === 'running' ? 'running' : 'backfill';
}

module.exports = { get, semanticMode };
