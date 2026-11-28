'use strict';

// Fragment is the authoritative observation. Legacy Claim ids survive only as
// evidence anchors so existing Episode/Profile publications remain readable.
const FRAGMENT_EVIDENCE_OFFSET = 1_000_000_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_fragment_evidence_refs (
    evidence_id INTEGER PRIMARY KEY,
    fragment_id INTEGER NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    subject_entity_id INTEGER,
    temporal_state TEXT NOT NULL DEFAULT 'unknown',
    event_from TEXT,
    event_until TEXT,
    time_precision TEXT NOT NULL DEFAULT 'unknown',
    input_hash TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    reviewer TEXT,
    subject_kind TEXT NOT NULL DEFAULT 'unknown',
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
    body_enc TEXT,
    duty TEXT,
    context_scope TEXT,
    basis TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_memory_fragment_evidence_refs_fragment
    ON memory_fragment_evidence_refs(fragment_id,active,evidence_id);
CREATE TABLE IF NOT EXISTS memory_fragment_evidence_sources (
    evidence_id INTEGER NOT NULL REFERENCES memory_fragment_evidence_refs(evidence_id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    message_fingerprint TEXT NOT NULL,
    quote_enc TEXT NOT NULL,
    speaker TEXT NOT NULL CHECK(speaker IN('user','assistant')),
    source_time TEXT,
    PRIMARY KEY(evidence_id,message_id)
);
`;

function hasTable(db, name) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function syntheticId(fragmentId) {
    const id = Number(fragmentId);
    return Number.isSafeInteger(id) && id > 0 ? FRAGMENT_EVIDENCE_OFFSET + id : null;
}

function fragmentIdFromSynthetic(evidenceId) {
    const id = Number(evidenceId);
    return Number.isSafeInteger(id) && id > FRAGMENT_EVIDENCE_OFFSET
        ? id - FRAGMENT_EVIDENCE_OFFSET : null;
}

function parseObservation(fragment) {
    try { return JSON.parse(fragment.observation_json || '{}'); } catch (_) { return {}; }
}

function dutyFor(observation) {
    const domain = observation.domain || 'user_statement';
    const temporal = observation.temporal?.state || 'unknown';
    const type = observation.memory_type || observation.type || null;
    if (domain === 'companion_opinion') return { duty: 'opinion', context_scope: 'general', basis: 'scoped_expression' };
    if (domain === 'fiction') return { duty: 'fiction', context_scope: 'reference_material', basis: 'scoped_expression' };
    if (domain === 'third_party') return { duty: 'third_party', context_scope: 'general', basis: 'scoped_expression' };
    if (domain === 'inference') return { duty: 'unresolved', context_scope: 'unknown', basis: 'none' };
    const typed = {
        fact: ['stable_fact', 'general'],
        preference: ['preference', 'general'],
        event: ['event', 'specific_event'],
        intention: ['current_state', 'specific_event'],
        state: ['current_state', 'specific_event'],
        observation: ['current_state', 'specific_event'],
        reflection: ['unresolved', 'unknown'],
    }[type];
    if (domain === 'interaction') return { duty: typed?.[0] || 'event', context_scope: 'with_draco', basis: 'scoped_expression' };
    if (typed) return { duty: typed[0], context_scope: typed[1],
        basis: typed[0] === 'unresolved' ? 'none' : 'scoped_expression' };
    if (['planned', 'in_progress'].includes(temporal))
        return { duty: 'current_state', context_scope: 'specific_event', basis: 'scoped_expression' };
    if (domain === 'observed_activity' || ['completed', 'cancelled', 'historical'].includes(temporal))
        return { duty: 'event', context_scope: 'specific_event', basis: 'scoped_expression' };
    return { duty: 'stable_fact', context_scope: 'general', basis: 'scoped_expression' };
}

function directSources(db, fragment) {
    const protocol = require('./memoryProtocol');
    const observation = parseObservation(fragment);
    const sources = [];
    for (const item of observation.evidence || []) {
        const messageId = Number(item?.message_id);
        if (!Number.isSafeInteger(messageId) || messageId <= 0 || !item?.quote) continue;
        const row = db.prepare('SELECT id,chat_id,sender,content,is_encrypted,timestamp,status FROM messages WHERE id=?').get(messageId);
        if (!row) continue;
        sources.push({
            message_id: messageId,
            message_fingerprint: item.message_fingerprint || protocol.messageFingerprint(row),
            quote: String(item.quote),
            speaker: item.speaker || protocol.normalizeSpeaker(row.sender),
            source_time: item.source_time || row.timestamp,
        });
    }
    return sources;
}

function direct(db, fragmentId) {
    const protocol = require('./memoryProtocol');
    if (hasTable(db, 'memory_fragment_evidence_refs')
        && db.prepare('SELECT 1 FROM memory_fragment_evidence_refs WHERE fragment_id=? LIMIT 1').get(fragmentId)) return null;
    const fragment = db.prepare(`SELECT id,content,status,source_date,observation_json,observation_state
        FROM memory_fragments WHERE id=?`).get(fragmentId);
    if (!fragment || fragment.status !== 'active' || fragment.observation_state !== 'quoted') return null;
    const observation = parseObservation(fragment);
    const sources = directSources(db, fragment);
    if (!sources.length) return null;
    const duty = dutyFor(observation);
    const temporal = observation.temporal || {};
    const inputHash = protocol.hash({
        fragment_id: fragment.id,
        body: String(fragment.content || ''),
        domain: observation.domain || 'user_statement',
        subject_kind: observation.subject || 'unknown',
        temporal,
        sources: sources.map(source => ({
            message_id: source.message_id,
            message_fingerprint: source.message_fingerprint,
            quote: source.quote,
            speaker: source.speaker,
            source_time: source.source_time,
        })),
    });
    return {
        id: syntheticId(fragment.id), fragment_id: fragment.id, scope: 'default',
        body: String(fragment.content || ''), domain: observation.domain || 'user_statement',
        subject_entity_id: null, temporal_state: temporal.state || 'unknown',
        event_from: temporal.event_from || null, event_until: temporal.event_until || null,
        time_precision: temporal.precision || 'unknown', input_hash: inputHash, revision: 1,
        reviewer: 'pipeline:fragment_direct', subject_kind: observation.subject || 'unknown',
        claim_status: 'active', source_state: 'supported', support_state: 'supported',
        attribution_state: 'supported', manual_locked: 0, synthetic: true,
        sources, ...duty, duty_state: duty.duty === 'unresolved' ? 'pending' : 'supported',
    };
}

function legacy(db, evidenceId) {
    if (!hasTable(db, 'memory_fragment_evidence_refs')) return null;
    const row = db.prepare('SELECT * FROM memory_fragment_evidence_refs WHERE evidence_id=?').get(evidenceId);
    if (!row) return null;
    const fragment = db.prepare('SELECT content,status FROM memory_fragments WHERE id=?').get(row.fragment_id);
    if (!fragment) return null;
    const protocol = require('./memoryProtocol');
    const sources = db.prepare(`SELECT * FROM memory_fragment_evidence_sources
        WHERE evidence_id=? ORDER BY message_id`).all(evidenceId).map(source => ({
        message_id: source.message_id,
        message_fingerprint: source.message_fingerprint,
        quote: protocol.decrypt(source.quote_enc),
        speaker: source.speaker,
        source_time: source.source_time,
    }));
    return {
        id: row.evidence_id, fragment_id: row.fragment_id, scope: 'default',
        body: row.body_enc ? protocol.decrypt(row.body_enc) : String(fragment.content || ''),
        domain: row.domain, subject_entity_id: row.subject_entity_id,
        temporal_state: row.temporal_state, event_from: row.event_from, event_until: row.event_until,
        time_precision: row.time_precision, input_hash: row.input_hash, revision: row.revision,
        reviewer: row.reviewer, subject_kind: row.subject_kind,
        claim_status: row.active && fragment.status === 'active' ? 'active' : 'superseded',
        source_state: row.active ? 'supported' : 'stale', support_state: row.active ? 'supported' : 'stale',
        attribution_state: row.active ? 'supported' : 'stale', manual_locked: 0, ledger: true,
        sources, duty: row.duty, context_scope: row.context_scope, basis: row.basis,
        duty_state: row.active && row.duty && row.duty !== 'unresolved' ? 'supported' : 'pending',
    };
}

function read(db, evidenceId) {
    const id = Number(evidenceId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return legacy(db, id) || direct(db, fragmentIdFromSynthetic(id));
}

function forFragment(db, fragmentId) {
    const allRows = hasTable(db, 'memory_fragment_evidence_refs')
        ? db.prepare(`SELECT evidence_id,active FROM memory_fragment_evidence_refs
            WHERE fragment_id=? ORDER BY evidence_id`).all(fragmentId)
        : [];
    if (allRows.length) return allRows.filter(row => row.active === 1)
        .map(row => legacy(db, row.evidence_id)).filter(Boolean);
    const current = direct(db, fragmentId);
    return current ? [current] : [];
}

function eligible(db, evidenceId) {
    const evidence = read(db, evidenceId);
    if (!evidence || evidence.claim_status !== 'active' || evidence.duty_state !== 'supported') return false;
    return evidence.duty !== 'unresolved' && require('./memoryProtocol').sourcesCurrent(db, evidence);
}

function enqueueDirect(db, fragmentId, priority) {
    const protocol = require('./memoryProtocol');
    const evidence = direct(db, fragmentId);
    if (!evidence) return null;
    protocol.enqueueJob(db, {
        stage: 'fragment_classification', targetType: 'fragment', targetId: evidence.id,
        inputRevision: evidence.revision, inputHash: evidence.input_hash,
        priority: Math.max(Number(priority) || 0, protocol.LIVE_JOB_PRIORITY),
    });
    return evidence;
}

function supersede(db, evidenceId) {
    const evidence = read(db, evidenceId);
    if (!evidence) return false;
    if (evidence.ledger) {
        return db.prepare('UPDATE memory_fragment_evidence_refs SET active=0 WHERE evidence_id=? AND active=1')
            .run(evidence.id).changes === 1;
    }
    return db.prepare("UPDATE memory_fragments SET status='superseded' WHERE id=? AND status='active'")
        .run(evidence.fragment_id).changes === 1;
}

function migrate(db) {
    db.exec(SCHEMA);
    if (!hasTable(db, 'memory_claims')) return;
    db.exec(`
        INSERT OR REPLACE INTO memory_fragment_evidence_refs(
            evidence_id,fragment_id,domain,subject_entity_id,temporal_state,event_from,event_until,
            time_precision,input_hash,revision,reviewer,subject_kind,active,body_enc,
            duty,context_scope,basis,created_at)
        SELECT c.id,c.fragment_id,c.domain,c.subject_entity_id,c.temporal_state,c.event_from,c.event_until,
            c.time_precision,c.input_hash,c.revision,c.reviewer,c.subject_kind,
            CASE WHEN c.claim_status='active' AND c.source_state='supported'
                AND c.support_state='supported' AND c.attribution_state='supported'
                AND d.state='supported' AND d.duty!='unresolved'
                AND (c.manual_locked=1 OR 2=(SELECT COUNT(*) FROM memory_claim_review_passes p
                    WHERE p.claim_id=c.id AND p.claim_revision=c.revision AND p.input_hash=c.input_hash
                      AND p.contract_version='claim-review-v2' AND p.support_state='supported'
                      AND p.attribution_state='supported')) THEN 1 ELSE 0 END,
            c.body_enc,d.duty,d.context_scope,d.basis,c.created_at
        FROM memory_claims c
        LEFT JOIN memory_claim_duties d ON d.claim_id=c.id AND d.claim_revision=c.revision;

        INSERT OR REPLACE INTO memory_fragment_evidence_sources(
            evidence_id,message_id,message_fingerprint,quote_enc,speaker,source_time)
        SELECT claim_id,message_id,message_fingerprint,quote_enc,speaker,source_time
        FROM memory_claim_sources;

        ALTER TABLE memory_claim_classification RENAME TO memory_claim_classification_v124;
        CREATE TABLE memory_claim_classification (
            claim_id INTEGER PRIMARY KEY, claim_revision INTEGER NOT NULL, input_hash TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK(outcome IN('linked','topic_only','no_independent_node','needs_resolution')),
            links_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(links_json)),
            topics_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(topics_json)), reviewer TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO memory_claim_classification SELECT * FROM memory_claim_classification_v124;
        DROP TABLE memory_claim_classification_v124;

        ALTER TABLE memory_node_reviews RENAME TO memory_node_reviews_v124;
        CREATE TABLE memory_node_reviews (
            claim_id INTEGER NOT NULL, entity_id INTEGER NOT NULL REFERENCES entity_profiles(id), role TEXT NOT NULL,
            verdict TEXT NOT NULL CHECK(verdict IN('supported','rejected','pending')),
            claim_revision INTEGER NOT NULL,input_hash TEXT NOT NULL,quote_enc TEXT,reviewer TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(claim_id,entity_id,role)
        );
        INSERT INTO memory_node_reviews SELECT * FROM memory_node_reviews_v124;
        DROP TABLE memory_node_reviews_v124;

        ALTER TABLE memory_evidence_pool RENAME TO memory_evidence_pool_v124;
        CREATE TABLE memory_evidence_pool (
            claim_id INTEGER PRIMARY KEY,claim_revision INTEGER NOT NULL,input_hash TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN('ineligible','needs_resolution','deferred','unassigned','topic_only','node_candidate','grounded')),
            reason_code TEXT NOT NULL,entity_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(entity_ids_json)),
            attempts INTEGER NOT NULL DEFAULT 0,evidence_fingerprint TEXT NOT NULL,
            next_review_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL
        );
        INSERT INTO memory_evidence_pool SELECT * FROM memory_evidence_pool_v124;
        DROP TABLE memory_evidence_pool_v124;
        CREATE INDEX idx_memory_evidence_pool_state ON memory_evidence_pool(state,next_review_at,updated_at);

        ALTER TABLE memory_identity_alias_evidence RENAME TO memory_identity_alias_evidence_v124;
        CREATE TABLE memory_identity_alias_evidence (
            entity_id INTEGER NOT NULL REFERENCES entity_profiles(id) ON DELETE CASCADE,
            alias TEXT NOT NULL,normalized_alias TEXT NOT NULL,claim_id INTEGER NOT NULL,
            claim_revision INTEGER NOT NULL,message_id INTEGER NOT NULL,quote_enc TEXT NOT NULL,
            reviewer TEXT NOT NULL,created_at INTEGER NOT NULL,
            PRIMARY KEY(entity_id,normalized_alias,claim_id,message_id)
        );
        INSERT INTO memory_identity_alias_evidence SELECT * FROM memory_identity_alias_evidence_v124;
        DROP TABLE memory_identity_alias_evidence_v124;

        ALTER TABLE memory_constellation_discovery_candidates RENAME TO memory_constellation_discovery_candidates_v124;
        CREATE TABLE memory_constellation_discovery_candidates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,anchor_claim_id INTEGER NOT NULL,input_hash TEXT NOT NULL UNIQUE,
            proposed_name TEXT NOT NULL,proposed_category TEXT NOT NULL,basis TEXT NOT NULL,
            identity_candidate_id INTEGER REFERENCES memory_constellation_candidates(id),
            status TEXT NOT NULL CHECK(status IN('pending_identity','contained','rejected','needs_resolution')),
            reviewer TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
        );
        INSERT INTO memory_constellation_discovery_candidates SELECT * FROM memory_constellation_discovery_candidates_v124;
        DROP TABLE memory_constellation_discovery_candidates_v124;

        ALTER TABLE memory_correction_inbox RENAME TO memory_correction_inbox_v124;
        CREATE TABLE memory_correction_inbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id INTEGER NOT NULL REFERENCES chats(id),
            message_id INTEGER NOT NULL REFERENCES messages(id),message_fingerprint TEXT NOT NULL,
            quote_enc TEXT NOT NULL,correction_enc TEXT NOT NULL,target_claim_id INTEGER,input_hash TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL CHECK(status IN('queued','applied','unlocated','needs_review','stale')),
            reviewer TEXT,replacement_claim_id INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
        );
        INSERT INTO memory_correction_inbox SELECT * FROM memory_correction_inbox_v124;
        DROP TABLE memory_correction_inbox_v124;
        CREATE INDEX idx_memory_correction_inbox_state ON memory_correction_inbox(status,updated_at);

        ALTER TABLE memory_search_projection RENAME TO memory_search_projection_v124;
        CREATE TABLE memory_search_projection (
            projection_key TEXT PRIMARY KEY,
            target_type TEXT NOT NULL CHECK(target_type IN('claim','fragment','episode','saga','profile')),
            target_id INTEGER NOT NULL,field TEXT,revision INTEGER NOT NULL,input_hash TEXT NOT NULL,
            text_enc TEXT NOT NULL,metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
            updated_at INTEGER NOT NULL
        );
        INSERT INTO memory_search_projection SELECT * FROM memory_search_projection_v124;
        DROP TABLE memory_search_projection_v124;
        CREATE INDEX idx_memory_search_projection_target ON memory_search_projection(target_type,target_id);

        UPDATE memory_jobs SET status='no_change',error_code='claim_stage_retired',lease_token=NULL,lease_until=NULL,
            updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
        WHERE stage IN('claim_review','claim_review_a','claim_review_b','claim_recovery','claim_duty')
          AND status IN('queued','retry','running','skipped');
        UPDATE memory_jobs SET stage='fragment_classification',target_type='fragment'
        WHERE stage='claim_classification';
        UPDATE memory_jobs SET target_type='fragment'
        WHERE stage IN('node_review','evidence_resolution','constellation_discovery','episode_candidate')
          AND target_type LIKE 'claim%';

        DROP TABLE IF EXISTS memory_claim_recoveries;
        DROP TABLE IF EXISTS memory_claim_review_passes;
        DROP TABLE IF EXISTS memory_claim_reviews;
        DROP TABLE IF EXISTS memory_claim_duties;
        DROP TABLE IF EXISTS memory_claim_sources;
        DROP TABLE IF EXISTS memory_claims;

        UPDATE memory_fragments SET status='active',observation_state='quoted'
        WHERE status='frozen' AND id IN (
            SELECT fragment_id FROM memory_fragment_evidence_refs WHERE active=1
        );
    `);

    const activeRefs = db.prepare(`SELECT DISTINCT fragment_id FROM memory_fragment_evidence_refs WHERE active=1`)
        .all().map(row => Number(row.fragment_id));
    const protectedFragments = new Set(activeRefs);
    for (const row of db.prepare(`SELECT id FROM memory_fragments
        WHERE status='active' AND observation_state='quoted' ORDER BY id`).all()) {
        if (!protectedFragments.has(Number(row.id))) enqueueDirect(db, Number(row.id), 100);
    }
}

module.exports = {
    FRAGMENT_EVIDENCE_OFFSET, SCHEMA, hasTable, syntheticId, fragmentIdFromSynthetic,
    dutyFor, read, direct, legacy, forFragment, eligible, enqueueDirect, supersede, migrate,
};
