// =================================================================
// 庇护所加密系统 - 最终修复版 (encryption.js)
// =================================================================

const crypto = require('crypto');

class SanctuaryEncryption {
    constructor() {
        // 从环境变量获取加密密钥
        this.encryptionKey = process.env.SANCTUARY_ENCRYPTION_KEY;
        this.algorithm = 'aes-256-gcm';
        
        if (!this.encryptionKey) {
            console.error('❌ 未找到SANCTUARY_ENCRYPTION_KEY环境变量！');
            throw new Error('加密密钥未设置');
        }
        
        if (this.encryptionKey.length !== 64) {
            console.error('❌ 加密密钥长度不正确，应为64个十六进制字符');
            throw new Error('加密密钥格式错误');
        }
        
        console.log('🔐 加密系统初始化成功');
    }
    
    // 加密文本
    encrypt(text) {
        console.log('🔐 encrypt被调用, text类型:', typeof text, 'text长度:', text?.length);
        if (!text || typeof text !== 'string') {
            console.log('⚠️ text不是有效字符串，返回原值');
            return text;
        }
        
        if (text === '') {
            console.log('⚠️ text是空字符串');
            return '';  // 空字符串直接返回
        }
        
        try {
            const iv = crypto.randomBytes(16);
            const key = Buffer.from(this.encryptionKey, 'hex');

            console.log('🔐 开始加密, key长度:', key.length, 'iv长度:', iv.length);
            
            const cipher = crypto.createCipheriv(this.algorithm, key, iv);
            
            let encrypted = cipher.update(text, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            
            const authTag = cipher.getAuthTag();
            
            const result = `enc:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
            console.log('✅ 加密成功, 结果长度:', result.length);
            return result;
                } catch (error) {
                    console.error('🚨 加密失败:', error);
                    return text;
        }
    }
    
    // 解密文本。opts.silent 静默已知的预期失败（如旧数据密钥轮换后的残留密文）
    decrypt(encryptedText, opts = {}) {
        if (!encryptedText || typeof encryptedText !== 'string') {
            return encryptedText;
        }

        if (!encryptedText.startsWith('enc:')) {
            return encryptedText;
        }

        try {
            const parts = encryptedText.substring(4).split(':');
            if (parts.length !== 3) {
                if (!opts.silent) console.warn('解密格式错误:', encryptedText.substring(0, 50));
                return '[解密失败：格式错误]';
            }

            const [ivHex, authTagHex, encrypted] = parts;
            const iv = Buffer.from(ivHex, 'hex');
            const authTag = Buffer.from(authTagHex, 'hex');
            const key = Buffer.from(this.encryptionKey, 'hex');

            const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
            decipher.setAuthTag(authTag);

            let decrypted = decipher.update(encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');

            return decrypted;
        } catch (error) {
            if (!opts.silent) console.warn('解密失败:', error.message, '| data:', encryptedText.substring(0, 60));
            return '[解密失败的消息]';
        }
    }
    
    // 检查文本是否已加密
    isEncrypted(text) {
        return text && typeof text === 'string' && text.startsWith('enc:');
    }
}

// 创建全局加密实例
const encryption = new SanctuaryEncryption();

// 导出供index.js使用
module.exports = {
    encryption
};