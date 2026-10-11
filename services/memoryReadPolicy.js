'use strict';

const protocol = require('./memoryProtocol');

function readableClaim(db, claimId) {
    if (!protocol.eligible(db, claimId)) return false;
    const pool = db.prepare('SELECT state FROM memory_evidence_pool WHERE claim_id=?').get(claimId);
    return !!pool && ['grounded', 'unassigned'].includes(pool.state);
}

function readableProfileField(row) {
    return !!row && Number(row.revision) > 0 && !!row.input_hash && !!row.value_enc;
}

module.exports = { readableClaim, readableProfileField };
