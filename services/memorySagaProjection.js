'use strict';

const protocol = require('./memoryProtocol');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_saga_publications (
    saga_key TEXT PRIMARY KEY,
    saga_id INTEGER NOT NULL REFERENCES memory_sagas(id),
    episode_ids_json TEXT NOT NULL CHECK(json_valid(episode_ids_json)),
    input_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    producer TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    published_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_saga_publication_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    saga_key TEXT NOT NULL,
    saga_id INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    published_at INTEGER NOT NULL
);
`;

function publish(db, decision) {
    const ids = [...new Set(decision.episodeIds || [])].sort((a, b) => a - b);
    if (!decision.sagaKey || !ids.length || !decision.producer) protocol.fail('saga_input_invalid');
    const episodes = ids.map(id => db.prepare(`SELECT p.*,m.status FROM memory_episode_publications p
        JOIN memories m ON m.id=p.memory_id WHERE p.memory_id=?`).get(id));
    if (episodes.some(item => !item)) protocol.fail('saga_episode_unpublished');
    const inputHash = protocol.hash(episodes.map(item => ({ memory_id: item.memory_id,
        input_hash: item.input_hash, revision: item.revision, status: item.status })));
    if (decision.inputHash !== inputHash) protocol.fail('saga_cas_failed');
    const title = String(decision.title || '').trim();
    const description = String(decision.description || '').trim();
    if (!title || !description) protocol.fail('saga_content_required');
    return db.transaction(() => {
        const previous = db.prepare('SELECT * FROM memory_saga_publications WHERE saga_key=?').get(decision.sagaKey);
        const revision = Number(previous?.revision || 0) + 1;
        let sagaId = previous?.saga_id;
        if (sagaId) db.prepare(`UPDATE memory_sagas SET title=?,description=?,memory_ids=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(title, description, JSON.stringify(ids), sagaId);
        else sagaId = Number(db.prepare(`INSERT INTO memory_sagas(title,description,memory_ids,status)
            VALUES(?,?,?,'active')`).run(title, description, JSON.stringify(ids)).lastInsertRowid);
        const payload = JSON.stringify({ title, description, episode_ids: ids });
        const now = Date.now();
        db.prepare(`INSERT INTO memory_saga_publications(saga_key,saga_id,episode_ids_json,input_hash,revision,producer,payload_json,published_at)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(saga_key) DO UPDATE SET saga_id=excluded.saga_id,
            episode_ids_json=excluded.episode_ids_json,input_hash=excluded.input_hash,revision=excluded.revision,
            producer=excluded.producer,payload_json=excluded.payload_json,published_at=excluded.published_at`).run(
            decision.sagaKey, sagaId, JSON.stringify(ids), inputHash, revision, decision.producer, payload, now);
        db.prepare(`INSERT INTO memory_saga_publication_history(saga_key,saga_id,input_hash,revision,payload_json,published_at)
            VALUES(?,?,?,?,?,?)`).run(decision.sagaKey, sagaId, inputHash, revision, payload, now);
        return { saga_id: sagaId, revision, input_hash: inputHash };
    })();
}

function inputHash(db, episodeIds) {
    const ids = [...new Set(episodeIds || [])].sort((a, b) => a - b);
    return protocol.hash(ids.map(id => {
        const row = db.prepare(`SELECT p.input_hash,p.revision,p.memory_id,m.status FROM memory_episode_publications p
            JOIN memories m ON m.id=p.memory_id WHERE p.memory_id=?`).get(id);
        if (!row) protocol.fail('saga_episode_unpublished');
        return row;
    }));
}

module.exports = { SCHEMA, inputHash, publish };
