// services/tools/index.js
// 工具注册表：统一管理工具发现、开关、执行

const tools = [
  ...require('./alarms'),
  ...require('./ccBridge'),
  ...require('./memoryTools'),
  ...require('./musicTools'),
  require('./rememberTo'),
  require('./manageClaraState'),
];

function isEnabled(v) {
  return v !== false && v !== 'false' && v !== 0 && v !== '0';
}

/**
 * 获取当前启用的工具列表（按 setting + whitelist 过滤）
 * @param {object} opts
 * @param {Function} opts.getUserSetting - 读设置函数
 * @param {boolean} [opts.skipTools] - 跳过所有工具
 * @param {string[]} [opts.toolWhitelist] - 只允许这些工具
 * @returns {Promise<{functionDeclarations: object[], instructionText: string}>}
 */
async function getEnabledTools({ getUserSetting, skipTools, toolWhitelist }) {
  if (skipTools) return { functionDeclarations: [], instructionText: '' };

  const enabled = [];
  let instructionText = '';

  for (const tool of tools) {
    if (toolWhitelist && !toolWhitelist.includes(tool.name)) continue;

    if (tool.settingsKey) {
      const setting = await getUserSetting(tool.settingsKey);
      const effectiveValue = setting.value == null ? tool.defaultEnabled : setting.value;
      if (!isEnabled(effectiveValue)) continue;
    }

    enabled.push(tool);
    if (tool.instructionText) {
      instructionText += `${tool.instructionText}\n\n`;
    }
  }

  return {
    functionDeclarations: enabled.map(t => t.getFunctionDeclaration()),
    instructionText: instructionText.trim(),
  };
}

/**
 * 执行指定工具
 * @param {string} name - 工具名
 * @param {object} args - 参数
 * @param {object} context - 调用上下文 { chatId, lastClaraMessage }
 * @returns {Promise<object>} { success, formatted, ... }
 */
async function executeTool(name, args, context) {
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    console.log(`⚠️ [工具注册表] 未知工具: ${name}`);
    return { success: false, error: '未知工具' };
  }
  return tool.handler(args, context);
}

module.exports = { getEnabledTools, executeTool };
