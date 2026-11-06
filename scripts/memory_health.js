'use strict';

require('dotenv').config();
const { initDatabase } = require('../database');
const health = require('../services/memoryDerivedStateHealth');
const reconciler = require('../services/memoryProjectionReconciler');
const vectors = require('../services/memoryVectorProjection');
const legacyFts = require('../services/memoryLegacyFts');
const { config } = require('../services/memoryConfig');

async function check(db, remote, deep) {
    const report = remote ? await health.inspectRemote(db, { deep }) : health.inspectLocal(db, { deep });
    health.record(db, report, remote ? 'remote' : 'local');
    return report;
}

async function repair(db, execute) {
    const local = reconciler.reconcileLocal(db, { execute });
    let legacy = { execute: false, status: 'not_applicable', reason: 'modern_pipeline_authoritative' };
    if (config.pipeline?.mode !== 'modern') {
        const before = legacyFts.inspect(db, { deep: true });
        legacy = execute && before.status !== 'healthy'
            ? { execute: true, before, after: legacyFts.rebuild(db).health }
            : { execute: false, before, after: before };
    }
    const remote = await vectors.repairRemote(db, { execute });
    const after = await health.inspectRemote(db, { deep: true });
    health.record(db, after, 'remote');
    return { execute, local, legacy_fts: legacy, remote_vector: remote, after };
}

async function main() {
    const command = process.argv[2] || 'check';
    const execute = process.argv.includes('--execute');
    const remote = process.argv.includes('--remote');
    const deep = process.argv.includes('--deep');
    const db = initDatabase();
    const result = command === 'repair' ? await repair(db, execute) : await check(db, remote, deep);
    console.log(JSON.stringify(result, null, 2));
    const status = command === 'repair' ? result.after.status : result.status;
    process.exitCode = status === 'healthy' ? 0 : status === 'drift' ? 1 : 2;
}

main().catch(error => {
    console.error(JSON.stringify({ status: 'unverifiable', error_code: String(error.code || error.message) }));
    process.exitCode = 2;
});
