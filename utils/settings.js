// utils/settings.js
// 用户设置读写工具函数（从 index.js 拆出）

const { getDb } = require('../database');

const getUserSetting = async (key) => {
    try {
        const db = getDb();
        const setting = db.prepare(`
            SELECT setting_value 
            FROM user_settings 
            WHERE setting_key = ?
        `).get(key);
        
        if (!setting) {
            return { value: null };
        }
        
        // 尝试转成数字，如果不行就返回原值
        const rawValue = setting.setting_value;
        const numValue = Number(rawValue);
        
        return { 
            value: isNaN(numValue) ? rawValue : numValue 
        };
    } catch (error) {
        console.error(`获取用户设置 ${key} 失败:`, error);
        return { value: null };
    }
};

const setUserSetting = async (key, value) => {
    try {
        const db = getDb();
        db.prepare(`
            INSERT INTO user_settings (setting_key, setting_value, updated_at) 
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(setting_key) 
            DO UPDATE SET setting_value = ?, updated_at = CURRENT_TIMESTAMP
        `).run(key, value, value);
        
        if (key !== 'draco_state_snapshot') {
            console.log(`✅ 设置已更新: ${key} = ${value}`);
        }
    } catch (error) {
        console.error(`❌ 设置用户设置 ${key} 失败:`, error);
        throw error;
    }
};

module.exports = { getUserSetting, setUserSetting };