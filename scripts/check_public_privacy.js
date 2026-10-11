'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const self = 'scripts/check_public_privacy.js';
const status = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const paths = status.map(row => row.slice(3).split(' -> ').at(-1));
const forbiddenFiles = paths.filter(name => /(^|\/)(sanctuary|work)(?:[-_.].*)?\.db(?:-(?:wal|shm))?$|\.(?:sqlite|sqlite3)(?:-(?:wal|shm))?$/i.test(name));

let additions = execFileSync('git', ['diff', '--unified=0', '--no-color', 'HEAD', '--', '.', `:(exclude)${self}`], { cwd: root }).toString()
    .split(/\r?\n/).filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
for (const relative of paths.filter(name => name !== self)) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) continue;
    const tracked = (() => { try { execFileSync('git', ['ls-files', '--error-unmatch', '--', relative], { cwd: root, stdio: 'ignore' }); return true; } catch (_) { return false; } })();
    if (!tracked && /\.(?:js|json|md|txt|yml|yaml|sh)$/i.test(relative)) additions += `\n${fs.readFileSync(absolute, 'utf8')}`;
}

const checks = [
    ['private absolute path', /\/home\/[^/]+\/Project_Sanctuary/i],
    ['private deployment domain', /draclavitiatus\./i],
    ['private persona name', /\bDraco\b/i],
    ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ['OpenAI-style secret', /\bsk-[A-Za-z0-9_-]{20,}\b/],
    ['GitHub token', /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
    ['Google API key', /\bAIza[A-Za-z0-9_-]{20,}\b/],
];
const hits = checks.filter(([, pattern]) => pattern.test(additions)).map(([name]) => name);
if (forbiddenFiles.length || hits.length) {
    if (forbiddenFiles.length) console.error(`Forbidden database artifacts: ${forbiddenFiles.join(', ')}`);
    if (hits.length) console.error(`Potential private additions: ${hits.join(', ')}`);
    process.exit(1);
}
console.log(`Privacy check OK (${paths.length} changed paths; additions only, no private patterns or database artifacts).`);
