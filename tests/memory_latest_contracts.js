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
        const scribe = require('../services/memoryScribe');
        const review = require('../services/memoryClaimReview');
        const duty = require('../services/memoryClaimDuty');
        const classification = require('../services/memoryClassification');
        const nodes = require('../services/memoryNodeReview');
        const evidence = require('../services/memoryEvidenceResolution');
        const recovery = require('../services/memoryClaimRecovery');
        const profiles = require('../services/memoryProfileProjection');
        const fields = require('../services/memoryProfileFields');

        assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get().version, 124);
        db.prepare("INSERT INTO chats(id,name) VALUES(1,'Fictional Contract Lab')").run();
        let minute = 0;
        const addMessage = (content, { sender = 'user', mode = 'default' } = {}) => {
            const timestamp = `2026-06-04 09:${String(minute++).padStart(2, '0')}:00`;
            return Number(db.prepare(`INSERT INTO messages(
                chat_id,sender,content,timestamp,is_encrypted,message_type,status,picked_up_at,chat_mode)
                VALUES(1,?,?,?,0,'text','sent',?,?)`)
                .run(sender, content, timestamp, timestamp, mode).lastInsertRowid);
        };
        const addFragment = messageIds => Number(db.prepare(`INSERT INTO memory_fragments(
            type,entity,content,emotional_weight,source,source_date,status,source_msg_ids,
            observation_json,observation_state,content_hash)
            VALUES('observation','unassigned','Synthetic contract fixture',0.2,'chat','2026-06-04','frozen',?,
            '{}','frozen',?)`).run(JSON.stringify(messageIds), protocol.hash({ messageIds, minute })).lastInsertRowid);
        const addClaim = (fragmentId, messageId, body, quote, domain = 'user_statement', temporal = 'unknown') =>
            protocol.createClaim(db, { fragmentId, body, domain,
                subjectKind: domain === 'companion_opinion' ? 'assistant' : 'user',
                temporal: { state: temporal }, sources: [protocol.captureSource(db, messageId, quote)] });
        const approve = (claim, claimDuty, contextScope = 'general', extra = {}) => {
            review.commit(db, { claimId: claim.id, expectedRevision: claim.revision, inputHash: claim.input_hash,
                support: 'supported', attribution: 'supported', temporalState: claim.temporal_state,
                reviewer: 'test-contract' });
            return duty.commit(db, { claimId: claim.id, expectedRevision: claim.revision,
                inputHash: claim.input_hash, duty: claimDuty, contextScope, basis: 'exact_quote',
                state: 'supported', reviewer: 'test-contract', ...extra });
        };
        const ground = (claim, entityId, role = 'subject') => {
            classification.commit(db, { claimId: claim.id, expectedRevision: claim.revision,
                inputHash: claim.input_hash, outcome: 'linked', links: [{ entity_id: entityId, role }],
                topics: [], reviewer: 'test-contract' });
            nodes.commit(db, { claimId: claim.id, entityId, role, expectedRevision: claim.revision,
                inputHash: claim.input_hash, verdict: 'supported', quote: claim.sources[0].quote,
                reviewer: 'test-contract' });
            return evidence.reconcile(db, claim.id);
        };

        // Complete semantic units reject dangling pronouns and context-free product suffixes.
        assert.equal(scribe.incompleteBodyReason('It was repaired.'), 'scribe_dangling_reference');
        assert.equal(scribe.incompleteBodyReason("Avery's Pro."), 'scribe_dangling_reference');
        assert.match(scribe.buildPrompt([]).system, /same object and will be retrieved or updated together/);

        // Role-play/reference material cannot become a real-world user fact.
        const fictionMessage = addMessage('In the novel, the glass orchard floats above the sea.', { mode: 'roleplay' });
        await assert.rejects(() => scribe.runBatch(db.prepare('SELECT * FROM messages WHERE id=?').all(fictionMessage),
            { at: '2000-01-01 00:00:00', id: 0 }, { extractEntries: async () => [{
                body: 'The user lives in a glass orchard.', subject: 'user', domain: 'user_statement',
                temporal_state: 'unknown', evidence: [{ message_id: fictionMessage,
                    quote: 'glass orchard floats above the sea' }],
            }] }), /scribe_roleplay_must_be_fiction/);

        // A question is an object anchor, not proof. A later declaration can support the property.
        const questionId = addMessage('Is Nova Satchel made from basalt fiber?');
        const questionClaim = addClaim(addFragment([questionId]), questionId,
            'Nova Satchel is made from basalt fiber.', 'Is Nova Satchel made from basalt fiber?');
        assert.throws(() => review.commit(db, { claimId: questionClaim.id,
            expectedRevision: questionClaim.revision, inputHash: questionClaim.input_hash,
            support: 'supported', attribution: 'supported', temporalState: 'unknown',
            reviewer: 'test-contract' }), /memory_review_question_not_fact_evidence/);
        assert.equal(review.sourceKind({ quote: 'Could be made from basalt fiber.' }), 'declarative_evidence');
        const statementId = addMessage('Nova Satchel may be made from basalt fiber.');
        const qualified = addClaim(addFragment([statementId]), statementId,
            'Nova Satchel may be made from basalt fiber.', 'may be made from basalt fiber');
        approve(qualified, 'stable_fact', 'general', { qualified: true });

        // Local recovery preserves an accepted sibling while replacing only the disputed claim.
        const recoveryMessage = addMessage('Nova Satchel is a blue travel bag, and its zipper was replaced last winter.');
        const recoveryFragment = addFragment([recoveryMessage]);
        const stableSibling = addClaim(recoveryFragment, recoveryMessage,
            'Nova Satchel is a blue travel bag.', 'Nova Satchel is a blue travel bag');
        approve(stableSibling, 'stable_fact');
        const disputed = addClaim(recoveryFragment, recoveryMessage,
            'Nova Satchel is blue and had an unspecified repair.', 'its zipper was replaced last winter');
        review.commit(db, { claimId: disputed.id, expectedRevision: disputed.revision,
            inputHash: disputed.input_hash, support: 'rejected', attribution: 'supported',
            temporalState: 'historical', reviewer: 'test-contract' });
        const recoveryInput = recovery.snapshot(db, recoveryFragment, { disputedClaimIds: [disputed.id] });
        const recovered = recovery.commit(db, { fragmentId: recoveryFragment,
            inputHash: recoveryInput.input_hash, disputedClaimIds: [disputed.id], outcome: 'recovered',
            reviewer: 'test-contract', claims: [{
                body: 'Nova Satchel had its zipper replaced last winter.', subject: 'user',
                domain: 'user_statement', temporal: { state: 'historical' },
                evidence: [{ message_id: recoveryMessage, quote: 'its zipper was replaced last winter' }],
            }] });
        assert.deepEqual(recovered.preserved_claim_ids, [stableSibling.id]);
        assert.equal(protocol.readClaim(db, stableSibling.id).claim_status, 'active');
        assert.equal(protocol.readClaim(db, disputed.id).claim_status, 'superseded');

        // One unambiguous named object carries its complete stable attribute group into Node Review.
        const entityId = Number(db.prepare(`INSERT INTO entity_profiles(name,category,status,aliases,memory_scope)
            VALUES('Nova Satchel','object','active','[]','default')`).run().lastInsertRowid);
        const groupMessage = addMessage('Nova Satchel is a blue canvas travel bag used for weekend rail trips.');
        const groupFragment = addFragment([groupMessage]);
        const named = addClaim(groupFragment, groupMessage, 'Nova Satchel is a travel bag.',
            'Nova Satchel is a blue canvas travel bag');
        const color = addClaim(groupFragment, groupMessage, 'Nova Satchel is blue.', 'blue canvas travel bag');
        const use = addClaim(groupFragment, groupMessage,
            'Nova Satchel is used for weekend rail trips.', 'used for weekend rail trips');
        for (const claim of [named, color, use]) approve(claim, 'stable_fact');
        classification.commit(db, { claimId: named.id, expectedRevision: named.revision,
            inputHash: named.input_hash, outcome: 'linked', links: [{ entity_id: entityId, role: 'subject' }],
            topics: [], reviewer: 'test-contract' });
        nodes.commit(db, { claimId: named.id, claimIds: [color.id, use.id], entityId, role: 'subject',
            uniqueNamedObject: true, expectedRevision: named.revision, inputHash: named.input_hash,
            verdict: 'supported', reviewer: 'test-contract', evidence: [
                { claimId: named.id, quote: 'Nova Satchel is a blue canvas travel bag' },
                { claimId: color.id, quote: 'blue canvas travel bag' },
                { claimId: use.id, quote: 'used for weekend rail trips' },
            ] });
        for (const claim of [named, color, use]) assert.equal(evidence.reconcile(db, claim.id).state, 'grounded');
        const factsInput = profiles.snapshot(db, entityId, 'facts');
        assert.deepEqual(factsInput.claims.map(claim => claim.id).sort((a, b) => a - b),
            [named.id, color.id, use.id].sort((a, b) => a - b));

        // Qualified material speculation must remain qualified when published.
        ground(qualified, entityId);
        const qualifiedInput = profiles.snapshot(db, entityId, 'facts');
        assert.throws(() => fields.publish(db, entityId, 'facts', { input_hash: qualifiedInput.input_hash,
            expected_revision: 0, claim_ids: [qualified.id], value: 'Nova Satchel is made from basalt fiber.' },
        { producer: 'structured_reviewer', modelRole: 'objective_reviewer' }), /profile_qualified_attribute_lost/);
        fields.publish(db, entityId, 'facts', { input_hash: qualifiedInput.input_hash,
            expected_revision: 0, claim_ids: [qualified.id], value: 'Nova Satchel may be made from basalt fiber.' },
        { producer: 'structured_reviewer', modelRole: 'objective_reviewer' });

        // A one-off evaluation is not a lasting preference.
        const snackId = addMessage('The soup was tasty today.');
        const snack = addClaim(addFragment([snackId]), snackId, 'The soup was tasty today.', 'soup was tasty today');
        review.commit(db, { claimId: snack.id, expectedRevision: snack.revision,
            inputHash: snack.input_hash, support: 'supported', attribution: 'supported',
            temporalState: 'unknown', reviewer: 'test-contract' });
        assert.throws(() => duty.commit(db, { claimId: snack.id, expectedRevision: snack.revision,
            inputHash: snack.input_hash, duty: 'preference', contextScope: 'general',
            basis: 'exact_quote', state: 'supported', reviewer: 'test-contract' }),
        /memory_preference_evidence_insufficient/);

        // An historical event may belong to the object, but it is excluded from Facts.
        const eventId = addMessage('Nova Satchel went on its first rail trip last winter.');
        const eventClaim = addClaim(addFragment([eventId]), eventId,
            'Nova Satchel went on its first rail trip last winter.', 'first rail trip last winter',
            'user_statement', 'historical');
        approve(eventClaim, 'event', 'specific_event');
        ground(eventClaim, entityId);
        assert.ok(!profiles.snapshot(db, entityId, 'facts').claims.some(claim => claim.id === eventClaim.id));

        // Independent A/B disagreement stays unpublished.
        const disagreementId = addMessage('Avery may attend the workshop.');
        const disagreement = addClaim(addFragment([disagreementId]), disagreementId,
            'Avery may attend the workshop.', 'may attend the workshop');
        const passA = review.submitPass(db, { claimId: disagreement.id,
            expectedRevision: disagreement.revision, inputHash: disagreement.input_hash, pass: 'a',
            support: 'supported', attribution: 'supported', temporalState: 'planned', reviewer: 'reviewer-a' });
        const passB = review.submitPass(db, { claimId: disagreement.id,
            expectedRevision: disagreement.revision, inputHash: disagreement.input_hash, pass: 'b',
            support: 'pending', attribution: 'supported', temporalState: 'planned', reviewer: 'reviewer-b' });
        assert.equal(passA.outcome, 'awaiting_peer');
        assert.equal(passB.outcome, 'needs_review');
        assert.equal(protocol.eligible(db, disagreement.id), false);

        console.log(JSON.stringify({ ok: true, schema: 124,
            recovery_preserved: recovered.preserved_claim_ids.length,
            object_group_claims: factsInput.claims.length, independent_review: passB.outcome }));
    } finally {
        db.close();
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
