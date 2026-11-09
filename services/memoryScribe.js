'use strict';

const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { getWorldContext } = require('./worldContext');
const protocol = require('./memoryProtocol');
const subjects = require('./memoryConversationSubjects');

const CONTRACT = 'complete-semantic-unit-v3';
const MAX_BODY_CHARS = 180;
const MIN_RECOVERY_BATCH = 15;
const FAILURE_BACKOFF_SECONDS = 60 * 60;

const GENERIC_OBJECT_RE = /(?:[这那](?:件|个)[^，。！？\n]{0,12}(?:衣服|东西|物品|商品|款式|事情|地方)|(?:奇怪的|某个?|某种|什么|一些|有些|不明的|乱七八糟的)(?:东西|事情|事|人|关系|因素|问题)|外物|任何(?:事|东西|事物)|\b(?:(?:this|that|some|strange|unknown|external|any)\s+(?:thing|matter|issue|place|factor)s?|something\s+(?:strange|unknown|external)|something|anything)\b)/i;
const BARE_ACTION_RE = /^(?:(?:(?:the\s+)?(?:user|assistant)|[^，。！？,.!?\s]{1,32})(?:当时|目前|现在|刚刚|已经|还|尚)?(?:尚未|还没|没有|没|未)?(?:通关|看完|读完|写完|完成|开始|继续|买下|玩过|看过|读过)(?:了|过|呢)?|(?:the\s+)?(?:user|assistant)\s+(?:(?:has|have|had|is|was)\s+)?(?:not\s+)?(?:finished|completed|started|continued|bought|watched|read|played)(?:\s+(?:it|that))?)[。！？.!?]?$/i;
const DANGLING_REFERENCE_RE = /^(?:他|她|它|这个|那个|这件事|那件事|其|it|this|that|they|he|she)\b|(?:的\s*(?:Pro|Plus|Max)|'s\s+(?:Pro|Plus|Max))\s*[。.!]?$/i;
const FICTION_MARKER_RE = /(?:小说|作品|设定|角色扮演|虚构|剧本|参考材料|fiction|fictional|novel|role[- ]?play|reference material|story setting)/i;
const GRAPHIC_INTIMACY_RE = /(?:性交|插入|射精|阴茎|阴道|肛门|口交|genitals?|penetrat(?:e|ion)|ejaculat(?:e|ion)|oral sex|anal sex)/i;

function decodeMessage(row) {
    return { ...row, content: protocol.messageText(row) };
}

function lastCursor(db) {
    const row = db.prepare(`SELECT processed_until,COALESCE(processed_until_id,0) processed_until_id
        FROM scribe_runs WHERE status='done' ORDER BY id DESC LIMIT 1`).get();
    return { at: row?.processed_until || '2000-01-01 00:00:00', id: Number(row?.processed_until_id || 0) };
}

function pendingMessages(db, cursor, limit = 60) {
    return db.prepare(`SELECT id,chat_id,sender,content,is_encrypted,timestamp,picked_up_at,status,message_type,chat_mode
        FROM messages WHERE status='sent' AND message_type!='image'
          AND (COALESCE(picked_up_at,timestamp)>? OR (COALESCE(picked_up_at,timestamp)=? AND id>?))
        ORDER BY COALESCE(picked_up_at,timestamp),id LIMIT ?`)
        .all(cursor.at, cursor.at, cursor.id, limit).map(decodeMessage);
}

function buildPrompt(messages, feedback = '') {
    const input = messages.map(message => ({
        message_id: message.id,
        speaker: subjects.sourceSpeaker(message.sender),
        timestamp: message.timestamp,
        chat_mode: message.chat_mode || 'default',
        text: message.content,
    }));
    return {
        system: `${getWorldContext('scribe')}\n\nYou are the Scribe. Extract the smallest complete semantic units directly supported by exact quotes.
Do not decide constellation identity, admission, profile fields, personality, or relationships.
Do not use prior memory. Do not merge independent claims.
Preserve who the observation is about. An assistant self-statement is not a user fact.
Keep user facts, third-party information, and assistant/persona attitudes in separate source domains. A user's phrase such as "I think" is not an assistant opinion.
"Atomic" does not mean one sentence or one clause per entry. An entry must remain understandable outside the chat: who, what object, and what happened or was believed must be explicit.
Messages from the same chat, speaker, and timestamp are one expression burst. Understand the burst as a whole before splitting it. Merge background, action, result, feeling, or explanation when they concern the same object and will be retrieved or updated together. A domain or temporal-state difference alone is not a reason to split.
Split only when each part concerns an independent object or future use and remains complete by itself.
If one speaker expresses relationship insecurity and the other gives a concrete reassurance or explanation, preserve both sides as one domain=interaction entry with both exact quotes. Use subject=unknown when no single subject represents the complete interaction; do not infer a relationship label.
Never leave a bare action without its object. Never reduce a concrete explanation back to vague phrases such as "that thing", "something strange", or "anything". If the object cannot be grounded in exact evidence, omit the entry.
Fiction, role-play, novel settings, and reference material must use domain=fiction and say explicitly in body that they are fictional/reference material. Never turn them into the user's real experience.
Do not discard consensual affectionate interaction merely because it is intimate. Preserve only a high-level, non-graphic interaction observation, mark sensitivity=intimacy, and bind only the minimum safe exact quote. Omit graphic sexual detail.
Each evidence message_id may appear at most once per entry. When one message contains multiple supporting spans, quote the smallest continuous source range covering them.
Keep body at or below ${MAX_BODY_CHARS} characters.
Return JSON only: {"entries":[{"body":"neutral, independently consumable semantic unit","subject":"user|assistant|third_party|unknown","domain":"user_statement|observed_activity|interaction|companion_opinion|inference|fiction|third_party","sensitivity":"none|intimacy","temporal_state":"unknown|planned|in_progress|completed|cancelled|historical","event_from":null,"event_until":null,"time_precision":"unknown|day","evidence":[{"message_id":1,"quote":"exact substring"}]}]}.
Before returning, audit sibling entries from the same expression burst and merge any that only make sense together. If evidence is insufficient, omit the entry.${feedback ? `\n\nPrevious-attempt audit:\n${feedback}` : ''}`,
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
    if (entry.body.trim().length > MAX_BODY_CHARS) protocol.fail('scribe_body_too_long');
    const incomplete = incompleteBodyReason(entry.body);
    if (incomplete) protocol.fail(incomplete);
    if (!protocol.DOMAINS.includes(entry.domain)) protocol.fail('scribe_domain_invalid');
    if (!protocol.TEMPORAL_STATES.includes(entry.temporal_state || 'unknown')) protocol.fail('scribe_temporal_invalid');
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) protocol.fail('scribe_evidence_required');
    const seenMessageIds = new Set();
    const sources = entry.evidence.map(item => {
        const message = messageMap.get(Number(item.message_id));
        if (!message || typeof item.quote !== 'string' || !message.content.includes(item.quote)) protocol.fail('scribe_quote_not_exact');
        if (seenMessageIds.has(message.id)) protocol.fail('scribe_duplicate_message_evidence');
        seenMessageIds.add(message.id);
        return {
            message_id: message.id,
            message_fingerprint: protocol.messageFingerprint(message),
            quote: item.quote,
            speaker: subjects.sourceSpeaker(message.sender),
            source_time: message.timestamp,
        };
    });
    const subject = subjects.validateSubject(entry.subject || 'unknown', sources);
    const sourceMessages = entry.evidence.map(item => messageMap.get(Number(item.message_id)));
    const roleplay = sourceMessages.some(message => message?.chat_mode === 'roleplay');
    if (roleplay && entry.domain !== 'fiction') protocol.fail('scribe_roleplay_must_be_fiction');
    if (entry.domain === 'fiction' && !roleplay && !FICTION_MARKER_RE.test(entry.body)
        && !sources.some(source => FICTION_MARKER_RE.test(source.quote))) protocol.fail('scribe_fiction_scope_missing');
    const sensitivity = entry.sensitivity || 'none';
    if (!['none', 'intimacy'].includes(sensitivity)) protocol.fail('scribe_sensitivity_invalid');
    if (sensitivity === 'intimacy') {
        if (entry.domain !== 'interaction') protocol.fail('scribe_intimacy_domain_invalid');
        if (GRAPHIC_INTIMACY_RE.test(entry.body) || sources.some(source => GRAPHIC_INTIMACY_RE.test(source.quote)))
            protocol.fail('scribe_intimacy_graphic_detail');
    }
    return {
        body: entry.body.trim(), domain: entry.domain,
        subject, sensitivity,
        temporal: {
            state: entry.temporal_state || 'unknown',
            event_from: entry.event_from || null,
            event_until: entry.event_until || null,
            precision: entry.time_precision || 'unknown',
        },
        sources,
    };
}

function incompleteBodyReason(body) {
    const text = String(body || '').trim();
    if (GENERIC_OBJECT_RE.test(text)) return 'scribe_generic_object';
    if (DANGLING_REFERENCE_RE.test(text)) return 'scribe_dangling_reference';
    return BARE_ACTION_RE.test(text) ? 'scribe_missing_action_object' : null;
}

function coalesceDuplicateEvidence(entry, messages) {
    if (!entry || !Array.isArray(entry.evidence) || entry.evidence.length < 2) return entry;
    const messageMap = new Map((messages || []).map(message => [Number(message.id), message]));
    const groups = new Map();
    for (const item of entry.evidence) {
        const id = Number(item?.message_id);
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(item);
    }
    if (![...groups.values()].some(items => items.length > 1)) return entry;
    const evidence = [];
    for (const [id, items] of groups) {
        if (items.length === 1) {
            evidence.push(items[0]);
            continue;
        }
        const text = String(messageMap.get(id)?.content || '');
        const spans = items.map(item => {
            const quote = typeof item?.quote === 'string' ? item.quote.trim() : '';
            const start = quote ? text.indexOf(quote) : -1;
            return { start, end: start < 0 ? -1 : start + quote.length };
        });
        if (!text || spans.some(span => span.start < 0)) {
            evidence.push(...items);
            continue;
        }
        const start = Math.min(...spans.map(span => span.start));
        const end = Math.max(...spans.map(span => span.end));
        evidence.push({ message_id: id, quote: text.slice(start, end) });
    }
    return { ...entry, evidence };
}

function sameBurstSplitDiagnostics(entries, messages) {
    if (!Array.isArray(entries) || entries.length < 2) return [];
    const messageMap = new Map((messages || []).map(message => [Number(message.id), message]));
    const groups = new Map();
    for (let index = 0; index < entries.length; index++) {
        for (const evidence of entries[index]?.evidence || []) {
            const message = messageMap.get(Number(evidence.message_id));
            if (!message) continue;
            const at = String(message.picked_up_at || message.timestamp || '');
            if (!at) continue;
            const key = [Number(message.chat_id), at, subjects.sourceSpeaker(message.sender),
                entries[index].subject || 'unknown'].join('|');
            if (!groups.has(key)) groups.set(key, new Set());
            groups.get(key).add(index);
        }
    }
    return [...groups.entries()].map(([key, indexes]) => ({ key, indexes: [...indexes].sort((a, b) => a - b) }))
        .filter(group => group.indexes.length > 1);
}

function auditEntries(rawEntries, messages, { checkSplit = true } = {}) {
    if (!Array.isArray(rawEntries)) protocol.fail('scribe_invalid_contract');
    const entries = rawEntries.map(entry => coalesceDuplicateEvidence(entry, messages));
    const hard = entries.map((entry, index) => ({ index, reason: incompleteBodyReason(entry?.body) }))
        .filter(item => item.reason);
    const split = checkSplit ? sameBurstSplitDiagnostics(entries, messages) : [];
    return { entries, hard, split };
}

function auditFeedback(audit) {
    const parts = [];
    if (audit.split.length) parts.push(`Sibling entries may be over-split: ${JSON.stringify(audit.split)}. Merge entries that concern the same object and future retrieval/update use; keep separate objects independent.`);
    if (audit.hard.length) parts.push(`These entries are not independently consumable: ${JSON.stringify(audit.hard)}. Restore the concrete object and scene from exact quotes, or omit them.`);
    return parts.join('\n');
}

async function extractWithAudit(messages, extractEntries, maxAttempts = 2) {
    let feedback = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const rawEntries = await extractEntries(messages, { attempt, feedback });
        const audit = auditEntries(rawEntries, messages, { checkSplit: attempt === 1 });
        if (attempt < maxAttempts && (audit.hard.length || audit.split.length)) {
            feedback = auditFeedback(audit);
            continue;
        }
        const rejected = new Set(audit.hard.map(item => item.index));
        return { entries: audit.entries.filter((_entry, index) => !rejected.has(index)),
            rejected: rejected.size, attempts: attempt, feedback };
    }
    protocol.fail('scribe_audit_exhausted');
}

async function extract(messages, { feedback = '' } = {}) {
    require('./memoryModelBudget').reserve(getDb(), 'scribe');
    const prompt = buildPrompt(messages, feedback);
    return parseEntries(await callLLM([{ role: 'user', parts: [{ text: prompt.user }] }], prompt.system, null, {
        temperature: 0, maxOutputTokens: 8192,
    }));
}

async function persist(messages, cursor, rawEntries, { advanceCursor = true } = {}) {
    const db = getDb();
    const decoded = messages.map(message => message.content && !message.content.startsWith('enc:') ? message : decodeMessage(message));
    const messageMap = new Map(decoded.map(message => [Number(message.id), message]));
    const entries = rawEntries.map(entry => validateEntry(messageMap, entry));
    const finalMessage = decoded.at(-1);
    const next = { at: finalMessage.picked_up_at || finalMessage.timestamp, id: Number(finalMessage.id) };
    return db.transaction(() => {
        let written = 0;
        for (const entry of entries) {
            const sourceIds = [...new Set(entry.sources.map(source => source.message_id))].sort((a, b) => a - b);
            const identity = protocol.hash({ contract: CONTRACT, sources: entry.sources.map(source => ({
                message_id: source.message_id, quote: source.quote,
            })), body: entry.body, subject: entry.subject, domain: entry.domain, temporal: entry.temporal });
            const existing = db.prepare('SELECT id FROM memory_claims WHERE claim_key=?').get(`scribe:${identity}`);
            if (existing) continue;
            const fragmentResult = db.prepare(`INSERT INTO memory_fragments(
                type,entity,content,emotional_weight,source,source_date,status,source_msg_ids,
                observation_json,observation_state,content_hash)
                VALUES('observation','unassigned',?,0.5,'chat',?,'frozen',?,?,'frozen',?)`).run(
                entry.body, entry.sources.map(source => source.source_time).filter(Boolean).sort().at(-1)?.slice(0, 10) || null,
                JSON.stringify(sourceIds), JSON.stringify({ contract: CONTRACT, subject: entry.subject,
                    domain: entry.domain, sensitivity: entry.sensitivity, temporal: entry.temporal,
                    evidence: entry.sources.map(source => ({ message_id: source.message_id, quote: source.quote,
                        speaker: source.speaker, source_time: source.source_time })) }), identity,
            );
            protocol.createClaim(db, {
                fragmentId: Number(fragmentResult.lastInsertRowid), claimKey: `scribe:${identity}`,
                body: entry.body, subjectKind: entry.subject, domain: entry.domain, temporal: entry.temporal,
                sources: entry.sources, priority: protocol.LIVE_JOB_PRIORITY,
            });
            written++;
        }
        if (advanceCursor) db.prepare(`INSERT INTO scribe_runs(processed_until,processed_until_id,messages_processed,fragments_written,status)
            VALUES(?,?,?,?, 'done')`).run(next.at, next.id, decoded.length, written);
        return { outcome: 'done', messages_processed: decoded.length, observations_written: written,
            cursor: advanceCursor ? next : cursor, replay: !advanceCursor };
    })();
}

async function runBatch(messages, cursor, { extractEntries = extract } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return { outcome: 'no_change' };
    const db = getDb();
    const decoded = messages.map(message => message.content && !message.content.startsWith('enc:') ? message : decodeMessage(message));
    let audited;
    try {
        audited = await extractWithAudit(decoded, extractEntries);
    } catch (error) {
        db.prepare(`INSERT INTO scribe_runs(processed_until,processed_until_id,messages_processed,fragments_written,status)
            VALUES(?,?,0,0,'failed')`).run(cursor.at, cursor.id);
        throw error;
    }
    const result = await persist(decoded, cursor, audited.entries, { advanceCursor: true });
    return { ...result, observations_rejected: audited.rejected, extraction_attempts: audited.attempts };
}

async function replayMessages(messageIds, { extractEntries = extract } = {}) {
    const ids = [...new Set((messageIds || []).map(Number))];
    if (!ids.length || ids.length > 20 || ids.some(id => !Number.isSafeInteger(id) || id <= 0))
        protocol.fail('scribe_replay_ids_invalid');
    const db = getDb();
    const marks = ids.map(() => '?').join(',');
    const messages = db.prepare(`SELECT id,chat_id,sender,content,is_encrypted,timestamp,picked_up_at,status,message_type,chat_mode
        FROM messages WHERE id IN(${marks}) AND status='sent' ORDER BY COALESCE(picked_up_at,timestamp),id`).all(...ids);
    if (messages.length !== ids.length) protocol.fail('scribe_replay_message_missing');
    const decoded = messages.map(decodeMessage);
    const audited = await extractWithAudit(decoded, extractEntries);
    const result = await persist(decoded, lastCursor(db), audited.entries, { advanceCursor: false });
    return { ...result, observations_rejected: audited.rejected, extraction_attempts: audited.attempts };
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

module.exports = { CONTRACT, MAX_BODY_CHARS, MIN_RECOVERY_BATCH, FAILURE_BACKOFF_SECONDS, lastCursor, pendingMessages,
    buildPrompt, parseEntries, validateEntry, incompleteBodyReason, coalesceDuplicateEvidence,
    sameBurstSplitDiagnostics, auditEntries, extractWithAudit, persist, runBatch, replayMessages,
    recoveryState, checkAndRun };
