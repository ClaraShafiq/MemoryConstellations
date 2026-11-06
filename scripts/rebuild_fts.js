// Legacy FTS health check and deterministic rebuild.
// Modern verified publications use memory_search_projection instead.
'use strict';

require('dotenv').config();
const { initDatabase } = require('../database');
const legacyFts = require('../services/memoryLegacyFts');

const db = initDatabase();
const checkOnly = process.argv.includes('--check');
const deep = process.argv.includes('--deep') || checkOnly;
const result = checkOnly ? legacyFts.inspect(db, { deep }) : legacyFts.rebuild(db);

console.log(JSON.stringify(result, null, 2));
const health = checkOnly ? result : result.health;
process.exitCode = health.status === 'healthy' ? 0 : 1;
