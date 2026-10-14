'use strict';

const protocol = require('./memoryProtocol');
const projection = require('./memoryEpisodeProjection');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_episode_publications (
    candidate_id INTEGER PRIMARY KEY REFERENCES memory_episode_candidates(id),
    memory_id INTEGER NOT NULL REFERENCES memories(id),
    input_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    producer TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    published_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_episode_publication_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL,
    memory_id INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    producer TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    published_at INTEGER NOT NULL
);
`;

function publish(db, candidateId, draft, meta) {
    const checked = projection.validate(db, candidateId, draft);
    if (!meta?.producer || !meta?.reviewer) protocol.fail('episode_publication_actor_required');
    return db.transaction(() => {
        const previous = db.prepare('SELECT * FROM memory_episode_publications WHERE candidate_id=?').get(candidateId);
        if (previous?.input_hash === checked.input.input_hash) return previous;
        const revision = Number(previous?.revision || 0) + 1;
        const sourceIds = [...new Set(checked.input.claims.flatMap(claim => claim.sources.map(source => source.message_id)))];
        const entityId = checked.input.entity_ids[0] || null;
        let memoryId = previous?.memory_id;
        const encrypted = protocol.encrypt(checked.content);
        if (memoryId) {
            db.prepare(`UPDATE memories SET title=?,content=?,tags=?,content_hash=?,source_msg_ids=?,layer='episode',
                entity_id=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(checked.title, encrypted,
                JSON.stringify(checked.tags), protocol.hash(checked.content), JSON.stringify(sourceIds), entityId,
                checked.input.transient ? 'ongoing' : 'permanent', memoryId);
        } else {
            const result = db.prepare(`INSERT INTO memories(title,content,tags,content_hash,source_msg_ids,layer,entity_id,status)
                VALUES(?,?,?,?,?,'episode',?,?)`).run(checked.title, encrypted, JSON.stringify(checked.tags),
                protocol.hash(checked.content), JSON.stringify(sourceIds), entityId,
                checked.input.transient ? 'ongoing' : 'permanent');
            memoryId = Number(result.lastInsertRowid);
        }
        const payload = JSON.stringify({ title: checked.title, content: checked.content, tags: checked.tags,
            claim_ids: checked.input.claims.map(claim => claim.id), transient: checked.input.transient });
        const now = Date.now();
        db.prepare(`INSERT INTO memory_episode_publications(candidate_id,memory_id,input_hash,revision,producer,reviewer,payload_json,published_at)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET memory_id=excluded.memory_id,
            input_hash=excluded.input_hash,revision=excluded.revision,producer=excluded.producer,
            reviewer=excluded.reviewer,payload_json=excluded.payload_json,published_at=excluded.published_at`).run(
            candidateId, memoryId, checked.input.input_hash, revision, meta.producer, meta.reviewer, payload, now);
        db.prepare(`INSERT INTO memory_episode_publication_history(candidate_id,memory_id,input_hash,revision,producer,reviewer,payload_json,published_at)
            VALUES(?,?,?,?,?,?,?,?)`).run(candidateId, memoryId, checked.input.input_hash, revision,
            meta.producer, meta.reviewer, payload, now);
        db.prepare("UPDATE memory_episode_candidates SET status='published',updated_at=? WHERE id=? AND input_hash=?")
            .run(now, candidateId, checked.input.input_hash);
        protocol.enqueueJob(db, { stage: 'search_projection', targetType: 'memory', targetId: memoryId,
            inputRevision: revision, inputHash: checked.input.input_hash, priority: meta.priority });
        return db.prepare('SELECT * FROM memory_episode_publications WHERE candidate_id=?').get(candidateId);
    })();
}

module.exports = { SCHEMA, publish };
