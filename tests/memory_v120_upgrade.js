'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
if (!process.env.DB_PATH) {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-constellations-upgrade-'));
    process.env.DB_PATH = path.join(dir, 'upgrade.db');
    process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
}
process.env.SANCTUARY_ENCRYPTION_KEY ||= '4'.repeat(64);

if (process.env.MEMORY_V120_SEED === '1') {
    const db = require('../database').initDatabase();
    db.prepare(`INSERT INTO correction_log(target_type,target_id,wrong_summary,correct_summary,source,status)
        VALUES('fragment',1,'Old fictional note','Corrected fictional note','fictional-upgrade','active')`).run();
    db.prepare(`INSERT INTO memory_vector_projection(
        projection_key,vector_id,revision,source_hash,operation,status,attempts,updated_at)
        VALUES('claim:upgrade','verified_upgrade',1,'upgrade-hash','upsert','retry',2,?)`).run(Date.now());
    db.exec(`
        ALTER TABLE correction_log RENAME TO correction_log_v120;
        CREATE TABLE correction_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_type TEXT NOT NULL,
            target_id INTEGER,
            wrong_summary TEXT NOT NULL,
            correct_summary TEXT NOT NULL,
            source TEXT DEFAULT 'manual',
            chat_message_id INTEGER,
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO correction_log(id,target_type,target_id,wrong_summary,correct_summary,source,chat_message_id,status,created_at)
            SELECT id,target_type,target_id,wrong_summary,correct_summary,source,chat_message_id,status,created_at
            FROM correction_log_v120;
        DROP TABLE correction_log_v120;

        ALTER TABLE memory_vector_projection RENAME TO memory_vector_projection_v120;
        CREATE TABLE memory_vector_projection (
            projection_key TEXT PRIMARY KEY,
            vector_id TEXT NOT NULL UNIQUE,
            revision INTEGER NOT NULL,
            source_hash TEXT NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN('upsert','delete')),
            status TEXT NOT NULL CHECK(status IN('queued','running','done','retry','obsolete')),
            attempts INTEGER NOT NULL DEFAULT 0,
            lease_token TEXT,
            lease_until INTEGER,
            error_code TEXT,
            acknowledged_at INTEGER,
            updated_at INTEGER NOT NULL
        );
        INSERT INTO memory_vector_projection SELECT * FROM memory_vector_projection_v120;
        DROP TABLE memory_vector_projection_v120;
        CREATE INDEX idx_memory_vector_projection_ready
            ON memory_vector_projection(status,updated_at);
        ALTER TABLE memory_claim_recoveries RENAME TO memory_claim_recoveries_v120;
        CREATE TABLE memory_claim_recoveries (
            fragment_id INTEGER PRIMARY KEY REFERENCES memory_fragments(id) ON DELETE CASCADE,
            input_hash TEXT NOT NULL,
            replacement_claim_ids_json TEXT NOT NULL CHECK(json_valid(replacement_claim_ids_json)),
            outcome TEXT NOT NULL CHECK(outcome IN('recovered','needs_context')),
            reviewer TEXT NOT NULL,
            recovered_at INTEGER NOT NULL
        );
        INSERT INTO memory_claim_recoveries(fragment_id,input_hash,replacement_claim_ids_json,outcome,reviewer,recovered_at)
            SELECT fragment_id,input_hash,replacement_claim_ids_json,outcome,reviewer,recovered_at
            FROM memory_claim_recoveries_v120;
        DROP TABLE memory_claim_recoveries_v120;
        DROP TABLE IF EXISTS memory_claim_review_passes;
        DROP TABLE IF EXISTS memory_foreground_leases;
        DROP TABLE IF EXISTS memory_runtime_state;
        DELETE FROM schema_version WHERE version>=120;
    `);
    db.close();
    process.exit(0);
}

const seeded = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, MEMORY_V120_SEED: '1' },
    encoding: 'utf8',
});
if (seeded.status !== 0) {
    process.stderr.write(seeded.stdout || '');
    process.stderr.write(seeded.stderr || '');
    process.exit(seeded.status || 1);
}

const db = require('../database').initDatabase();
assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get().version, 124);
const correctionColumns = new Set(db.prepare('PRAGMA table_info(correction_log)').all().map(row => row.name));
assert.ok(correctionColumns.has('source_msg_ids_json'));
assert.ok(correctionColumns.has('feedback_applied_at'));
const historical = db.prepare("SELECT * FROM correction_log WHERE source='fictional-upgrade'").get();
assert.ok(historical.feedback_applied_at);
assert.equal(historical.source_msg_ids_json, '[]');
assert.equal(db.prepare("SELECT status FROM memory_vector_projection WHERE projection_key='claim:upgrade'").get().status,
    'retry');
db.prepare(`UPDATE memory_vector_projection SET status='needs_review'
    WHERE projection_key='claim:upgrade'`).run();
assert.equal(db.prepare("SELECT status FROM memory_vector_projection WHERE projection_key='claim:upgrade'").get().status,
    'needs_review');
const recoveryColumns = new Set(db.prepare('PRAGMA table_info(memory_claim_recoveries)').all().map(row => row.name));
assert.ok(recoveryColumns.has('preserved_claim_ids_json'));
assert.ok(recoveryColumns.has('disputed_claim_ids_json'));
assert.ok(recoveryColumns.has('contract_version'));
assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_claim_review_passes'").get());
assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_foreground_leases'").get());

console.log(JSON.stringify({ ok: true, from_schema: 119, schema: 124, historical_feedback_preserved: true }));
