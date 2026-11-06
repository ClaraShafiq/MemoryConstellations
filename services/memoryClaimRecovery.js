'use strict';

const protocol = require('./memoryProtocol');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_claim_recoveries (
    fragment_id INTEGER PRIMARY KEY REFERENCES memory_fragments(id) ON DELETE CASCADE,
    input_hash TEXT NOT NULL,
    replacement_claim_ids_json TEXT NOT NULL CHECK(json_valid(replacement_claim_ids_json)),
    outcome TEXT NOT NULL CHECK(outcome IN('recovered','needs_context')),
    reviewer TEXT NOT NULL,
    recovered_at INTEGER NOT NULL
);
`;

function snapshot(db, fragmentId) {
    const fragment = db.prepare(`SELECT id,status,source_msg_ids,observation_json,content_hash
        FROM memory_fragments WHERE id=?`).get(fragmentId);
    if (!fragment) protocol.fail('claim_recovery_fragment_missing');
    let sourceIds = [];
    try { sourceIds = JSON.parse(fragment.source_msg_ids || '[]').map(Number); } catch (_) {}
    if (!sourceIds.length) protocol.fail('claim_recovery_sources_required');
    const marks = sourceIds.map(() => '?').join(',');
    const messages = db.prepare(`SELECT id,chat_id,sender,content,is_encrypted,timestamp,status
        FROM messages WHERE id IN(${marks}) ORDER BY id`).all(...sourceIds).map(row => ({
        id: row.id, speaker: protocol.normalizeSpeaker ? protocol.normalizeSpeaker(row.sender) : row.sender === 'user' ? 'user' : 'assistant',
        text: protocol.messageText(row), timestamp: row.timestamp, fingerprint: protocol.messageFingerprint(row),
    }));
    if (messages.length !== sourceIds.length) protocol.fail('claim_recovery_source_missing');
    const claims = db.prepare(`SELECT id,revision,input_hash,claim_status,manual_locked FROM memory_claims
        WHERE fragment_id=? ORDER BY id`).all(fragmentId);
    const inputHash = protocol.hash({ fragment: { id: fragment.id, status: fragment.status,
        content_hash: fragment.content_hash, observation_json: fragment.observation_json }, messages, claims });
    return { fragment_id: fragment.id, input_hash: inputHash, messages, claims };
}

function commit(db, decision) {
    const input = snapshot(db, decision.fragmentId);
    if (decision.inputHash !== input.input_hash) protocol.fail('claim_recovery_cas_failed');
    if (!decision.reviewer) protocol.fail('claim_recovery_reviewer_required');
    if (decision.outcome === 'needs_context') {
        db.prepare(`INSERT INTO memory_claim_recoveries(fragment_id,input_hash,replacement_claim_ids_json,outcome,reviewer,recovered_at)
            VALUES(?,?,'[]','needs_context',?,?) ON CONFLICT(fragment_id) DO UPDATE SET
            input_hash=excluded.input_hash,replacement_claim_ids_json='[]',outcome=excluded.outcome,
            reviewer=excluded.reviewer,recovered_at=excluded.recovered_at`)
            .run(input.fragment_id, input.input_hash, decision.reviewer, Date.now());
        return { outcome: 'needs_context', claim_ids: [] };
    }
    if (decision.outcome !== 'recovered' || !Array.isArray(decision.claims) || !decision.claims.length)
        protocol.fail('claim_recovery_decision_invalid');
    return db.transaction(() => {
        const created = [];
        for (const draft of decision.claims) {
            const sources = (draft.evidence || []).map(item => protocol.captureSource(db, Number(item.message_id), item.quote));
            const claim = protocol.createClaim(db, {
                fragmentId: input.fragment_id,
                claimKey: `recovery:${input.fragment_id}:${protocol.hash({ body: draft.body, sources })}`,
                body: draft.body, domain: draft.domain, subjectKind: draft.subject || 'unknown',
                temporal: draft.temporal || { state: 'unknown' }, sources,
                priority: Number.isFinite(Number(decision.priority)) ? Number(decision.priority) : protocol.BACKFILL_JOB_PRIORITY,
            });
            created.push(claim.id);
        }
        for (const old of input.claims) {
            if (old.claim_status !== 'active' || old.manual_locked || created.includes(old.id)) continue;
            protocol.supersedeClaim(db, old.id, { expectedRevision: old.revision, inputHash: old.input_hash,
                actor: decision.reviewer });
        }
        db.prepare(`INSERT INTO memory_claim_recoveries(fragment_id,input_hash,replacement_claim_ids_json,outcome,reviewer,recovered_at)
            VALUES(?,?,?,'recovered',?,?) ON CONFLICT(fragment_id) DO UPDATE SET input_hash=excluded.input_hash,
            replacement_claim_ids_json=excluded.replacement_claim_ids_json,outcome=excluded.outcome,
            reviewer=excluded.reviewer,recovered_at=excluded.recovered_at`)
            .run(input.fragment_id, input.input_hash, JSON.stringify(created), decision.reviewer, Date.now());
        return { outcome: 'recovered', claim_ids: created };
    })();
}

module.exports = { SCHEMA, snapshot, commit };
