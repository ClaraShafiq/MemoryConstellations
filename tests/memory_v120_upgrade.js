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

if (process.env.MEMORY_V124_SEED === '1') {
    const db = require('../database').initDatabase();
    const protocol = require('../services/memoryProtocol');
    db.exec(protocol.SCHEMA);

    db.prepare("INSERT INTO chats(id,name) VALUES(1,'v124 Upgrade Fixture')").run();
    const messageId = Number(db.prepare(`INSERT INTO messages(
        chat_id,sender,content,timestamp,is_encrypted,message_type,status,picked_up_at)
        VALUES(1,'user','River keeps a cedar notebook.','2026-01-02 10:00:00',0,'text','sent','2026-01-02 10:00:00')`)
        .run().lastInsertRowid);
    const observation = {
        contract: 'complete-semantic-unit-v3', subject: 'user', domain: 'user_statement',
        sensitivity: 'none', temporal: { state: 'unknown', event_from: null, event_until: null, precision: 'unknown' },
        evidence: [],
    };
    const fragmentId = Number(db.prepare(`INSERT INTO memory_fragments(
        type,entity,content,emotional_weight,source,source_date,status,source_msg_ids,
        observation_json,observation_state,content_hash)
        VALUES('observation','unassigned','River keeps a cedar notebook.',0.5,'chat','2026-01-02','frozen',?,?,'frozen',?)`)
        .run(JSON.stringify([messageId]), JSON.stringify(observation), 'v124-upgrade-fragment').lastInsertRowid);
    const source = protocol.captureSource(db, messageId, 'keeps a cedar notebook');
    observation.evidence = [source];
    db.prepare('UPDATE memory_fragments SET observation_json=? WHERE id=?')
        .run(JSON.stringify(observation), fragmentId);
    const unverifiedFragmentId = Number(db.prepare(`INSERT INTO memory_fragments(
        type,entity,content,emotional_weight,source,source_date,status,source_msg_ids,
        observation_json,observation_state,content_hash)
        VALUES('observation','unassigned','Unverified migration fixture.',0.2,'chat','2026-01-02','frozen','[]',?,'frozen',?)`)
        .run(JSON.stringify({ ...observation, evidence: [] }), 'v124-unverified-fragment').lastInsertRowid);

    const claim = protocol.createClaim(db, { fragmentId, body: 'River keeps a cedar notebook.',
        domain: 'user_statement', subjectKind: 'user', temporal: { state: 'unknown' }, sources: [source] });
    protocol.reviewClaim(db, claim.id, { expectedRevision: claim.revision, inputHash: claim.input_hash,
        support: 'supported', attribution: 'supported', temporalState: 'unknown', reviewer: 'test-upgrade' });
    protocol.setDuty(db, claim.id, { expectedRevision: claim.revision, inputHash: claim.input_hash,
        duty: 'stable_fact', contextScope: 'general', basis: 'exact_quote', state: 'supported',
        reviewer: 'test-upgrade' });
    db.prepare('UPDATE memory_claims SET manual_locked=1 WHERE id=?').run(claim.id);
    db.prepare(`INSERT INTO memory_claim_classification(
        claim_id,claim_revision,input_hash,outcome,links_json,topics_json,reviewer)
        VALUES(?,?,?,'no_independent_node','[]','["notebook"]','test-upgrade')`)
        .run(claim.id, claim.revision, claim.input_hash);
    db.prepare(`INSERT INTO memory_evidence_pool(
        claim_id,claim_revision,input_hash,state,reason_code,entity_ids_json,attempts,
        evidence_fingerprint,next_review_at,updated_at)
        VALUES(?,?,?,'unassigned','no_independent_node','[]',0,'upgrade-evidence',0,?)`)
        .run(claim.id, claim.revision, claim.input_hash, Date.now());

    const candidateId = Number(db.prepare(`INSERT INTO memory_episode_candidates(
        claim_ids_json,entity_ids_json,temporal_state,input_hash,status,created_at,updated_at)
        VALUES(?,'[]','completed','episode-hash-preserved','published',?,?)`)
        .run(JSON.stringify([claim.id]), Date.now(), Date.now()).lastInsertRowid);
    const memoryId = Number(db.prepare(`INSERT INTO memories(title,content,status,layer,source_msg_ids)
        VALUES('Cedar notebook',?,'permanent','episode',?)`)
        .run(protocol.encrypt('River keeps a cedar notebook.'), JSON.stringify([messageId])).lastInsertRowid);
    const episodePayload = JSON.stringify({ title: 'Cedar notebook', content: 'River keeps a cedar notebook.',
        tags: ['notebook'], claim_ids: [claim.id], transient: false });
    db.prepare(`INSERT INTO memory_episode_publications(
        candidate_id,memory_id,input_hash,revision,producer,reviewer,payload_json,published_at)
        VALUES(?,?,'episode-hash-preserved',1,'structured_reviewer','test-upgrade',?,?)`)
        .run(candidateId, memoryId, episodePayload, Date.now());

    const entityId = Number(db.prepare(`INSERT INTO entity_profiles(name,category,status,aliases,memory_scope)
        VALUES('River','person','active','[]','default')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO memory_profile_field_publications(
        entity_id,field,input_hash,revision,value_enc,claim_ids_json,producer,model_role,persona_hash,published_at)
        VALUES(?,'facts','profile-hash-preserved',1,?,?,'structured_reviewer','objective_reviewer',NULL,?)`)
        .run(entityId, protocol.encrypt('Keeps a cedar notebook.'), JSON.stringify([claim.id]), Date.now());

    db.prepare('DELETE FROM schema_version WHERE version=125').run();
    db.prepare(`INSERT INTO user_settings(setting_key,setting_value) VALUES('v124_unverified_fragment_id',?)`)
        .run(String(unverifiedFragmentId));
    db.close();
    process.exit(0);
}

const seeded = spawnSync('/usr/bin/node', [__filename], {
    env: { ...process.env, MEMORY_V124_SEED: '1' }, encoding: 'utf8',
});
if (seeded.status !== 0) {
    process.stderr.write(seeded.stdout || '');
    process.stderr.write(seeded.stderr || '');
    process.exit(seeded.status || 1);
}

const db = require('../database').initDatabase();
const protocol = require('../services/memoryProtocol');
assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get().version, 125);
for (const table of ['memory_claims', 'memory_claim_sources', 'memory_claim_duties',
    'memory_claim_reviews', 'memory_claim_review_passes', 'memory_claim_recoveries']) {
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), undefined);
}
const ref = db.prepare('SELECT * FROM memory_fragment_evidence_refs').get();
assert.ok(ref);
assert.equal(ref.active, 1);
const preserved = protocol.readClaim(db, ref.evidence_id);
assert.equal(preserved.ledger, true);
assert.equal(preserved.body, 'River keeps a cedar notebook.');
assert.equal(preserved.sources[0].quote, 'keeps a cedar notebook');
assert.equal(protocol.eligible(db, preserved.id), true);
assert.deepEqual(JSON.parse(db.prepare('SELECT claim_ids_json FROM memory_episode_candidates').get().claim_ids_json),
    [preserved.id]);
const episode = db.prepare('SELECT input_hash,payload_json FROM memory_episode_publications').get();
assert.equal(episode.input_hash, 'episode-hash-preserved');
assert.deepEqual(JSON.parse(episode.payload_json).claim_ids, [preserved.id]);
const profile = db.prepare('SELECT input_hash,claim_ids_json FROM memory_profile_field_publications').get();
assert.equal(profile.input_hash, 'profile-hash-preserved');
assert.deepEqual(JSON.parse(profile.claim_ids_json), [preserved.id]);
assert.equal(db.prepare('SELECT status FROM memory_fragments WHERE id=?').get(preserved.fragment_id).status, 'active');
const unverifiedFragmentId = Number(db.prepare(`SELECT setting_value FROM user_settings
    WHERE setting_key='v124_unverified_fragment_id'`).get().setting_value);
assert.equal(db.prepare('SELECT status FROM memory_fragments WHERE id=?').get(unverifiedFragmentId).status, 'frozen');
assert.equal(require('../services/memoryFragmentEvidence').direct(db, unverifiedFragmentId), null);
protocol.supersedeClaim(db, preserved.id, { expectedRevision: preserved.revision,
    inputHash: preserved.input_hash, actor: 'test-upgrade' });
assert.deepEqual(require('../services/memoryFragmentEvidence').forFragment(db, preserved.fragment_id), []);
assert.equal(require('../services/memoryFragmentEvidence').direct(db, preserved.fragment_id), null);

console.log(JSON.stringify({ ok: true, from_schema: 124, schema: 125,
    legacy_evidence_id: preserved.id, publications_preserved: true }));
