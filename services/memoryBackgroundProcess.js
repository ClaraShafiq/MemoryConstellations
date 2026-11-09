'use strict';

async function main() {
    const { initDatabase } = require('../database');
    const db = initDatabase();
    const gate = require('./memoryForegroundGate').status(db);
    if (gate.blocked) return { outcome: 'skipped', reason: gate.reason };
    try {
        return await require('./memoryMaintenanceRunner').tick(db, { childProcess: true });
    } catch (error) {
        if (['foreground_active', 'foreground_cooldown'].includes(error.code))
            return { outcome: 'skipped', reason: error.code };
        throw error;
    }
}

if (require.main === module) {
    main().then(result => {
        if (process.send) process.send({ type: 'result', result });
        process.exitCode = 0;
    }).catch(error => {
        if (process.send) process.send({ type: 'error', error: error.code || error.message });
        console.error(error.stack || error);
        process.exitCode = 1;
    });
}

module.exports = { main };
