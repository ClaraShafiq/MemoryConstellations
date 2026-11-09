'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-constellations-runtime-'));
process.env.DB_PATH = path.join(testDir, 'runtime.db');
process.env.SANCTUARY_ENCRYPTION_KEY ||= '2'.repeat(64);

async function main() {
    const db = require('../database').initDatabase();
    try {
        const gate = require('../services/memoryForegroundGate');
        const supervisor = require('../services/memoryBackgroundSupervisor');
        const protocol = require('../services/memoryProtocol');
        const runner = require('../services/memoryMaintenanceRunner');

        const base = Date.now();
        const lease = gate.acquire(db, { owner: 'fictional-chat-host', ttlMs: 5000, now: base });
        assert.equal(gate.status(db, base + 1).reason, 'foreground_active');
        assert.deepEqual(await supervisor.tick(db), { outcome: 'skipped', reason: 'foreground_active' });
        assert.equal(gate.release(db, lease.token, { now: base + 2, cooldownMs: 60000 }).released, true);
        assert.equal(gate.status(db, base + 3).reason, 'foreground_cooldown');
        assert.equal(gate.status(db, base + 60003).blocked, false);
        db.prepare('UPDATE memory_runtime_state SET cooldown_until=0 WHERE id=1').run();

        protocol.enqueueJob(db, { stage: 'target_probe', targetType: 'claim', targetId: 101,
            inputRevision: 1, inputHash: 'a', priority: protocol.LIVE_JOB_PRIORITY });
        protocol.enqueueJob(db, { stage: 'target_probe', targetType: 'claim', targetId: 202,
            inputRevision: 1, inputHash: 'b', priority: protocol.LIVE_JOB_PRIORITY });
        const targeted = protocol.leaseJobs(db, 'target_probe', { targetType: 'claim', targetId: 202, limit: 10 });
        assert.deepEqual(targeted.map(job => job.target_id), [202]);
        protocol.finishJob(db, targeted[0], 'done');
        assert.equal(db.prepare("SELECT status FROM memory_jobs WHERE stage='target_probe' AND target_id=101").get().status,
            'queued');

        assert.ok(runner.REVIEW_STAGES.includes('claim_review_a'));
        assert.ok(runner.REVIEW_STAGES.includes('claim_review_b'));
        assert.equal(supervisor.FAILURE_LIMIT, 3);
        db.prepare(`INSERT INTO user_settings(setting_key,setting_value) VALUES('memory_semantic_maintenance_mode','running')
            ON CONFLICT(setting_key) DO UPDATE SET setting_value='running'`).run();
        await assert.rejects(runner.execute(db, { targetId: 202 }), /memory_target_type_required/);
        const targetedRun = await runner.execute(db, { targetType: 'claim', targetId: 202 });
        assert.deepEqual(targetedRun.target, { targetType: 'claim', targetId: 202 });
        assert.equal(targetedRun.scribe, undefined);
        assert.equal(targetedRun.vectors, undefined);
        db.prepare(`INSERT INTO user_settings(setting_key,setting_value) VALUES('memory_semantic_maintenance_mode','backfill')
            ON CONFLICT(setting_key) DO UPDATE SET setting_value='backfill'`).run();
        const child = spawnSync(process.execPath, [path.join(__dirname, '../services/memoryBackgroundProcess.js')], {
            env: { ...process.env }, encoding: 'utf8', timeout: 30000,
        });
        assert.equal(child.status, 0, child.stderr || child.stdout);

        console.log(JSON.stringify({ ok: true, schema: 124, foreground_cooldown_ms: gate.COOLDOWN_MS,
            exact_target: targeted[0].target_id, child_exit: child.status }));
    } finally {
        db.close();
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
