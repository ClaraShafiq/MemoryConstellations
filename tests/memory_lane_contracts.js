'use strict';

require('./test_env');

const assert = require('node:assert/strict');
const { initDatabase } = require('../database');

async function main() {
    const db = initDatabase();
    const protocol = require('../services/memoryProtocol');
    const fragments = require('../services/memoryFragmentEvidence');
    const scribe = require('../services/memoryScribe');
    const classification = require('../services/memoryClassification');
    const codex = require('../services/memoryCodexExecutor');
    const { config } = require('../services/memoryConfig');

    assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get().version, 125);
    db.prepare("INSERT OR IGNORE INTO chats(id,name) VALUES(1,'Lane Contract Test')").run();

    const addMessage = (content, timestamp) => Number(db.prepare(`INSERT INTO messages(
        chat_id,sender,content,timestamp,is_encrypted,message_type,status,picked_up_at)
        VALUES(1,'user',?,?,0,'text','sent',?)`).run(content, timestamp, timestamp).lastInsertRowid);
    const observe = async (messageId, body, quote, cursor) => {
        const before = db.prepare('SELECT COALESCE(MAX(id),0) id FROM memory_fragments').get().id;
        await scribe.runBatch(db.prepare('SELECT * FROM messages WHERE id=?').all(messageId), cursor, {
            extractEntries: async () => [{ body, subject: 'user', domain: 'user_statement', temporal_state: 'unknown',
                evidence: [{ message_id: messageId, quote }] }],
        });
        const fragment = db.prepare("SELECT id FROM memory_fragments WHERE id>? AND status='active'").get(before);
        return protocol.readClaim(db, fragments.syntheticId(fragment.id));
    };

    const firstMessage = addMessage('River prefers jasmine tea.', '2026-01-02 10:00:00');
    const current = await observe(firstMessage, 'River prefers jasmine tea.', 'prefers jasmine tea',
        { at: '2000-01-01 00:00:00', id: 0 });
    const currentJob = db.prepare("SELECT * FROM memory_jobs WHERE stage='fragment_classification' AND target_id=?")
        .get(current.id);
    assert.equal(currentJob.priority, protocol.LIVE_JOB_PRIORITY);

    protocol.enqueueJob(db, { stage: 'lane_probe', targetType: 'fragment', targetId: 10,
        inputRevision: 1, inputHash: 'current', priority: protocol.LIVE_JOB_PRIORITY });
    protocol.enqueueJob(db, { stage: 'lane_probe', targetType: 'fragment', targetId: 20,
        inputRevision: 1, inputHash: 'backfill', priority: protocol.BACKFILL_JOB_PRIORITY });
    const liveProbe = protocol.leaseJobs(db, 'lane_probe', { limit: 5, priorityBand: 'current' });
    assert.deepEqual(liveProbe.map(job => job.target_id), [10]);
    protocol.finishJob(db, liveProbe[0], 'done');
    const backfillProbe = protocol.leaseJobs(db, 'lane_probe', { limit: 5, priorityBand: 'backfill' });
    assert.deepEqual(backfillProbe.map(job => job.target_id), [20]);
    protocol.finishJob(db, backfillProbe[0], 'done');

    const leased = protocol.leaseJobs(db, 'fragment_classification', { limit: 1, priorityBand: 'current' });
    assert.equal(leased[0].target_id, current.id);
    classification.commit(db, { claimId: current.id, expectedRevision: current.revision,
        inputHash: current.input_hash, outcome: 'no_independent_node', links: [], topics: [],
        reviewer: 'test-lane', priority: leased[0].priority });
    protocol.finishJob(db, leased[0], 'done');
    assert.equal(db.prepare("SELECT priority FROM memory_jobs WHERE stage='evidence_resolution' AND target_id=?")
        .get(current.id).priority, protocol.LIVE_JOB_PRIORITY);

    const staleMessage = addMessage('River might buy a notebook someday.', '2026-01-02 12:00:00');
    const stale = await observe(staleMessage, 'River might buy a notebook someday.', 'might buy a notebook someday',
        { at: '2026-01-02 10:00:00', id: firstMessage });
    db.prepare("UPDATE messages SET content='Source changed after extraction.' WHERE id=?").run(staleMessage);
    let modelCalls = 0;
    const staleResult = await codex.runLeased(db, 'fragment_classification', {
        propose: async () => { modelCalls++; throw new Error('must_not_call_model'); },
    }, { limit: 1, priorityBand: 'current', targetId: stale.id });
    assert.equal(modelCalls, 0);
    assert.equal(staleResult[0].status, 'no_change');
    assert.equal(staleResult[0].error, 'classification_source_changed');

    const stableCursor = scribe.lastCursor(db);
    const failingMessage = addMessage('A neutral message that remains pending.', '2026-01-02 13:00:00');
    const pending = db.prepare('SELECT * FROM messages WHERE id=?').all(failingMessage);
    for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(() => scribe.runBatch(pending, stableCursor, {
            extractEntries: async () => { throw Object.assign(new Error('stable_failure'), { code: 'stable_failure' }); },
        }), /stable_failure/);
        assert.deepEqual(scribe.lastCursor(db), stableCursor);
    }
    assert.equal(scribe.recoveryState(db, stableCursor, 60).batchLimit, 15);
    assert.equal((await scribe.checkAndRun()).reason, 'failure_backoff');

    config.pipeline.mode = 'modern';
    assert.equal((await require('../services/skillManager').scanForPatterns()).reason, 'macro_insight_not_published');
    assert.equal((await require('../services/archivist').classifyFragments()).reason, 'modern_memory_protocol');
    assert.equal(require('../services/cognitiveModel').getModelContext(), '');
    assert.equal((await require('../services/cognitiveModel').runUserModelCycle()).reason, 'modern_memory_protocol');

    console.log(JSON.stringify({ ok: true, schema: 125, live_priority: protocol.LIVE_JOB_PRIORITY,
        backfill_priority: protocol.BACKFILL_JOB_PRIORITY, model_calls_for_stale_fragment: modelCalls }));
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
