'use strict';

require('dotenv').config();

const { initDatabase } = require('../database');
const readMode = require('../services/memoryReadMode');

function main() {
    const command = process.argv[2] || 'status';
    if (!['status', 'start', 'pause'].includes(command)) {
        throw new Error('usage: node scripts/memory_maintenance.js status|start|pause');
    }
    const db = initDatabase();
    if (command !== 'status') {
        const value = command === 'start' ? 'running' : 'backfill';
        db.prepare(`INSERT INTO user_settings(setting_key,setting_value)
            VALUES('memory_semantic_maintenance_mode',?) ON CONFLICT(setting_key)
            DO UPDATE SET setting_value=excluded.setting_value`).run(value);
    }
    console.log(JSON.stringify({ command, semantic_maintenance: readMode.semanticMode(db) }, null, 2));
}

try { main(); } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
}
