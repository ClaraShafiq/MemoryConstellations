// services/tools/index.js
// 工具注册表 — OSS: 仅记忆相关工具

const tools = [
  ...require('./memoryTools'),
  require('./manageUserState'),
];

function isEnabled(v) {
  return v !== false && v !== 'false' && v !== 0 && v !== '0';
}

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

async function executeTool(name, args, context) {
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    console.log(`[Tools] 未知工具: ${name}`);
    return { success: false, error: '未知工具' };
  }
  return tool.handler(args, context);
}

module.exports = { getEnabledTools, executeTool };
