'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const timeModulePath = require.resolve('../utils/time');
let passed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        console.error(`  \x1b[31m✗\x1b[0m ${name}`);
        throw error;
    }
}

function loadTimeWithZone(timeZone) {
    const previous = process.env.TZ;
    if (timeZone === undefined) delete process.env.TZ;
    else process.env.TZ = timeZone;
    delete require.cache[timeModulePath];
    const loaded = require('../utils/time');
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
    return loaded;
}

console.log('Runtime contracts');

test('TZ 环境变量是服务端时区唯一配置入口', () => {
    const time = loadTimeWithZone('Pacific/Auckland');
    assert.equal(time.APP_TIME_ZONE, 'Pacific/Auckland');
    const formatted = time.formatUtcInAppTimeZone(
        '2026-01-01 00:00:00',
        'en-GB',
        { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    );
    assert.match(formatted, /13:00/);
});

test('非法 TZ 安全回退，不把无效值传给 Intl 或 cron', () => {
    const time = loadTimeWithZone('Not/A-Time-Zone');
    assert.notEqual(time.APP_TIME_ZONE, 'Not/A-Time-Zone');
    assert.doesNotThrow(() => time.formatUtcInAppTimeZone(new Date(0)));
});

test('共享路由合同同时提供 Express pattern 与浏览器 URL builder', () => {
    const routes = require('../shared/memoryRoutes');
    assert.equal(routes.universe, '/api/memory/universe');
    assert.equal(routes.tracePattern, '/api/memory/trace/:fragmentId');
    assert.equal(routes.trace('fragment 1'), '/api/memory/trace/fragment%201');
    assert.equal(routes.mergeProposal('a/b'), '/api/memory/merge-proposal/a%2Fb');
    assert.ok(Object.isFrozen(routes));
});

test('星图前端不再手写共享 memory API URL', () => {
    const frontendDir = path.join(root, 'js', 'memory');
    const offenders = fs.readdirSync(frontendDir)
        .filter(name => name.endsWith('.js'))
        .filter(name => /fetch\s*\(\s*['"`]\/api\/memory/.test(
            fs.readFileSync(path.join(frontendDir, name), 'utf8'),
        ));
    assert.deepEqual(offenders, []);
});

test('服务端 /api/memory 路由注册也只引用共享合同', () => {
    const source = fs.readFileSync(path.join(root, 'routes/memory-api.js'), 'utf8');
    assert.match(source, /require\('\.\.\/shared\/memoryRoutes'\)/);
    assert.doesNotMatch(source, /router\.(?:get|post|put|patch|delete)\(\s*['"`]\/api\/memory(?:\/|['"`])/);
});

test('新增浏览器 ES modules 可以被 JavaScript 引擎解析', () => {
    for (const relative of ['js/memory/api.js', 'js/memory/time.js']) {
        const source = fs.readFileSync(path.join(root, relative), 'utf8');
        assert.doesNotThrow(() => new vm.SourceTextModule(source, { identifier: relative }));
    }
});

test('运行期源码不再写死城市时区', () => {
    const files = [
        'index.js',
        'tasks/cron.js',
        'routes/memory-api.js',
        'services/context.js',
        'utils/time.js',
        'js/memory/main.js',
        'js/memory/time.js',
        'deploy/docker-compose.memory.yml',
    ];
    const offenders = files.filter(relative => fs.readFileSync(path.join(root, relative), 'utf8')
        .includes('Asia/Shanghai'));
    assert.deepEqual(offenders, []);
});

test('干净 clone 的页面入口复用带 example 回退的配置加载器', () => {
    const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
    assert.match(source, /require\('\.\/services\/memoryConfig'\)/);
    assert.doesNotMatch(source, /require\('\.\/memory_config\.json'\)/);
});

console.log(`通过: ${passed}  失败: 0`);
