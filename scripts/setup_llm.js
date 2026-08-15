// scripts/setup_llm.js — 引导配置轻量模型（记忆管线用的后台模型）
//
// 用法：
//   node scripts/setup_llm.js                      （交互式，推荐）
//   node scripts/setup_llm.js --provider openrouter --key sk-xxx --model "deepseek/deepseek-chat"
//
// 说明：
//   记忆管线（Scribe 提取碎片 / Archivist 分类整合 / Consolidator 编叙事）
//   需要调用 LLM，但都是后台批量任务，用「轻量模型」（flash / flash-lite 级别）
//   即可，便宜够用。聊天用的主力模型不在这里配。
//
//   本脚本在 api_configs 表里建一条 is_default=1 的配置，后台管线在
//   找不到专属配置时会自动回落到这条默认配置。
//
// 提供商预设（endpoint 自动填）：
//   openrouter   OpenAI 兼容，https://openrouter.ai/api/v1
//   deepseek     OpenAI 兼容，https://api.deepseek.com/v1
//   gemini       Gemini 原生，https://generativelanguage.googleapis.com/v1beta/models/

const readline = require('readline');
const { initDatabase, getDb } = require('../database');

const PROVIDERS = {
    openrouter: { provider: 'openai_compatible', endpoint: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', label: 'OpenRouter' },
    deepseek:   { provider: 'openai_compatible', endpoint: 'https://api.deepseek.com/v1',      model: 'deepseek-chat',        label: 'DeepSeek' },
    gemini:     { provider: 'gemini',             endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/', model: 'gemini-2.5-flash', label: 'Gemini 官方' },
};

function parseArgs(argv) {
    const a = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--provider') a.provider = argv[++i];
        else if (argv[i] === '--key' || argv[i] === '--api-key') a.key = argv[++i];
        else if (argv[i] === '--model') a.model = argv[++i];
        else if (argv[i] === '--endpoint') a.endpoint = argv[++i];
        else if (argv[i] === '--name') a.name = argv[++i];
    }
    return a;
}

function ask(rl, q) {
    return new Promise(res => rl.question(q, res));
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));

    let providerKey, apiKey, model, endpoint, name;

    if (flags.provider && flags.key) {
        // 非交互模式
        providerKey = flags.provider;
        apiKey = flags.key;
        model = flags.model || PROVIDERS[providerKey]?.model;
        endpoint = flags.endpoint || PROVIDERS[providerKey]?.endpoint;
        name = flags.name || `轻量模型 (${providerKey})`;
    } else {
        // 交互模式
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        console.log('\n🌟 配置记忆管线用的轻量模型\n');
        console.log('可选提供商：');
        for (const [k, v] of Object.entries(PROVIDERS)) {
            console.log(`   ${k.padEnd(12)} ${v.label}  (${v.endpoint})`);
        }
        console.log('（默认 openrouter）\n');

        const p = (await ask(rl, '提供商 [openrouter/deepseek/gemini] (回车=openrouter): ')).trim().toLowerCase() || 'openrouter';
        providerKey = PROVIDERS[p] ? p : 'openrouter';
        apiKey = (await ask(rl, `API Key (${PROVIDERS[providerKey].label}): `)).trim();
        if (!apiKey) { console.error('❌ API Key 不能为空'); process.exit(1); }
        const dm = PROVIDERS[providerKey].model;
        model = (await ask(rl, `模型名 (回车=${dm}): `)).trim() || dm;
        endpoint = (await ask(rl, `Endpoint (回车=${PROVIDERS[providerKey].endpoint}): `)).trim() || PROVIDERS[providerKey].endpoint;
        name = (await ask(rl, '这条配置的名字 (回车=轻量模型): ')).trim() || '轻量模型';
        rl.close();
    }

    if (!apiKey) { console.error('❌ 缺少 API Key'); process.exit(1); }
    if (!model) { console.error('❌ 缺少模型名'); process.exit(1); }

    const preset = PROVIDERS[providerKey];
    if (!preset) { console.error(`❌ 未知提供商: ${providerKey}（可选 openrouter/deepseek/gemini）`); process.exit(1); }

    initDatabase();
    const db = getDb();

    // 若已有默认配置，先取消默认（避免冲突），再插入新的默认配置
    db.prepare('UPDATE api_configs SET is_default = 0 WHERE is_default = 1').run();
    const info = db.prepare(`
        INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
        VALUES (?, ?, ?, ?, ?, 1, 1)
    `).run(name, preset.provider, endpoint, apiKey, model);

    console.log(`\n✅ 轻量模型已配置（api_configs #${info.lastInsertRowid}）`);
    console.log(`   名字:     ${name}`);
    console.log(`   提供商:   ${preset.provider}`);
    console.log(`   模型:     ${model}`);
    console.log(`   Endpoint: ${endpoint}`);
    console.log(`   已设为默认（is_default=1）`);
    console.log('\n后台记忆管线（Scribe/Archivist/Consolidator）会自动使用这条配置。');
    console.log('如需更改，重新运行本脚本即可。');
    process.exit(0);
}

main().catch(e => { console.error('❌ 配置失败:', e); process.exit(1); });
