'use strict';

require('./test_env');

const assert = require('node:assert/strict');
const { initDatabase } = require('../database');

async function main() {
    const db = initDatabase();
    const correction = require('../services/correction');
    const lifecycle = require('../services/lifecycle');

    assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get().version, 124);
    const addFragment = (content, sourceIds, weight = 0.8) => Number(db.prepare(`INSERT INTO memory_fragments(
        type,entity,content,emotional_weight,source,status,source_msg_ids,observation_state)
        VALUES('observation','unassigned',?,?,'fictional-test','active',?,'legacy')`)
        .run(content, weight, JSON.stringify(sourceIds)).lastInsertRowid);

    const target = addFragment('A fictional lantern was blue.', [7001]);
    const sibling = addFragment('The same fictional lantern was stored safely.', [7001, 7002]);
    const unrelated = addFragment('A paper kite was catalogued separately.', [7999]);
    const correctionId = correction.recordCorrection({
        targetType: 'fragment',
        targetId: target,
        wrongSummary: 'The fictional lantern was blue.',
        correctSummary: 'The fictional lantern was green.',
        source: 'fictional-test',
    });
    const receipt = db.prepare('SELECT * FROM correction_log WHERE id=?').get(correctionId);
    assert.deepEqual(JSON.parse(receipt.source_msg_ids_json), [7001]);
    assert.ok(receipt.feedback_applied_at);
    assert.equal(receipt.status, 'active');
    assert.equal(db.prepare('SELECT status FROM memory_fragments WHERE id=?').get(target).status, 'consolidated');
    assert.equal(db.prepare('SELECT emotional_weight FROM memory_fragments WHERE id=?').get(sibling).emotional_weight, 0.4);
    assert.equal(db.prepare('SELECT emotional_weight FROM memory_fragments WHERE id=?').get(unrelated).emotional_weight, 0.8);
    assert.throws(() => correction.recordCorrection({ targetType: 'fragment', targetId: unrelated,
        wrongSummary: 'An incomplete correction.', correctSummary: '', source: 'manual' }),
    /correction_correct_summary_required/);
    assert.deepEqual(correction.applyCorrectionFeedback(db, correctionId), { applied: false, cascaded: 0 });
    assert.equal(db.prepare('SELECT emotional_weight FROM memory_fragments WHERE id=?').get(sibling).emotional_weight, 0.4);

    const deferredTarget = addFragment('A fictional compass note was incorrect.', [8001]);
    const deferredSibling = addFragment('The fictional compass shared the same source.', [8001], 0.6);
    const deferredId = Number(db.prepare(`INSERT INTO correction_log(
        target_type,target_id,wrong_summary,correct_summary,source,status,source_msg_ids_json)
        VALUES('fragment',?,?,?,'fictional-test','active',?)`)
        .run(deferredTarget, 'Incorrect compass note.', 'Corrected compass note.', '[8001]').lastInsertRowid);
    const stats = await lifecycle.runCorrectionFeedback();
    assert.equal(stats.processed, 1);
    assert.equal(stats.cascaded, 1);
    assert.equal(db.prepare('SELECT emotional_weight FROM memory_fragments WHERE id=?').get(deferredSibling).emotional_weight,
        0.3);
    const deferredReceipt = db.prepare('SELECT status,feedback_applied_at FROM correction_log WHERE id=?').get(deferredId);
    assert.equal(deferredReceipt.status, 'active');
    assert.ok(deferredReceipt.feedback_applied_at);
    assert.deepEqual(await lifecycle.runCorrectionFeedback(), { processed: 0, cascaded: 0 });

    console.log(JSON.stringify({ ok: true, schema: 124, immediate_cascade: 1, deferred_cascade: stats.cascaded }));
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
