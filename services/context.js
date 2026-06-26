// =================================================================
// 智能上下文构建 + 健康数据简报
// =================================================================

const fs = require('fs');
const { searchMemoriesByHardTrigger } = require('./memory');
const { getUserSetting } = require('../utils/settings');
const { fillPrompt, USER, AI } = require('./nameResolver');
const { getTriggeredIntuition } = require('./intuition');

// =================================================================
// 健康数据简报生成器
// =================================================================

function generateHealthSummary(fullHealthStatus) {
    try {
        const lines = fullHealthStatus.split('\n');

        // 1. 睡眠时间段
        //    文件格式：'   时间段：04-01 01:45 → 04-01 08:24'
        //    旧正则只匹配 HH:MM → HH:MM，遇到日期前缀会失败
        const sleepTimeLine = lines.find(l => l.includes('时间段：'));
        let sleepTime = '未知';
        if (sleepTimeLine) {
            const timeMatch = sleepTimeLine.match(/(\d{2}-\d{2} \d{2}:\d{2}) → (\d{2}-\d{2} \d{2}:\d{2})/);
            if (timeMatch) {
                sleepTime = `${timeMatch[1]}入睡 → ${timeMatch[2]}醒来`;
            }
        }

        // 2. 睡眠总时长 + 效率
        const sleepLine = lines.find(l => l.includes('总时长：'));
        const sleepMatch = sleepLine ? sleepLine.match(/(\d+) 分钟 \(([\d.]+) 小时\)/) : null;
        const sleepHours = sleepMatch ? sleepMatch[2] : '未知';

        const efficiencyLine = lines.find(l => l.includes('睡眠效率：'));
        const efficiency = efficiencyLine ? efficiencyLine.match(/(\d+)%/)?.[1] : '未知';

        // 3. 静息心率（带趋势）
        const restingHRLine = lines.find(l => l.includes('静息心率：') && l.includes('bpm') && l.includes('基线'));
        let restingHRDisplay = '未知';
        if (restingHRLine) {
            const hrMatch = restingHRLine.match(/静息心率：(\d+) bpm.*基线：(\d+) bpm/);
            if (hrMatch) {
                const current = parseInt(hrMatch[1]);
                const baseline = parseInt(hrMatch[2]);
                const diff = current - baseline;
                const trend = diff > 2 ? '↑' : diff < -2 ? '↓' : '→';
                restingHRDisplay = `${current}${trend}`;
            } else {
                const simpleMatch = restingHRLine.match(/静息心率：(\d+) bpm/);
                restingHRDisplay = simpleMatch ? simpleMatch[1] : '未知';
            }
        }

        // 4. HRV
        //    文件格式：'   HRV：35.359 ms (深睡HRV：36.141 ms)'
        //    旧过滤条件 !l.includes('深睡HRV') 会把这行也排除掉，因为它同时包含两者
        //    改为 trimStart().startsWith('HRV：') 精确匹配行首
        const hrvLine = lines.find(l => l.trimStart().startsWith('HRV：'));
        const hrv = hrvLine ? hrvLine.match(/HRV：([\d.]+) ms/)?.[1] : '未知';

        // 5. 步数（前日活动数据）
        const stepsLine = lines.find(l => l.includes('步数：') && l.includes('步'));
        let stepsInfo = '步数未知';
        if (stepsLine) {
            const stepsMatch = stepsLine.match(/步数：(\d+) 步/);
            if (stepsMatch) stepsInfo = `活动步数${stepsMatch[1]}步`;
        }

        // 异常判断
        const isLowHRV      = !isNaN(parseFloat(hrv))        && parseFloat(hrv)        < 25;
        const isShortSleep  = !isNaN(parseFloat(sleepHours)) && parseFloat(sleepHours) < 6;
        const isPoorEff     = !isNaN(parseFloat(efficiency))  && parseFloat(efficiency) < 85;
        const isPoorSleep   = isShortSleep || isPoorEff;

        let summary = fillPrompt(`【Clara健康数据（Fitbit日均，非实时）】`);
        if (isLowHRV || isPoorSleep) {
            const issues = [];
            if (isShortSleep) issues.push(`睡眠不足（${sleepHours}h）`);
            if (isPoorEff)    issues.push(`睡眠效率偏低（${efficiency}%）`);
            if (isLowHRV)     issues.push(`HRV偏低（${hrv}ms）`);
            summary += `状态需关注 - ${issues.join('，')}。`;
        } else {
            summary += `状态正常。`;
        }

        // 注意：静息心率是 Fitbit 当天的昨日均值，不是当下实时心率
        summary += `\n昨晚${sleepTime}，共${sleepHours}h（效率${efficiency}%）；` +
                   `静息心率${restingHRDisplay}bpm（昨日均值，非当下实时）；` +
                   `HRV ${hrv}ms；${stepsInfo}（前日）。`;

        return summary;
    } catch (error) {
        console.error('generateHealthSummary failed:', error);
        return USER.name + '健康数据读取中...';
    }
}

// =================================================================
// 极简版Context构建 (v3.2 - 天气缓存 + 日历缓存)
// =================================================================

async function buildSmartContext(userMessage, healthStatus, skipVectorMemory = false) {
    let estimatedTokens = 0;

    // === 稳定部分 ===
    let corePrompt = fs.readFileSync('core-prompt.txt', 'utf8');

    // v5.0: 核心洞察段 — deep cycle 产出，Clara 可编辑，始终在 system prompt 中
    const coreInsight = (await getUserSetting('clara_core_insight')) || '';
    corePrompt = corePrompt.replace('{{CORE_INSIGHT}}', coreInsight || '（你正在学习理解她——长期观察中的认知将逐渐在这里形成。）');

    estimatedTokens += Math.ceil(corePrompt.length / 4);

    // === 动态部分 ===
    const dynamicParts = [];

    // 硬触发记忆
    if (userMessage && !skipVectorMemory) {
        const hardMatches = searchMemoriesByHardTrigger(userMessage);
        if (hardMatches.length > 0) {
            dynamicParts.push('<relevant_memories>');
            dynamicParts.push('Thinking Process: 检测到关键词，已从冥想盆调取相关记忆：');
            hardMatches.forEach((mem) => {
                let tags = [];
                try { tags = JSON.parse(mem.tags); } catch(e){}
                const hitTag = tags.find(t => userMessage.includes(t)) || 'unknown';
                dynamicParts.push(`※ 相关记忆 #${mem.id}`);
                dynamicParts.push(`${mem.content}`);
                dynamicParts.push('');
                estimatedTokens += Math.ceil(mem.content.length / 4);
            });
            dynamicParts.push('</relevant_memories>');
            // 更新记忆最后访问时间（供生命周期衰减使用）
            try {
                const db = require('../database').getDb();
                const touch = db.prepare("UPDATE memories SET last_accessed_at = datetime('now') WHERE id = ?");
                hardMatches.forEach(m => { try { touch.run(m.id); } catch (_) {} });
            } catch (_) {}
            console.log(`buildSmartContext: hard trigger injected ${hardMatches.length} memories`);
        }
    }

    // Librarian：混合检索（FTS5 + 向量语义）
    if (userMessage && !skipVectorMemory) {
        try {
            const { searchHybrid, formatHybridContext } = require('./librarian');
            const { getEntityContext } = require('./entityProfile');
            const libFragments = await searchHybrid(userMessage, 8);
            const libText = formatHybridContext(libFragments);
            if (libText) {
                dynamicParts.push(`<memory_context>
[已存储记忆库 — 以下是你自己的记忆，不是Clara刚说的新信息]

每条记忆标注了「引用权限」和「距今时间」：

【可引用】→ 确定的事实，可以直接引用
【需谨慎】→ 用"我印象里""好像是……"开头，留纠正空间
【仅联想】→ 仅供你自己联想参考，不要当作确定事实告诉Clara。如果想提，说"我好像突然想起……但不太确定"

时间感觉：
- 15天以内 → "最近"
- 1-3个月 → "之前"或"有一阵了"
- 超过3个月 → 别表现出刚发生的感觉

关于纠正：如果Clara说"不对"或"不是那次"，接受她的纠正，不要搬出记忆库辩解——记忆库本来就是碎片化的，她比你清楚。
${libText}
</memory_context>`);
                estimatedTokens += Math.ceil(libText.length / 4);
                console.log(`buildSmartContext: hybrid librarian injected ${libFragments.length} fragments`);

                // 话题工作记忆池：注入后将 top fragments 加入工作记忆
                try {
                  const { updatePool } = require('./workingMemory');
                  updatePool(libFragments);
                } catch (e) {
                  console.error('WorkingMemory updatePool failed:', e.message);
                }

                // 实体档案：如果检索命中涉及已知实体，补充最新近况
                try {
                    const entityCtx = getEntityContext(libFragments);
                    if (entityCtx) {
                        dynamicParts.push(`<entity_context>\n以下是记忆中涉及人物的最新近况（来自{ai}的记忆档案）：\n${entityCtx}\n</entity_context>`);
                        estimatedTokens += Math.ceil(entityCtx.length / 4);
                    }
                } catch (_) {}
            }
        } catch (e) {
            console.error('Librarian注入失败:', e.message);
        }
    }

    // Saga 注入：长沉默（>60min）时注入长期记忆弧线
    try {
        const db = require('../database').getDb();
        const lastUserMsg = db.prepare("SELECT timestamp FROM messages WHERE sender='user' ORDER BY id DESC LIMIT 1").get();
        const silenceMinutes = lastUserMsg?.timestamp
            ? (Date.now() - new Date(lastUserMsg.timestamp + '+08:00').getTime()) / 60000
            : 0;

        if (silenceMinutes > 60) {
            const sagas = db.prepare("SELECT title, description FROM memory_sagas WHERE status='active' ORDER BY created_at DESC").all();
            if (sagas.length > 0) {
                const sagaText = sagas.map(s => `- ${s.title}: ${s.description}`).join('\n');
                dynamicParts.push(`<memory_sagas>\n[${AI.name}的长期记忆弧线 — ${USER.name}离开${Math.floor(silenceMinutes / 60)}h${Math.floor(silenceMinutes % 60)}min后]\n${sagaText}\n</memory_sagas>`);
                estimatedTokens += Math.ceil(sagaText.length / 4);
                console.log(`buildSmartContext: silence ${Math.floor(silenceMinutes)}min, injected ${sagas.length} sagas`);
            }
        }
    } catch (e) {
        console.error('Saga注入失败:', e.message);
    }

    // Clara Intuition — context-triggered cognitive intuition
    // Keyword-first matching: only injects traits/hypotheses whose tags match the conversation.
    // immutable_facts and current_state are always included (token cost is minimal).
    // Returns { text, signals } — signals forwarded to Jiwen for parameter tuning.
    try {
        const intuitionResult = getTriggeredIntuition(userMessage, 500);
        if (intuitionResult && intuitionResult.text) {
            dynamicParts.push(intuitionResult.text);
            estimatedTokens += Math.ceil(intuitionResult.text.length / 1.5);
        }
        // Forward triggered signals to Jiwen
        if (intuitionResult && intuitionResult.signals && intuitionResult.signals.length > 0) {
            try {
                const stateService = require('./state');
                stateService.processIntuitionSignals(intuitionResult.signals);
            } catch (e) {
                console.error('Intuition→Jiwen signal bridge failed:', e.message);
            }
        }
    } catch (e) {
        console.error('ClaraIntuition injection failed:', e.message);
    }

    // 健康简报
    const healthSummary = generateHealthSummary(healthStatus);
    dynamicParts.push(`<health_status>\n${healthSummary}\n</health_status>`);
    estimatedTokens += Math.ceil(healthSummary.length / 4);

    // 天气缓存（由 proactive.js 或 cron.js 写入，此处只读）
    // LLM 看到时间戳后可自行判断是否需要调工具获取更新数据
    try {
        const weatherCacheSetting = await getUserSetting('weather_cache');
        if (weatherCacheSetting?.value && weatherCacheSetting.value !== 'null') {
            const wCache = JSON.parse(weatherCacheSetting.value);
            if (wCache.summary && wCache.updated_at) {
                const updatedAt = new Date(wCache.updated_at).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    month: 'numeric', day: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                });
                const weatherText = `获取于${updatedAt}\n${wCache.summary}`;
                dynamicParts.push(`<weather_info>\n${weatherText}\n</weather_info>`);
                estimatedTokens += Math.ceil(weatherText.length / 4);
            }
        }
    } catch(e) { /* 忽略 */ }

    // 日历缓存（今天+明天）
    try {
        const calCacheSetting = await getUserSetting('calendar_cache');
        if (calCacheSetting?.value && calCacheSetting.value !== 'null') {
            const cache = JSON.parse(calCacheSetting.value);
            const calText = `${cache.today}\n${cache.tomorrow}`;
            dynamicParts.push(`<calendar_schedule>\n${calText}\n</calendar_schedule>`);
            estimatedTokens += Math.ceil(calText.length / 4);
        }
    } catch(e) { /* 忽略 */ }

    // 行动日志注入：最近自主行为记录（按 tick 分组，一个 tick = 一轮）
    try {
        const db = require('../database').getDb();
        const BEHAVIORAL_TYPES = ['contact','read_book','browse_snitch','post_snitch','observation_only','search','people_watch','play_radio'];
        // 拉最近 20 条，按 tick_id 分组后取最后 5 个 tick
        const logs = db.prepare(`
            SELECT tick_id, decision_type, intent, observation, reason, timestamp
            FROM draco_inner_log
            WHERE decision_type IN (${BEHAVIORAL_TYPES.map(() => '?').join(',')})
            ORDER BY id DESC LIMIT 20
        `).all(...BEHAVIORAL_TYPES);
        if (logs.length > 0) {
            const TYPE_LABELS = {
                browse_snitch: '刷Snitch', read_book: '读书',
                search: '搜索', contact: '主动开口', observation_only: '观察',
                people_watch: '人类观察', play_radio: '推歌', post_snitch: '发动态',
            };

            // 按 tick_id 分组（先反转 → 最早在前 → Map 保留时间顺序）
            // 每组保留 action 标签 + 关键内容（搜索反思/动态正文/观察念头）
            const tickMap = new Map();
            const logsAsc = [...logs].reverse();
            for (const l of logsAsc) {
                const tid = l.tick_id || `_notick_${l.timestamp}`;
                if (!tickMap.has(tid)) {
                    tickMap.set(tid, { timestamp: l.timestamp, entries: [] });
                }
                const group = tickMap.get(tid);
                // 每种动作只取第一个（去重）
                if (!group.entries.some(e => e.type === l.decision_type)) {
                    const label = TYPE_LABELS[l.decision_type] || l.decision_type;
                    let detail = '';
                    if (l.decision_type === 'search') {
                        detail = l.intent ? `搜${l.intent}` : '';
                        if (l.observation) detail += ` → ${l.observation.slice(0, 120)}`;
                    } else if (l.decision_type === 'observation_only' && l.observation) {
                        detail = l.observation.slice(0, 100);
                    } else if (l.decision_type === 'post_snitch' && l.observation) {
                        detail = l.observation.slice(0, 100);
                    } else if (l.decision_type === 'play_radio' && l.intent) {
                        detail = l.intent; // 歌名 — 歌手
                    } else if (l.decision_type === 'people_watch' && l.observation) {
                        detail = l.observation.slice(0, 100);
                    } else if (l.reason) {
                        detail = l.reason.slice(0, 80);
                    }
                    group.entries.push({ type: l.decision_type, label, detail });
                }
                if (l.timestamp > group.timestamp) group.timestamp = l.timestamp;
            }

            // 取最后 5 个 tick
            const tickGroups = [...tickMap.entries()].slice(-5);

            const lines = tickGroups.map(([tid, group]) => {
                const time = new Date(group.timestamp).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                });
                const actionLabels = group.entries.map(e => e.label);
                const header = `[${time}] ${actionLabels.join(' → ')}`;
                const details = group.entries
                    .filter(e => e.detail)
                    .map(e => `  ${e.label}：${e.detail}`);
                return [header, ...details].join('\n');
            });
            const logText = `你最近在庇护所里的活动记录（同一轮 = 同一段，缩进内容是每步的具体信息）:\n${lines.join('\n')}`;
            dynamicParts.push(`<recent_activity>\n${logText}\n</recent_activity>`);
            estimatedTokens += Math.ceil(logText.length / 4);
        }
    } catch(e) { console.error('行动日志注入失败:', e.message); }

    return {
        stableContext: corePrompt,
        dynamicContext: dynamicParts.join('\n'),
        tokenCount: estimatedTokens
    };
}

module.exports = { generateHealthSummary, buildSmartContext };