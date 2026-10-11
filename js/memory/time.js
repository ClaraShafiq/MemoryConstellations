const UI = globalThis.MEMORY_UI_CONFIG || {};

export const APP_TIME_ZONE = UI.timeZone
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC';

export function parseUtcTimestamp(value) {
    if (!value) return null;
    const text = String(value);
    const date = new Date(text + (/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? '' : 'Z'));
    return Number.isNaN(date.getTime()) ? null : date;
}

export function formatUtcTimestamp(value, options = {}) {
    const date = parseUtcTimestamp(value);
    if (!date) return '';
    return date.toLocaleString('zh-CN', { ...options, timeZone: APP_TIME_ZONE });
}
