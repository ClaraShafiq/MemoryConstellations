'use strict';

const protocol = require('./memoryProtocol');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_correction_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id),
    message_id INTEGER NOT NULL REFERENCES messages(id),
    message_fingerprint TEXT NOT NULL,
    quote_enc TEXT NOT NULL,
    correction_enc TEXT NOT NULL,
    target_claim_id INTEGER REFERENCES memory_claims(id),
    input_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN('queued','applied','unlocated','needs_review','stale')),
    reviewer TEXT,
    replacement_claim_id INTEGER REFERENCES memory_claims(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_correction_inbox_state
    ON memory_correction_inbox(status,updated_at);
`;

function submit(db, input) {
    const source = protocol.captureSource(db, Number(input.messageId), input.quote);
    const message = db.prepare('SELECT chat_id FROM messages WHERE id=?').get(source.message_id);
    if (Number(input.chatId) !== Number(message.chat_id)) protocol.fail('correction_chat_mismatch');
    const correction = String(input.correction || '').trim();
    if (!correction) protocol.fail('correction_body_required');
    const targetClaimId = input.targetClaimId == null ? null : Number(input.targetClaimId);
    if (targetClaimId !== null && (!Number.isSafeInteger(targetClaimId) || targetClaimId <= 0))
        protocol.fail('correction_target_invalid');
    const inputHash = protocol.hash({ chat_id: Number(input.chatId), source, correction, target_claim_id: targetClaimId });
    const now = Date.now();
    db.prepare(`INSERT OR IGNORE INTO memory_correction_inbox(
        chat_id,message_id,message_fingerprint,quote_enc,correction_enc,target_claim_id,input_hash,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'queued',?,?)`).run(Number(input.chatId), source.message_id,
        source.message_fingerprint, protocol.encrypt(source.quote), protocol.encrypt(correction),
        targetClaimId, inputHash, now, now);
    const receipt = db.prepare('SELECT id,input_hash,status FROM memory_correction_inbox WHERE input_hash=?').get(inputHash);
    protocol.enqueueJob(db, { stage: 'correction_review', targetType: 'correction', targetId: receipt.id,
        inputRevision: 1, inputHash: receipt.input_hash, priority: protocol.LIVE_JOB_PRIORITY });
    return receipt;
}

function snapshot(db, receiptId) {
    const row = db.prepare('SELECT * FROM memory_correction_inbox WHERE id=?').get(receiptId);
    if (!row) protocol.fail('correction_receipt_missing');
    const source = protocol.captureSource(db, row.message_id, protocol.decrypt(row.quote_enc));
    if (source.message_fingerprint !== row.message_fingerprint) {
        db.prepare("UPDATE memory_correction_inbox SET status='stale',updated_at=? WHERE id=?").run(Date.now(), row.id);
        protocol.fail('correction_source_changed');
    }
    const target = row.target_claim_id ? protocol.readClaim(db, row.target_claim_id) : null;
    return { id: row.id, input_hash: row.input_hash, status: row.status, chat_id: row.chat_id,
        correction: protocol.decrypt(row.correction_enc), source, target };
}

function review(db, decision) {
    const input = snapshot(db, decision.receiptId);
    if (input.status !== 'queued' && input.status !== 'needs_review') protocol.fail('correction_not_reviewable');
    if (decision.inputHash !== input.input_hash || !decision.reviewer) protocol.fail('correction_cas_failed');
    if (decision.outcome === 'unlocated' || decision.outcome === 'needs_review') {
        db.prepare('UPDATE memory_correction_inbox SET status=?,reviewer=?,updated_at=? WHERE id=? AND input_hash=?')
            .run(decision.outcome, decision.reviewer, Date.now(), input.id, input.input_hash);
        return { outcome: decision.outcome, replacement_claim_id: null };
    }
    if (decision.outcome !== 'applied' || !input.target) protocol.fail('correction_target_required');
    if (Number(decision.expectedRevision) !== Number(input.target.revision)
        || decision.targetInputHash !== input.target.input_hash) protocol.fail('correction_target_cas_failed');
    return db.transaction(() => {
        const source = input.source;
        const replacement = protocol.createClaim(db, {
            fragmentId: input.target.fragment_id,
            claimKey: `correction:${input.id}:${protocol.hash(input.correction)}`,
            body: input.correction, domain: 'correction', subjectKind: input.target.subject_kind || 'unknown',
            temporal: { state: decision.temporalState || input.target.temporal_state,
                event_from: input.target.event_from, event_until: input.target.event_until,
                precision: input.target.time_precision }, sources: [source], priority: protocol.LIVE_JOB_PRIORITY,
        });
        protocol.supersedeClaim(db, input.target.id, { expectedRevision: input.target.revision,
            inputHash: input.target.input_hash, actor: decision.reviewer });
        db.prepare(`UPDATE memory_correction_inbox SET status='applied',reviewer=?,replacement_claim_id=?,updated_at=?
            WHERE id=? AND input_hash=?`).run(decision.reviewer, replacement.id, Date.now(), input.id, input.input_hash);
        return { outcome: 'applied', replacement_claim_id: replacement.id };
    })();
}

module.exports = { SCHEMA, submit, snapshot, review };
