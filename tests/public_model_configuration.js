const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const encryptionKey = '11'.repeat(32);

function cleanEnv(extra = {}) {
    return {
        ...process.env,
        SANCTUARY_ENCRYPTION_KEY: encryptionKey,
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        NO_PROXY: '',
        MEMORY_LLM_PROVIDER: '',
        MEMORY_LLM_ENDPOINT: '',
        MEMORY_LLM_MODEL: '',
        MEMORY_LLM_API_KEY: '',
        MEMORY_LLM_NAME: '',
        ...extra,
    };
}

function runNode(source, env = {}) {
    return execFileSync(process.execPath, ['-e', source], {
        cwd: repoRoot,
        env: cleanEnv(env),
        encoding: 'utf8',
    });
}

function readResult(output) {
    const line = output.split('\n').find(item => item.startsWith('TEST_RESULT='));
    assert(line, `missing TEST_RESULT in output:\n${output}`);
    return JSON.parse(line.slice('TEST_RESULT='.length));
}

const direct = readResult(runNode(`
    const llm = require('./services/llm');
    console.log('TEST_RESULT=' + JSON.stringify({
        external: llm.needsProxy('https://llm.invalid/v1'),
        dispatcher: llm.getProxyDispatcher(),
        axiosProxy: llm.getAxiosProxy('https://llm.invalid/v1')
    }));
`));
assert.strictEqual(direct.external, false);
assert.strictEqual(direct.dispatcher, null);
assert.strictEqual(direct.axiosProxy, false);

const proxied = readResult(runNode(`
    const llm = require('./services/llm');
    console.log('TEST_RESULT=' + JSON.stringify({
        external: llm.needsProxy('https://llm.invalid/v1'),
        internal: llm.needsProxy('https://api.internal.test/v1'),
        proxy: llm.getAxiosProxy('https://llm.invalid/v1')
    }));
`, {
    HTTPS_PROXY: 'http://proxy.invalid:8080',
    NO_PROXY: '.internal.test',
}));
assert.strictEqual(proxied.external, true);
assert.strictEqual(proxied.internal, false);
assert.deepStrictEqual(proxied.proxy, {
    protocol: 'http',
    host: 'proxy.invalid',
    port: 8080,
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-constellations-llm-config-'));
try {
    const configuredDb = path.join(tmpDir, 'configured.sqlite');
    execFileSync(process.execPath, ['scripts/setup_llm.js'], {
        cwd: repoRoot,
        env: cleanEnv({
            DB_PATH: configuredDb,
            MEMORY_LLM_PROVIDER: 'openai_compatible',
            MEMORY_LLM_ENDPOINT: 'https://llm.invalid/v1',
            MEMORY_LLM_MODEL: 'synthetic-atomic-extractor',
            MEMORY_LLM_API_KEY: 'test-key-not-secret',
            MEMORY_LLM_NAME: 'synthetic-test',
        }),
        encoding: 'utf8',
    });

    const configured = readResult(runNode(`
        const { initDatabase, getDb } = require('./database');
        const { encryption } = require('./encryption');
        initDatabase();
        const row = getDb().prepare('SELECT * FROM api_configs WHERE is_default = 1').get();
        console.log('TEST_RESULT=' + JSON.stringify({
            count: getDb().prepare('SELECT COUNT(*) AS count FROM api_configs').get().count,
            provider: row.provider,
            endpoint: row.endpoint,
            model: row.model_name,
            encrypted: row.api_key.startsWith('enc:'),
            decrypted: encryption.decrypt(row.api_key)
        }));
        process.exit(0);
    `, { DB_PATH: configuredDb }));
    assert.deepStrictEqual(configured, {
        count: 1,
        provider: 'openai_compatible',
        endpoint: 'https://llm.invalid/v1',
        model: 'synthetic-atomic-extractor',
        encrypted: true,
        decrypted: 'test-key-not-secret',
    });

    const emptyDb = path.join(tmpDir, 'empty.sqlite');
    const empty = readResult(runNode(`
        const { initDatabase, getDb } = require('./database');
        initDatabase();
        console.log('TEST_RESULT=' + JSON.stringify({
            count: getDb().prepare('SELECT COUNT(*) AS count FROM api_configs').get().count
        }));
        process.exit(0);
    `, { DB_PATH: emptyDb }));
    assert.strictEqual(empty.count, 0);
} finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

const scribeSource = fs.readFileSync(path.join(repoRoot, 'services', 'scribe.js'), 'utf8');
assert(!scribeSource.includes('API_CONFIG_ID: 52'));
assert(!scribeSource.includes("get(SCRIBE_CONFIG.API_CONFIG_ID)"));

const summarySource = fs.readFileSync(path.join(repoRoot, 'services', 'summary.js'), 'utf8');
assert(!summarySource.includes('gemini-3.1-flash-lite'));

const composeSource = fs.readFileSync(path.join(repoRoot, 'deploy', 'docker-compose.memory.yml'), 'utf8');
assert(composeSource.includes('MEMORY_LLM_PROVIDER=${MEMORY_LLM_PROVIDER}'));
assert(!/^\s*- API_KEY=/m.test(composeSource));

const costDoc = fs.readFileSync(path.join(repoRoot, 'docs', 'COST.md'), 'utf8');
assert(!costDoc.includes('OpenRouter'));
assert(!/\$\d/.test(costDoc));

console.log('public model configuration: ok');
