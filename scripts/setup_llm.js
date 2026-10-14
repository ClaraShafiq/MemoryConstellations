// 配置记忆管线使用的默认模型连接。
// 推荐把 MEMORY_LLM_* 写入 .env 后运行 `npm run setup:llm`。
// 也支持交互式输入或 --provider/--endpoint/--model/--key/--name 参数。

require('dotenv').config();

const readline = require('readline');
const { initDatabase, getDb } = require('../database');
const { encryption } = require('../encryption');

const VALID_PROVIDERS = new Set(['gemini', 'openai_compatible']);

function parseArgs(argv) {
    const a = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--provider') a.provider = argv[++i];
        else if (argv[i] === '--key' || argv[i] === '--api-key') a.apiKey = argv[++i];
        else if (argv[i] === '--model') a.model = argv[++i];
        else if (argv[i] === '--endpoint') a.endpoint = argv[++i];
        else if (argv[i] === '--name') a.name = argv[++i];
    }
    return a;
}

function ask(rl, q) {
    return new Promise(res => rl.question(q, value => res(value.trim())));
}

function normalizeProvider(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_');
    return normalized === 'openai' ? 'openai_compatible' : normalized;
}

function validateEndpoint(value) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error('MEMORY_LLM_ENDPOINT 必须是完整 URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('MEMORY_LLM_ENDPOINT 只支持 http:// 或 https://');
    }
    return parsed.toString().replace(/\/$/, '');
}

async function collectConfig() {
    const flags = parseArgs(process.argv.slice(2));
    const config = {
        provider: normalizeProvider(flags.provider || process.env.MEMORY_LLM_PROVIDER),
        endpoint: flags.endpoint || process.env.MEMORY_LLM_ENDPOINT || '',
        model: flags.model || process.env.MEMORY_LLM_MODEL || '',
        apiKey: flags.apiKey || process.env.MEMORY_LLM_API_KEY || '',
        name: flags.name || process.env.MEMORY_LLM_NAME || 'memory-pipeline',
    };

    if (config.provider && config.endpoint && config.model && config.apiKey) return config;

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        console.log('\n配置记忆管线默认模型连接');
        config.provider = normalizeProvider(await ask(
            rl,
            `传输协议 [gemini/openai_compatible]${config.provider ? ` (回车=${config.provider})` : ''}: `
        ) || config.provider);
        config.endpoint = await ask(
            rl,
            `API endpoint${config.endpoint ? ` (回车=${config.endpoint})` : ''}: `
        ) || config.endpoint;
        config.model = await ask(
            rl,
            `模型标识${config.model ? ` (回车=${config.model})` : ''}: `
        ) || config.model;
        config.apiKey = await ask(
            rl,
            config.apiKey ? 'API key（回车使用 .env 中的值）: ' : 'API key: '
        ) || config.apiKey;
        config.name = await ask(rl, `配置名称 (回车=${config.name}): `) || config.name;
    } finally {
        rl.close();
    }
    return config;
}

async function main() {
    const config = await collectConfig();
    if (!VALID_PROVIDERS.has(config.provider)) {
        throw new Error('provider 必须是 gemini 或 openai_compatible');
    }
    if (!config.model) throw new Error('缺少 MEMORY_LLM_MODEL');
    if (!config.apiKey) throw new Error('缺少 MEMORY_LLM_API_KEY');
    config.endpoint = validateEndpoint(config.endpoint);

    initDatabase();
    const db = getDb();
    const encryptedKey = encryption.encrypt(config.apiKey);
    const save = db.transaction(() => {
        db.prepare('UPDATE api_configs SET is_default = 0 WHERE is_default = 1').run();
        const existing = db.prepare('SELECT id FROM api_configs WHERE name = ? ORDER BY id DESC LIMIT 1').get(config.name);
        if (existing) {
            db.prepare(`
                UPDATE api_configs
                SET provider = ?, endpoint = ?, api_key = ?, model_name = ?, is_default = 1, supports_tools = 1
                WHERE id = ?
            `).run(config.provider, config.endpoint, encryptedKey, config.model, existing.id);
            return existing.id;
        }
        return db.prepare(`
            INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
            VALUES (?, ?, ?, ?, ?, 1, 1)
        `).run(config.name, config.provider, config.endpoint, encryptedKey, config.model).lastInsertRowid;
    });

    const id = save();
    console.log(`\n默认记忆模型连接已保存（api_configs #${id}）`);
    console.log(`名称: ${config.name}`);
    console.log(`传输协议: ${config.provider}`);
    console.log(`模型: ${config.model}`);
    console.log(`Endpoint: ${config.endpoint}`);
    console.log('API key 已加密保存；后台 Scribe/Archivist 使用 is_default=1 的连接。');
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(`配置失败: ${error.message}`);
        process.exit(1);
    });
