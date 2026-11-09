'use strict';

const express = require('express');
const { getDb } = require('../database');
const gate = require('../services/memoryForegroundGate');
const router = express.Router();

router.post('/memory/runtime/foreground/start', (req, res) => {
    const lease = gate.acquire(getDb(), { owner: req.body?.owner, ttlMs: req.body?.ttl_ms });
    res.json({ success: true, ...lease });
});

router.post('/memory/runtime/foreground/end', (req, res) => {
    const result = gate.release(getDb(), req.body?.token, { cooldownMs: req.body?.cooldown_ms });
    if (!result.released) return res.status(409).json({ success: false, error: 'foreground_lease_not_found' });
    res.json({ success: true });
});

router.get('/memory/runtime/status', (_req, res) => {
    res.json({ success: true, foreground: gate.status(getDb()),
        background: require('../services/memoryBackgroundSupervisor').status() });
});

module.exports = router;
