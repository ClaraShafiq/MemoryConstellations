'use strict';

const express = require('express');
const { getDb } = require('../database');
const readMode = require('../services/memoryReadMode');
const release = require('../services/memoryReleaseGate');
const vectors = require('../services/memoryVectorProjection');
const runner = require('../services/memoryMaintenanceRunner');
const derivedHealth = require('../services/memoryDerivedStateHealth');
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
        const manifest = vectors.manifest(db);
        const derived = derivedHealth.inspectLocal(db);
        const mode = readMode.state(db);
        res.status(derived.status === 'unverifiable' ? 503 : 200).json({ ok: derived.status !== 'unverifiable',
            schema_version: version, chat_read_mode: mode.effective,
            requested_chat_read_mode: readMode.requested(db),
            chat_read_state: mode,
            semantic_maintenance: readMode.semanticMode(db), maintenance_runner: runner.status(),
            verified_release: { ready: release.isReady(db), vector_manifest_ready: manifest.ready,
                expected: manifest.expected, done: manifest.done, blockers: manifest.blockers },
            derived_memory_health: derived, counts });
    } catch (error) {
        res.status(503).json({ ok: false, error: 'memory_pipeline_unavailable' });
    }
});

module.exports = router;
