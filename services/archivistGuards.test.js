// ============================================================
// Archivist 守卫规则回归测试（纯函数，不碰库）
// 运行：/usr/bin/node services/archivistGuards.test.js
//   （要用 /usr/bin/node —— better-sqlite3 编译在 v18 上）
//
// 三条规则都是 2026-09-28 加的止血：
//   1. isTimePhraseName    —— 纯日期/时间短语不是实体（2026-09-04 b6800fd 立）
//   2. isPeriodPhraseName  —— 以期间词收尾的名字不是实体（2026-09-28 新）
//   3. isNoChangeSentinel  —— 「无明显变化」是哨兵，不落库（2026-09-28 新）
//
// ⚠️ 改词表前先读这三条规则的注释（services/archivist.js 顶部附近）。
//    第 2 条刻意不含「计划」「系列」「记录」——「曼哈顿计划」「哈利波特系列」
//    这类可能是正经项目/作品名，误杀代价比放过一条大。要加词先在这里补用例。
// ============================================================

const { isTimePhraseName, isPeriodPhraseName, isNoChangeSentinel } = require('./archivist');

let passed = 0;
let failed = 0;

function ok(desc, cond) {
    if (cond) { passed++; console.log(`  ✓ ${desc}`); }
    else { failed++; console.error(`  ✗ ${desc}`); }
}

console.log('\n[1] isTimePhraseName — 纯日期/时间短语');
for (const s of ['日晚', '日凌晨', '日傍晚', '日上午', '日下午', '三点半', '周六', '年月日']) {
    ok(`拒「${s}」`, isTimePhraseName(s) === true);
}
for (const s of ['阿日斯兰', '下午茶', '哈利波特', '日晚报', '星铁', '点数']) {
    ok(`放行「${s}」`, isTimePhraseName(s) === false);
}

console.log('\n[2] isPeriodPhraseName — 期间词收尾');
// ⚠️ 用例一律用**完全中性的词**（工程/流程类）。
// **不要写带着生活特征的组合——哪怕前面加个「某」也没用**：几个具体名词凑在一起，
// 本身就是可识别信息，遮住专有名词不等于匿名。这条同样适用于以后往这里加用例的人。
for (const s of [
    '筹备季', '审计期', '交付历程', '迁移过程', '巡检日常', '试运行阶段',
    '招标季', '验收期', '优化历程', '联调过程',
]) {
    ok(`拒「${s}」`, isPeriodPhraseName(s) === true);
}
for (const s of [
    // 专有名词：不以期间词收尾的一律放行
    '曼哈顿计划', '阿波罗计划', '哈利波特系列', 'freeCodeCamp', 'Kubernetes',
    // 刻意不收的词 —— 可能是正经项目/作品名
    '梦境记录', '操作日志', '维基百科',
]) {
    ok(`放行「${s}」`, isPeriodPhraseName(s) === false);
}

console.log('\n[3] isNoChangeSentinel — 哨兵');
for (const s of ['无明显变化', '无明显变化。', '无明显变化。 ', '无', '无。', '暂无', '无变化', '近期无新动态', '']) {
    ok(`哨兵「${s}」`, isNoChangeSentinel(s) === true);
}
for (const s of ['新增了两项待办事项。', '无花果采购', '无明显变化发生后的安排']) {
    ok(`非哨兵「${s}」`, isNoChangeSentinel(s) === false);
}

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
