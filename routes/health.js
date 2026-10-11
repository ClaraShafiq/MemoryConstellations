'use strict';

const express = require('express');
const { getDb } = require('../database');
const readMode = require('../services/memoryReadMode');
const router = express.Router();

router.get('/health', (_req, res) => {
    try {
        const db = getDb();
        const version = db.prepare('SELECT MAX(version) version FROM schema_version').get().version || 0;
        const counts = Object.fromEntries([
            ['claims', 'memory_claims'], ['evidence', 'memory_evidence_pool'],
            ['episodes', 'memory_episode_publications'], ['profile_fields', 'memory_profile_field_publications'],
            ['search_units', 'memory_search_projection'],
        ].map(([key, table]) => [key, db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count]));
        res.json({ ok: true, schema_version: version, chat_read_mode: readMode.get(db),
            semantic_maintenance: readMode.semanticMode(db), counts });
    } catch (error) {
        res.status(503).json({ ok: false, error: 'memory_pipeline_unavailable' });
    }
});

module.exports = router;
