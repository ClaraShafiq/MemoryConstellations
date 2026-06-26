// Memory Constellations — 配置常量

const CONFIG = {
    PORT: process.env.PORT || 3000,
    SESSION_SECRET: process.env.SESSION_SECRET || 'memory-constellations',
    SESSION_MAX_AGE: 24 * 60 * 60 * 1000,
    JSON_LIMIT: '20mb',
    DEFAULT_MAX_TOKENS: 4000,
    HISTORY_TOKEN_LIMIT: 8000,
};

module.exports = { CONFIG };
