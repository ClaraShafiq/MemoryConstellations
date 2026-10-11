'use strict';

const protocol = require('./memoryProtocol');
const classification = require('./memoryClassification');
const evidence = require('./memoryEvidenceResolution');
const identity = require('./memoryConstellationIdentity');
const profiles = require('./memoryProfileProjection');

function inspect(db, targetType, targetId) {
    if (targetType === 'claim') {
        const claim = protocol.readClaim(db, targetId);
        return { claim, duty: db.prepare('SELECT * FROM memory_claim_duties WHERE claim_id=?').get(targetId) || null,
            classification: db.prepare('SELECT * FROM memory_claim_classification WHERE claim_id=?').get(targetId) || null,
            evidence: evidence.current(db, targetId) };
    }
    if (targetType === 'constellation_candidate') return identity.snapshot(db, targetId);
    if (targetType === 'entity') return profiles.snapshot(db, targetId);
    if (targetType === 'classification') return classification.snapshot(db, targetId);
    protocol.fail('investigation_target_invalid');
}

module.exports = { inspect };
