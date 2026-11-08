'use strict';

const assert = require('node:assert/strict');
const { initDatabase } = require('../database');

async function main() {
    const db = initDatabase();
    const scribe = require('../services/memoryScribe');

    assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get().version, 120);
    assert.equal(scribe.CONTRACT, 'complete-semantic-unit-v2');
    db.prepare("INSERT OR IGNORE INTO chats(id,name) VALUES(1,'Fictional Harbor Workshop')").run();

    const insertMessage = db.prepare(`INSERT INTO messages(
        chat_id,sender,content,timestamp,is_encrypted,message_type,status,picked_up_at)
        VALUES(1,'user',?,'2026-04-03 09:00:00',0,'text','sent','2026-04-03 09:00:00')`);
    const guideId = Number(insertMessage.run('I finished reading the fictional harbor guide.').lastInsertRowid);
    const notesId = Number(insertMessage.run('I also organized the matching route notes.').lastInsertRowid);
    const messages = db.prepare('SELECT * FROM messages WHERE id IN (?,?) ORDER BY id').all(guideId, notesId);

    let calls = 0;
    const result = await scribe.runBatch(messages, { at: '2000-01-01 00:00:00', id: 0 }, {
        extractEntries: async (_batch, options) => {
            calls++;
            if (calls === 1) {
                assert.equal(options.feedback, '');
                return [
                    { body: 'The user finished reading the fictional harbor guide.', subject: 'user',
                        domain: 'observed_activity', temporal_state: 'completed',
                        evidence: [{ message_id: guideId, quote: 'finished reading the fictional harbor guide' }] },
                    { body: 'The user organized the matching route notes.', subject: 'user',
                        domain: 'observed_activity', temporal_state: 'completed',
                        evidence: [{ message_id: notesId, quote: 'organized the matching route notes' }] },
                ];
            }
            assert.match(options.feedback, /over-split/);
            return [{ body: 'The user finished the fictional harbor guide and organized its matching route notes.',
                subject: 'user', domain: 'observed_activity', temporal_state: 'completed',
                evidence: [
                    { message_id: guideId, quote: 'finished reading the fictional harbor guide' },
                    { message_id: notesId, quote: 'organized the matching route notes' },
                ] }];
        },
    });
    assert.equal(calls, 2);
    assert.equal(result.extraction_attempts, 2);
    assert.equal(result.observations_written, 1);
    assert.equal(result.observations_rejected, 0);
    const sourceIds = JSON.parse(db.prepare('SELECT source_msg_ids FROM memory_fragments').get().source_msg_ids);
    assert.deepEqual(sourceIds, [guideId, notesId]);

    const evidenceMessage = { id: 99, content: 'The lantern was repaired carefully before the evening test.' };
    const coalesced = scribe.coalesceDuplicateEvidence({
        body: 'The lantern was repaired carefully before the evening test.',
        evidence: [
            { message_id: 99, quote: 'lantern was repaired' },
            { message_id: 99, quote: 'before the evening test' },
        ],
    }, [evidenceMessage]);
    assert.deepEqual(coalesced.evidence, [{
        message_id: 99,
        quote: 'lantern was repaired carefully before the evening test',
    }]);

    assert.equal(scribe.incompleteBodyReason('The user finished.'), 'scribe_missing_action_object');
    assert.equal(scribe.incompleteBodyReason('用户已经看完了。'), 'scribe_missing_action_object');
    assert.equal(scribe.incompleteBodyReason('The user worried that something strange might interfere.'),
        'scribe_generic_object');
    assert.equal(scribe.incompleteBodyReason('The user finished reading the fictional harbor guide.'), null);
    const prompt = scribe.buildPrompt(messages);
    assert.match(prompt.system, /smallest complete semantic units/);
    assert.match(prompt.system, /same chat, speaker, and timestamp/);
    assert.match(prompt.system, /Each evidence message_id may appear at most once/);

    console.log(JSON.stringify({ ok: true, schema: 120, contract: scribe.CONTRACT,
        attempts: result.extraction_attempts, observations: result.observations_written }));
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
