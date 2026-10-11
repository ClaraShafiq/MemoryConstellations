'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const files = ['README.md', 'OSS_SETUP.md', ...fs.readdirSync(path.join(root, 'docs'))
    .filter(name => name.endsWith('.md')).map(name => `docs/${name}`)];
const missing = [];

for (const relative of files) {
    const absolute = path.join(root, relative);
    const text = fs.readFileSync(absolute, 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].trim().replace(/^<|>$/g, '').split('#')[0];
        if (!target || /^(https?:|mailto:)/i.test(target)) continue;
        const resolved = path.resolve(path.dirname(absolute), decodeURIComponent(target));
        if (!fs.existsSync(resolved)) missing.push(`${relative} -> ${target}`);
    }
}

if (missing.length) {
    console.error(`Broken documentation links:\n${missing.join('\n')}`);
    process.exit(1);
}
console.log(`Documentation links OK (${files.length} Markdown files checked).`);
