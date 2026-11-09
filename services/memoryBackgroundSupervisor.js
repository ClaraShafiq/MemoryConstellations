'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');

const FAILURE_LIMIT = 3;
const FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
let child = null;
let failures = 0;
let retryAfter = 0;
let lastResult = null;

function tick(db, options = {}) {
    const gate = require('./memoryForegroundGate').status(db);
    if (gate.blocked) return Promise.resolve({ outcome: 'skipped', reason: gate.reason });
    if (child) return Promise.resolve({ outcome: 'skipped', reason: 'background_child_active' });
    if (Date.now() < retryAfter) return Promise.resolve({ outcome: 'skipped', reason: 'background_failure_cooldown', retry_after: retryAfter });
    return new Promise(resolve => {
        const script = path.join(__dirname, 'memoryBackgroundProcess.js');
        child = fork(script, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
            env: { ...process.env, MEMORY_BACKGROUND_CHILD: '1' } });
        let reported = null;
        child.on('message', message => { reported = message; });
        child.once('exit', code => {
            child = null;
            if (code === 0) {
                failures = 0;
                lastResult = reported?.result || { outcome: 'done' };
            } else {
                failures++;
                lastResult = { outcome: 'failed', error: reported?.error || `child_exit_${code}` };
                if (failures >= FAILURE_LIMIT) retryAfter = Date.now() + FAILURE_COOLDOWN_MS;
            }
            resolve(lastResult);
        });
    });
}

function status() {
    return { active: !!child, failures, retry_after: retryAfter, last_result: lastResult };
}

module.exports = { FAILURE_LIMIT, FAILURE_COOLDOWN_MS, tick, status };
