'use strict';

require('dotenv').config();

const { initDatabase } = require('../database');
const release = require('../services/memoryReleaseGate');
const vectors = require('../services/memoryVectorProjection');
const readMode = require('../services/memoryReadMode');

async function main() {
    const command = process.argv[2] || 'status';
    if (!['status', 'prepare', 'activate', 'rollback'].includes(command)) {
        throw new Error('usage: node scripts/memory_release.js status|prepare|activate|rollback');
    }
    const db = initDatabase();
    let result;
    if (command === 'prepare') result = await release.prepare(db);
    else if (command === 'activate') result = release.activate(db);
    else if (command === 'rollback') result = release.rollback(db);
    else {
        const manifest = vectors.manifest(db);
        result = {
            requested_chat_read_mode: readMode.requested(db),
            effective_chat_read_mode: readMode.get(db),
            semantic_maintenance: readMode.semanticMode(db),
            release_ready: release.isReady(db),
            vector_manifest: {
                ready: manifest.ready,
                expected: manifest.expected,
                done: manifest.done,
                blockers: manifest.blockers,
                digest: manifest.digest,
            },
        };
    }
    console.log(JSON.stringify({ command, ...result }, null, 2));
}

main().catch(error => {
    console.error(error.code || error.message || error);
    process.exitCode = 1;
});
