'use strict';

require('./test_env');

const assert = require('node:assert/strict');
const { initDatabase } = require('../database');
const {
    normalizeEmotionalWeight,
    getDecayLambda,
    segmentedDecay,
} = require('../utils/emotionalWeight');

function assertPureFunctions() {
    // 0 是有效分值（纯事实），只有缺失值才落到默认档
    assert.equal(normalizeEmotionalWeight(0), 0);
    assert.equal(normalizeEmotionalWeight(0.1), 0.1);
    assert.equal(normalizeEmotionalWeight(0.5), 0.5);
    assert.equal(normalizeEmotionalWeight(undefined), 0.5);
    assert.equal(normalizeEmotionalWeight(null), 0.5);
    assert.equal(normalizeEmotionalWeight(''), 0.5);
    assert.equal(normalizeEmotionalWeight(NaN), 0.5);
    assert.equal(normalizeEmotionalWeight(Infinity), 0.5);
    assert.equal(normalizeEmotionalWeight('0'), 0);
    assert.equal(normalizeEmotionalWeight(-0.2), 0);
    assert.equal(normalizeEmotionalWeight(1.4), 1);
    assert.equal(normalizeEmotionalWeight(undefined, 0.3), 0.3);

    assert.equal(getDecayLambda(0), 0.04);
    assert.equal(getDecayLambda(0.5), 0.02);
    assert.equal(getDecayLambda(1), 0.005);

    // 报告 1.1：修复前 ew=0 会被当成 0.5，衰减比 ew=0.1 更慢
    assert.ok(
        segmentedDecay(10, 0) < segmentedDecay(10, 0.1),
        'ew=0 must decay faster than ew=0.1'
    );
    // 报告 T3：读路径对越界值做上限钳制，衰减因子不再 >1
    assert.equal(segmentedDecay(0, 2), segmentedDecay(0, 1));
    assert.ok(segmentedDecay(0, 2) <= 1);
}

function assertEvidenceReplayIsIdempotent() {
    const db = initDatabase();

    // 测试固定走 legacy 认知模型；公开仓干净安装的默认模式也是 legacy。
    const { config } = require('../services/memoryConfig');
    config.pipeline.mode = 'legacy';

    const cognitive = require('../services/cognitiveModel');
    const entryId = cognitive.createEntry('current_state', 'Synthetic state for evidence replay fixture', {
        confidence: 0.3,
        source_quality: 'inferred',
    });
    assert.ok(entryId);

    const insertFragment = (content, messageId) => Number(db.prepare(`
        INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, source_msg_ids)
        VALUES ('fact', 'User', ?, 0.2, 'chat', ?)
    `).run(content, JSON.stringify([messageId])).lastInsertRowid);

    const firstFragment = insertFragment('Synthetic evidence one', 1);
    const secondFragment = insertFragment('Synthetic evidence two', 2);

    const before = db.prepare('SELECT confidence, evidence_count FROM user_model WHERE id = ?').get(entryId);
    const first = cognitive.addEvidence(entryId, firstFragment, true, { sourceMsgIds: [1] });
    assert.ok(first, 'first evidence should be accepted');

    const afterFirst = db.prepare('SELECT confidence, evidence_count, source_fragment_ids FROM user_model WHERE id = ?').get(entryId);
    assert.ok(afterFirst.confidence > before.confidence);
    assert.equal(afterFirst.evidence_count, before.evidence_count + 1);
    assert.deepEqual(JSON.parse(afterFirst.source_fragment_ids), [firstFragment]);

    // 同一个 fragment 重放：不增加 confidence / evidence_count
    const replay = cognitive.addEvidence(entryId, firstFragment, true, { sourceMsgIds: [1] });
    assert.equal(replay, null);
    const afterReplay = db.prepare('SELECT confidence, evidence_count FROM user_model WHERE id = ?').get(entryId);
    assert.equal(afterReplay.confidence, afterFirst.confidence);
    assert.equal(afterReplay.evidence_count, afterFirst.evidence_count);

    // 换一份真正独立的 fragment：仍应正常累积
    const second = cognitive.addEvidence(entryId, secondFragment, true, { sourceMsgIds: [2] });
    assert.ok(second, 'a different fragment should still be accepted');
    const afterSecond = db.prepare('SELECT confidence, evidence_count FROM user_model WHERE id = ?').get(entryId);
    assert.ok(afterSecond.confidence > afterReplay.confidence);
    assert.equal(afterSecond.evidence_count, afterReplay.evidence_count + 1);
}

try {
    assertPureFunctions();
    assertEvidenceReplayIsIdempotent();
    console.log('emotional weight + evidence replay: ok');
} catch (error) {
    console.error(error);
    process.exit(1);
}
