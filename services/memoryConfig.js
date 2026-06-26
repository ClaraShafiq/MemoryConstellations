// =================================================================
// memoryConfig — 记忆子系统配置加载器
//
// 读取 memory_config.json，提供 {{user.name}} 等模板变量替换。
// 所有硬编码的 Clara/Draco 引用应通过此模块获取，而不是直接写字符串。
//
// 消费端用法:
//   const { USER, AI, REL, PROJ, fillTemplate } = require('./memoryConfig');
//   const prompt = fillTemplate(`你是${AI.name}，${USER.name}的${REL.type}`);
// =================================================================

// Fall back to .example.json if memory_config.json doesn't exist (fresh clone)
let config;
try {
    config = require('../memory_config.json');
} catch (_) {
    console.log('[memoryConfig] memory_config.json 未找到，使用 memory_config.example.json');
    config = require('../memory_config.example.json');
}

// Flatten template variables from config (recursive {{key.subkey}} resolution)
function resolveTemplate(template) {
    let result = template;
    // Support {{user.name}}, {{ai.name}}, {{project.name}}
    result = result.replace(/\{\{user\.name\}\}/g, config.user.name);
    result = result.replace(/\{\{user\.pronoun\}\}/g, config.user.pronoun);
    result = result.replace(/\{\{user\.short_desc\}\}/g, config.user.short_desc);
    result = result.replace(/\{\{ai\.name\}\}/g, config.ai.name);
    result = result.replace(/\{\{ai\.pronoun\}\}/g, config.ai.pronoun);
    result = result.replace(/\{\{project\.name\}\}/g, config.project.name);
    return result;
}

// Resolve nested templates within config values
function resolveConfig() {
    const resolved = JSON.parse(JSON.stringify(config));
    for (const section of Object.values(resolved)) {
        if (typeof section === 'object') {
            for (const [key, val] of Object.entries(section)) {
                if (typeof val === 'string') {
                    section[key] = resolveTemplate(val);
                }
            }
        }
    }
    return resolved;
}

const resolved = resolveConfig();

// Entity names to skip in queries (twin stars are managed separately)
const SKIP_NAMES = [
    resolved.user.name,
    resolved.ai.name,
    resolved.user.name.toLowerCase(),
    resolved.ai.name.toLowerCase(),
];

module.exports = {
    config: resolved,
    USER: resolved.user,
    AI: resolved.ai,
    SKIP_NAMES,
    REL: resolved.relationship,
    PROJ: resolved.project,
    UI: resolved.ui,
    resolveTemplate,
};
