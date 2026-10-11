'use strict';

const identity = require('./memoryConstellationIdentity');
const constellation = require('./memoryConstellation');

module.exports = {
    createCandidate: identity.createCandidate,
    resolveIdentity: identity.resolveIdentity,
    admit: constellation.admit,
    addRelation: constellation.addRelation,
};
