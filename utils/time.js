// =================================================================
// 时间工具函数（上海时区 UTC+8）
// =================================================================

const getShanghaiTime = () => {
    try {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const shanghaiTime = new Date(utc + (8 * 3600000));
        
        const year = shanghaiTime.getFullYear();
        const month = String(shanghaiTime.getMonth() + 1).padStart(2, '0');
        const day = String(shanghaiTime.getDate()).padStart(2, '0');
        const hour = String(shanghaiTime.getHours()).padStart(2, '0');
        const minute = String(shanghaiTime.getMinutes()).padStart(2, '0');
        const second = String(shanghaiTime.getSeconds()).padStart(2, '0');
        
        return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
    } catch (error) {
        console.error('getShanghaiTime failed:', error);
        return new Date().toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        }).replace(/\//g, '-').replace(/,/g, '');
    }
};

const getTimeOfDay = () => {
    try {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const shanghaiTime = new Date(utc + (8 * 3600000));
        const hour = shanghaiTime.getHours();
        
        if (hour >= 5 && hour < 11) return '早上';
        if (hour >= 11 && hour < 13) return '中午';
        if (hour >= 13 && hour < 17) return '下午';
        if (hour >= 17 && hour < 19) return '傍晚';
        if (hour >= 19 && hour < 23) return '晚上';
        return '深夜';
    } catch (error) {
        console.error('getTimeOfDay failed:', error);
        return '';
    }
};

module.exports = { getShanghaiTime, getTimeOfDay };