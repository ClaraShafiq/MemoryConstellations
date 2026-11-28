'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-constellations-contracts-'));
process.env.DB_PATH = path.join(testDir, 'contracts.db');
process.env.SANCTUARY_ENCRYPTION_KEY ||= '1'.repeat(64);

async function main() {
    const db = require('../database').initDatabase();
    try {
        const protocol = require('../services/memoryProtocol');
        const fragmentEvidence = require('../services/memoryFragmentEvidence');
        const scribe = require('../services/memoryScribe');
        const classification = require('../services/memoryClassification');
        const evidence = require('../services/memoryEvidenceResolution');

        assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get().version, 125);
        for (const table of ['memory_claims', 'memory_claim_sources', 'memory_claim_duties',
            'memory_claim_reviews', 'memory_claim_review_passes', 'memory_claim_recoveries']) {
            assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), undefined);
        }
        assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_fragment_evidence_refs'").get());
        assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_fragment_evidence_sources'").get());

        db.prepare("INSERT INTO chats(id,name) VALUES(1,'Fictional Contract Lab')").run();
        let minute = 0;
        const addMessage = (content, { sender = 'user', mode = 'default' } = {}) => {
            const timestamp = `2026-06-04 09:${String(minute++).padStart(2, '0')}:00`;
            return Number(db.prepare(`INSERT INTO messages(
                chat_id,sender,content,timestamp,is_encrypted,message_type,status,picked_up_at,chat_mode)
                VALUES(1,?,?,?,0,'text','sent',?,?)`)
                .run(sender, content, timestamp, timestamp, mode).lastInsertRowid);
        };
        const observe = async (messageId, entry) => {
            const before = db.prepare('SELECT COALESCE(MAX(id),0) id FROM memory_fragments').get().id;
            await scribe.runBatch(db.prepare('SELECT * FROM messages WHERE id=?').all(messageId), scribe.lastCursor(db), {
                extractEntries: async () => [{ ...entry,
                    evidence: [{ message_id: messageId, quote: entry.quote }] }],
            });
            const row = db.prepare("SELECT id,status,observation_state FROM memory_fragments WHERE id>? ORDER BY id DESC LIMIT 1")
                .get(before);
            assert.equal(row.status, 'active');
            assert.equal(row.observation_state, 'quoted');
            return protocol.readClaim(db, fragmentEvidence.syntheticId(row.id));
        };

        assert.equal(scribe.incompleteBodyReason('It was repaired.'), 'scribe_dangling_reference');
        assert.equal(scribe.incompleteBodyReason("Avery's Pro."), 'scribe_dangling_reference');
        assert.match(scribe.buildPrompt([]).system, /same object and will be retrieved or updated together/);

        const fictionMessage = addMessage('In the novel, the glass orchard floats above the sea.', { mode: 'roleplay' });
        await assert.rejects(() => scribe.runBatch(db.prepare('SELECT * FROM messages WHERE id=?').all(fictionMessage),
            { at: '2000-01-01 00:00:00', id: 0 }, { extractEntries: async () => [{
                body: 'The user lives in a glass orchard.', subject: 'user', domain: 'user_statement',
                temporal_state: 'unknown', evidence: [{ message_id: fictionMessage,
                    quote: 'glass orchard floats above the sea' }],
            }] }), /scribe_roleplay_must_be_fiction/);

        const statementId = addMessage('River prefers jasmine tea.');
        const direct = await observe(statementId, { body: 'River prefers jasmine tea.', memory_type: 'preference', subject: 'user',
            domain: 'user_statement', temporal_state: 'unknown', quote: 'prefers jasmine tea' });
        assert.equal(direct.synthetic, true);
        assert.equal(direct.duty, 'preference');
        assert.equal(protocol.eligible(db, direct.id), true);
        assert.throws(() => protocol.createClaim(db, {}), /memory_claim_layer_retired/);
        assert.throws(() => protocol.reviewClaim(db, direct.id, {}), /memory_claim_layer_retired/);
        assert.throws(() => protocol.setDuty(db, direct.id, {}), /memory_claim_layer_retired/);

        classification.commit(db, { claimId: direct.id, expectedRevision: direct.revision,
            inputHash: direct.input_hash, outcome: 'no_independent_node', links: [], topics: ['tea'],
            reviewer: 'test-contract' });
        assert.equal(evidence.reconcile(db, direct.id).state, 'unassigned');
        assert.equal(db.prepare("SELECT target_type FROM memory_jobs WHERE stage='episode_candidate' AND target_id=?")
            .get(direct.id).target_type, 'fragment');

        db.prepare("UPDATE messages SET content='River changed the source sentence.' WHERE id=?").run(statementId);
        assert.equal(protocol.sourcesCurrent(db, direct), false);
        assert.equal(protocol.eligible(db, direct.id), false);
        assert.deepEqual(classification.availability(db, direct.id), {
            available: false, reason: 'classification_source_changed',
        });

        console.log(JSON.stringify({ ok: true, schema: 125, fragment_evidence_id: direct.id,
            claim_tables_retired: true, stale_source_rejected: true }));
    } finally {
        db.close();
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
