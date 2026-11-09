'use strict';

const protocol = require('./memoryProtocol');

const CONTRACT_VERSION = 'claim-recovery-v2';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_claim_recoveries (
    fragment_id INTEGER PRIMARY KEY REFERENCES memory_fragments(id) ON DELETE CASCADE,
    input_hash TEXT NOT NULL,
    replacement_claim_ids_json TEXT NOT NULL CHECK(json_valid(replacement_claim_ids_json)),
    preserved_claim_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(preserved_claim_ids_json)),
    disputed_claim_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(disputed_claim_ids_json)),
    contract_version TEXT NOT NULL DEFAULT 'claim-recovery-v2',
    outcome TEXT NOT NULL CHECK(outcome IN('recovered','needs_context')),
    reviewer TEXT NOT NULL,
    recovered_at INTEGER NOT NULL
);
`;

function uniqueIds(values) {
    return [...new Set((values || []).map(Number))].filter(Number.isSafeInteger).sort((a, b) => a - b);
}

function evidenceKey(domain, sources) {
    return protocol.hash({ domain, sources: sources.map(source => ({
        message_id: Number(source.message_id), quote: String(source.quote), speaker: source.speaker,
    })).sort((a, b) => a.message_id - b.message_id || a.quote.localeCompare(b.quote)) });
}

function snapshot(db, fragmentId, options = {}) {
    const fragment = db.prepare(`SELECT id,status,source_msg_ids,observation_json,content_hash
        FROM memory_fragments WHERE id=?`).get(fragmentId);
    if (!fragment) protocol.fail('claim_recovery_fragment_missing');
    let sourceIds = [];
    try { sourceIds = JSON.parse(fragment.source_msg_ids || '[]').map(Number); } catch (_) {}
    if (!sourceIds.length) protocol.fail('claim_recovery_sources_required');
    const marks = sourceIds.map(() => '?').join(',');
    const messages = db.prepare(`SELECT id,chat_id,sender,content,is_encrypted,timestamp,status
        FROM messages WHERE id IN(${marks}) ORDER BY id`).all(...sourceIds).map(row => ({
        id: row.id, speaker: protocol.normalizeSpeaker(row.sender), text: protocol.messageText(row),
        timestamp: row.timestamp, fingerprint: protocol.messageFingerprint(row),
    }));
    if (messages.length !== sourceIds.length) protocol.fail('claim_recovery_source_missing');
    const claims = db.prepare(`SELECT id,revision,input_hash,claim_status,manual_locked,support_state,attribution_state
        FROM memory_claims WHERE fragment_id=? ORDER BY id`).all(fragmentId).map(row => {
        const claim = protocol.readClaim(db, row.id);
        return { ...row, body: claim.body, domain: claim.domain, subject_kind: claim.subject_kind,
            temporal_state: claim.temporal_state, sources: claim.sources };
    });
    const requested = uniqueIds(options.disputedClaimIds);
    const disputed = requested.length ? requested : claims.filter(claim => claim.claim_status === 'active'
        && (claim.support_state !== 'supported' || claim.attribution_state !== 'supported'))
        .map(claim => claim.id);
    if (disputed.some(id => !claims.some(claim => claim.id === id && claim.claim_status === 'active')))
        protocol.fail('claim_recovery_disputed_claim_invalid');
    const preserved = claims.filter(claim => claim.claim_status === 'active' && !disputed.includes(claim.id))
        .map(claim => claim.id);
    const inputHash = protocol.hash({ contract: CONTRACT_VERSION, fragment: {
        id: fragment.id, status: fragment.status, content_hash: fragment.content_hash,
        observation_json: fragment.observation_json,
    }, messages, claims: claims.map(claim => ({ id: claim.id, revision: claim.revision,
        input_hash: claim.input_hash, claim_status: claim.claim_status, manual_locked: claim.manual_locked,
        support_state: claim.support_state, attribution_state: claim.attribution_state })), disputed, preserved });
    return { contract_version: CONTRACT_VERSION, fragment_id: fragment.id, input_hash: inputHash,
        messages, current_claims: claims, disputed_claim_ids: disputed, preserved_claim_ids: preserved,
        rules: [
            'Only disputed_claim_ids may be replaced; verified sibling claims must remain active.',
            'Resolve pronouns from an object anchor established before the descriptive statement.',
            'A question can establish the current object anchor but cannot prove its proposition.',
            'Recover independently verifiable atomic claims, not a paragraph summary.',
        ] };
}

function activeEvidenceMatches(db, fragmentId, domain, sources, excludedIds) {
    const key = evidenceKey(domain, sources);
    return db.prepare(`SELECT id FROM memory_claims WHERE fragment_id=? AND claim_status='active' ORDER BY manual_locked DESC,id`)
        .all(fragmentId).map(row => protocol.readClaim(db, row.id))
        .find(claim => !excludedIds.has(claim.id) && claim.domain === domain
            && evidenceKey(claim.domain, claim.sources) === key);
}

function persistReceipt(db, input, outcome, created, reviewer) {
    db.prepare(`INSERT INTO memory_claim_recoveries(
        fragment_id,input_hash,replacement_claim_ids_json,preserved_claim_ids_json,
        disputed_claim_ids_json,contract_version,outcome,reviewer,recovered_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(fragment_id) DO UPDATE SET
        input_hash=excluded.input_hash,replacement_claim_ids_json=excluded.replacement_claim_ids_json,
        preserved_claim_ids_json=excluded.preserved_claim_ids_json,
        disputed_claim_ids_json=excluded.disputed_claim_ids_json,contract_version=excluded.contract_version,
        outcome=excluded.outcome,reviewer=excluded.reviewer,recovered_at=excluded.recovered_at`).run(
        input.fragment_id, input.input_hash, JSON.stringify(created), JSON.stringify(input.preserved_claim_ids),
        JSON.stringify(input.disputed_claim_ids), CONTRACT_VERSION, outcome, reviewer, Date.now());
}

function commit(db, decision) {
    const input = snapshot(db, decision.fragmentId, { disputedClaimIds: decision.disputedClaimIds });
    if (decision.inputHash !== input.input_hash) protocol.fail('claim_recovery_cas_failed');
    if (!decision.reviewer) protocol.fail('claim_recovery_reviewer_required');
    if (!input.disputed_claim_ids.length) protocol.fail('claim_recovery_disputed_claims_required');
    if (decision.outcome === 'needs_context') {
        persistReceipt(db, input, 'needs_context', [], decision.reviewer);
        return { outcome: 'needs_context', claim_ids: [], preserved_claim_ids: input.preserved_claim_ids };
    }
    if (decision.outcome !== 'recovered' || !Array.isArray(decision.claims) || !decision.claims.length)
        protocol.fail('claim_recovery_decision_invalid');
    return db.transaction(() => {
        const created = [];
        const disputed = new Set(input.disputed_claim_ids);
        for (const draft of decision.claims) {
            const sources = (draft.evidence || []).map(item =>
                protocol.captureSource(db, Number(item.message_id), item.quote));
            if (!sources.length) protocol.fail('memory_sources_required');
            const duplicate = activeEvidenceMatches(db, input.fragment_id, draft.domain, sources, disputed);
            if (duplicate) {
                created.push(duplicate.id);
                continue;
            }
            const claim = protocol.createClaim(db, {
                fragmentId: input.fragment_id,
                claimKey: `recovery:${input.fragment_id}:${evidenceKey(draft.domain, sources)}`,
                body: draft.body, domain: draft.domain, subjectKind: draft.subject || 'unknown',
                temporal: draft.temporal || { state: 'unknown' }, sources,
                priority: Number.isFinite(Number(decision.priority))
                    ? Number(decision.priority) : protocol.BACKFILL_JOB_PRIORITY,
            });
            created.push(claim.id);
        }
        for (const id of input.disputed_claim_ids) {
            const old = input.current_claims.find(claim => claim.id === id);
            if (!old || old.claim_status !== 'active' || old.manual_locked || created.includes(old.id)) continue;
            protocol.supersedeClaim(db, old.id, { expectedRevision: old.revision,
                inputHash: old.input_hash, actor: decision.reviewer });
        }
        persistReceipt(db, input, 'recovered', uniqueIds(created), decision.reviewer);
        return { outcome: 'recovered', claim_ids: uniqueIds(created),
            preserved_claim_ids: input.preserved_claim_ids };
    })();
}

module.exports = { CONTRACT_VERSION, SCHEMA, evidenceKey, snapshot, commit };
