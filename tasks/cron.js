// =================================================================
// tasks/cron.js — 后台记忆管线调度
//
// 记忆管线不是请求驱动的：Scribe 要在沉默期后回扫消息，Archivist 要每 2 分钟
// 走一次自主循环，主角的每日日志要按天写。这些都不会被某次 HTTP 请求带起来，
// 必须有人定期去问一次——就是这里。
//
// ⚠️ 注册顺序有讲究：`archivist.start()` 只调一次，它自己管 2 分钟 tick 和
// 「Scribe 写完碎片」的事件监听；其余都是「定期去问一次」的定时器，触发条件
// （沉默 ≥20 分钟 / 积压条数）在各自的 checkAndRun* 内部判断，这里不要重复实现。
// =================================================================

const cron = require('node-cron');

// 时区统一走 TZ 环境变量（docker-compose 里已设）。不设就用系统时区——
// generateDailyEntityStatus 判「昨天」用的也是同一套口径，别在这儿单独写死。
const TZ = process.env.TZ;
const TZ_OPT = TZ ? { timezone: TZ } : {};

let registered = false;

function registerCronJobs() {
    if (registered) return;
    registered = true;

    const { config } = require('../services/memoryConfig');
    const modern = config.pipeline?.mode === 'modern';
    const { start: startArchivist } = require('../services/archivist');

    // ── Archivist Agent：自主循环（2min tick + 事件驱动）──
    // 启动即生效，不是定时任务；没这一步后面的 Scribe/分类/整合都不会发生。
    if (!modern) {
        startArchivist()
            .then(() => console.log('[Cron] Archivist Agent started (2min tick loop + event-driven)'))
            .catch(err => console.error('[Cron] Archivist Agent start error:', err));
    } else {
        cron.schedule('*/2 * * * *', () => {
            const { getDb } = require('../database');
            require('../services/memoryPipeline').tick(getDb()).catch(err => {
                console.error('[Cron] Modern memory pipeline error:', err.message);
            });
        }, TZ_OPT);
        console.log('[Cron] Modern controlled pipeline registered: every 2 minutes');
    }

    // ── Scribe：每 5 分钟去问一次「该不该提取了」──
    // 门槛（沉默 ≥20min + 积压 ≥60 条，或积压 ≥100 条）在 checkAndRunScribe 里面，
    // 这里只负责定期敲门。挂在自己的 cron 上、不要串进别的 tick——上游踩过：
    // 排在一串会 return 的闸门后面时，兜底那句「超过 N 小时也跑」可能永远轮不到执行。
    cron.schedule('*/5 * * * *', () => {
        require('../services/scribe').checkAndRunScribe().catch(err => {
            console.error('[Cron] Scribe error:', err.message);
        });
    }, TZ_OPT);
    console.log('[Cron] Scribe registered: every 5 minutes');

    // ── 每日主角状态：写主角星座的「X月X日：…」日志行 ──
    // 主角不在 regenerateEntityOverviews 的扫描范围里（SKIP_NAMES），这一条是她
    // current_status 的唯一写入方。
    if (!modern) {
        cron.schedule('0 3 * * *', () => {
            require('../services/archivist').generateDailyEntityStatus().catch(err => {
                console.error('[Cron] Daily entity status error:', err.message);
            });
        }, TZ_OPT);
        console.log('[Cron] Daily entity status registered: 03:00');
    }

    // ── 生命周期引擎：碎片冷却/冻结/清空、episode 衰减 ──
    if (!modern) {
        cron.schedule('47 4 * * *', () => {
            require('../services/lifecycle').runLifecycleMaintenance().catch(err => {
                console.error('[Cron] Lifecycle maintenance error:', err.message);
            });
        }, TZ_OPT);
        console.log('[Cron] Lifecycle maintenance registered: 04:47');
    }
}

module.exports = { registerCronJobs };
