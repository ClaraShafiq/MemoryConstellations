// ============================================================
// Archivist 守卫规则回归测试（纯函数，不碰库）
// 运行：/usr/bin/node services/archivistGuards.test.js
//   （要用 /usr/bin/node —— better-sqlite3 编译在 v18 上）
//
// 三条规则都是 2026-09-28 加的止血：
//   1. isTimePhraseName    —— 纯日期/时间短语不是实体（2026-09-04 b6800fd 立）
//   2. isPeriodPhraseName  —— 以期间词收尾的名字不是实体（2026-09-28 新）
//   3. isNoChangeSentinel  —— 「无明显变化」是哨兵，不落库（2026-09-28 新）
//   4. _mentionWeight / _aliasAmbiguous —— 别名的三道门（2026-09-28 新，见第 4 节）
//
// ⚠️ 改词表前先读这三条规则的注释（services/archivist.js 顶部附近）。
//    第 2 条刻意不含「计划」「系列」「记录」——「曼哈顿计划」「哈利波特系列」
//    这类可能是正经项目/作品名，误杀代价比放过一条大。要加词先在这里补用例。
//
// ⚠️ **所有用例一律用完全中性的造词**（工程/流程类）。别用真实的人名、店名、
//    作品名、地名——哪怕前面加个「某」也没用：几个具体名词凑在一起本身就是可识别
//    信息，遮住专有名词不等于匿名。第 4 节的 owners 表就是现造的。
// ============================================================

const { isTimePhraseName, isPeriodPhraseName, isNoChangeSentinel,
        _mentionWeight, _aliasAmbiguous } = require('./archivist');

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

// ── [4] 别名的三道门 ──
// 字面链接器把「实体名 + 别名」都拿去做 LIKE 匹配。不加门时，模型写的别名清单里
// 那些泛称（职业通用词、地区名、话题词）每个都会吸进几十上百条碎片。
// 判据是纯函数，所以能在这儿离线测——不用真库、不用真名。
console.log('\n[4a] _mentionWeight — 信息量权重（拉丁 0.5 / 汉字 1）');
for (const [s, want] of [
    ['abc', 1.5], ['abcd', 2], ['abcde', 2.5], ['abcdef', 3],
    ['筹备', 2], ['筹备组', 3], ['图灵测试', 4],
    ['AI 峰会', 3], ['A B', 1], ['', 0],
]) {
    ok(`「${s}」→ ${want}`, Math.abs(_mentionWeight(s) - want) < 1e-9);
}
// 门槛是 3 分：3 个拉丁字母（1.5）过不去，3 个汉字（3）刚好过得去。
ok('3 个拉丁字母过不了门', _mentionWeight('abc') < 3);
ok('3 个汉字过得去', _mentionWeight('筹备组') >= 3);

console.log('\n[4b] _aliasAmbiguous — 跟别人的叫法互相包含');
{
    // 现造的所有权表：id 1 叫「工程组」，id 2 叫「总部工程组」，3 自己有两个叫法。
    const owners = new Map([
        ['工程组', new Set([1])],
        ['总部工程组', new Set([2])],
        ['正式名', new Set([3])],
        ['简称', new Set([3])],
        ['无关项', new Set([4])],
    ]);
    ok('子串跨实体 → 指代不明', _aliasAmbiguous(1, '工程组', owners) === true);
    ok('超串跨实体 → 也指代不明', _aliasAmbiguous(2, '总部工程组', owners) === true);
    ok('跟自己的另一个叫法互相包含 → 不算', _aliasAmbiguous(3, '简称', owners) === false);
    ok('谁也不挨着 → 放行', _aliasAmbiguous(4, '无关项', owners) === false);
    ok('全新的词 → 放行', _aliasAmbiguous(1, '尚未出现过的说法', owners) === false);
}

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
