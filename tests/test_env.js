'use strict';

// Memory tests must never fall back to the application's default database.
if (!process.env.DB_PATH) {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-constellations-test-'));
    process.env.DB_PATH = path.join(dir, 'test.db');
    process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
}
process.env.SANCTUARY_ENCRYPTION_KEY ||= '3'.repeat(64);

module.exports = { dbPath: process.env.DB_PATH };
