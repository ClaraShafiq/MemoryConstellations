'use strict';

const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { WORLD_CONTEXT } = require('./worldContext');
const protocol = require('./memoryProtocol');

const CONTRACT = 'atomic-observation-v1';
const MIN_RECOVERY_BATCH = 15;
const FAILURE_BACKOFF_SECONDS = 60 * 60;

function decodeMessage(row) {
    return { ...row, content: protocol.messageText(row) };
}

function lastCursor(db) {
    const row = db.prepare(`SELECT processed_until,COALESCE(processed_until_id,0) processed_until_id
        FROM scribe_runs WHERE status='done' ORDER BY id DESC LIMIT 1`).get();
    return { at: row?.processed_until || '2000-01-01 00:00:00', id: Number(row?.processed_until_id || 0) };
}

function pendingMessages(db, cursor, limit = 60) {
    return db.prepare(`SELECT id,chat_id,sender,content,is_encrypted,timestamp,picked_up_at,status,message_type
        FROM messages WHERE status='sent' AND message_type!='image'
          AND (COALESCE(picked_up_at,timestamp)>? OR (COALESCE(picked_up_at,timestamp)=? AND id>?))
        ORDER BY COALESCE(picked_up_at,timestamp),id LIMIT ?`)
        .all(cursor.at, cursor.at, cursor.id, limit).map(decodeMessage);
}

function buildPrompt(messages) {
    const input = messages.map(message => ({
        message_id: message.id,
        speaker: message.sender === 'user' ? 'user' : 'companion',
        timestamp: message.timestamp,
        text: message.content,
    }));
    return {
        system: `${WORLD_CONTEXT}\n\nYou are the Scribe. Extract only atomic observations directly supported by exact quotes.
Do not decide constellation identity, admission, profile fields, personality, or relationships.
Do not use prior memory. Do not merge independent claims.
Return JSON only: {"entries":[{"body":"neutral atomic statement","domain":"user_statement|observed_activity|interaction|companion_opinion|inference|fiction|third_party","temporal_state":"unknown|planned|in_progress|completed|cancelled|historical","event_from":null,"event_until":null,"time_precision":"unknown|day","evidence":[{"message_id":1,"quote":"exact substring"}]}]}.
If evidence is insufficient, omit the entry.`,
        user: JSON.stringify({ contract: CONTRACT, messages: input }),
    };
}

function parseEntries(reply) {
    const text = typeof reply === 'string' ? reply : reply?.reply;
    if (typeof text !== 'string') throw Object.assign(new Error('scribe_empty_response'), { code: 'scribe_empty_response' });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw Object.assign(new Error('scribe_invalid_json'), { code: 'scribe_invalid_json' });
    const parsed = JSON.parse(match[0]);
    if (!parsed || !Array.isArray(parsed.entries)) throw Object.assign(new Error('scribe_invalid_contract'), { code: 'scribe_invalid_contract' });
    return parsed.entries;
}

function validateEntry(messageMap, entry) {
    if (!entry || typeof entry.body !== 'string' || !entry.body.trim()) protocol.fail('scribe_entry_invalid');
    if (!protocol.DOMAINS.includes(entry.domain)) protocol.fail('scribe_domain_invalid');
    if (!protocol.TEMPORAL_STATES.includes(entry.temporal_state || 'unknown')) protocol.fail('scribe_temporal_invalid');
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) protocol.fail('scribe_evidence_required');
    const sources = entry.evidence.map(item => {
        const message = messageMap.get(Number(item.message_id));
        if (!message || typeof item.quote !== 'string' || !message.content.includes(item.quote)) protocol.fail('scribe_quote_not_exact');
        return {
            message_id: message.id,
            message_fingerprint: protocol.messageFingerprint(message),
            quote: item.quote,
            speaker: message.sender === 'user' ? 'user' : 'companion',
            source_time: message.timestamp,
        };
    });
    return {
        body: entry.body.trim(), domain: entry.domain,
        temporal: {
            state: entry.temporal_state || 'unknown',
            event_from: entry.event_from || null,
            event_until: entry.event_until || null,
            precision: entry.time_precision || 'unknown',
        },
        sources,
    };
}

async function extract(messages) {
    const prompt = buildPrompt(messages);
    return parseEntries(await callLLM([{ role: 'user', parts: [{ text: prompt.user }] }], prompt.system, null, {
        temperature: 0, maxOutputTokens: 8192,
    }));
}

async function runBatch(messages, cursor, { extractEntries = extract } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return { outcome: 'no_change' };
    const db = getDb();
    const decoded = messages.map(message => message.content && !message.content.startsWith('enc:') ? message : decodeMessage(message));
    const messageMap = new Map(decoded.map(message => [Number(message.id), message]));
    let rawEntries;
    try {
        rawEntries = await extractEntries(decoded);
    } catch (error) {
        db.prepare(`INSERT INTO scribe_runs(processed_until,processed_until_id,messages_processed,fragments_written,status)
            VALUES(?,?,0,0,'failed')`).run(cursor.at, cursor.id);
        throw error;
    }
    const entries = rawEntries.map(entry => validateEntry(messageMap, entry));
    const finalMessage = decoded.at(-1);
    const next = { at: finalMessage.picked_up_at || finalMessage.timestamp, id: Number(finalMessage.id) };
    const result = db.transaction(() => {
        let written = 0;
        for (const entry of entries) {
            const sourceIds = [...new Set(entry.sources.map(source => source.message_id))].sort((a, b) => a - b);
            const identity = protocol.hash({ contract: CONTRACT, sources: entry.sources.map(source => ({
                message_id: source.message_id, quote: source.quote,
            })), body: entry.body, domain: entry.domain, temporal: entry.temporal });
            const existing = db.prepare('SELECT id FROM memory_claims WHERE claim_key=?').get(`scribe:${identity}`);
            if (existing) continue;
            const fragmentResult = db.prepare(`INSERT INTO memory_fragments(
                type,entity,content,emotional_weight,source,source_date,status,source_msg_ids,
                observation_json,observation_state,content_hash)
                VALUES('observation','unassigned',?,0.5,'chat',?,'frozen',?,?,'frozen',?)`).run(
                entry.body, entry.sources.map(source => source.source_time).filter(Boolean).sort().at(-1)?.slice(0, 10) || null,
                JSON.stringify(sourceIds), JSON.stringify({ contract: CONTRACT, domain: entry.domain, temporal: entry.temporal,
                    evidence: entry.sources.map(source => ({ message_id: source.message_id, quote: source.quote,
                        speaker: source.speaker, source_time: source.source_time })) }), identity,
            );
            protocol.createClaim(db, {
                fragmentId: Number(fragmentResult.lastInsertRowid), claimKey: `scribe:${identity}`,
                body: entry.body, domain: entry.domain, temporal: entry.temporal, sources: entry.sources,
                priority: protocol.LIVE_JOB_PRIORITY,
            });
            written++;
        }
        db.prepare(`INSERT INTO scribe_runs(processed_until,processed_until_id,messages_processed,fragments_written,status)
            VALUES(?,?,?,?, 'done')`).run(next.at, next.id, decoded.length, written);
        return { outcome: 'done', messages_processed: decoded.length, observations_written: written, cursor: next };
    })();
    return result;
}

function recoveryState(db, cursor, maxBatch) {
    const row = db.prepare(`SELECT COUNT(*) failures,
        COALESCE(CAST(strftime('%s','now') AS INTEGER)-CAST(strftime('%s',MAX(run_at)) AS INTEGER),0) age_seconds
        FROM scribe_runs WHERE status='failed' AND processed_until=? AND COALESCE(processed_until_id,0)=?
          AND id>COALESCE((SELECT MAX(id) FROM scribe_runs WHERE status='done'),0)`).get(cursor.at, cursor.id);
    const failures = Number(row?.failures || 0);
    const divisor = 2 ** Math.min(failures, 2);
    return {
        failures,
        ageSeconds: Number(row?.age_seconds || 0),
        batchLimit: Math.max(Math.min(MIN_RECOVERY_BATCH, maxBatch), Math.floor(maxBatch / divisor)),
    };
}

async function checkAndRun(options = {}) {
    const db = getDb();
    const cursor = lastCursor(db);
    const configured = Math.max(1, Number(process.env.MEMORY_SCRIBE_BATCH_SIZE || 60));
    const recovery = recoveryState(db, cursor, configured);
    if (recovery.failures >= 3 && recovery.ageSeconds < FAILURE_BACKOFF_SECONDS && options.forceRetry !== true) {
        return { outcome: 'skipped', reason: 'failure_backoff',
            retry_after_seconds: FAILURE_BACKOFF_SECONDS - recovery.ageSeconds };
    }
    const messages = pendingMessages(db, cursor, recovery.batchLimit);
    if (!messages.length) return { outcome: 'no_change' };
    const min = Number(process.env.MEMORY_SCRIBE_MIN_MESSAGES || 1);
    if (messages.length < min) return { outcome: 'skipped', reason: 'below_minimum' };
    return protocol.tracked(db, 'scribe', () => runBatch(messages, cursor));
}

module.exports = { CONTRACT, MIN_RECOVERY_BATCH, FAILURE_BACKOFF_SECONDS, lastCursor, pendingMessages,
    buildPrompt, parseEntries, validateEntry, runBatch, recoveryState, checkAndRun };
