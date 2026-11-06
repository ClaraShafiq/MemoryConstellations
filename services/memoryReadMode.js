'use strict';

function state(db) {
    const row = db.prepare("SELECT setting_value FROM user_settings WHERE setting_key='memory_chat_read_mode'").get();
    const requested = row?.setting_value === 'verified' ? 'verified' : 'legacy';
    if (requested !== 'verified') {
        return { requested, effective: 'legacy', reason: null };
    }
    try {
        if (require('./memoryReleaseGate').isReady(db)) {
            return { requested, effective: 'verified', reason: null };
        }
        return { requested, effective: 'blocked', reason: 'verified_release_not_ready' };
    } catch (_) {
        return { requested, effective: 'blocked', reason: 'verified_release_unverifiable' };
    }
}

function get(db) {
    return state(db).effective;
}

function requested(db) {
    const row = db.prepare("SELECT setting_value FROM user_settings WHERE setting_key='memory_chat_read_mode'").get();
    return row?.setting_value === 'verified' ? 'verified' : 'legacy';
}

function semanticMode(db) {
    const row = db.prepare("SELECT setting_value FROM user_settings WHERE setting_key='memory_semantic_maintenance_mode'").get();
    return row?.setting_value === 'running' ? 'running' : 'backfill';
}

module.exports = { get, state, requested, semanticMode };
