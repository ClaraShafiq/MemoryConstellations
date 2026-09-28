// =================================================================
// Memory Constellations — SSRF 防护冒烟测试
// 验证：utils/ssrf-guard.js 的 isPrivateIP / validateEndpoint / buildSafeUrl
// 用法: node tests/ssrf_validation.js
// =================================================================

require('dotenv').config();
const { isPrivateIP, validateEndpoint, buildSafeUrl } = require('../utils/ssrf-guard');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        passed++;
    } catch (e) {
        console.log(`  \x1b[31m✗\x1b[0m ${name}`);
        console.log(`    ${e.message}`);
        failed++;
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        passed++;
    } catch (e) {
        console.log(`  \x1b[31m✗\x1b[0m ${name}`);
        console.log(`    ${e.message}`);
        failed++;
    }
}

async function expectBlocked(endpoint) {
    try {
        await validateEndpoint(endpoint);
        throw new Error('应被拒绝，但通过了校验');
    } catch (e) {
        if (e.message === '应被拒绝，但通过了校验') throw e;
        // 其他任何 throw 都视为"被拒绝"，符合预期
    }
}

async function main() {
    console.log('🧪 Memory Constellations — SSRF 防护冒烟测试\n');

    console.log('── 1. isPrivateIP: IPv4 ──');
    test('10.0.0.1 -> 私有', () => { if (!isPrivateIP('10.0.0.1')) throw new Error('应判定为私有'); });
    test('127.0.0.1 -> 私有', () => { if (!isPrivateIP('127.0.0.1')) throw new Error('应判定为私有'); });
    test('169.254.169.254 云元数据 -> 私有', () => { if (!isPrivateIP('169.254.169.254')) throw new Error('应判定为私有'); });
    test('172.16.0.1 -> 私有', () => { if (!isPrivateIP('172.16.0.1')) throw new Error('应判定为私有'); });
    test('172.32.0.1 -> 不是私有（边界外）', () => { if (isPrivateIP('172.32.0.1')) throw new Error('不应判定为私有'); });
    test('192.168.1.1 -> 私有', () => { if (!isPrivateIP('192.168.1.1')) throw new Error('应判定为私有'); });
    test('100.64.0.1 CGNAT -> 私有', () => { if (!isPrivateIP('100.64.0.1')) throw new Error('应判定为私有'); });
    test('0.0.0.0 -> 私有', () => { if (!isPrivateIP('0.0.0.0')) throw new Error('应判定为私有'); });
    test('192.0.0.1 IETF协议保留段 -> 私有', () => { if (!isPrivateIP('192.0.0.1')) throw new Error('应判定为私有'); });
    test('192.0.2.1 TEST-NET-1 -> 私有', () => { if (!isPrivateIP('192.0.2.1')) throw new Error('应判定为私有'); });
    test('198.18.0.1 benchmarking -> 私有', () => { if (!isPrivateIP('198.18.0.1')) throw new Error('应判定为私有'); });
    test('198.51.100.1 TEST-NET-2 -> 私有', () => { if (!isPrivateIP('198.51.100.1')) throw new Error('应判定为私有'); });
    test('203.0.113.1 TEST-NET-3 -> 私有', () => { if (!isPrivateIP('203.0.113.1')) throw new Error('应判定为私有'); });
    test('224.0.0.1 多播 -> 私有', () => { if (!isPrivateIP('224.0.0.1')) throw new Error('应判定为私有'); });
    test('240.0.0.1 保留段 -> 私有', () => { if (!isPrivateIP('240.0.0.1')) throw new Error('应判定为私有'); });
    test('255.255.255.255 广播 -> 私有', () => { if (!isPrivateIP('255.255.255.255')) throw new Error('应判定为私有'); });
    test('8.8.8.8 -> 公网', () => { if (isPrivateIP('8.8.8.8')) throw new Error('不应判定为私有'); });

    console.log('\n── 2. isPrivateIP: IPv6 ──');
    test('::1 loopback -> 私有', () => { if (!isPrivateIP('::1')) throw new Error('应判定为私有'); });
    test(':: 未指定 -> 私有', () => { if (!isPrivateIP('::')) throw new Error('应判定为私有'); });
    test('fd00::1 唯一本地地址 -> 私有', () => { if (!isPrivateIP('fd00::1')) throw new Error('应判定为私有'); });
    test('fc00::1 唯一本地地址 -> 私有', () => { if (!isPrivateIP('fc00::1')) throw new Error('应判定为私有'); });
    test('fe80::1 链路本地 -> 私有', () => { if (!isPrivateIP('fe80::1')) throw new Error('应判定为私有'); });
    test('::ffff:127.0.0.1 IPv4映射loopback -> 私有', () => { if (!isPrivateIP('::ffff:127.0.0.1')) throw new Error('应判定为私有'); });
    test('::ffff:7f00:1 IPv4映射（纯hex形式） -> 私有', () => { if (!isPrivateIP('::ffff:7f00:1')) throw new Error('应判定为私有'); });
    test('::ffff:8.8.8.8 IPv4映射公网 -> 不是私有', () => { if (isPrivateIP('::ffff:8.8.8.8')) throw new Error('不应判定为私有'); });
    test('2001:4860:4860::8888（Google公网DNS） -> 不是私有', () => { if (isPrivateIP('2001:4860:4860::8888')) throw new Error('不应判定为私有'); });

    console.log('\n── 3. validateEndpoint: 协议/凭证/格式（本地判定，无需网络） ──');
    await asyncTest('http:// 协议 -> 拒绝', async () => { await expectBlocked('http://example.com'); });
    await asyncTest('URL内嵌用户名密码 -> 拒绝', async () => { await expectBlocked('https://user:pass@example.com'); });
    await asyncTest('非法URL格式 -> 拒绝', async () => { await expectBlocked('not a url'); });

    console.log('\n── 4. validateEndpoint: IP字面量（本地解析，无需网络） ──');
    await asyncTest('https://127.0.0.1 -> 拒绝', async () => { await expectBlocked('https://127.0.0.1'); });
    await asyncTest('https://10.0.0.1 -> 拒绝', async () => { await expectBlocked('https://10.0.0.1'); });
    await asyncTest('https://169.254.169.254（云元数据） -> 拒绝', async () => { await expectBlocked('https://169.254.169.254'); });
    await asyncTest('https://[::1] -> 拒绝', async () => { await expectBlocked('https://[::1]'); });
    await asyncTest('https://[fd00::1] -> 拒绝', async () => { await expectBlocked('https://[fd00::1]'); });
    await asyncTest('https://8.8.8.8（公网IP字面量） -> 允许', async () => { await validateEndpoint('https://8.8.8.8'); });

    console.log('\n── 5. validateEndpoint: 域名解析（需要网络DNS，离线环境自动跳过） ──');
    await asyncTest('https://generativelanguage.googleapis.com/v1beta -> 允许（公网域名）', async () => {
        try {
            await validateEndpoint('https://generativelanguage.googleapis.com/v1beta');
        } catch (e) {
            if (e.message === '无法解析endpoint地址') {
                console.log('    \x1b[33m⚠ 跳过：无网络DNS\x1b[0m');
                return;
            }
            throw e;
        }
    });
    await asyncTest('169.254.169.254.nip.io（通配符DNS重绑定演示） -> 拒绝', async () => {
        let unresolvable = false;
        try {
            await validateEndpoint('https://169.254.169.254.nip.io');
        } catch (e) {
            if (e.message === '无法解析endpoint地址') unresolvable = true;
            else return; // 其他 throw 视为正确拒绝
        }
        if (unresolvable) {
            console.log('    \x1b[33m⚠ 跳过：无网络DNS\x1b[0m');
            return;
        }
        throw new Error('应被拒绝，但通过了校验');
    });

    console.log('\n── 6. buildSafeUrl: 路径拼接不能丢失 base 的子路径 ──');
    test('endpoint带子路径 /v1beta（无末尾斜杠） -> 拼接结果仍包含 /v1beta/models/', () => {
        const base = new URL('https://generativelanguage.googleapis.com/v1beta');
        const url = buildSafeUrl(base, 'models', 'gemini-2.5-flash:generateContent');
        if (!url.pathname.includes('/v1beta/models/')) throw new Error(`路径拼接错误，得到: ${url.pathname}`);
    });
    test('endpoint末尾已有斜杠 -> 拼接结果同样正确', () => {
        const base = new URL('https://generativelanguage.googleapis.com/v1beta/');
        const url = buildSafeUrl(base, 'models', 'gemini-2.5-flash:generateContent');
        if (!url.pathname.includes('/v1beta/models/')) throw new Error(`路径拼接错误，得到: ${url.pathname}`);
    });

    // ── 结果 ──
    console.log(`\n══════════════════`);
    console.log(`通过: ${passed}  失败: ${failed}`);
    if (failed === 0) {
        console.log('🎉 SSRF 防护校验通过！');
    } else {
        console.log('⚠️  有测试失败。');
        process.exit(1);
    }
    process.exit(0);
}

main().catch(e => {
    console.error('💥 测试中断:', e.message);
    process.exit(1);
});
