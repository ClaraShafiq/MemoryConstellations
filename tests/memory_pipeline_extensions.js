'use strict';

const assert = require('node:assert/strict');
const { initDatabase } = require('../database');

async function main() {
    const db = initDatabase();
    const protocol = require('../services/memoryProtocol');
    const scribe = require('../services/memoryScribe');
    const claimReview = require('../services/memoryClaimReview');
    const claimDuty = require('../services/memoryClaimDuty');
    const classification = require('../services/memoryClassification');
    const nodeReview = require('../services/memoryNodeReview');
    const evidence = require('../services/memoryEvidenceResolution');
    const recovery = require('../services/memoryClaimRecovery');
    const discovery = require('../services/memoryConstellationDiscovery');
    const identity = require('../services/memoryConstellationIdentity');
    const corrections = require('../services/memoryCorrection');
    const profileProjection = require('../services/memoryProfileProjection');
    const profileFields = require('../services/memoryProfileFields');
    const search = require('../services/memorySearchProjection');
    const vectors = require('../services/memoryVectorProjection');
    const release = require('../services/memoryReleaseGate');
    const readMode = require('../services/memoryReadMode');
    const budget = require('../services/memoryModelBudget');
    const runner = require('../services/memoryMaintenanceRunner');
    const codex = require('../services/memoryCodexExecutor');
    const pipeline = require('../services/memoryPipeline');

    assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get().version, 120);
    db.prepare("INSERT INTO chats(id,name) VALUES(1,'Fictional Pipeline Test')").run();

    let minute = 0;
    function addMessage(sender, content) {
        const timestamp = `2026-11-01 10:${String(minute++).padStart(2, '0')}:00`;
        return Number(db.prepare(`INSERT INTO messages(
            chat_id,sender,content,timestamp,is_encrypted,message_type,status,picked_up_at)
            VALUES(1,?,?,?,0,'text','sent',?)`).run(sender, content, timestamp, timestamp).lastInsertRowid);
    }

    async function observe(messageId, entry) {
        const before = db.prepare('SELECT COALESCE(MAX(id),0) id FROM memory_claims').get().id;
        await scribe.runBatch(db.prepare('SELECT * FROM messages WHERE id=?').all(messageId), scribe.lastCursor(db), {
            extractEntries: async () => [{ ...entry, evidence: [{ message_id: messageId, quote: entry.quote }] }],
        });
        const row = db.prepare('SELECT id FROM memory_claims WHERE id>? ORDER BY id DESC LIMIT 1').get(before);
        return protocol.readClaim(db, row.id);
    }

    function reviewSupported(claim, duty, entityId = null) {
        claimReview.commit(db, { claimId: claim.id, expectedRevision: claim.revision, inputHash: claim.input_hash,
            support: 'supported', attribution: 'supported', temporalState: claim.temporal_state,
            reviewer: 'fixture-reviewer' });
        claimDuty.commit(db, { claimId: claim.id, expectedRevision: claim.revision, inputHash: claim.input_hash,
            duty, contextScope: 'profile', basis: 'exact_quote', state: 'supported', reviewer: 'fixture-reviewer' });
        classification.commit(db, { claimId: claim.id, expectedRevision: claim.revision, inputHash: claim.input_hash,
            outcome: entityId ? 'linked' : 'no_independent_node',
            links: entityId ? [{ entity_id: entityId, role: 'subject' }] : [], topics: [], reviewer: 'fixture-reviewer' });
        if (entityId) nodeReview.commit(db, { claimId: claim.id, entityId, role: 'subject',
            expectedRevision: claim.revision, inputHash: claim.input_hash, verdict: 'supported',
            quote: claim.sources[0].quote, reviewer: 'fixture-reviewer' });
        return evidence.reconcile(db, claim.id);
    }

    const rejectedMessage = addMessage('user', 'River mentioned mint tea and a cedar notebook.');
    const rejectedClaim = await observe(rejectedMessage, { body: 'River has several unrelated preferences.',
        subject: 'user', domain: 'user_statement', temporal_state: 'unknown', quote: 'mint tea and a cedar notebook' });
    claimReview.commit(db, { claimId: rejectedClaim.id, expectedRevision: rejectedClaim.revision,
        inputHash: rejectedClaim.input_hash, support: 'rejected', attribution: 'supported',
        temporalState: 'unknown', reviewer: 'fixture-reviewer' });
    const recoveryInput = recovery.snapshot(db, rejectedClaim.fragment_id);
    assert.equal(recoveryInput.messages[0].text, 'River mentioned mint tea and a cedar notebook.');
    assert.equal(db.prepare("SELECT input_hash FROM memory_jobs WHERE stage='claim_recovery' AND target_id=?")
        .get(rejectedClaim.fragment_id).input_hash, recoveryInput.input_hash);
    const recovered = recovery.commit(db, { fragmentId: rejectedClaim.fragment_id,
        inputHash: recoveryInput.input_hash, outcome: 'recovered', reviewer: 'fixture-reviewer', claims: [
            { body: 'River mentioned mint tea.', subject: 'user', domain: 'user_statement',
                temporal: { state: 'unknown' }, evidence: [{ message_id: rejectedMessage, quote: 'mint tea' }] },
            { body: 'River mentioned a cedar notebook.', subject: 'user', domain: 'user_statement',
                temporal: { state: 'unknown' }, evidence: [{ message_id: rejectedMessage, quote: 'cedar notebook' }] },
        ] });
    assert.equal(recovered.claim_ids.length, 2);
    assert.equal(protocol.readClaim(db, rejectedClaim.id).claim_status, 'superseded');
    assert.ok(recovered.claim_ids.every(id => !protocol.readClaim(db, id).body.includes('several unrelated')));

    const replayMessage = addMessage('ai', 'I find River’s careful note-taking endearing.');
    const cursorBeforeReplay = scribe.lastCursor(db);
    await assert.rejects(() => scribe.replayMessages([replayMessage], { extractEntries: async () => [{
        body: 'The user finds note-taking endearing.', subject: 'user', domain: 'companion_opinion',
        temporal_state: 'unknown', evidence: [{ message_id: replayMessage, quote: 'note-taking endearing' }],
    }] }), /scribe_subject_not_supported/);
    const replayed = await scribe.replayMessages([replayMessage], { extractEntries: async () => [{
        body: 'The assistant finds River’s note-taking endearing.', subject: 'assistant', domain: 'companion_opinion',
        temporal_state: 'unknown', evidence: [{ message_id: replayMessage, quote: 'note-taking endearing' }],
    }] });
    assert.equal(replayed.replay, true);
    assert.deepEqual(scribe.lastCursor(db), cursorBeforeReplay);
    const attitudeClaim = protocol.readClaim(db, db.prepare('SELECT MAX(id) id FROM memory_claims').get().id);

    const entityId = Number(db.prepare(`INSERT INTO entity_profiles(name,category,status,aliases,memory_scope)
        VALUES('River','person','active','[]','default')`).run().lastInsertRowid);
    const mintMessage = addMessage('user', 'River prefers mint tea.');
    const mintClaim = await observe(mintMessage, { body: 'River prefers mint tea.', subject: 'user',
        domain: 'user_statement', temporal_state: 'unknown', quote: 'prefers mint tea' });
    assert.equal(reviewSupported(mintClaim, 'preference', entityId).state, 'grounded');
    const notebookMessage = addMessage('user', 'River keeps a blue notebook.');
    const notebookClaim = await observe(notebookMessage, { body: 'River keeps a blue notebook.', subject: 'user',
        domain: 'user_statement', temporal_state: 'unknown', quote: 'keeps a blue notebook' });
    assert.equal(reviewSupported(notebookClaim, 'stable_fact', entityId).state, 'grounded');
    assert.ok(db.prepare("SELECT COUNT(*) count FROM memory_jobs WHERE stage='node_review' AND target_id=?")
        .get(notebookClaim.id).count >= 1);
    assert.ok(db.prepare("SELECT COUNT(*) count FROM memory_jobs WHERE stage='constellation_discovery' AND target_id=?")
        .get(notebookClaim.id).count >= 1);
    assert.equal(db.prepare("SELECT input_hash FROM memory_jobs WHERE stage='constellation_discovery' AND target_id=?")
        .get(notebookClaim.id).input_hash, evidence.current(db, notebookClaim.id).evidence_fingerprint);
    assert.equal(reviewSupported(attitudeClaim, 'opinion', entityId).state, 'grounded');

    const ambiguousMessage = addMessage('user', 'River mentioned a workshop without identifying it.');
    const ambiguousClaim = await observe(ambiguousMessage, { body: 'River mentioned an unidentified workshop.',
        subject: 'user', domain: 'user_statement', temporal_state: 'unknown', quote: 'a workshop without identifying it' });
    claimReview.commit(db, { claimId: ambiguousClaim.id, expectedRevision: ambiguousClaim.revision,
        inputHash: ambiguousClaim.input_hash, support: 'supported', attribution: 'supported',
        temporalState: 'unknown', reviewer: 'fixture-reviewer' });
    claimDuty.commit(db, { claimId: ambiguousClaim.id, expectedRevision: ambiguousClaim.revision,
        inputHash: ambiguousClaim.input_hash, duty: 'event', contextScope: 'episode', basis: 'exact_quote',
        state: 'supported', reviewer: 'fixture-reviewer' });
    classification.commit(db, { claimId: ambiguousClaim.id, expectedRevision: ambiguousClaim.revision,
        inputHash: ambiguousClaim.input_hash, outcome: 'needs_resolution', links: [], topics: [],
        reviewer: 'fixture-reviewer' });
    assert.equal(evidence.reconcile(db, ambiguousClaim.id).state, 'needs_resolution');
    assert.equal(evidence.reconcile(db, ambiguousClaim.id).state, 'deferred');
    classification.commit(db, { claimId: ambiguousClaim.id, expectedRevision: ambiguousClaim.revision,
        inputHash: ambiguousClaim.input_hash, outcome: 'topic_only', links: [], topics: ['workshop'],
        reviewer: 'fixture-reviewer' });
    assert.equal(evidence.reconcile(db, ambiguousClaim.id).state, 'topic_only');

    const identityCandidate = identity.createCandidate(db, { claimIds: [notebookClaim.id], name: 'River', category: 'person' });
    assert.throws(() => identity.resolveIdentity(db, { candidateId: identityCandidate.id, outcome: 'identity',
        name: 'User', category: 'person', aliases: [], reviewer: 'fixture-reviewer' }), /identity_invalid/);
    const discoveryInput = discovery.snapshot(db, notebookClaim.id);
    const discovered = discovery.commit(db, { claimId: notebookClaim.id, expectedRevision: discoveryInput.revision,
        inputHash: discoveryInput.evidence_fingerprint, name: 'River', category: 'person',
        basis: 'lasting_identity', outcome: 'candidate', reviewer: 'fixture-reviewer' });
    assert.ok(discovered.identity_candidate_id);
    assert.throws(() => discovery.commit(db, { claimId: notebookClaim.id, expectedRevision: discoveryInput.revision,
        inputHash: discoveryInput.evidence_fingerprint, name: 'River', category: 'person',
        basis: 'unsupported_kind', outcome: 'candidate', reviewer: 'fixture-reviewer' }),
    /constellation_discovery_type_invalid/);
    const coreEntity = Number(db.prepare(`INSERT INTO entity_profiles(name,category,status,aliases,memory_scope)
        VALUES('User','person','active','[]','default')`).run().lastInsertRowid);
    assert.throws(() => profileProjection.snapshot(db, coreEntity), /profile_core_identity_managed_separately/);

    let profileInput = profileProjection.snapshot(db, entityId);
    const firstFacts = profileFields.publish(db, entityId, 'facts', { input_hash: profileInput.input_hash,
        expected_revision: 0, operations: [
            { action: 'add', text: 'Prefers mint tea.', claim_ids: [mintClaim.id] },
            { action: 'add', text: 'Keeps a blue notebook.', claim_ids: [notebookClaim.id] },
        ] }, { producer: 'structured_reviewer', modelRole: 'objective_reviewer' });
    assert.equal(firstFacts.items.length, 2);

    const correctionMessage = addMessage('user', 'Correction: River prefers cedar tea.');
    const receipt = corrections.submit(db, { chatId: 1, messageId: correctionMessage,
        quote: 'prefers cedar tea', correction: 'River prefers cedar tea.', targetClaimId: mintClaim.id });
    assert.equal(receipt.status, 'queued');
    assert.ok(db.prepare("SELECT COUNT(*) count FROM memory_jobs WHERE stage='correction_review' AND target_id=?")
        .get(receipt.id).count >= 1);
    assert.equal(profileFields.readField(db, entityId, 'facts').revision, 1);
    const correctionInput = corrections.snapshot(db, receipt.id);
    const applied = corrections.review(db, { receiptId: receipt.id, inputHash: correctionInput.input_hash,
        outcome: 'applied', expectedRevision: mintClaim.revision, targetInputHash: mintClaim.input_hash,
        temporalState: 'unknown', reviewer: 'fixture-reviewer' });
    const correctedClaim = protocol.readClaim(db, applied.replacement_claim_id);
    assert.equal(reviewSupported(correctedClaim, 'preference', entityId).state, 'grounded');
    const correctionReviewJob = db.prepare("SELECT * FROM memory_jobs WHERE stage='claim_review' AND target_id=?")
        .get(correctedClaim.id);
    const agentPacket = codex.snapshotForJob(db, correctionReviewJob);
    assert.equal(agentPacket.input.claim_id, correctedClaim.id);
    assert.equal(agentPacket.input.sources[0].quote, 'prefers cedar tea');
    assert.equal('body_enc' in agentPacket.input, false);
    profileInput = profileProjection.snapshot(db, entityId);
    const mintItem = firstFacts.items.find(item => item.text.includes('mint'));
    const revisedFacts = profileFields.publish(db, entityId, 'facts', { input_hash: profileInput.input_hash,
        expected_revision: 1, operations: [{ action: 'revise', target_id: mintItem.id,
            text: 'Prefers cedar tea.', claim_ids: [correctedClaim.id] }] },
    { producer: 'structured_reviewer', modelRole: 'objective_reviewer' });
    assert.deepEqual(revisedFacts.items.map(item => item.text).sort(), ['Keeps a blue notebook.', 'Prefers cedar tea.']);

    profileInput = profileProjection.snapshot(db, entityId);
    let judgment = profileFields.publish(db, entityId, 'judgment', { input_hash: profileInput.input_hash,
        expected_revision: 0, operations: [{ action: 'add', text: 'I find the careful note-taking endearing.',
            claim_ids: [attitudeClaim.id] }] },
    { producer: 'persona_writer', modelRole: 'companion_persona', personaHash: 'a'.repeat(64) });
    const facetId = judgment.items[0].id;
    const seedId = profileFields.recordJudgmentSeed(db, entityId, {
        text: 'The companion consistently values careful observations.', reviewer: 'fixture-reviewer' });
    judgment = profileFields.publish(db, entityId, 'judgment', { input_hash: profileInput.input_hash,
        expected_revision: 1, operations: [{ action: 'reinforce', target_id: facetId, seed_ids: [seedId] }] },
    { producer: 'persona_writer', modelRole: 'companion_persona', personaHash: 'a'.repeat(64) });
    assert.deepEqual(judgment.items[0].seed_ids, [seedId]);
    judgment = profileFields.publish(db, entityId, 'judgment', { input_hash: profileInput.input_hash,
        expected_revision: 2, operations: [{ action: 'revise', target_id: facetId,
            text: 'I value River’s attentive way of recording details.', claim_ids: [attitudeClaim.id] }] },
    { producer: 'persona_writer', modelRole: 'companion_persona', personaHash: 'a'.repeat(64) });
    assert.match(judgment.value, /attentive/);
    judgment = profileFields.publish(db, entityId, 'judgment', { input_hash: profileInput.input_hash,
        expected_revision: 3, operations: [{ action: 'withdraw', target_id: facetId, seed_ids: [seedId] }] },
    { producer: 'persona_writer', modelRole: 'companion_persona', personaHash: 'a'.repeat(64) });
    assert.equal(judgment.value, '');

    db.prepare(`INSERT INTO user_settings(setting_key,setting_value) VALUES('memory_semantic_maintenance_mode','running')
        ON CONFLICT(setting_key) DO UPDATE SET setting_value='running'`).run();
    await pipeline.tick(db);
    assert.ok(db.prepare("SELECT COUNT(*) count FROM memory_jobs WHERE stage='episode_publish'").get().count >= 1);

    assert.equal(search.refreshProfile(db, entityId), 1);
    const remote = new Map();
    const transport = async (operation, payload) => {
        if (operation === 'upsert') remote.set(payload.id, payload.metadata);
        if (operation === 'delete') remote.delete(payload.id);
        if (operation === 'get_batch') return { items: payload.ids.filter(id => remote.has(id))
            .map(id => ({ id, metadata: remote.get(id) })) };
        if (operation === 'list_ids') return { ids: [...remote.keys()].slice(payload.offset, payload.offset + payload.limit),
            total: remote.size };
        return {};
    };
    const drained = await vectors.drain(db, { limit: 50, transport, embed: async () => [0.1, 0.2] });
    assert.ok(drained.done >= 1);
    assert.equal(vectors.manifest(db).ready, true);
    const prepared = await release.prepare(db, { transport });
    assert.equal(prepared.ready, true);
    assert.equal(readMode.get(db), 'legacy');
    release.activate(db);
    assert.equal(readMode.requested(db), 'verified');
    assert.equal(readMode.get(db), 'verified');
    const factsProjection = db.prepare("SELECT * FROM memory_search_projection WHERE projection_key=?")
        .get(`profile:${entityId}:facts`);
    search.put(db, factsProjection.projection_key, 'profile', entityId, 'facts', factsProjection.revision + 1,
        protocol.hash('changed publication'), 'River: changed publication', { field: 'facts' });
    assert.equal(readMode.get(db), 'blocked');
    release.rollback(db);
    assert.equal(readMode.requested(db), 'legacy');

    const firstBudget = budget.reserve(db, 'fixture', { limit: 1, now: Date.UTC(2026, 10, 1) });
    assert.equal(firstBudget.used, 1);
    assert.throws(() => budget.reserve(db, 'fixture', { limit: 1, now: Date.UTC(2026, 10, 1) }),
    /memory_model_budget_exhausted/);

    db.prepare("UPDATE memory_jobs SET status='skipped',lease_token=NULL,lease_until=NULL WHERE stage='claim_review'").run();
    const agentMessage = addMessage('user', 'River uses a green index card.');
    const agentClaim = await observe(agentMessage, { body: 'River uses a green index card.', subject: 'user',
        domain: 'user_statement', temporal_state: 'unknown', quote: 'uses a green index card' });
    process.env.MEMORY_MAINTENANCE_DAILY_CALL_LIMIT = '1';
    const agentResults = await codex.runLeased(db, 'claim_review', { propose: async packet => {
        assert.equal(packet.input.claim_id, agentClaim.id);
        assert.equal(packet.input.sources[0].quote, 'uses a green index card');
        return { type: 'review_claim', claimId: packet.job.target_id,
            expectedRevision: packet.job.input_revision, inputHash: packet.job.input_hash,
            support: 'supported', attribution: 'supported', reviewer: 'fixture-agent' };
    } }, { limit: 1, priorityBand: 'current' });
    delete process.env.MEMORY_MAINTENANCE_DAILY_CALL_LIMIT;
    assert.equal(agentResults[0].status, 'done');
    assert.equal(protocol.readClaim(db, agentClaim.id).support_state, 'supported');

    db.prepare("UPDATE memory_jobs SET status='skipped',lease_token=NULL,lease_until=NULL").run();
    db.prepare(`INSERT INTO scribe_runs(processed_until,processed_until_id,messages_processed,fragments_written,status)
        VALUES('9999-12-31 23:59:59',999999,0,0,'done')`).run();
    const firstRun = runner.tick(db, { vectorOptions: { embed: async () => [0.1, 0.2],
        transport: async () => new Promise(resolve => setTimeout(() => resolve({}), 20)) } });
    const overlapping = await runner.tick(db);
    assert.deepEqual(overlapping, { outcome: 'skipped', reason: 'single_flight_active' });
    await firstRun;

    protocol.enqueueJob(db, { stage: 'fixture_lease', targetType: 'claim', targetId: correctedClaim.id,
        inputRevision: correctedClaim.revision, inputHash: correctedClaim.input_hash });
    const leased = protocol.leaseJobs(db, 'fixture_lease', { now: 1000, leaseMs: 10 });
    assert.equal(leased.length, 1);
    assert.equal(protocol.leaseJobs(db, 'fixture_lease', { now: 1011 }).length, 0);
    const expired = db.prepare("SELECT * FROM memory_jobs WHERE stage='fixture_lease'").get();
    assert.equal(expired.status, 'retry');
    assert.equal(expired.error_code, 'lease_expired');

    console.log(JSON.stringify({ ok: true, schema: 120, recovered_claims: recovered.claim_ids.length,
        facts_revision: revisedFacts.revision, vector_receipts: vectors.manifest(db).rows.length }));
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
