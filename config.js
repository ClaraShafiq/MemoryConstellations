// =================================================================
// 配置常量 + 记忆日志加载
// =================================================================

const fs = require('fs');

const CONFIG = {
    PORT: 3000,
    PASSWORD: '$2b$10$Z0Bktu0.AYLM.ELOGIgD..bTgLSg2X1khz5qG20wr7/XXMudpcfoK',
    SESSION_SECRET: process.env.SESSION_SECRET || '250103',
    SESSION_MAX_AGE: 24 * 60 * 60 * 1000,
    JSON_LIMIT: '20mb',
    DEFAULT_MODEL: 'gemini-2.5-pro',
    DEFAULT_MAX_TOKENS: 4000,
    HISTORY_TOKEN_LIMIT: 8000,
    REQUEST_BUDGET: 100000,
};

// 读取记忆日志（文本格式，注入system prompt用）
function loadMemoryLog() {
    try {
        const memoryLogPath = './memory_log.json';
        if (fs.existsSync(memoryLogPath)) {
            const logData = JSON.parse(fs.readFileSync(memoryLogPath, 'utf8'));
            
            let memoryText = "\n\n【最近的记忆】\n";
            
            if (logData.recent_memory && logData.recent_memory.length > 0) {
                memoryText += "本周发生的事：\n";
                for (const entry of logData.recent_memory) {
                    memoryText += `${entry.date} (${entry.weekday}): ${entry.log}\n\n`;
                }
            }
            
            if (logData.important_moments && logData.important_moments.length > 0) {
                memoryText += "重要时刻：\n";
                for (const moment of logData.important_moments) {
                    memoryText += `• ${moment.date}: ${moment.description}\n`;
                }
            }
            
            return memoryText;
        }
        return "";
    } catch (error) {
        console.error('loadMemoryLog failed:', error);
        return "";
    }
}

// 读取记忆日志（JSON对象格式）
function loadMemoryLogJSON() {
    try {
        const memoryLogPath = './memory_log.json';
        if (fs.existsSync(memoryLogPath)) {
            return JSON.parse(fs.readFileSync(memoryLogPath, 'utf8'));
        }
        return { recent_memory: [], important_moments: [] };
    } catch (error) {
        console.error('loadMemoryLogJSON failed:', error);
        return { recent_memory: [], important_moments: [] };
    }
}

module.exports = {
    CONFIG,
    loadMemoryLog,
    loadMemoryLogJSON
};