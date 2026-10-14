'use strict';

const assert = require('node:assert/strict');
const { initDatabase } = require('../database');

async function main() {
    const db = initDatabase();
    const protocol = require('../services/memoryProtocol');
    const scribe = require('../services/memoryScribe');
    const claimReview = require('../services/memoryClaimReview');
    const codex = require('../services/memoryCodexExecutor');
    const { config } = require('../services/memoryConfig');

    assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get().version, 112);
    db.prepare("INSERT OR IGNORE INTO chats(id,name) VALUES(1,'Lane Contract Test')").run();

    const addMessage = (content, timestamp) => Number(db.prepare(`INSERT INTO messages(
        chat_id,sender,content,timestamp,is_encrypted,message_type,status,picked_up_at)
        VALUES(1,'user',?,?,0,'text','sent',?)`).run(content, timestamp, timestamp).lastInsertRowid);
    const observe = async (messageId, body, quote, cursor) => {
        await scribe.runBatch(db.prepare('SELECT * FROM messages WHERE id=?').all(messageId), cursor, {
            extractEntries: async () => [{ body, domain: 'user_statement', temporal_state: 'unknown',
                evidence: [{ message_id: messageId, quote }] }],
        });
        return protocol.readClaim(db, db.prepare('SELECT id FROM memory_claims ORDER BY id DESC LIMIT 1').get().id);
    };

    const firstMessage = addMessage('River prefers jasmine tea.', '2026-01-02 10:00:00');
    const currentClaim = await observe(firstMessage, 'River prefers jasmine tea.', 'prefers jasmine tea',
        { at: '2000-01-01 00:00:00', id: 0 });
    const currentReviewJob = db.prepare("SELECT * FROM memory_jobs WHERE stage='claim_review' AND target_id=?").get(currentClaim.id);
    assert.equal(currentReviewJob.priority, protocol.LIVE_JOB_PRIORITY);

    const backfillMessage = addMessage('River once visited a museum.', '2026-01-02 11:00:00');
    const backfillFragment = Number(db.prepare(`INSERT INTO memory_fragments(
        type,entity,content,emotional_weight,source,source_date,status,source_msg_ids,observation_state,content_hash)
        VALUES('observation','unassigned','Historical neutral fixture',0.2,'import','2026-01-02','frozen',?,'frozen','backfill-fixture')`)
        .run(JSON.stringify([backfillMessage])).lastInsertRowid);
    const backfillClaim = protocol.createClaim(db, { fragmentId: backfillFragment,
        body: 'River once visited a museum.', domain: 'user_statement', temporal: { state: 'historical' },
        sources: [protocol.captureSource(db, backfillMessage, 'visited a museum')] });
    assert.equal(db.prepare("SELECT priority FROM memory_jobs WHERE stage='claim_review' AND target_id=?")
        .get(backfillClaim.id).priority, protocol.BACKFILL_JOB_PRIORITY);

    const leasedCurrent = protocol.leaseJobs(db, 'claim_review', { limit: 1, priorityBand: 'current' });
    assert.equal(leasedCurrent[0].target_id, currentClaim.id);
    claimReview.commit(db, { claimId: currentClaim.id, expectedRevision: currentClaim.revision,
        inputHash: currentClaim.input_hash, support: 'supported', attribution: 'supported',
        temporalState: 'unknown', reviewer: 'lane-test', priority: leasedCurrent[0].priority });
    protocol.finishJob(db, leasedCurrent[0], 'done');
    for (const stage of ['claim_duty', 'claim_classification']) {
        assert.equal(db.prepare('SELECT priority FROM memory_jobs WHERE stage=? AND target_id=?')
            .get(stage, currentClaim.id).priority, protocol.LIVE_JOB_PRIORITY);
    }
    assert.equal(protocol.leaseJobs(db, 'claim_review', { limit: 5, priorityBand: 'current' }).length, 0);
    const leasedBackfill = protocol.leaseJobs(db, 'claim_review', { limit: 1, priorityBand: 'backfill' });
    assert.equal(leasedBackfill[0].target_id, backfillClaim.id);
    protocol.finishJob(db, leasedBackfill[0], 'no_change');
    protocol.enqueueJob(db, { stage: 'lane_probe', targetType: 'claim', targetId: backfillClaim.id,
        inputRevision: backfillClaim.revision, inputHash: backfillClaim.input_hash });
    let runnerCalls = 0;
    const pipeline = require('../services/memoryPipeline');
    assert.equal(pipeline.processStage(db, 'lane_probe', () => { runnerCalls++; }, 5).length, 0);
    assert.equal(runnerCalls, 0);
    assert.equal(pipeline.processStage(db, 'lane_probe', () => { runnerCalls++; }, 5,
        { priorityBand: 'backfill' }).length, 1);
    assert.equal(runnerCalls, 1);

    const oldClassification = protocol.leaseJobs(db, 'claim_classification', { limit: 1, priorityBand: 'current' })[0];
    protocol.finishJob(db, oldClassification, 'no_change');
    const rejectedMessage = addMessage('River might buy a notebook someday.', '2026-01-02 12:00:00');
    const rejectedClaim = await observe(rejectedMessage, 'River will buy a notebook.', 'might buy a notebook someday',
        { at: '2026-01-02 10:00:00', id: firstMessage });
    const rejectedReviewJob = protocol.leaseJobs(db, 'claim_review', { limit: 1, priorityBand: 'current' })[0];
    claimReview.commit(db, { claimId: rejectedClaim.id, expectedRevision: rejectedClaim.revision,
        inputHash: rejectedClaim.input_hash, support: 'rejected', attribution: 'supported',
        temporalState: 'planned', reviewer: 'lane-test', priority: rejectedReviewJob.priority });
    protocol.finishJob(db, rejectedReviewJob, 'done');
    let modelCalls = 0;
    const rejectedResult = await codex.runLeased(db, 'claim_classification', {
        propose: async () => { modelCalls++; throw new Error('must_not_call_model'); },
    }, { limit: 1, priorityBand: 'current' });
    assert.equal(modelCalls, 0);
    assert.equal(rejectedResult[0].status, 'no_change');
    assert.equal(rejectedResult[0].error, 'classification_no_supported_claims');

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
    const backoff = await scribe.checkAndRun();
    assert.equal(backoff.reason, 'failure_backoff');

    config.pipeline.mode = 'modern';
    const skillResult = await require('../services/skillManager').scanForPatterns();
    assert.equal(skillResult.reason, 'macro_insight_not_published');
    const legacyClassification = await require('../services/archivist').classifyFragments();
    assert.equal(legacyClassification.reason, 'modern_memory_protocol');
    assert.equal(require('../services/cognitiveModel').getModelContext(), '');
    const legacyCognitive = await require('../services/cognitiveModel').runUserModelCycle();
    assert.equal(legacyCognitive.reason, 'modern_memory_protocol');

    console.log(JSON.stringify({ ok: true, schema: 112, live_priority: protocol.LIVE_JOB_PRIORITY,
        backfill_priority: protocol.BACKFILL_JOB_PRIORITY, model_calls_for_rejected_claim: modelCalls }));
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
