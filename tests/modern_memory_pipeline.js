'use strict';

const assert = require('node:assert/strict');
const { initDatabase } = require('../database');

async function main() {
    const db = initDatabase();
    const protocol = require('../services/memoryProtocol');
    const claimReview = require('../services/memoryClaimReview');
    const claimDuty = require('../services/memoryClaimDuty');
    const classification = require('../services/memoryClassification');
    const nodeReview = require('../services/memoryNodeReview');
    const evidence = require('../services/memoryEvidenceResolution');
    const episodeCandidates = require('../services/memoryEpisodeCandidates');
    const episodeProjection = require('../services/memoryEpisodeProjection');
    const episodeWriter = require('../services/episodeWriter');
    const identity = require('../services/memoryConstellationIdentity');
    const constellation = require('../services/memoryConstellation');
    const sagas = require('../services/memorySagaProjection');
    const profileProjection = require('../services/memoryProfileProjection');
    const profileFields = require('../services/memoryProfileFields');
    const search = require('../services/memorySearchProjection');
    const packet = require('../services/memoryChatPacket');
    const codex = require('../services/memoryCodexExecutor');
    const scribe = require('../services/memoryScribe');

    db.prepare("INSERT OR IGNORE INTO chats(id,name) VALUES(1,'Neutral Test Chat')").run();
    const msg = db.prepare(`INSERT INTO messages(chat_id,sender,content,timestamp,is_encrypted,message_type,status,picked_up_at)
        VALUES(1,'user',?,'2026-01-02 10:00:00',0,'text','sent','2026-01-02 10:00:00')`).run('River said they prefer mint tea.');
    const messageId = Number(msg.lastInsertRowid);
    const scribeResult = await scribe.runBatch(db.prepare('SELECT * FROM messages WHERE id=?').all(messageId),
        { at: '2000-01-01 00:00:00', id: 0 }, { extractEntries: async () => [{
            body: 'River prefers mint tea.', domain: 'user_statement', temporal_state: 'unknown',
            evidence: [{ message_id: messageId, quote: 'prefer mint tea' }],
        }] });
    assert.equal(scribeResult.observations_written, 1);
    const fragment = db.prepare("SELECT * FROM memory_fragments WHERE observation_state='frozen'").get();
    assert.equal(fragment.status, 'frozen');
    const claim = protocol.readClaim(db, db.prepare('SELECT id FROM memory_claims').get().id);
    assert.equal(claim.sources[0].quote, 'prefer mint tea');

    claimReview.commit(db, { claimId: claim.id, expectedRevision: claim.revision, inputHash: claim.input_hash,
        support: 'supported', attribution: 'supported', temporalState: 'unknown', reviewer: 'test-reviewer' });
    claimDuty.commit(db, { claimId: claim.id, expectedRevision: claim.revision, inputHash: claim.input_hash,
        duty: 'preference', contextScope: 'profile', basis: 'exact_quote', state: 'supported', reviewer: 'test-reviewer' });
    const entityId = Number(db.prepare(`INSERT INTO entity_profiles(name,category,status,aliases,memory_scope)
        VALUES('River','person','active','[]','default')`).run().lastInsertRowid);
    classification.commit(db, { claimId: claim.id, expectedRevision: claim.revision, inputHash: claim.input_hash,
        outcome: 'linked', links: [{ entity_id: entityId, role: 'subject' }], topics: ['beverage'], reviewer: 'test-reviewer' });
    nodeReview.commit(db, { claimId: claim.id, entityId, role: 'subject', expectedRevision: claim.revision,
        inputHash: claim.input_hash, verdict: 'supported', quote: 'prefer mint tea', reviewer: 'test-reviewer' });
    assert.equal(evidence.reconcile(db, claim.id).state, 'grounded');

    const identityCandidate = identity.createCandidate(db, { claimIds: [claim.id], name: 'Mint Tea', category: 'term' });
    const identityResult = identity.resolveIdentity(db, { candidateId: identityCandidate.id, outcome: 'identity',
        name: 'Mint Tea', category: 'term', aliases: [{ value: 'mint tea', claim_id: claim.id, message_id: messageId }],
        reviewer: 'test-reviewer' });
    assert.ok(identityResult.entity_id);
    assert.equal(constellation.admit(db, { candidateId: identityCandidate.id, outcome: 'admitted',
        basis: 'ongoing_theme', reviewer: 'test-reviewer' }).outcome, 'admitted');

    const candidate = episodeCandidates.create(db, [claim.id]);
    const episodeInput = episodeProjection.snapshot(db, candidate.id);
    const publication = episodeWriter.publish(db, candidate.id, { input_hash: episodeInput.input_hash,
        title: 'A beverage preference', content: 'River directly stated a preference for mint tea.',
        claim_ids: [claim.id], tags: ['preference'] }, { producer: 'structured_reviewer', reviewer: 'test-reviewer' });
    assert.equal(publication.revision, 1);
    const sagaHash = sagas.inputHash(db, [publication.memory_id]);
    assert.equal(sagas.publish(db, { sagaKey: 'neutral-preference', episodeIds: [publication.memory_id],
        inputHash: sagaHash, title: 'Preference notes', description: 'A bounded series of verified preferences.',
        producer: 'structured_reviewer' }).revision, 1);

    const profileInput = profileProjection.snapshot(db, entityId);
    profileFields.publish(db, entityId, 'facts', { input_hash: profileInput.input_hash, expected_revision: 0,
        claim_ids: [claim.id], value: 'Prefers mint tea.' },
    { producer: 'structured_reviewer', modelRole: 'objective_reviewer' });
    profileFields.publish(db, entityId, 'status', { input_hash: profileInput.input_hash, expected_revision: 0,
        claim_ids: [claim.id], value: 'No temporary status is established.' },
    { producer: 'structured_reviewer', modelRole: 'objective_reviewer' });
    assert.throws(() => profileFields.publish(db, entityId, 'judgment', {
        input_hash: profileInput.input_hash, expected_revision: 0, claim_ids: [claim.id], value: 'I cherish this.' },
    { producer: 'structured_reviewer', modelRole: 'objective_reviewer' }), /judgment_persona_writer_required/);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM memory_profile_field_publications WHERE field='judgment'").get().count, 0);
    profileFields.publish(db, entityId, 'judgment', { input_hash: profileInput.input_hash,
        expected_revision: 0, claim_ids: [], value: '' }, { producer: 'judgment_gate', modelRole: 'evidence_gate' });
    assert.equal(db.prepare("SELECT judgment FROM entity_profiles WHERE id=?").get(entityId).judgment, null);
    profileFields.publish(db, entityId, 'judgment', { input_hash: profileInput.input_hash,
        expected_revision: 1, claim_ids: [claim.id], value: 'I remember this preference as a small, clear detail.' },
    { producer: 'persona_writer', modelRole: 'companion_persona', personaHash: 'b'.repeat(64) });
    const preserved = db.prepare('SELECT judgment FROM entity_profiles WHERE id=?').get(entityId).judgment;
    assert.throws(() => profileFields.publish(db, entityId, 'judgment', { input_hash: profileInput.input_hash,
        expected_revision: 2, claim_ids: [claim.id], value: 'This invalid writer must not replace the old value.' },
    { producer: 'structured_reviewer', modelRole: 'objective_reviewer' }), /judgment_persona_writer_required/);
    assert.equal(db.prepare('SELECT judgment FROM entity_profiles WHERE id=?').get(entityId).judgment, preserved);
    assert.throws(() => codex.apply(db, { type: 'publish_profile_field', entityId, field: 'judgment',
        draft: { input_hash: profileInput.input_hash, expected_revision: 2, claim_ids: [claim.id], value: 'I remember.' },
        producer: 'persona_writer', modelRole: 'companion_persona', personaHash: 'a'.repeat(64) }), /codex_judgment_forbidden/);

    assert.equal(search.refreshClaim(db, claim.id), true);
    assert.equal(search.refreshEpisode(db, publication.memory_id), true);
    assert.equal(search.refreshProfile(db, entityId), 3);
    const found = search.search(db, 'mint tea', 8);
    assert.ok(found.length >= 2);
    assert.ok(packet.build(found).units.length >= 2);

    const leased = protocol.leaseJobs(db, 'claim_review', { limit: 1, now: Date.now() });
    if (leased.length) {
        assert.throws(() => protocol.finishJob(db, { ...leased[0], lease_token: 'wrong' }, 'done'), /memory_job_lease_lost/);
    }
    assert.throws(() => classification.commit(db, { claimId: claim.id, expectedRevision: 99,
        inputHash: claim.input_hash, outcome: 'no_independent_node', reviewer: 'test-reviewer' }), /classification_cas_failed/);

    console.log(JSON.stringify({ ok: true, schema: 112, claim_id: claim.id, entity_id: entityId,
        episode_id: publication.memory_id, search_results: found.length }));
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
