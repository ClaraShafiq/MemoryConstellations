'use strict';

function get(db) {
    const row = db.prepare("SELECT setting_value FROM user_settings WHERE setting_key='memory_chat_read_mode'").get();
    if (row?.setting_value !== 'verified') return 'legacy';
    try { return require('./memoryReleaseGate').isReady(db) ? 'verified' : 'legacy'; }
    catch (_) { return 'legacy'; }
}

function requested(db) {
    const row = db.prepare("SELECT setting_value FROM user_settings WHERE setting_key='memory_chat_read_mode'").get();
    return row?.setting_value === 'verified' ? 'verified' : 'legacy';
}

function semanticMode(db) {
    const row = db.prepare("SELECT setting_value FROM user_settings WHERE setting_key='memory_semantic_maintenance_mode'").get();
    return row?.setting_value === 'running' ? 'running' : 'backfill';
}

module.exports = { get, requested, semanticMode };
