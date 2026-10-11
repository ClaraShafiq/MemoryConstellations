'use strict';

// Runtime adapters are optional. The host accepts proposals only through
// memoryCodexExecutor; this module never grants shell or SQL access.
const { spawn } = require('node:child_process');
function createAdapter(propose) {
    if (typeof propose !== 'function') throw new Error('memory_codex_adapter_requires_propose');
    return { async propose(job) {
        const action = await propose(Object.freeze({
            id: job.id, stage: job.stage, target_type: job.target_type,
            target_id: job.target_id, input_revision: job.input_revision, input_hash: job.input_hash,
        }));
        if (typeof action === 'string') return JSON.parse(action);
        return action;
    } };
}

function createCliAdapter({ executable = 'codex', cwd, timeoutMs = 120000 } = {}) {
    if (process.env.ALLOW_MEMORY_CODEX_CLI !== '1') throw new Error('memory_codex_cli_not_enabled');
    if (!cwd) throw new Error('memory_codex_isolated_cwd_required');
    return createAdapter(job => new Promise((resolve, reject) => {
        const child = spawn(executable, ['exec', '--json', '--sandbox', 'read-only', '-'], {
            cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) return reject(Object.assign(new Error(stderr.trim() || `codex_exit_${code}`), { code: 'codex_cli_failed' }));
            try {
                const events = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
                const messages = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message');
                const text = messages.at(-1)?.item?.text;
                if (!text) throw new Error('codex_cli_empty_action');
                resolve(JSON.parse(text));
            } catch (error) {
                reject(Object.assign(error, { code: 'codex_cli_invalid_action' }));
            }
        });
        child.stdin.end(JSON.stringify({
            instruction: 'Return exactly one JSON action allowed by services/memoryCodexReviewPolicy.js. Do not write files, run SQL, or produce first-person judgment.',
            job,
        }));
    }));
}

module.exports = { createAdapter, createCliAdapter };
