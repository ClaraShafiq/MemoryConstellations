'use strict';

const protocol = require('./memoryProtocol');

function readableClaim(db, claimId) {
    if (!protocol.eligible(db, claimId)) return false;
    const pool = db.prepare('SELECT * FROM memory_evidence_pool WHERE claim_id=?').get(claimId);
    const claim = db.prepare('SELECT revision,input_hash FROM memory_claims WHERE id=?').get(claimId);
    return !!pool && !!claim && ['grounded', 'unassigned'].includes(pool.state)
        && Number(pool.claim_revision) === Number(claim.revision) && pool.input_hash === claim.input_hash;
}

function readableProfileField(db, row) {
    if (!row || Number(row.revision) <= 0 || !row.input_hash || !row.value_enc) return false;
    try {
        const current = require('./memoryProfileProjection').snapshot(db, row.entity_id, row.field);
        return current.input_hash === row.input_hash;
    } catch (_) {
        return false;
    }
}

function readableEpisode(db, row) {
    if (!row) return false;
    try {
        const current = require('./memoryEpisodeProjection').snapshot(db, row.candidate_id);
        return current.input_hash === row.input_hash
            && current.claims.every(claim => readableClaim(db, claim.id));
    } catch (_) {
        return false;
    }
}

function readableSaga(db, row) {
    if (!row) return false;
    try {
        const ids = JSON.parse(row.episode_ids_json || '[]');
        if (!ids.length) return false;
        const hash = require('./memorySagaProjection').inputHash(db, ids);
        if (hash !== row.input_hash) return false;
        return ids.every(id => {
            const episode = db.prepare('SELECT * FROM memory_episode_publications WHERE memory_id=?').get(id);
            return readableEpisode(db, episode);
        });
    } catch (_) {
        return false;
    }
}

function projectionCurrent(db, row) {
    if (!row) return false;
    if (row.target_type === 'claim') {
        const claim = db.prepare('SELECT revision,input_hash FROM memory_claims WHERE id=?').get(row.target_id);
        return readableClaim(db, row.target_id) && Number(row.revision) === Number(claim?.revision)
            && row.input_hash === claim?.input_hash;
    }
    if (row.target_type === 'profile') {
        const publication = db.prepare(`SELECT * FROM memory_profile_field_publications
            WHERE entity_id=? AND field=?`).get(row.target_id, row.field);
        return readableProfileField(db, publication) && Number(row.revision) === Number(publication?.revision)
            && row.input_hash === publication?.input_hash;
    }
    if (row.target_type === 'episode') {
        const publication = db.prepare('SELECT * FROM memory_episode_publications WHERE memory_id=?').get(row.target_id);
        return readableEpisode(db, publication) && Number(row.revision) === Number(publication?.revision)
            && row.input_hash === publication?.input_hash;
    }
    if (row.target_type === 'saga') {
        const publication = db.prepare('SELECT * FROM memory_saga_publications WHERE saga_id=?').get(row.target_id);
        return readableSaga(db, publication) && Number(row.revision) === Number(publication?.revision)
            && row.input_hash === publication?.input_hash;
    }
    return false;
}

module.exports = { readableClaim, readableProfileField, readableEpisode, readableSaga, projectionCurrent };
