'use strict';

const assert = require('node:assert/strict');
const { initDatabase } = require('../database');

async function main() {
    const db = initDatabase();
    const protocol = require('../services/memoryProtocol');
    const search = require('../services/memorySearchProjection');
    const vectors = require('../services/memoryVectorProjection');
    const reconciler = require('../services/memoryProjectionReconciler');
    const legacyFts = require('../services/memoryLegacyFts');
    const health = require('../services/memoryDerivedStateHealth');

    assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get().version, 119);

    const fragmentId = Number(db.prepare(`INSERT INTO memory_fragments(
        type,entity,content,status,source_msg_ids,observation_state)
        VALUES('observation','unassigned','A neutral fictional observation.','active','[]','legacy')`)
        .run().lastInsertRowid);
    assert.equal(legacyFts.inspect(db, { deep: true }).status, 'healthy');
    db.prepare("UPDATE memory_fragments SET status='frozen' WHERE id=?").run(fragmentId);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM memory_fragments_fts_docsize').get().count, 0);
    db.prepare("UPDATE memory_fragments SET status='active' WHERE id=?").run(fragmentId);
    assert.equal(legacyFts.inspect(db, { deep: true }).status, 'healthy');

    search.put(db, 'claim:999', 'claim', 999, null, 1, protocol.hash('stale'),
        'Fictional stale projection.', {});
    assert.equal(reconciler.reconcileLocal(db).search_removed, 1);
    assert.ok(db.prepare("SELECT 1 FROM memory_search_projection WHERE projection_key='claim:999'").get());
    assert.equal(reconciler.reconcileLocal(db, { execute: true }).search_removed, 1);
    assert.equal(db.prepare("SELECT 1 FROM memory_search_projection WHERE projection_key='claim:999'").get(), undefined);

    search.put(db, 'claim:1000', 'claim', 1000, null, 1, protocol.hash('fixture'),
        'Fictional current projection.', {});
    const remote = new Map();
    const transport = async (operation, payload) => {
        if (operation === 'upsert') remote.set(payload.id, payload.metadata);
        if (operation === 'delete') remote.delete(payload.id);
        if (operation === 'get_batch') return { items: payload.ids.filter(id => remote.has(id))
            .map(id => ({ id, metadata: remote.get(id) })) };
        if (operation === 'list_ids') return { ids: [...remote.keys()].slice(payload.offset, payload.offset + payload.limit),
            total: remote.size };
        return {};
    };
    await vectors.drain(db, { limit: 20, transport, embed: async () => [0.2, 0.3] });
    assert.equal((await vectors.verifyRemote(db, { transport })).status, 'healthy');
    remote.set('unexpected_fixture_vector', {});
    const drift = await vectors.verifyRemote(db, { transport });
    assert.deepEqual(drift.details.extra, ['unexpected_fixture_vector']);
    const repaired = await vectors.repairRemote(db, { execute: true, transport, embed: async () => [0.2, 0.3] });
    assert.equal(repaired.after.status, 'healthy');
    assert.equal(remote.has('unexpected_fixture_vector'), false);

    assert.equal(health.inspectLocal(db).status, 'healthy');
    protocol.enqueueJob(db, { stage: 'health_fixture', targetType: 'claim', targetId: 1000,
        inputRevision: 1, inputHash: protocol.hash('health-fixture') });
    db.prepare(`UPDATE memory_jobs SET status='running',lease_token='fixture',lease_until=?,updated_at=?
        WHERE stage='health_fixture'`).run(Date.now() - 1, Date.now() - 60_000);
    const unhealthy = health.inspectLocal(db);
    assert.equal(unhealthy.status, 'drift');
    assert.ok(unhealthy.issues.includes('job_leases_expired'));

    console.log(JSON.stringify({ ok: true, schema: 119, remote_status: repaired.after.status,
        fts_status: legacyFts.inspect(db).status }));
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
