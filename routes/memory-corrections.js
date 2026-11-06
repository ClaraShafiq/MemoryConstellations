'use strict';

const express = require('express');
const { getDb } = require('../database');
const corrections = require('../services/memoryCorrection');
const router = express.Router();

router.post('/memory/corrections', (req, res) => {
    try {
        const receipt = corrections.submit(getDb(), {
            chatId: req.body?.chat_id,
            messageId: req.body?.message_id,
            quote: req.body?.quote,
            correction: req.body?.correction,
            targetClaimId: req.body?.target_claim_id,
        });
        res.status(202).json({ success: true, receipt });
    } catch (error) {
        res.status(400).json({ success: false, error: error.code || error.message });
    }
});

module.exports = router;
