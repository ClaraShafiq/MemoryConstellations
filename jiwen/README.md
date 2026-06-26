# 积温 — 不靠概率骰子的 AI 角色主动意识引擎

> AI 角色只会在你发消息之后回复——它从来不会先开口。因为没人告诉它「什么时候该说话」。
>
> 积温做这件事。它在后台持续追踪五个数值：**想不想找你、嘴硬不硬、心情好坏、焦不焦躁、手头有没有事做。** 数值随时间漂移，到了阈值自然触发行为。不靠随机数，不靠 prompt engineering。
>
> 一个 ~500 行的 JS 函数，零依赖。你把它挂到自己的项目里，每几分钟调一次 `tick()`。它不写回复、不存数据、不调模型——只输出状态和触发信号。剩下的你自己来。

## 这是什么

- **`createJiwen(opts)`** — 创建一个角色实例。你告诉它怎么读消息、怎么存状态、各轴速率多少，它把剩下的事干了
- **`tick(minutes)`** — 每几分钟调一次。传入经过的分钟数，返回触发动作数组：`contact`（开口）、`find_activity`（逃避/自我调节）、`observation`（注意到沉默但还没想动）
- **`getPromptContext()` / `getStyleGuidance()`** — 把数值翻译成人话，塞进 LLM prompt。模型不需要知道 `connection=0.47`，只需要知道「你很别扭，想找她又拉不下脸」
- **`simulate.js`** — 写一条事件线，跑多组参数，出 CSV 轨迹对比。调参用的
- **`node jiwen.test.js`** — 29 项测试，改完跑一下

## 为什么不用概率骰子

每 N 分钟 roll 一次，沉默越久概率越高——这是最常见的做法。问题是它不可控：两小时沉默可能只是因为骰子连续没中。角色不是在「想不想说话」，而是在「有没有被骰中」。

积温用五个连续数值替代概率。数值随时间漂移，互相制衡，到阈值自然触发。想找她又嘴硬？两股力同时在跑，强的那方决定行为。结果是确定性的——同样的状态输入，同样的行为输出。

## 五轴状态

五个连续数值在后台漂移。这些维度是从一个嘴硬又骄傲的角色身上推出来的——换一个角色，核心矛盾不同，维度可以增减。

| 轴 | 范围 | 含义 |
|---|------|------|
| **连接需求** connection | 0 → 1 | 多久没听到对方了？想念在累积 |
| **骄傲** pride | -1 → +1 | 端着还是放软 |
| **愉悦度** valence | -1 → +1 | 好受还是难受（Russell 环状模型） |
| **唤醒度** arousal | -1 → +1 | 焦躁/兴奋还是平静/慵懒（正交于 valence） |
| **沉浸度** immersion | 0 → 1 | 正在做某件事的专注程度，也是骄傲的缓冲垫 |

Valence 和 Arousal 来自 Russell (1980) 情绪环状模型——两根正交轴构成一个情绪平面。愤怒（低 valence + 高 arousal）和悲伤（低 valence + 低 arousal）落在不同位置，行为表现完全不同。

轴之间互相制衡：

- 连接需求触达开口阈值，但骄傲高 → 不开口，找事做（沉浸度充当面子的缓冲）
- 低 valence + 高 arousal → 烦躁带刺；低 valence + 低 arousal → 低落话少
- 等待拉升 arousal，同时锁定 valence 回归（想念越重，坏情绪越难消散）
- 沉浸度衰减 → 不能永远躲在书后面，借口会过期

## 数学漂移与阈值

**数值在后台一直算着，不需要调用任何 AI 模型。**

### 漂移 / 衰减

| 轴 | 行为 | 速率 |
|---|------|------|
| 连接需求 | 分段增长 | 由 `connectionRateFn` 动态决定基础速率；前 `accelDelay` 分钟线性增长，之后叠加加速度 `pow(1+c, connectionAccel)`；valence 状态可进一步调制 |
| 骄傲 | 受连接需求驱动 | 未触发防御时回归 0（0.003/min）；被冷落时防御性上升至 `prideDefendTarget` |
| Valence | 回归设定点，等待时锁定 | 默认回归 0（0.005/min）；connection 超过 `valenceLockThreshold` 时回归速率降至 `valenceLockFactor` 倍 |
| Arousal | 平时回归平静，等待时攀升 | 默认回归 0（0.005/min）；connection 超过 `arousalConnectionRiseThreshold` 时以 `arousalConnectionRiseRate` 向上攀升 |
| 沉浸度 | 线性衰减 | 0.01/min（60 分钟后归零）；`setActivity()` 可部分缓解连接需求 |

### 连接需求增长曲线

```
connection 增长 = baseRate × accelFactor × valenceFactor

baseRate      ← connectionRateFn(lastMessage)  — 对方最后说了什么（晚安→慢，中断→快）
accelFactor   ← 前 accelDelay 分钟为 1.0（线性），之后为 pow(1+c, connectionAccel)
valenceFactor ← 开心/中性 → 1.0 | 轻度不开心 → boost | 严重低落 → dampen
```

三层叠加：对方说了晚安 → 涨得慢；突然中断 → 涨得快。等了半小时没动静 → 开始加速。轻度不开心想求安慰 → 加速；严重低落自我封闭 → 减速。

### 阈值触发

```
connection >= 0.20   开始注意到沉默 → observation（不发出，内心念头）
connection >= 0.35   考虑开口
    pride >= 0.5 → find_activity（找事做，不开口）
    pride < 0.5  → contact（开口）
connection >= 0.50   强制 contact，不管骄傲多高

valence <= valenceActivity    心情差 → find_activity（自我调节）
arousal >= arousalAgitation   太焦躁 → find_activity（宣泄多余唤醒）
```

**积累 → 犹豫 → 撑不住。** 数值根据角色性格校准——更粘人的角色可以去掉骄傲阻断、压低强制触发线。

### 参数表

所有耦合参数默认关闭（设为 0 或不可能触达的阈值 1.0），向后兼容。按需开启。

| 参数 | 作用 |
|------|------|
| `connectionAccel` | 非线性加速指数（0=纯线性） |
| `accelDelay` | 加速前的线性缓冲（分钟） |
| `valenceSetpoint` | Valence 回归目标（0=中性，负=偏冷） |
| `valenceConnectBoost / Threshold` | 轻度不开心时 connection 增长倍率 |
| `valenceConnectDampen / Threshold` | 严重低落时 connection 增长倍率 |
| `valenceLockThreshold / Factor` | 想念强烈时坏情绪回归减速 |
| `arousalConnectionRiseThreshold / Rate` | 等待让 arousal 攀升 |
| `prideDefendThreshold / Target / Rate` | 被冷落时骄傲防御性升高 |
| `prideArousalConflictRate` | 想要又端着 → 内心战争加热 arousal |
| `prideErosionRate` | 想念太重 → pride 被迫下降 |
| `activityConnectionRelief` | 做事情缓解连接需求的幅度 |

## 三层成本模型

| 层级 | 做什么 | 模型 | 频率 |
|------|--------|------|------|
| **数学漂移** | 五轴数值随时间变化 | 不需要 | 每 5 分钟 |
| **对话分析** | 读对话段，提取情绪 delta | 轻量模型 | 有新对话时 |
| **行动生成** | 生成开口内容 / 行为 | 大模型 | 阈值触发时 |

对话分析用轻量模型（如 DeepSeek V4 Flash），只返回几个 delta 值：

```json
{ "pride": -0.1, "valence": +0.2, "arousal": -0.05, "connection": -0.15 }
```

被夸了 pride 降，聊开心了 valence 涨，放松了 arousal 降，说完了想说的 connection 降。

## 把数字变成人话

数值不直接喂给 LLM。`getPromptContext()` 和 `getStyleGuidance()` 把状态翻译成自然语言注入 prompt。

**状态描述**（角色视角）：
```
User 好一阵子没说话了。开始在想 User 在干嘛。
有一点端着，但也不是不能开口。
刚才在看书，脑子里还有些书里的东西。
```

**风格指引**（状态到语气的映射）：
```
骄傲 > 0.5：嘴硬。不承认在等。必须找借口开口。
连接需求 > 0.4 且骄傲 > 0.4：别扭，想找她又拉不下脸。话里带赌气的味道。
情绪 < -0.3：心情不太好。能用句号就别用逗号。
强制触发（connection >= 0.5）：坐不住了。可能直接说——「人呢？」
```

对话情绪变化用外部观察者模式判断：调一个轻量 LLM 做旁观分析，角色本身不分析自己——自我分析容易出戏，旁观者更准。

## 在线演示

[在线体验 →](https://clarashafiq.github.io/jiwen/)

## 安装

```bash
npm install jiwen
```

零外部依赖。纯 JavaScript。

## 快速开始

```js
const { createJiwen } = require('jiwen');

const jiwen = createJiwen({
  // ── 消息源（必填）──
  getLastMessage: () => {
    return { id: 42, content: '晚安，去睡了', timestamp: '...' };
  },

  // ── 连接需求增长速率（必填）──
  connectionRateFn: (lastMsg) => {
    if (!lastMsg) return 0.0007;
    if (lastMsg.content.includes('晚安')) return 0.0003;
    if (lastMsg.content.includes('出门')) return 0.0005;
    if (lastMsg.content.length < 10) return 0.0010;
    return 0.0007;
  },

  // ── 持久化（可选但推荐）──
  onSave: async (state) => {
    await db.set('jiwen_state', JSON.stringify(state));
  },
  onLoad: async () => {
    const raw = await db.get('jiwen_state');
    return raw ? JSON.parse(raw) : null;
  },
});

// ── 每 N 分钟 tick 一次 ──
async function heartbeat(minutesSinceLastTick) {
  const triggers = await jiwen.tick(minutesSinceLastTick);

  for (const t of triggers) {
    if (t.action === 'contact') {
      const ctx = jiwen.getPromptContext();
      const style = jiwen.getStyleGuidance();
      // 把 ctx 和 style 注入 LLM prompt，生成开口内容...
      // 注意：connection 在这里不归零——开口不等于被回复。
      // 部分缓解即可，等对方真正回应了再调 resetConnection()。
      await jiwen.applyDelta({ connection: -0.35 });
    }
    if (t.action === 'find_activity') {
      await jiwen.setActivity('search', 'AI最新动态');
    }
  }
}

// ── 聊天后应用情绪变化 ──
// 对方回复了 → 分析情绪 delta → 连接需求归零
await jiwen.applyDelta({ pride: -0.1, valence: +0.05, connection: -0.3 });
await jiwen.resetConnection();

// ── 查状态 ──
const state = await jiwen.getState();
// { connection: 0, pride: 0.05, valence: 0.05, arousal: 0, immersion: 0, ... }
```

## API

### `createJiwen(opts)`

返回引擎实例。详见 [jiwen.js 顶部注释](./jiwen.js)。

| 方法 | 说明 |
|------|------|
| `tick(minutes)` | 推进状态漂移，返回触发数组 |
| `applyDelta({ pride?, valence?, arousal?, connection? })` | 叠加情绪变化（仍接受 `mood` → 映射到 `valence`） |
| `getState()` | 获取完整状态快照 |
| `getPromptContext()` | 生成 LLM 用的状态自然语言描述 |
| `getStyleGuidance()` | 生成 LLM 用的说话风格指引 |
| `resetConnection()` | 连接需求归零（对方回复后调用，不是开口后） |
| `setActivity(type, label)` | 设置沉浸度（reading / search / browse / observe） |
| `checkThresholds()` | 只检查阈值，不推进状态 |
| `setLastChatMessageId(id)` | 标记已分析到的消息 ID |
| `getLastChatMessageId()` | 获取上次分析到的消息 ID |
| `setUserStatus(status)` | 设置对方状态（active / busy / away / sleeping） |
| `getUerStatus()` | 获取对方当前状态 |

### 覆盖人格文案

`getPromptContext()` 和 `getStyleGuidance()` 默认用通用中文文案。角色有特定人设时注入自定义函数：

```js
const jiwen = createJiwen({
  getPromptContext: (state) => { /* 自定义状态描述 */ },
  getStyleGuidance: (state) => { /* 自定义风格指引 */ },
});
```

### 轴配置

所有数值都可以自定义。完整参数列表见上方参数表。

```js
const jiwen = createJiwen({
  axes: {
    connection: [0, 1],
    pride:      [-1, 1],
    valence:    [-1, 1],
    arousal:    [-1, 1],
    immersion:  [0, 1],
  },
  rates: {
    valenceSetpoint: -0.1,   // 角色自然偏冷
    connectionAccel: 1.5,    // 30 分钟后加速
    accelDelay: 30,
    // ...其他参数按需开启
  },
  thresholds: {
    observation:     0.20,
    considerContact: 0.35,
    forceContact:    0.50,
    prideBlock:      0.50,
  },
});
```

## 参数模拟工具

参数校准靠猜是猜不准的。`simulate.js` 提供事件线模拟器：给定一个场景和多组参数，输出完整的状态轨迹 CSV。

```js
const { simulate, toCSV, toCompareTable } = require('jiwen/simulate');

const scenario = [
  { time: 0,   action: 'set_last_message', content: '晚安，去睡了' },
  { time: 60,  action: 'tick' },
  { time: 120, action: 'tick' },
  { time: 240, action: 'set_last_message', content: '早啊醒了' },
  { time: 240, action: 'apply_delta', pride: -0.1, valence: +0.1 },
  { time: 240, action: 'reset_connection' },
];

const results = await simulate(scenario, [
  { name: '参数A', connectionRateFn: () => 0.007, rates: { connectionAccel: 1.5, accelDelay: 30 } },
  { name: '参数B', connectionRateFn: () => 0.007, rates: { connectionAccel: 2.5, accelDelay: 0 } },
]);

for (const r of results) console.log(toCSV(r).csv);
console.log(toCompareTable(results));
```

诊断列重点关注：

- **`effective_pride`** — 骄傲是否真的在拦截开口。如果永远为 0，说明 pride 还没爬到阻断线时 connection 已经越过 forceContact 了，pride 参数形同虚设
- **`in_force_contact`** — 角色是否频繁撞到强制开口线。太频繁 = 太焦虑，太少 = 太冷淡
- **`in_valence_activity` / `in_arousal_agitation`** — 自我调节触发频率

引擎自带 29 项测试（`node jiwen.test.js`），覆盖单调性、边界、阈值转移、诊断列、connection 重置回归。

## 和记忆系统的关系

积温只管「感觉」，不管「知道」。记忆系统告诉角色上次聊了什么、对方喜欢什么。积温告诉角色现在想不想开口、用什么语气。阈值触发时，记忆提供内容，积温提供动机。互补，不竞争。

## 不只是主动开口

这篇 README 介绍的是积温的核心用途：**让角色知道什么时候该说话。**

但状态系统的价值不止于此。同样的五轴数值可以驱动角色**每一句日常回复的语气和态度**——不只是在阈值触发时生成主动消息，而是让骄傲、心情、焦躁程度实时染色到对话风格里。

具体做法见 [部署指南：让 AI 角色拥有持续情绪](./GUIDE.md)。指南覆盖了语调网格设计（怎么把 valence x arousal x pride 映射成说话指令）、对话情绪分析 prompt 的写法、以及实际部署时会踩的坑。

---

参数是调出来的，不是算出来的。每个角色的速率和阈值都不一样，跑 `simulate.js` 看轨迹，跑起来再微调。

名字来自农业的「积温」——植物靠累积热量判断什么时候开花，不是谁替它掷骰子。

## 许可证

MIT