// scripts/list_tag_routing.js
//
// 列出「可以单独成一颗星座的那些值标」——给装的人、或者帮着装的 AI 看的。
//
// 用途：给一个新用户配置时，先跑这个，看到有哪几类可选，再问用户要不要。
//   $ node scripts/list_tag_routing.js
//   当前已配置：亲密(亲密时刻)、健康(健康)
//   可选项：
//     intimacy  亲密      默认名字「亲密时刻」  星系：亲密
//                这条碎片来自一次亲密互动本身……
//     health    健康      默认名字「健康」      星系：社交
//                这条碎片讲的是身体本身的客观状况……
//
// 配置写在 memory_config.json 的 tag_routing：
//   "tag_routing": { "intimacy": "亲密时刻", "health": "健康" }
// 不填 = 一颗都不建。

require('dotenv').config();
const { ROUTABLE_TAGS, getTagRouting } = require('../services/tagRouting');

const active = new Map(getTagRouting().map(d => [d.tag, d.name]));

console.log('\n可单独成星座的值标（tag_routing）\n' + '─'.repeat(60));
for (const def of ROUTABLE_TAGS) {
    const on = active.get(def.tag);
    console.log(`${on ? '●' : '○'} ${def.tag.padEnd(10)} ${def.label}    默认名字「${def.defaultName}」    星系：${def.galaxy}${on ? `    ← 已启用，叫「${on}」` : ''}`);
    console.log(`    ${def.desc}`);
    console.log(`    ⚠️ ${def.exclude}`);
    console.log('');
}
console.log('─'.repeat(60));
console.log(`当前已启用 ${active.size} 个${active.size ? '：' + [...active.values()].join('、') : '（memory_config.json 的 tag_routing 是空的）'}`);
console.log('要在配置里加，就把 tag 写在 tag_routing 里，值是你想给它的名字。');
console.log('加完需要重启服务，并且历史碎片要跑一次补链（深循环的 aggregateLink 任务会自动做）。\n');
