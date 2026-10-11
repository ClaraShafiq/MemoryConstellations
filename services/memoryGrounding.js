'use strict';

const evidence = require('./memoryEvidenceResolution');

module.exports = { reconcile: evidence.reconcile, current: evidence.current };
