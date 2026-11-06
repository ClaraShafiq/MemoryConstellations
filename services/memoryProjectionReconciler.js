'use strict';

const search = require('./memorySearchProjection');
const vectors = require('./memoryVectorProjection');

function ids(rows, field) {
    return rows.map(row => Number(row[field])).filter(Number.isSafeInteger);
}

function unionIds(...groups) {
    return [...new Set(groups.flat())].sort((a, b) => a - b);
}

function keys(db) {
    return db.prepare('SELECT projection_key FROM memory_search_projection ORDER BY projection_key')
        .all().map(row => row.projection_key);
}

function applyLocal(db) {
    const before = new Set(keys(db));
    const expected = new Set();
    const scanned = { claims: 0, episodes: 0, sagas: 0, profiles: 0 };

    const claimIds = unionIds(
        ids(db.prepare('SELECT id FROM memory_claims').all(), 'id'),
        ids(db.prepare("SELECT target_id FROM memory_search_projection WHERE target_type='claim'").all(), 'target_id'),
    );
    for (const id of claimIds) {
        scanned.claims++;
        if (search.refreshClaim(db, id)) expected.add(`claim:${id}`);
    }

    const episodeIds = unionIds(
        ids(db.prepare('SELECT memory_id FROM memory_episode_publications').all(), 'memory_id'),
        ids(db.prepare("SELECT target_id FROM memory_search_projection WHERE target_type='episode'").all(), 'target_id'),
    );
    for (const id of episodeIds) {
        scanned.episodes++;
        if (search.refreshEpisode(db, id)) expected.add(`episode:${id}`);
    }

    const sagaIds = unionIds(
        ids(db.prepare('SELECT saga_id FROM memory_saga_publications').all(), 'saga_id'),
        ids(db.prepare("SELECT target_id FROM memory_search_projection WHERE target_type='saga'").all(), 'target_id'),
    );
    for (const id of sagaIds) {
        scanned.sagas++;
        if (search.refreshSaga(db, id)) expected.add(`saga:${id}`);
    }

    const profileIds = unionIds(
        ids(db.prepare('SELECT id FROM entity_profiles').all(), 'id'),
        ids(db.prepare("SELECT target_id FROM memory_search_projection WHERE target_type='profile'").all(), 'target_id'),
    );
    for (const id of profileIds) {
        scanned.profiles++;
        search.refreshProfile(db, id);
        for (const row of db.prepare("SELECT projection_key FROM memory_search_projection WHERE target_type='profile' AND target_id=?")
            .all(id)) expected.add(row.projection_key);
    }

    for (const row of db.prepare('SELECT projection_key FROM memory_search_projection').all()) {
        if (!expected.has(row.projection_key)) search.remove(db, row.projection_key);
    }

    const currentKeys = keys(db);
    const vectorKeys = new Set(currentKeys);
    for (const row of db.prepare('SELECT projection_key FROM memory_vector_projection').all()) {
        vectorKeys.add(row.projection_key);
    }
    let vectorScheduled = 0;
    for (const key of vectorKeys) {
        const previous = db.prepare('SELECT status,revision,source_hash,operation FROM memory_vector_projection WHERE projection_key=?').get(key);
        const next = vectors.schedule(db, key);
        if (next && (!previous || previous.status !== next.status || previous.revision !== next.revision
            || previous.source_hash !== next.source_hash || previous.operation !== next.operation)) vectorScheduled++;
    }

    const after = new Set(currentKeys);
    return {
        scanned,
        search_before: before.size,
        search_after: after.size,
        search_added: [...after].filter(key => !before.has(key)).length,
        search_removed: [...before].filter(key => !after.has(key)).length,
        vector_scheduled: vectorScheduled,
    };
}

function reconcileLocal(db, { execute = false } = {}) {
    const savepoint = 'memory_projection_reconcile';
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
        const result = applyLocal(db);
        if (execute) db.exec(`RELEASE ${savepoint}`);
        else db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        return { execute, ...result };
    } catch (error) {
        try { db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); } catch (_) { /* best effort */ }
        throw error;
    }
}

module.exports = { reconcileLocal };
