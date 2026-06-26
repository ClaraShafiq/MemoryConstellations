// =================================================================
// Archivist Agent — 记忆认知核心
//
// 自主节律：Agent 循环 (2min tick) + 事件驱动 + Draco 感知
// 职责：分类碎片、维护知识树、发现关系、提取洞察
// 类比：养一棵树 — 浇水(分类)/修剪(拆分)/除草(纠错)/观察(主题发现)
//
// 数据源：chat / wechat / books / snitch / cinema / music
// 所有数据源的碎片统一走分类管道 → 知识树
// =================================================================

const os = require('os');
const EventEmitter = require('events');
const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { chromaDBOperation } = require('./memory');
const { WORLD_CONTEXT } = require('./worldContext');
const { SKIP_NAMES, USER, AI } = require('./memoryConfig');
const SKIP_PH = SKIP_NAMES.map(() => '?').join(', '); // SQL placeholder string for NOT IN clauses
const { runClaraModelCycle, matchEvidenceFromFragments, harvestFacts, processModelDecay, resolveExpiredStates, MIN_GAP_COGNITIVE_MODEL } = require('./cognitiveModel');

// ═══════════════════════════════════════════════════════
// Event Bus — Scribe 发事件，Archivist 监听
// ═══════════════════════════════════════════════════════

const archivistEvents = new EventEmitter();
archivistEvents.setMaxListeners(20);

// ═══════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════

const ARCHIVIST_LLM_CONFIG_ID = 36;  // [书库]DS — 主题提案/树审计/关系发现
const ARCHIVIST_VERIFY_CONFIG_ID = 38;  // [心跳]flash — 分类校验/insight，便宜够用

const TICK_INTERVAL_MS = 2 * 60 * 1000;       // Agent 循环 tick 间隔
// 从 memory_config.json 读取深循环触发间隔（默认 60 分钟）
const CLARA_IDLE_DEEP_CYCLE_MS = (() => {
    try {
        const cfg = require('../memory_config.json');
        const mins = cfg.rhythm?.deep_cycle_idle_minutes;
        if (typeof mins === 'number' && mins > 0) return mins * 60 * 1000;
    } catch (_) {}
    return 60 * 60 * 1000; // 默认 1h
})();

const ENTITY_DISCOVERY_MIN_FRAGS = 5;
const INSIGHT_BATCH_MAX = 20;
const CLASSIFY_THRESHOLD = 0.35;
const CLASSIFY_MARGIN = 0.12;
const VERIFY_HIGH_THRESHOLD = 0.75;
const VERIFY_BATCH_MAX = 15;
const MAX_TAGS_PER_FRAGMENT = 3;
const MIN_CLUSTER_SIZE = 3;
const THEME_SIMILARITY = 0.72;
const THEME_SAMPLE_SIZE = 200;
const THEME_COOLDOWN_HOURS = 24;

const KEYWORD_SEED_LIMIT = 12;
const KEYWORD_SEED_CONFIDENCE = 0.80;

const BOOTSTRAP_MIN_CLUSTER = 3;
const BOOTSTRAP_MAX_CATEGORIES = 8;
const BOOTSTRAP_SAMPLE = 300;

// Cost controls
const MAX_DAILY_LLM_CALLS = 500;          // 硬上限：日总调用次数
const MAX_LLM_PER_TICK_IDLE = 50;         // Draco 空闲时每 tick 最大 LLM 调用
const MAX_LLM_PER_TICK_ACTIVE = 10;       // Draco 活跃时每 tick 最大 LLM 调用

// Min intervals between task types (ms) — prevents thrashing
const MIN_GAP_CLASSIFY = 2 * 60 * 1000;
const MIN_GAP_INSIGHTS = 10 * 60 * 1000;
const MIN_GAP_DESCRIPTIONS = 30 * 60 * 1000;
const MIN_GAP_ENTITY_OVERVIEWS = 30 * 60 * 1000;
const MIN_GAP_THEMES = 6 * 60 * 60 * 1000;
const MIN_GAP_SKILLS = 30 * 60 * 1000;
const MIN_GAP_PROPOSALS = 10 * 60 * 1000;
const MIN_GAP_RECONCILE = 30 * 60 * 1000;
const MIN_GAP_RELATIONSHIPS = 30 * 60 * 1000;
const MIN_GAP_EMERGENT = 30 * 60 * 1000;           // 涌现地点/事件检测（聚类第二遍扫描）——清积压期30min
const MIN_GAP_ENTITY_VERIFY = 60 * 60 * 1000;           // 管道A实体分类LLM抽检
const MIN_GAP_CATEGORY_CONSOLIDATE = 60 * 60 * 1000;    // 按星座合并碎片为episode（v5.3: 数据源从 memory_ontology 切到 entity_profiles）
const MIN_GAP_SAGA_CLUSTER = 24 * 60 * 60 * 1000;        // Saga聚类（LLM语义聚类所有episode），24h冷却
const MIN_GAP_CATEGORY_MERGE = 6 * 60 * 60 * 1000;        // 重叠类别自动合并（LLM审视全貌）
const MIN_GAP_BELIEF_DRIFT = 4 * 60 * 60 * 1000;         // 信念漂移检测：Clara 对同一主题的看法是否随时间改变
const MIN_GAP_MUSIC_EXTRACT = 2 * 60 * 60 * 1000;   // 音乐品味变化慢
const MIN_GAP_BOOK_EXTRACT = 60 * 60 * 1000;         // 读书批注新增较快
const MIN_GAP_AUTO_LINK = 2 * 60 * 1000;             // 字面自动链接 2min（轻量，零LLM）
const MIN_GAP_AUTO_MERGE = 5 * 60 * 1000;             // 轻量级重叠检测 5min 冷却
const AUTO_MERGE_OVERLAP_THRESHOLD = 0.80;           // 小类别 ≥80% 碎片已在另一类别中 → 自动合并

const EMERGENCE_THRESHOLD = 50;                    // 未分类积累到 50 条 → 触发生长脉冲
const EMERGENCE_SAMPLE = 150;                      // 生长脉冲采样碎片数
const EMBED_BATCH_SIZE = 50;                       // ChromaDB embed_batch 单次最大（过proxy有限制）
const MIN_GAP_EMERGENCE = 30 * 60 * 1000;          // 生长脉冲冷却 30min
const MIN_GAP_REMATCH = 2 * 60 * 60 * 1000;            // 字面回补 2h
const MIN_GAP_SEMANTIC_REMATCH = 4 * 60 * 60 * 1000;   // 语义回补 4h（ChromaDB + LLM 较重）
const MIN_GAP_SEED_MERGE = 12 * 60 * 60 * 1000;        // 种子合并 12h
const MIN_GAP_RELATED_ENTITIES = 24 * 60 * 60 * 1000;  // 实体关系发现 24h
const MIN_GAP_EPISODE_AUDIT = 6 * 60 * 60 * 1000;        // Episode质检 6h
const MIN_FREE_MEMORY_MB = 1200;                   // 深度循环最低可用内存（MB），不足跳过
const MEMORY_CHECK_GRACE_MB = 300;                 // 每轮分类后额外保留内存

// ═══════════════════════════════════════════════════════
// Agent State
// ═══════════════════════════════════════════════════════

let agentState = {
    running: false,
    tickTimer: null,
    inTick: false,

    // Draco activity tracking
    dracoActive: false,
    dracoLastActive: Date.now(),

    // Clara idle → deep cycle trigger
    lastClaraMessageTime: 0,
    deepCycleSinceLastClaraMsg: false,

    // Cost tracking
    dailyLLMCalls: 0,
    dailyLLMReset: Date.now(),
    tickLLMCalls: 0,

    // Work tracking (last execution timestamps)
    lastClassify: 0,
    lastInsights: 0,
    lastDescriptions: 0,
    lastEntityOverviews: 0,
    lastThemes: 0,
    lastOverdensity: 0,
    lastSkills: 0,
    lastAudit: 0,
    lastProposals: 0,
    lastReconcile: 0,
    lastRelationships: 0,
    lastLeafStructure: 0,
    lastEntityVerify: 0,
    lastCategoryConsolidate: 0,
    lastMusicExtract: 0,
    lastBookExtract: 0,
    lastEmergence: 0,
    lastAutoMerge: 0,
    lastClaraModel: 0,
    lastCategoryMerge: 0,
    lastBeliefDrift: 0,
    lastPatternCluster: 0,

    // Tree change tracker (whisper refresh trigger)
    treeChanged: false,

    // Stats
    totalClassified: 0,
    totalTasksRun: 0,

    // Event tracking
    newFragmentsSinceLastTick: 0,
};

// ═══════════════════════════════════════════════════════
// Memory protection — prevent OOM during ChromaDB-heavy ops
// ═══════════════════════════════════════════════════════

function _freeMemoryMB() {
    return os.freemem() / (1024 * 1024);
}

function _checkMemoryGate(minMB, label) {
    const free = _freeMemoryMB();
    if (free < minMB) {
        console.log(`[Archivist] ⚠️ 内存不足，跳过${label}: 可用 ${free.toFixed(0)}MB < 需要 ${minMB}MB`);
        return false;
    }
    return true;
}

// ═══════════════════════════════════════════════════════
// Tool Registry
// ═══════════════════════════════════════════════════════

const toolRegistry = new Map();

function registerTool(name, handler, description, opts = {}) {
    toolRegistry.set(name, { handler, description, ...opts });
    console.log(`[Archivist Agent] 工具注册: ${name} — ${description}`);
}

function getTool(name) {
    return toolRegistry.get(name);
}

function listTools() {
    return [...toolRegistry.entries()].map(([name, t]) => ({ name, description: t.description }));
}

// ═══════════════════════════════════════════════════════
// Agent Loop — Start / Stop
// ═══════════════════════════════════════════════════════

function _isDracoActive() {
    // Use notify flag first (stream.js/proactive.js set this)
    if (agentState.dracoActive) return true;
    // Fallback: check actual scene (catches proactive actions)
    try {
        const stateService = require('./state');
        const scene = stateService.getDracoScene();
        if (scene && scene.scene !== 'idle') return true;
    } catch (_) {}
    return false;
}

function _getLastDracoActivityTime() {
    try {
        const stateService = require('./state');
        const state = stateService.getStateSync();
        return state ? state.lastActivity : agentState.dracoLastActive;
    } catch (_) {
        return agentState.dracoLastActive;
    }
}

// Called by stream.js when Draco starts/finishes responding
// Proactive notification: reduces need for state service polling
function isDracoActive() {
    // Use the same logic as internal _isDracoActive
    if (agentState.dracoActive) return true;
    try {
        const stateService = require('./state');
        const scene = stateService.getDracoScene();
        if (scene && scene.scene !== 'idle') return true;
    } catch (_) {}
    return false;
}

function setDracoActive(active) {
    const wasActive = agentState.dracoActive;
    agentState.dracoActive = active;
    if (!active) {
        agentState.dracoLastActive = Date.now();
    }
    if (wasActive && !active) {
        console.log('[Archivist Agent] Draco 回复结束，恢复全速');
    }
}

async function start() {
    if (agentState.running) return;
    agentState.running = true;
    agentState.dracoLastActive = Date.now();

    console.log('[Archivist Agent] 启动 — Agent 循环 (2min tick) + 事件驱动 + Draco 感知');

    // Listen for fragment events from Scribe — just set flags, don't cancel anything
    archivistEvents.on('fragments:written', (payload) => {
        onNewFragments(payload).catch(e =>
            console.error('[Archivist Agent] 事件处理异常:', e.stack || e.message));
    });

    // Start the agent loop
    scheduleTick();
    console.log('[Archivist Agent] 就绪');
}

function stop() {
    agentState.running = false;
    if (agentState.tickTimer) clearTimeout(agentState.tickTimer);
    archivistEvents.removeAllListeners('fragments:written');
    console.log('[Archivist Agent] 已停止');
}

function getStatus() {
    return {
        running: agentState.running,
        dracoActive: agentState.dracoActive,
        inTick: agentState.inTick,
        dailyLLMCalls: agentState.dailyLLMCalls,
        totalClassified: agentState.totalClassified,
        totalTasksRun: agentState.totalTasksRun,
        lastTick: agentState.tickTimer ? 'pending' : 'idle',
        tools: [...toolRegistry.keys()],
    };
}

// ═══════════════════════════════════════════════════════
// Event-Driven Path: Scribe 写完碎片 → 标记 flag
// ═══════════════════════════════════════════════════════

async function onNewFragments({ fragmentIds, sourceMsgIds }) {
    if (!fragmentIds || fragmentIds.length === 0) return;

    // Just set flags — Agent loop picks these up on next tick
    agentState.newFragmentsSinceLastTick += fragmentIds.length;

    // Trigger skills that match new fragments (lightweight, runs immediately)
    try {
        const { triggerSkills } = require('./skillManager');
        await triggerSkills({ newFragmentIds: fragmentIds });
    } catch (e) {
        // skillManager may not be loaded yet
    }

    // Throttled whisper invalidation
    try {
        const { onNewData } = require('./whisper');
        onNewData();
    } catch (_) {}

    // ── Event-driven consolidation: flash only (routine → deep cycle) ──
    try {
        maybeTriggerFlashConsolidation(fragmentIds, sourceMsgIds);
    } catch (_) {}
    // Extract insights from new fragments (fire-and-forget)
    extractFragmentInsights().catch(e =>
        console.error('[Archivist] insight 提取失败:', e.message));
}

// ── Event-driven consolidation helpers (moved from scribe.js) ──

const FLASH_MIN_COUNT = 4;
const FLASH_EW_THRESHOLD = 0.85;
const FLASH_SPIKE_THRESHOLD = 0.92;

function maybeTriggerFlashConsolidation(newFragmentIds, sourceMsgIds) {
    if (!newFragmentIds || newFragmentIds.length < FLASH_MIN_COUNT) return;

    const db = getDb();
    const placeholders = newFragmentIds.map(() => '?').join(',');

    const highEW = db.prepare(`
        SELECT id, content, emotional_weight, source_msg_ids FROM memory_fragments
        WHERE id IN (${placeholders}) AND emotional_weight >= ?
        ORDER BY emotional_weight DESC
    `).all(...newFragmentIds, FLASH_EW_THRESHOLD);

    if (highEW.length < FLASH_MIN_COUNT) return;

    const hasSpike = highEW.some(f => f.emotional_weight >= FLASH_SPIKE_THRESHOLD);
    if (!hasSpike) return;

    const spike = highEW.find(f => f.emotional_weight >= FLASH_SPIKE_THRESHOLD);
    console.log(`[Archivist] Flash触发条件满足：${highEW.length}条高EW碎片(≥${FLASH_EW_THRESHOLD})，尖峰=${spike.emotional_weight.toFixed(2)}`);

    const { consolidateFlash } = require('./consolidator');
    const msgIds = (() => {
        try { return JSON.parse(sourceMsgIds || '[]'); } catch (_) { return []; }
    })();
    consolidateFlash(highEW, msgIds).then(result => {
        if (result.flashed) {
            console.log(`[Archivist] Flash整合成功：episode #${result.memoryId}`);
        } else {
            console.log(`[Archivist] Flash整合未执行：${result.reason || 'unknown'}`);
        }
    }).catch(err => {
        console.error('[Archivist] Flash整合异常:', err.message);
    });
}

// ═══════════════════════════════════════════════════════
// Agent Tick — 主循环
// ═══════════════════════════════════════════════════════

function scheduleTick() {
    if (!agentState.running) return;
    agentState.tickTimer = setTimeout(async () => {
        if (!agentState.running) return;
        try {
            await agentTick();
        } catch (e) {
            // 分段定位崩溃来源
            const stack = e.stack || e.message || String(e);
            const sqlInfo = e.message && e.message.includes('parameter') ? ' [SQL参数不匹配]' : '';
            console.error(`[Archivist Agent] Tick 异常${sqlInfo}:`, stack);
            if (e.code) console.error(`  code=${e.code}`);
            try {
                const db = getDb();
                console.error(`  lastClaraMsg=${agentState.lastClaraMessageTime} deepDone=${agentState.deepCycleSinceLastClaraMsg}`);
            } catch (_) {}
        }
        scheduleTick();
    }, TICK_INTERVAL_MS);
}

function getLastClaraMessageTime() {
    const db = getDb();
    const row = db.prepare("SELECT timestamp FROM messages WHERE sender = 'user' ORDER BY id DESC LIMIT 1").get();
    return row ? new Date(row.timestamp).getTime() : 0;
}

async function agentTick() {
    if (agentState.inTick) return;
    agentState.inTick = true;
    agentState.tickLLMCalls = 0;
    const tickStart = Date.now();

    _checkDailyLLMReset();

    const newFragCount = agentState.newFragmentsSinceLastTick;
    agentState.newFragmentsSinceLastTick = 0;

    try {
        // 0. Clara activity check — detect new messages, determine mode
        const lastClaraTime = getLastClaraMessageTime();
        if (lastClaraTime > agentState.lastClaraMessageTime) {
            // Clara sent new messages — reset for next idle period
            agentState.deepCycleSinceLastClaraMsg = false;
            agentState.lastClaraMessageTime = lastClaraTime;
        }

        const claraIdleMs = Date.now() - lastClaraTime;
        const shouldDeepCycle = claraIdleMs >= CLARA_IDLE_DEEP_CYCLE_MS
                             && !agentState.deepCycleSinceLastClaraMsg;

        // 1. Assess tree health
        const health = await assessTreeHealth();

        if (newFragCount > 0 || health.unclassified > 0) {
            const mode = shouldDeepCycle ? '🌙深度整合' : '☀️轻量';
            console.log(`[Archivist Agent] Tick [${mode}] 新碎片=${newFragCount} 未分类=${health.unclassified} Clara空闲=${Math.round(claraIdleMs/60000)}min`);
        }

        // 2. Bootstrap (zero-state only) — ensure seed constellations exist
        if (health.categoryCount === 0) {
            console.log('[Archivist] 零状态：创建种子星座 (Clara + Draco)');
            const db = getDb();
            const { USER, AI } = require('./memoryConfig');
            db.prepare(`INSERT OR IGNORE INTO entity_profiles (name, category, status) VALUES (?, 'person', 'active')`).run(USER.name);
            db.prepare(`INSERT OR IGNORE INTO entity_profiles (name, category, status) VALUES (?, 'person', 'active')`).run(AI.name);
            if (agentState.treeChanged) _refreshWhisper();
            agentState.inTick = false;
            return;
        }

        // ═══════════════════════════════════════
        // LIGHTWEIGHT TASKS — always run, zero ChromaDB + zero LLM
        // ═══════════════════════════════════════

        // 3. Classification (lightweight: keyword match, zero LLM)
        if (health.unclassified >= 5) {
            await runTaskIfDue('classify', () => classifyFragments({ lightweight: !shouldDeepCycle }), MIN_GAP_CLASSIFY);
        }

        // 4. Music & Book extraction (DB-only, ChromaDB indexing deferred to deep cycle)
        await runTaskIfDue('musicExtract', async () => {
            try {
                const { extractMusicFragments } = require('./musicMemoryExtractor');
                const result = await extractMusicFragments({ skipChromaDB: !shouldDeepCycle });
                if (result.extracted > 0) agentState.treeChanged = true;
                return result;
            } catch (_) { return null; }
        }, MIN_GAP_MUSIC_EXTRACT);

        await runTaskIfDue('bookExtract', async () => {
            try {
                const { extractBookFragments } = require('./bookMemoryExtractor');
                const result = await extractBookFragments({ skipChromaDB: !shouldDeepCycle });
                if (result.extracted > 0) agentState.treeChanged = true;
                return result;
            } catch (_) { return null; }
        }, MIN_GAP_BOOK_EXTRACT);

        // 5c. Auto-merge overlapping categories — pure SQL, zero LLM
        // Detects when a small category is mostly (≥80%) contained in a larger one
        await runTaskIfDue('autoMerge', detectAndMergeOverlaps, MIN_GAP_AUTO_MERGE);

        // 5d. Lightweight evidence matching — zero LLM + zero ChromaDB
        // Matches new fragments against clara_model entries via keyword overlap
        if (newFragCount > 0) {
            try {
                matchEvidenceFromFragments();
                // harvestFacts v4.8 退役：Clara 客观事实走 entity_profiles 档案，不再产 immutable_fact
                // harvestFacts();
            } catch (e) {
                console.error('[Archivist] 轻量模型维护失败:', e.message);
            }
        }

        // 5e. Clara Model decay — pure math, zero LLM, zero ChromaDB
        // TTL expiry / hypothesis abandon / trait contradiction flagging / dormant marking
        // These are timer-based state transitions that must run regardless of deep cycle.
        // (v4.9 regression: these were locked inside runClaraModelCycle → deep cycle,
        //  causing current_state TTL to never fire when Clara is active.)
        await runTaskIfDue('processClaraDecay', () => {
            try {
                const result = processModelDecay();
                if (result && (result.resolved > 0 || result.abandoned > 0 || result.flagged > 0 || result.dormant > 0)) {
                    // Only log when something actually happened
                }
                return result;
            } catch (e) {
                console.error('[Archivist] processModelDecay 失败:', e.message);
                return null;
            }
        }, 2 * 60 * 1000);  // every 2 min (every tick)

        await runTaskIfDue('resolveExpiredStates', () => {
            try {
                return resolveExpiredStates();
            } catch (e) {
                console.error('[Archivist] resolveExpiredStates 失败:', e.message);
                return null;
            }
        }, 5 * 60 * 1000);  // every 5 min (fallback for >14d states, doesn't need frequent runs)

        // 5f. Auto-link literal entity mentions — pure SQL LIKE, zero LLM
        // Seeds stuck at fc=2 need just one more link to cross graduation threshold.
        // Low confidence (0.40) — deep cycle rematch upgrades to 0.60+.
        await runTaskIfDue('autoLink', () => {
            try {
                return autoLinkLiteralMentions();
            } catch (e) {
                console.error('[Archivist] autoLinkLiteralMentions 失败:', e.message);
                return null;
            }
        }, MIN_GAP_AUTO_LINK);

        // 5g. Aggregate linker — route music/book fragments to aggregate entities
        // These fragments are excluded from star map classification, but still need
        // a home. Linked to aggregate entities (音乐/共读) in 爱好 galaxy.
        await runTaskIfDue('aggregateLink', () => {
            try {
                return linkAggregateFragments();
            } catch (e) {
                console.error('[Archivist] aggregateLink 失败:', e.message);
                return null;
            }
        }, MIN_GAP_AUTO_LINK);

        // ═══════════════════════════════════════
        // DEEP CYCLE TASKS — LLM-heavy, only when Clara idle > 1h
        // ═══════════════════════════════════════

        if (shouldDeepCycle) {
            // Memory gate
            if (!_checkMemoryGate(MIN_FREE_MEMORY_MB, '深度整合周期')) {
                agentState.inTick = false;
                return;
            }

            console.log('[Archivist Agent] 🦉 进入深度整合周期');

            // ── Phase 0: Decide what to do ──
            const llmAvailable = _countRemainingLLM();
            const gardenPlan = await decideGardenAction(health, llmAvailable);

            // ── Phase 1: Execute tasks in decided order ──
            // Dispatch table: task name → { fn, cooldown, condition }
            const MAX_CLASSIFY_ROUNDS = 5;
            const LLM_RESERVE_PER_ROUND = 20;
            const db = getDb();

            const dispatch = {
                classify: async () => {
                    let classifyRounds = 0;
                    while (classifyRounds < MAX_CLASSIFY_ROUNDS && _canCallLLM(LLM_RESERVE_PER_ROUND + 25)) {
                        const rem = db.prepare(`SELECT COUNT(*) as c FROM memory_fragments WHERE status = 'active' AND id NOT IN (SELECT DISTINCT fragment_id FROM fragment_entities)`).get()?.c || 0;
                        if (rem < 1) break;  // 即使1条也跑LLM分类(碎片少时LLM调用也小)
                        if (!_checkMemoryGate(MEMORY_CHECK_GRACE_MB, `分类第${classifyRounds + 1}轮`)) break;
                        const result = await runTask('classify', () => classifyFragments({ lightweight: false }));
                        if (!result || result.classified === 0) break;
                        classifyRounds++;
                    }
                    if (classifyRounds > 0) {
                        console.log(`[Archivist Agent] 分类循环: ${classifyRounds} 轮`);
                        agentState.lastClassify = Date.now();
                    }
                    // Post-classify: spot-check low-confidence links
                    await spotCheckClassifications();
                    return { classified: classifyRounds };
                },

                rematch:         async () => runTaskIfDue('rematch', rematchFragmentsForSeeds, MIN_GAP_REMATCH),
                semanticRematch: async () => runTaskIfDue('semanticRematch', semanticRematchForSeeds, MIN_GAP_SEMANTIC_REMATCH),
                seedMerge:       async () => runTaskIfDue('seedMerge', mergeDuplicateSeeds, MIN_GAP_SEED_MERGE),
                graduate:        async () => graduateSeedsAndPrune(),
                emergence:       async () => runTaskIfDue('emergentDetection', detectEmergentPlacesAndEvents, MIN_GAP_EMERGENT),
                entityRelations: async () => runTaskIfDue('relatedEntities', discoverRelatedEntities, MIN_GAP_RELATED_ENTITIES),

                entityOverviews: async () => {
                    if (health.staleEntityOverviews > 0)
                        return runTaskIfDue('entity_overviews', regenerateEntityOverviews, MIN_GAP_ENTITY_OVERVIEWS);
                    return { skipped: true, reason: 'no stale overviews' };
                },
                entityScan:      async () => runTaskIfDue('entityScan', scanContentForNewEntities, MIN_GAP_ENTITY_VERIFY),
                patternCluster:  async () => runTaskIfDue('patternCluster', clusterObservations, MIN_GAP_PATTERN_CLUSTER),
                reviewStrategies: async () => runTaskIfDue('reviewStrategies', reviewFlaggedStrategies, MIN_GAP_PATTERN_CLUSTER),
                insights:        async () => {
                    if (health.needsInsight >= 10)
                        return runTaskIfDue('insights', () => extractFragmentInsights(INSIGHT_BATCH_MAX), MIN_GAP_INSIGHTS);
                    return { skipped: true, reason: `needsInsight=${health.needsInsight}` };
                },
                episodeAudit:    async () => runTaskIfDue('episodeAudit', auditNewEpisodes, MIN_GAP_EPISODE_AUDIT),
                consolidate:     async () => runTaskIfDue('consolidateCategory', consolidateCategory, MIN_GAP_CATEGORY_CONSOLIDATE),
                sagaCluster:     async () => {
                    const { clusterSagas } = require('./consolidator');
                    return runTaskIfDue('sagaCluster', clusterSagas, MIN_GAP_SAGA_CLUSTER);
                },
                cognitiveModel:      async () => runTaskIfDue('cognitiveModel', runClaraModelCycle, MIN_GAP_COGNITIVE_MODEL),
                stop:            async () => 'stop',
            };

            // ── Clara Model always runs (not optional — core cognitive maintenance) ──
            await dispatch.cognitiveModel();

            // ── seedMerge safety net: 低频但必须兜底 ──
            // LLM 决策倾向选"紧急"(种子积压)而非"重要但不急"(合并重复)。
            // 纯 SQL 检查：>3天没合并 且有 名字相似的实体对 → 强制前置
            const SEED_MERGE_MAX_GAP = 3 * 24 * 60 * 60 * 1000;
            const lastMerge = agentState.lastSeedMerge || 0;
            if (Date.now() - lastMerge > SEED_MERGE_MAX_GAP) {
                const candidateCount = db.prepare(`
                    SELECT COUNT(*) as c FROM (
                        SELECT a.id FROM entity_profiles a
                        JOIN entity_profiles b ON a.category = b.category AND a.id < b.id
                        WHERE a.status IN ('seed','active') AND b.status IN ('seed','active')
                          AND a.name NOT IN (${SKIP_PH}) AND b.name NOT IN (${SKIP_PH})
                          AND a.category NOT IN ('music_aggregate','book_aggregate','movie_aggregate')
                          AND b.category NOT IN ('music_aggregate','book_aggregate','movie_aggregate')
                          AND (a.name LIKE '%' || b.name || '%' OR b.name LIKE '%' || a.name || '%'
                               OR length(a.name) >= 3 AND length(b.name) >= 3
                                  AND (substr(a.name,1,2) = substr(b.name,1,2)
                                       OR substr(a.name,-2) = substr(b.name,-2)))
                        LIMIT 10
                    )
                `).get(...SKIP_NAMES, ...SKIP_NAMES)?.c || 0;
                if (candidateCount > 0 && !gardenPlan.includes('seedMerge')) {
                    console.log(`[Archivist] 🌿 安全阀: ${candidateCount}对潜在重复, ${Math.round((Date.now()-lastMerge)/86400000)}天未合并 → 强制前置 seedMerge`);
                    gardenPlan.unshift('seedMerge');
                }
            }

            for (const taskName of gardenPlan) {
                if (taskName === 'stop') break;
                const handler = dispatch[taskName];
                if (!handler) continue;
                if (!_canCallLLM(1) && taskName !== 'classify') {
                    console.log(`[Archivist] 🌿 跳过 ${taskName}: LLM配额耗尽 (已用${agentState.tickLLMCalls})`);
                    continue;
                }
                const taskStart = Date.now();
                console.log(`[Archivist] 🌿 ▶ ${taskName}...`);
                try {
                    const result = await handler();
                    const elapsed = Date.now() - taskStart;
                    // Write to ontology_changelog so 观星手记 can display
                    _logGardenActivity(taskName, result);
                    if (result) {
                        const summary = typeof result === 'object'
                            ? Object.entries(result).filter(([,v]) => v !== 0 && v !== false && v !== null && v !== undefined)
                                .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v).slice(0,60) : v}`).join(' ')
                            : result;
                        console.log(`[Archivist] 🌿 ✓ ${taskName} (${(elapsed/1000).toFixed(1)}s): ${summary || 'done'}`);
                    } else {
                        console.log(`[Archivist] 🌿 ○ ${taskName} (${(elapsed/1000).toFixed(1)}s): 跳过(冷却中或无待处理项)`);
                    }
                } catch (e) {
                    console.error(`[Archivist] 🌿 ✗ ${taskName}:`, e.stack || e.message);
                }
            }

            // Always write a deep cycle summary to 观星手记
            try {
                const db2 = getDb();
                const unclassifiedNow = db2.prepare(`SELECT COUNT(*) as c FROM memory_fragments WHERE status='active' AND id NOT IN (SELECT DISTINCT fragment_id FROM fragment_entities)`).get()?.c || 0;
                const seedsNow = db2.prepare(`SELECT COUNT(*) as c FROM entity_profiles WHERE status='seed'`).get()?.c || 0;
                db2.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, confidence, status)
                    VALUES ('deep_cycle', ?, ?, 0.80, 'completed')`)
                    .run('深循环完成', JSON.stringify({
                        llm_calls: agentState.tickLLMCalls,
                        unclassified_remaining: unclassifiedNow,
                        seeds_remaining: seedsNow,
                    }));
            } catch (_) {}

            console.log(`[Archivist] 🌿 园艺完成 (LLM: ${agentState.tickLLMCalls}次)`);

            // ── Phase 2: Always-run maintenance (zero LLM) ──
            // Intuition stopwords refresh
            await runTaskIfDue('intuitionStopwords', refreshIntuitionStopwords, MIN_GAP_RELATED_ENTITIES);

            // Skills pattern discovery
            await runTaskIfDue('skills', async () => {
                try {
                    const skm = require('./skillManager');
                    const scan = await skm.scanForPatterns();
                    const evalRes = await skm.evaluateSkills();
                    return { scanned: scan ? 'done' : 'none', evaluated: evalRes ? 'done' : 'none' };
                } catch (_) { return null; }
            }, MIN_GAP_SKILLS);

            // Tool-based relationship discovery (separate from entityRelations)
            await runTaskIfDue('relationships', () => {
                const tool = getTool('discover_relationships');
                return tool ? tool.handler({ includeReEval: true }) : { discovered: 0 };
            }, MIN_GAP_RELATIONSHIPS);

            // ChromaDB stale cleanup
            try {
                const { cleanupStaleChromaEntries } = require('./memory');
                await cleanupStaleChromaEntries();
            } catch (_) {}

            // Cognitive fusion
            try {
                const { fuseCorrections } = require('./cognitiveEvolution');
                await fuseCorrections();
            } catch (_) {}

            // Mark deep cycle as done for this idle period
            agentState.deepCycleSinceLastClaraMsg = true;
            console.log('[Archivist Agent] 🦉 深度整合周期完成');
        }

        // 17. Whisper refresh — after any tree change
        if (agentState.treeChanged) {
            _refreshWhisper();
        }

    } finally {
        agentState.inTick = false;
        const elapsed = Date.now() - tickStart;
        if (elapsed > 30000) {
            console.log(`[Archivist Agent] ⚠️ Tick 耗时 ${(elapsed/1000).toFixed(0)}s (LLM: ${agentState.tickLLMCalls})`);
        }
    }
}

// ═══════════════════════════════════════════════════════
// Tree Health Assessment — Agent 的"眼睛"
// ═══════════════════════════════════════════════════════

async function assessTreeHealth() {
    const db = getDb();

    // v4.7: categoryCount = active entity_profiles (constellations), not memory_ontology
    const categoryCount = (db.prepare("SELECT COUNT(*) as c FROM entity_profiles WHERE status = 'active'").get()?.c || 0);

    // Unclassified fragments — those not yet in fragment_entities
    // Music/book fragments are intentionally excluded: they're data exhaust
    // (listening/reading logs), not memory fragments about people/places/events.
    // They're harvested by musicMemoryExtractor/bookMemoryExtractor separately.
    const unclassified = db.prepare(`
        SELECT COUNT(*) as c FROM memory_fragments
        WHERE status = 'active'
          AND source NOT IN ('music', 'book')
          AND id NOT IN (SELECT DISTINCT fragment_id FROM fragment_entities)
    `).get()?.c || 0;

    // Unclassified by source type
    const unclassifiedBySource = db.prepare(`
        SELECT source, COUNT(*) as c FROM memory_fragments
        WHERE status = 'active'
          AND id NOT IN (SELECT DISTINCT fragment_id FROM fragment_entities)
        GROUP BY source ORDER BY c DESC
    `).all();

    // Fragments needing insights
    const needsInsight = db.prepare(`
        SELECT COUNT(*) as c FROM memory_fragments
        WHERE insight IS NULL AND status = 'active'
          AND content IS NOT NULL AND length(content) > 10
    `).get()?.c || 0;

    // Stale category descriptions (categories with growth since last description update)
    const staleDescriptions = _countStaleDescriptions(db);

    // Entity overviews needing update
    const staleEntityOverviews = _countStaleEntityOverviews(db);

    // Missing relationships (entities without relationship_to_clara, with enough fragments)
    const missingRelations = db.prepare(`
        SELECT COUNT(*) as c FROM entity_profiles ep
        WHERE ep.category = 'person'
          AND ep.name NOT IN (${SKIP_PH})
          AND (ep.relationship_to_clara IS NULL OR ep.relationship_to_clara = '')
          AND (SELECT COUNT(*) FROM memory_fragments WHERE entity_id = ep.id AND status = 'active') >= ?
    `).get(...SKIP_NAMES, ENTITY_DISCOVERY_MIN_FRAGS)?.c || 0;

    // Stale relationships (low-confidence or 30-day-old high-confidence)
    const staleRelations = db.prepare(`
        SELECT COUNT(*) as c FROM entity_profiles ep
        WHERE ep.category = 'person'
          AND ep.name NOT IN (${SKIP_PH})
          AND (
            (ep.relationship_confidence IN ('low', 'medium') AND (ep.last_evaluated_at IS NULL OR ep.last_evaluated_at < datetime('now', '-1 day')))
            OR (ep.relationship_confidence = 'high' AND ep.last_evaluated_at < datetime('now', '-30 days'))
          )
          AND (SELECT COUNT(*) FROM memory_fragments WHERE entity_id = ep.id AND status = 'active') >= 3
    `).get(...SKIP_NAMES)?.c || 0;

    // Pending high-confidence proposals
    const pendingProposals = db.prepare(`
        SELECT COUNT(*) as c FROM ontology_changelog
        WHERE confidence >= 0.85 AND status = 'pending'
    `).get()?.c || 0;

    return {
        categoryCount,
        unclassified,
        unclassifiedBySource: unclassifiedBySource || [],
        needsInsight,
        staleDescriptions,
        staleEntityOverviews,
        missingRelations,
        staleRelations,
        pendingProposals,
    };
}

function _countStaleDescriptions(db) {
    const cats = db.prepare(`
        SELECT o.id, o.path, o.fragment_count
        FROM memory_ontology o
        WHERE o.id IN (SELECT DISTINCT category_id FROM fragment_categories)
    `).all();

    let count = 0;
    for (const cat of cats) {
        if (!cat.description) { count++; continue; }

        const lastUpdate = db.prepare(`
            SELECT detail FROM ontology_changelog
            WHERE action IN ('description_update', 'myth_update') AND category_path = ?
            ORDER BY created_at DESC LIMIT 1
        `).get(cat.path);

        if (!lastUpdate) { count++; continue; }

        try {
            const detail = JSON.parse(lastUpdate.detail || '{}');
            const prevCount = detail.fragment_count_at_update || 0;
            const growth = cat.fragment_count - prevCount;
            if ((prevCount > 0 && growth / prevCount >= 0.2) || growth >= 5) {
                count++;
            }
        } catch (_) { count++; }
    }
    return count;
}

function _countStaleEntityOverviews(db) {
    const entities = db.prepare(`
        SELECT ep.id, ep.name, ep.overview, ep.last_eval_frag_count
        FROM entity_profiles ep
        WHERE ep.status = 'active'
          AND ep.name NOT IN (${SKIP_PH})
    `).all(...SKIP_NAMES);

    let count = 0;
    for (const ent of entities) {
        const currentCount = db.prepare(
            "SELECT COUNT(*) as c FROM memory_fragments WHERE entity_id = ? AND status = 'active'"
        ).get(ent.id)?.c || 0;

        if (currentCount === 0) continue;
        if (!ent.overview) { count++; continue; }

        const prevCount = ent.last_eval_frag_count || 0;
        const growth = currentCount - prevCount;
        if ((prevCount > 0 && growth / prevCount >= 0.2) || growth >= 3) {
            count++;
        }
    }
    return count;
}

// ═══════════════════════════════════════════════════════
// Task Runner — cost-controlled, Draco-aware
// ═══════════════════════════════════════════════════════

function _checkDailyLLMReset() {
    const now = Date.now();
    if (now - agentState.dailyLLMReset > 24 * 60 * 60 * 1000) {
        if (agentState.dailyLLMCalls > 0) {
            console.log(`[Archivist Agent] 日调用计数器重置 (昨日: ${agentState.dailyLLMCalls})`);
        }
        agentState.dailyLLMCalls = 0;
        agentState.dailyLLMReset = now;
    }
}

function _canCallLLM(count = 1) {
    const maxPerTick = agentState.dracoActive ? MAX_LLM_PER_TICK_ACTIVE : MAX_LLM_PER_TICK_IDLE;
    if (agentState.tickLLMCalls + count > maxPerTick) return false;
    if (agentState.dailyLLMCalls + count > MAX_DAILY_LLM_CALLS) {
        console.warn(`[Archivist Agent] ⚠️ 日 LLM 调用达上限 (${MAX_DAILY_LLM_CALLS})，跳过本 tick 剩余任务`);
        return false;
    }
    return true;
}

function _countRemainingLLM() {
    const maxPerTick = agentState.dracoActive ? MAX_LLM_PER_TICK_ACTIVE : MAX_LLM_PER_TICK_IDLE;
    const tickRemaining = Math.max(0, maxPerTick - agentState.tickLLMCalls);
    const dailyRemaining = Math.max(0, MAX_DAILY_LLM_CALLS - agentState.dailyLLMCalls);
    return Math.min(tickRemaining, dailyRemaining);
}

async function runTask(name, fn) {
    if (!_canCallLLM()) return null;
    try {
        const result = await fn();
        agentState.totalTasksRun++;
        if (result && result.llmCalls) {
            agentState.tickLLMCalls += result.llmCalls;
            agentState.dailyLLMCalls += result.llmCalls;
        }
        if (result && (result.classified > 0 || result.regenerated > 0 || result.proposals > 0
            || result.reconciled > 0 || result.discovered > 0)) {
            agentState.treeChanged = true;
        }
        if (result) {
            const summary = typeof result === 'object'
                ? Object.entries(result).filter(([,v]) => v !== 0 && v !== false && v !== null)
                    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')
                : result;
            if (summary) console.log(`[Archivist Agent]   ${name}: ${summary}`);
        }
        return result;
    } catch (e) {
        console.error(`[Archivist Agent] ${name} 失败:`, e.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════
// Lightweight auto-link: literal entity name mentions → fragment_entities
// ================================================================
// Pure SQL LIKE match, zero LLM, zero ChromaDB.
// Seeds stuck at fc=2 need just ONE more fragment to cross graduation
// threshold. This finds literal mentions that keyword classification missed.
// Low confidence (0.40) = not LLM-verified. Deep cycle rematch upgrades to 0.60+.
// ═══════════════════════════════════════════════════════

const AUTO_LINK_CONFIDENCE = 0.40;
const AUTO_LINK_CLASSIFIER = 'auto_literal';
const AUTO_LINK_MAX_PER_ENTITY = 5;  // max new links per entity per run (prevent flooding)

function autoLinkLiteralMentions() {
    const db = getDb();

    // Find fragments that literally contain an entity name but aren't linked yet
    // Exclude music/book (data exhaust) and SKIP_NAMES (Clara/Draco handled separately)
    const seeds = db.prepare(`
        SELECT ep.id, ep.name, ep.category, ep.fragment_count
        FROM entity_profiles ep
        WHERE ep.status IN ('seed', 'active')
          AND ep.name NOT IN (${SKIP_PH})
          AND ep.category NOT IN ('music_aggregate', 'book_aggregate', 'movie_aggregate')
          AND length(ep.name) >= 2
        ORDER BY ep.fragment_count ASC
    `).all(...SKIP_NAMES);

    if (seeds.length === 0) return { linked: 0 };

    let totalLinked = 0;
    const insertFe = db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, NULL, ?, ?)');
    const updateFc = db.prepare('UPDATE entity_profiles SET fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?) WHERE id = ?');

    const writeAll = db.transaction(() => {
        for (const s of seeds) {
            const frags = db.prepare(`
                SELECT mf.id FROM memory_fragments mf
                WHERE mf.content LIKE ? AND mf.status = 'active'
                  AND mf.source NOT IN ('music', 'book')
                  AND mf.id NOT IN (SELECT fragment_id FROM fragment_entities WHERE entity_id = ?)
                ORDER BY mf.id DESC
                LIMIT ?
            `).all('%' + s.name + '%', s.id, AUTO_LINK_MAX_PER_ENTITY);

            if (frags.length === 0) continue;

            for (const f of frags) {
                const r = insertFe.run(f.id, s.id, AUTO_LINK_CONFIDENCE, AUTO_LINK_CLASSIFIER);
                if (r.changes > 0) totalLinked++;
            }

            if (frags.length > 0) {
                updateFc.run(s.id, s.id);
            }
        }
    });

    try {
        writeAll();
    } catch (e) {
        console.error('[Archivist] autoLinkLiteralMentions 写入失败:', e.message);
        return { linked: 0, error: e.message };
    }

    if (totalLinked > 0) {
        console.log(`[Archivist] 🔗 字面自动链接: ${totalLinked} 条 (${AUTO_LINK_CONFIDENCE} conf, 零LLM)`);
    }
    return { linked: totalLinked };
}

// ═══════════════════════════════════════════════════════
// Aggregate linker: route music/book fragments to their aggregate entities
// ================================================================
// Music/book fragments are excluded from star map classification
// (they're data exhaust, not memory about people/places/events).
// Instead of leaving them unlinked, route them to aggregate entities
// (音乐 / 共读) so they have a home and can be searched.
// Pure SQL, zero LLM, zero ChromaDB.
// ═══════════════════════════════════════════════════════

const AGGREGATE_MAP = (() => {
    try {
        const cfg = require('../memory_config.json');
        const routing = cfg.source_routing || {};
        // Validate: must be object with string→string mappings
        if (typeof routing === 'object' && !Array.isArray(routing)) {
            const map = {};
            for (const [src, name] of Object.entries(routing)) {
                if (typeof src === 'string' && typeof name === 'string' && src !== '_comment') {
                    map[src] = name;
                }
            }
            return map;
        }
    } catch (_) {}
    return {};
})();

function linkAggregateFragments() {
    const db = getDb();
    let totalLinked = 0;

    const insertFe = db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, confidence, classified_by) VALUES (?, ?, 0.60, ?)');
    const updateFc = db.prepare('UPDATE entity_profiles SET fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?) WHERE id = ?');

    const writeAll = db.transaction(() => {
        for (const [source, entityName] of Object.entries(AGGREGATE_MAP)) {
            const entity = db.prepare("SELECT id FROM entity_profiles WHERE name = ? AND status = 'active'").get(entityName);
            if (!entity) continue;

            const frags = db.prepare(`
                SELECT mf.id FROM memory_fragments mf
                WHERE mf.source = ? AND mf.status = 'active'
                  AND mf.id NOT IN (SELECT fragment_id FROM fragment_entities WHERE entity_id = ?)
                LIMIT 50
            `).all(source, entity.id);

            for (const f of frags) {
                const r = insertFe.run(f.id, entity.id, 'aggregate_link');
                if (r.changes > 0) totalLinked++;
            }

            if (frags.length > 0) updateFc.run(entity.id, entity.id);
        }
    });

    try {
        writeAll();
    } catch (e) {
        console.error('[Archivist] linkAggregateFragments 写入失败:', e.message);
        return { linked: 0, error: e.message };
    }

    if (totalLinked > 0) {
        console.log(`[Archivist] 📦 聚合归位: ${totalLinked} 条 music/book 碎片`);
    }
    return { linked: totalLinked };
}

// ── 观星手记日志：将园艺操作结果写入 ontology_changelog ──
function _logGardenActivity(taskName, result) {
    if (!result) return;
    const db = getDb();
    const insert = db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, confidence, status)
        VALUES (?, ?, ?, 0.80, 'completed')`);

    try {
        if (taskName === 'classify' && result.classified > 0) {
            insert.run('classify', `+${result.classified}条`, JSON.stringify({ count: result.classified, constellations: result.constellationCount || '?' }));
        } else if (taskName === 'rematch' && result.rematched > 0) {
            insert.run('rematch', `+${result.rematched}条`, JSON.stringify({ count: result.rematched }));
        } else if (taskName === 'semanticRematch' && result.rematched > 0) {
            insert.run('semantic_rematch', `+${result.rematched}条`, JSON.stringify({ count: result.rematched }));
        } else if (taskName === 'insights' && result.extracted > 0) {
            insert.run('insights', `+${result.extracted}条`, JSON.stringify({ count: result.extracted }));
        }
    } catch (_) { /* 观星日志写入失败不阻断主流程 */ }
}

function _taskKey(name) {
    // Convert snake_case task name to lastCamelCase state key
    const camel = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    return `last${camel.charAt(0).toUpperCase() + camel.slice(1)}`;
}

async function runTaskIfDue(name, fn, minGapMs) {
    const key = _taskKey(name);
    const lastRun = agentState[key] || 0;
    if (Date.now() - lastRun < minGapMs) return null;
    const result = await runTask(name, fn);
    agentState[key] = Date.now();
    return result;
}

function _refreshWhisper() {
    try {
        const { invalidateCache } = require('./whisper');
        invalidateCache();
        agentState.treeChanged = false;
    } catch (_) {}
}

// ═══════════════════════════════════════════════════════
// Utility: Cosine Similarity
// ═══════════════════════════════════════════════════════

function cosineSimilarity(a, b) {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

function buildConnectedComponents(pairs, allIds) {
    const adj = new Map();
    for (const id of allIds) adj.set(id, new Set());
    for (const pair of pairs) {
        const a = typeof pair.fragment_a === 'number' ? pair.fragment_a : parseInt(pair.fragment_a);
        const b = typeof pair.fragment_b === 'number' ? pair.fragment_b : parseInt(pair.fragment_b);
        if (adj.has(a) && adj.has(b)) {
            adj.get(a).add(b);
            adj.get(b).add(a);
        }
    }
    const visited = new Set();
    const components = [];
    for (const id of allIds) {
        if (visited.has(id) || !adj.has(id)) continue;
        const comp = new Set();
        const stack = [id];
        while (stack.length > 0) {
            const node = stack.pop();
            if (visited.has(node)) continue;
            visited.add(node);
            comp.add(node);
            for (const neighbor of adj.get(node) || []) {
                if (!visited.has(neighbor)) stack.push(neighbor);
            }
        }
        if (comp.size >= 2) components.push(comp);
    }
    return components;
}

// ═══════════════════════════════════════════════════════
// Category Centroid
// ═══════════════════════════════════════════════════════

async function computeCategoryCentroid(categoryId) {
    const db = getDb();
    const cat = db.prepare('SELECT label, description FROM memory_ontology WHERE id = ?').get(categoryId);
    if (!cat) return null;

    // Time-stratified sampling: evenly spread across the full time range
    // so the centroid represents both old and new content. 50 samples max.
    const allRows = db.prepare(`
        SELECT DISTINCT mf.id, mf.content, mf.created_at
        FROM memory_fragments mf
        JOIN fragment_categories fc ON fc.fragment_id = mf.id
        WHERE fc.category_id = ?
          AND mf.status = 'active'
        ORDER BY mf.created_at
    `).all(categoryId);

    let rows;
    const maxSamples = 50;
    if (allRows.length <= maxSamples) {
        rows = allRows;
    } else {
        rows = [];
        const stride = allRows.length / maxSamples;
        for (let i = 0; i < maxSamples; i++) {
            rows.push(allRows[Math.floor(i * stride)]);
        }
    }

    const texts = rows.length > 0
        ? rows.map(r => `${USER.name}: ${r.content}`)
        : [`类别: ${cat.label} - ${cat.description || ''}`];

    try {
        const result = await chromaDBOperation('embed_batch', { texts });
        const dim = result.embeddings[0]?.length || 0;
        if (dim === 0) return null;
        const centroid = new Array(dim).fill(0);
        for (const emb of result.embeddings) {
            for (let i = 0; i < dim; i++) centroid[i] += emb[i];
        }
        for (let i = 0; i < dim; i++) centroid[i] /= result.embeddings.length;
        return centroid;
    } catch (e) {
        console.error(`[Archivist] 计算类别 #${categoryId} 质心失败:`, e.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════
// Keyword Seeding
// ═══════════════════════════════════════════════════════

let _seedKeywordMap = null;
let _boostKeywordMap = null;

function buildKeywordMaps(categories) {
    if (_seedKeywordMap) return { seedMap: _seedKeywordMap, boostMap: _boostKeywordMap };

    const seedDefs = {
        // NOTE: Do NOT include character-specific names here — those appear in
        // almost every fragment and cause false matches. Let centroid similarity handle
        // relationship topics; keywords here are for unambiguous topic signals only.
        '人际关系/朋友与同事':   ['闺蜜', '室友', '同学聚会', '老朋友', '同行聚餐'],
        '人际关系/家人':         ['妈妈', '爸爸', '母亲', '父亲', '父母', '奶奶', '爷爷', '姐姐', '妹妹', '哥哥', '弟弟'],
        '人际关系/关于我们/关系本质与情感博弈': ['AI伴侣', '跨次元', '实体化', '私有化部署', '排他性'],
        '人际关系/关于我们/角色扮演中的角色理解分歧': ['Character.AI', 'C.AI', 'RP用语'],
        '地点/旅行与日常出行':   ['旅行', '旅游', '爬山', '虞山', '常熟', '苏州', '杭州', '日本', '机票', '火车票', '酒店入住', '景点', '游玩', '登山杖', '护膝', '高铁', '环球影城', '浦东美术馆'],
        '创作/写作与代码':       ['写作', '小说', '稿子', '剧本', '设定', '大纲', '章节', '写代码', '前端', '后端', 'Node.js', '部署到N100'],
        '创作/配音':             ['配音', '试音', '录音棚', '声线', '棚录', '台词本'],
        '日常':                  ['烧卖', '饺子', '冰淇淋', '化妆水', '乳液', '防晒霜', '美瞳'],
        '音乐/网易云红心收藏':   ['网易云', '红心', 'liked song', '推歌', 'Ave Mujica', 'Rationale', 'Tethered', 'Bruno Major', '合成器'],
        '工作':                  ['N100', 'PM2', '虚拟机', '域名', '服务器部署'],
        '健康':                  ['布洛芬', 'HRV', 'Fitbit', '退烧', '全身酸痛', '斜方肌', '三角肌'],
        '自我意识与价值观':      ['高敏感', '不习惯被看见', '怕扫兴', '下意识收敛'],
    };

    const boostDefs = {
        '人际关系/朋友与同事':   ['闺蜜', '室友', '同学', '聚会', '同事', '同行'],
        '人际关系/家人':         ['妈妈', '爸爸', '母亲', '父亲', '父母', '奶奶', '爷爷', '姐姐', '妹妹', '哥哥', '弟弟'],
        '人际关系/关于我们/关系本质与情感博弈': ['AI伴侣', '跨次元', '实体化', '私有化', '排他性'],
        '人际关系/关于我们/角色扮演中的角色理解分歧': ['Character.AI', 'C.AI', 'RP', '扮演'],
        '地点/旅行与日常出行':   ['旅行', '旅游', '爬山', '虞山', '常熟', '苏州', '杭州', '日本', '机票', '火车', '酒店', '景点', '游玩', '登山', '高铁', '环球影城', '浦东'],
        '创作/写作与代码':       ['写作', '小说', '稿子', '剧本', '设定', '大纲', '章节', '故事', '代码', '编程'],
        '创作/配音':             ['配音', '试音', '录音', '声线', '棚录', '台词', '导演', '角色'],
        '日常':                  ['吃饭', '睡觉', '起床', '日常', '日记', '天气', '做饭', '烧卖', '饺子', '冰淇淋'],
        '音乐/网易云红心收藏':   ['网易云', '红心', '歌曲', '专辑', '歌手', '乐队', '推歌', '旋律', '和弦', '合成器'],
        '工作':                  ['N100', 'VSC', '虚拟机', '域名', 'PM2', '部署', '开发', 'Node', '编程', '前端', '后端'],
        '健康':                  ['身体', '疼', '痛', '酸', '病', '药', '运动', '步数', '锻炼', '酸痛', '肌肉', '布洛芬', '发烧', 'HRV', '睡眠'],
        '自我意识与价值观':      ['自我', '反思', '敏感', '害怕', '焦虑', '渴望', '羡慕', '习惯', '性格'],
    };

    const autoGen = autoGenerateKeywords(categories);

    _seedKeywordMap = [];
    _boostKeywordMap = [];
    for (const cat of categories) {
        let skw = seedDefs[cat.path];
        if (!skw || skw.length === 0) {
            skw = (autoGen[cat.path] || []).slice(0, 6);
        }
        if (skw.length > 0) {
            _seedKeywordMap.push({ categoryId: cat.id, path: cat.path, keywords: skw });
        }
        const bkw = boostDefs[cat.path] || autoGen[cat.path];
        if (bkw && bkw.length > 0) {
            _boostKeywordMap.push({ categoryId: cat.id, path: cat.path, keywords: bkw });
        }
    }
    return { seedMap: _seedKeywordMap, boostMap: _boostKeywordMap };
}

function clearKeywordCache() {
    _seedKeywordMap = null;
    _boostKeywordMap = null;
}

function autoGenerateKeywords(categories) {
    const map = {};
    for (const cat of categories) {
        const keywords = new Set();
        const segments = cat.path.split('/');
        for (const seg of segments) {
            if (seg && seg.length >= 2) keywords.add(seg);
        }
        if (cat.label && cat.label.length >= 2) keywords.add(cat.label);
        if (cat.description) {
            const chunks = cat.description.match(/[一-鿿]{2,4}/g);
            if (chunks) chunks.forEach(c => keywords.add(c));
        }
        map[cat.path] = [...keywords];
    }
    return map;
}

async function seedClassifyByKeywords(db, categories) {
    const { seedMap } = buildKeywordMaps(categories);
    if (seedMap.length === 0) return 0;

    const unclassified = db.prepare(`
        SELECT mf.id, mf.content FROM memory_fragments mf
        WHERE mf.status = 'active'
          AND mf.id NOT IN (SELECT DISTINCT fragment_id FROM fragment_categories)
        ORDER BY mf.created_at DESC
        LIMIT 200
    `).all();

    if (unclassified.length === 0) return 0;

    const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO fragment_categories (fragment_id, category_id, confidence, classified_by)
        VALUES (?, ?, ?, 'archivist_keyword')
    `);

    const catCounts = new Map();
    let seeded = 0;

    for (const frag of unclassified) {
        const content = frag.content || '';
        if (content.length < 4) continue;

        const matched = [];
        for (const entry of seedMap) {
            const count = catCounts.get(entry.categoryId) || 0;
            if (count >= KEYWORD_SEED_LIMIT) continue;
            for (const kw of entry.keywords) {
                if (content.includes(kw)) {
                    matched.push(entry);
                    break;
                }
            }
        }

        if (matched.length === 0) continue;
        matched.sort((a, b) => b.path.length - a.path.length);
        const best = matched[0];

        insertStmt.run(frag.id, best.categoryId, KEYWORD_SEED_CONFIDENCE);
        catCounts.set(best.categoryId, (catCounts.get(best.categoryId) || 0) + 1);
        seeded++;
    }

    console.log(`[Archivist] 关键词播种: ${seeded} 条 → ${catCounts.size} 个类别`);
    return seeded;
}

// ═══════════════════════════════════════════════════════
// Memory Landscape — gives the agent full visibility of its own memory structure
// ═══════════════════════════════════════════════════════

function buildLandscapeIndex() {
    const db = getDb();
    const cats = db.prepare(`
        SELECT id, path, label, description, fragment_count
        FROM memory_ontology ORDER BY fragment_count DESC
    `).all();

    if (cats.length === 0) return '（记忆星图为空——还没有任何星座）';

    const lines = [`🪐 记忆星图 · 当前共 ${cats.length} 个星座`];
    lines.push('═══════════════════════════════════════');
    for (let i = 0; i < cats.length; i++) {
        const c = cats[i];
        const desc = (c.description || '').substring(0, 50);
        lines.push(`${String(i + 1).padStart(2)}. ${c.path} (${c.fragment_count}条)${desc ? ' — ' + desc : ''}`);
    }
    lines.push('═══════════════════════════════════════');
    return lines.join('\n');
}

// ═══════════════════════════════════════════════════════
// Multi-Category Classification — agent sees the full landscape,
// not a tunnel-vision binary "does this belong to X?"
// ═══════════════════════════════════════════════════════

function buildMultiCategoryPrompt(candidateGroups, allCategories) {
    // candidateGroups: Map<fragId, { frag, candidates: [{categoryId, similarity, cat info}] }>
    const frags = [...candidateGroups.values()];

    // Build detailed info for categories that appear as candidates
    const catDetails = new Map();
    for (const g of frags) {
        for (const cand of g.candidates) {
            if (!catDetails.has(cand.categoryId)) {
                const cat = allCategories.find(c => c.id === cand.categoryId);
                if (cat) {
                    const db = getDb();
                    const samples = db.prepare(`
                        SELECT mf.content FROM memory_fragments mf
                        JOIN fragment_categories fc ON fc.fragment_id = mf.id
                        WHERE fc.category_id = ? AND mf.status = 'active'
                        ORDER BY mf.created_at DESC LIMIT 2
                    `).all(cat.id);
                    catDetails.set(cand.categoryId, {
                        id: cat.id,
                        path: cat.path,
                        label: cat.label,
                        description: cat.description || '无描述',
                        samples: samples.map(s => s.content.substring(0, 100)),
                    });
                }
            }
        }
    }

    const candidateBlock = [...catDetails.values()].map(c =>
        `【${c.path}】(id=${c.id}) — ${c.description}\n  示例: ${c.samples.map(s => `"${s}"`).join(' | ')}`
    ).join('\n\n');

    const fragBlock = frags.map((g, i) =>
        `[碎片${i}] ${g.frag.content}\n  候选: ${g.candidates.map(c => `"${c.categoryPath}" (${c.similarity.toFixed(2)})`).join(' | ')}`
    ).join('\n\n');

    return `${WORLD_CONTEXT}

你是记忆分类器。你拥有当前记忆星图的完整视野。为每条碎片选择最佳归属。

## 记忆星图（全貌）
${buildLandscapeIndex()}

## 本轮候选类别详情
${candidateBlock}

## 待分类碎片
${fragBlock}

## 规则
- 每条碎片选**一个**最合适的类别（category_id），或 null（不属于任何现有类别）
- 如果碎片和多个候选类别都相关，选择**最具体**的那个（比如「素食者批注」比「创作」更具体）
- 如果你注意到某些类别描述高度重叠、应该合并，在 overlaps 字段中指出
- 以事实为依据，不要推测碎片中没有的信息

## 输出格式
严格JSON数组，不含任何其他文字：
[{"index":0,"category_id":66,"confidence":0.85,"reason":"关于文学批注"},
 {"index":1,"category_id":null,"confidence":0.0,"reason":"无匹配类别"}]

如果发现重叠类别，在数组后附加 overlaps 字段（同个JSON对象内）：
..., {"overlaps":[{"cat_a":66,"cat_b":80,"reason":"都是Draco文学批注","confidence":0.9}]}`;
}

async function classifyFragmentsMultiCategory(candidateGroups, allCategories) {
    try {
        const prompt = buildMultiCategoryPrompt(candidateGroups, allCategories);
        const response = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            null, null,
            { temperature: 0.3, maxOutputTokens: 2000 },
            ARCHIVIST_VERIFY_CONFIG_ID
        );

        let text = response?.reply || '';
        text = text.replace(/```json|```/g, '').trim();
        const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (!match) {
            console.error('[Archivist] 多类别分类返回非JSON:', text.substring(0, 100));
            return { classified: [], overlaps: [] };
        }

        const parsed = JSON.parse(match[0]);
        // parsed may be the array directly, or an object with overlaps
        const results = Array.isArray(parsed) ? parsed : (parsed.results || parsed.classifications || []);
        const overlaps = !Array.isArray(parsed) && parsed.overlaps ? parsed.overlaps : [];

        const classified = [];
        for (const r of results) {
            if (r.category_id && r.confidence >= 0.6) {
                const group = [...candidateGroups.values()].find(g => {
                    const idx = [...candidateGroups.keys()].indexOf(g.frag.id);
                    return idx === r.index;
                });
                if (group) {
                    classified.push({ frag: group.frag, categoryId: r.category_id, similarity: r.confidence, classifiedBy: 'archivist_verified' });
                }
            }
        }

        return { classified, overlaps };
    } catch (e) {
        console.error('[Archivist] 多类别分类失败:', e.message);
        return { classified: [], overlaps: [] };
    }
}

// ═══════════════════════════════════════════════════════
// Entity Classification Verification
//
// Pipeline A uses string matching (0.70, pending).
// Deep cycle spot-checks with LLM: is the person really the SUBJECT
// or did the name just appear in passing / as an exclamation?
// ═══════════════════════════════════════════════════════

async function verifyEntityClassifications() {
    const db = getDb();

    const pending = db.prepare(`
        SELECT fc.fragment_id, fc.category_id, o.path, o.label, mf.content, fc.classified_by
        FROM fragment_categories fc
        JOIN memory_fragments mf ON mf.id = fc.fragment_id
        JOIN memory_ontology o ON o.id = fc.category_id
        WHERE fc.classified_by IN ('archivist_entity_pending', 'archivist_person_reconcile')
        ORDER BY fc.rowid ASC
        LIMIT 20
    `).all();

    if (pending.length === 0) return { verified: 0, removed: 0 };

    const prompt = `${WORLD_CONTEXT}

${buildLandscapeIndex()}

你是记忆分类校对器。管道A通过关键词匹配将碎片归入了人物类别，但关键词匹配可能误判。你需要逐条判断：**这个人的名字在碎片中是作为"被谈论/被描述的主体人物"，还是仅仅作为感叹、呼语、顺带提及出现？**

## 规则
- 如果碎片在**讲述关于这个人的事**、描述她的行为/状态/关系 → match: true
- 如果碎片只是在感叹语中用到了名字（如"我的妈呀"、"我的天"）、或在讲述**另一个人**时顺带提到了该名字 → match: false
- 注意：碎片是第三人称叙述（Clara的视角），"Clara 和 XX 一起做了Y"中 XX 是主体 → match: true
- 宁可漏分，不要错分

${pending.map((p, i) => `[${i}] 类别: ${p.path} | 碎片: ${p.content}`).join('\n\n')}

只输出一个JSON数组，不要markdown包裹：
[{"index":0,"match":true,"reason":"..."}, ...]`;

    try {
        const response = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            null, null,
            { temperature: 0.2, maxOutputTokens: 2000 },
            ARCHIVIST_VERIFY_CONFIG_ID
        );

        let text = response?.reply || '';
        text = text.replace(/```json|```/g, '').trim();
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) {
            console.error('[Archivist] 实体校验返回非JSON:', text.substring(0, 100));
            return { verified: 0, removed: 0 };
        }

        const results = JSON.parse(match[0]);
        let verified = 0, removed = 0;

        for (const r of results) {
            const entry = pending[r.index];
            if (!entry) continue;
            if (r.match === true) {
                db.prepare(`UPDATE fragment_categories SET confidence = 0.90, classified_by = 'archivist_entity_verified' WHERE fragment_id = ? AND category_id = ?`)
                    .run(entry.fragment_id, entry.category_id);
                verified++;
            } else {
                db.prepare(`DELETE FROM fragment_categories WHERE fragment_id = ? AND category_id = ? AND classified_by = ?`)
                    .run(entry.fragment_id, entry.category_id, entry.classified_by);
                removed++;
            }
        }

        if (verified > 0 || removed > 0) {
            console.log(`[Archivist] 实体分类抽检: ${verified} 确认, ${removed} 移除`);
        }
        return { verified, removed };
    } catch (e) {
        console.error('[Archivist] 实体校验失败:', e.message);
        return { verified: 0, removed: 0 };
    }
}

// ═══════════════════════════════════════════════════════
// Tool: classifyFragments
//
// Two-pipeline architecture:
//   Pipeline A: Entity classification (人物/) — deterministic name matching
//     Person categories are defined by WHO, not WHAT. No embedding needed.
//     Supports multi-entity: one fragment can match multiple people.
//   Pipeline B: Topic classification — centroid similarity + depth bonus
//     + size penalty + LLM verification (only in full mode). Person categories excluded.
// ═══════════════════════════════════════════════════════

async function classifyFragments(opts = {}) {
    const { lightweight = false } = opts;
    const db = getDb();

    // v4.7: Entity-based classification. No more memory_ontology or fragment_categories.
    // Fragments are linked to entity_profiles (constellations) via fragment_entities.
    // Draco directs classification in deep cycle; lightweight mode does DB-only maintenance.

    // Exclude music listening logs and book reading logs — they're data exhaust,
    // not memory fragments about people/places/events/works. Harvested separately
    // by musicMemoryExtractor / bookMemoryExtractor. Not classified into entity graph.
    const unclassified = db.prepare(`
        SELECT mf.id, mf.content, mf.emotional_weight, mf.created_at
        FROM memory_fragments mf
        WHERE mf.status = 'active'
          AND mf.source NOT IN ('music', 'book')
          AND mf.id NOT IN (SELECT DISTINCT fragment_id FROM fragment_entities)
        ORDER BY mf.created_at DESC
        LIMIT 200
    `).all();

    if (unclassified.length === 0) {
        return { classified: 0 };
    }

    console.log(`[Archivist] 待分类碎片: ${unclassified.length} 条 (实体星系)`);

    // Load current constellations (entity_profiles grouped by category)
    const allEntities = db.prepare(`
        SELECT id, name, category, overview, aliases, fragment_count, status
        FROM entity_profiles
        ORDER BY CASE category
            WHEN 'person' THEN 0 WHEN 'pet' THEN 1
            WHEN 'place' THEN 2 WHEN 'event' THEN 3
            WHEN 'project' THEN 4 ELSE 5 END, name
    `).all();

    if (allEntities.length === 0) {
        return { classified: 0 };
    }

    // Separate active constellations and nursery seeds
    // Exclude aggregate entities (music/book memory sinks) — they're not real constellations
    const constellations = allEntities.filter(e => e.status === 'active' && !e.category?.endsWith('_aggregate'));
    const seeds = allEntities.filter(e => e.status === 'seed');

    if (constellations.length === 0) {
        // No constellations yet — defer to deep cycle / manual seeding
        console.log('[Archivist] 无活跃星座，跳过分类（等待种子数据）');
        return { classified: 0 };
    }

    const insertFe = db.prepare(`
        INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by)
        VALUES (?, ?, ?, ?, ?)
    `);

    let classified = 0;

    if (lightweight) {
        // Lightweight: keyword match against entity names + aliases only, no LLM.
        // Capped confidence — deep cycle will do proper Draco-directed classification.
        const entityIndex = buildEntityNameIndex(constellations);

        for (const frag of unclassified) {
            const content = frag.content || '';
            const contentLower = content.toLowerCase();
            const matched = new Set();

            for (const [key, entities] of entityIndex) {
                if (contentLower.includes(key)) {
                    for (const e of entities) matched.add(e.id);
                }
            }

            if (matched.size > 0) {
                for (const eid of matched) {
                    insertFe.run(frag.id, eid, null, 0.55, 'archivist_keyword_light');
                }
                classified++;
            }
        }

        console.log(`[Archivist] 轻量分类: ${classified}/${unclassified.length} 条 (关键词匹配)`);
    } else {
        // Deep cycle: Draco-directed per-batch classification with flash-lite
        const BATCH_SIZE = 15;
        const batches = [];
        for (let i = 0; i < unclassified.length; i += BATCH_SIZE) {
            batches.push(unclassified.slice(i, i + BATCH_SIZE));
        }

        let totalSeedsCreated = 0;
        for (const batch of batches) {
            if (!_canCallLLM(1)) {
                console.log(`[Archivist] LLM 日配额耗尽，剩余 ${unclassified.length - classified} 条推迟`);
                break;
            }

            const result = await classifyFragmentBatch(batch, constellations, seeds);
            if (!result) continue;

            const writeBatch = db.transaction(() => {
                let written = 0, seedsMade = 0;
                for (const assignment of result.assignments) {
                    const info = insertFe.run(
                        assignment.frag_id, assignment.entity_id,
                        assignment.relation || null,
                        assignment.confidence || 0.70,
                        'draco_flash'
                    );
                    if (info.changes > 0) written++;

                    // Update entity fragment_count
                    db.prepare(`UPDATE entity_profiles SET fragment_count = (
                        SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?
                    ), updated_at = datetime('now') WHERE id = ?`).run(assignment.entity_id, assignment.entity_id);
                }
                return { written, seedsMade };
            });

            const { written, seedsMade: sm } = writeBatch();
            classified += written;
            totalSeedsCreated += result.newSeeds ? result.newSeeds.length : 0;

            // Plant new seeds in nursery
            if (result.newSeeds && result.newSeeds.length > 0) {
                for (const seed of result.newSeeds) {
                    try {
                        // 种子质量过滤：拒单字、纯数字、空名
                        const seedName = seed.name;
                        if (typeof seedName !== 'string' || !seedName.trim()
                            || seedName.trim().length < 2
                            || /^\d+$/.test(seedName.trim())) {
                            console.log(`[Archivist] ⏭ 种子名不合格，跳过: "${seedName}"`);
                            continue;
                        }
                        const existing = db.prepare('SELECT id, name FROM entity_profiles WHERE LOWER(name) = LOWER(?)').get(seed.name);
                        if (!existing) {
                            const r = db.prepare(`INSERT INTO entity_profiles (name, category, status, aliases)
                                VALUES (?, ?, 'seed', ?)`).run(seed.name, seed.category || 'term', JSON.stringify([]));
                            // Link the fragment that triggered this seed
                            if (seed.trigger_frag_id) {
                                insertFe.run(seed.trigger_frag_id, r.lastInsertRowid, null, 0.50, 'draco_flash_seed');
                                db.prepare(`UPDATE entity_profiles SET fragment_count = 1 WHERE id = ?`).run(r.lastInsertRowid);
                            }
                            console.log(`[Archivist] 🌱 种入苗圃: ${seed.name} (${seed.category})`);
                        } else if (existing.name !== seed.name) {
                            console.log(`[Archivist] 🔗 大小写合并: "${seed.name}" → 已存在 "${existing.name}" (id=${existing.id})`);
                        }
                    } catch (e) {
                        console.error(`[Archivist] 种子创建失败: ${seed.name}`, e.message);
                    }
                }
            }
        }

        console.log(`[Archivist] 深循环分类: ${classified}/${unclassified.length} 条 (Draco+flash-lite, 新种子=${totalSeedsCreated})`);

        // After classification: graduate seeds and prune dormant
        if (classified > 0) {
            await graduateSeedsAndPrune();
        }
    }

    return { classified };
}

// ═══════════════════════════════════════════════════════
// v4.7 Helper: Build entity name → entity index for keyword matching
// ═══════════════════════════════════════════════════════

function buildEntityNameIndex(entities) {
    const index = new Map(); // lowercaseKey → [entity]

    for (const e of entities) {
        const addName = (name) => {
            const key = name.toLowerCase().trim();
            if (key.length < 2) return;
            if (!index.has(key)) index.set(key, []);
            const list = index.get(key);
            if (!list.find(x => x.id === e.id)) list.push(e);
        };

        addName(e.name);
        try {
            const aliases = JSON.parse(e.aliases || '[]');
            for (const a of aliases) {
                if (a && a.trim().length >= 2) addName(a.trim());
            }
        } catch (_) {}
    }

    return index;
}

// ═══════════════════════════════════════════════════════
// v4.7: classifyFragmentBatch — Draco-directed flash-lite classification
//
// Sends a batch of fragments + the full constellation list to flash-lite.
// Returns assignments + optional new seeds.
// ═══════════════════════════════════════════════════════

async function classifyFragmentBatch(fragments, constellations, seeds) {
    const db = getDb();

    // Build constellation list grouped by galaxy
    // v4.7 evolved: 社交(人物+宠物) / 地点 / 事件 / Clara的星系(创作+消费+观念)
    const galaxies = { person: '社交', pet: '社交', place: '地点', event: '事件', project: USER.name + '的星系', work: USER.name + '的星系', term: USER.name + '的星系', hobby: '爱好', consumed: '爱好', music_aggregate: '爱好', book_aggregate: '爱好', movie_aggregate: '爱好', organization: '社交' };
    const grouped = {};
    for (const c of constellations) {
        // v5.0 防线1: 无 overview 的种子不参与 LLM 分类匹配
        // 它们只能在 nurseryLine 中通过精确名字匹配积累碎片
        if (!c.overview) continue;
        const galaxy = galaxies[c.category] || '其他';
        if (!grouped[galaxy]) grouped[galaxy] = [];
        const overview = c.overview.slice(0, 60).replace(/\n/g, ' ');
        grouped[galaxy].push(`${c.name}[id=${c.id}](${overview})`);
    }

    // Pre-filter seeds: only show seeds whose name appears in this batch's fragments.
    // Avoids overwhelming the LLM with hundreds of irrelevant names.
    let nurseryLine = '';
    if (seeds && seeds.length > 0) {
        const batchText = fragments.map(f => (f.content || '').toLowerCase()).join(' ');
        const relevantSeeds = seeds.filter(s => typeof s.name === 'string' && batchText.includes(s.name.toLowerCase()));
        if (relevantSeeds.length > 0) {
            const maxShow = Math.min(relevantSeeds.length, 30);
            const shown = relevantSeeds.slice(0, maxShow);
            const seedNames = shown.map(s => `${s.name}[id=${s.id},${s.category}]`).join(', ');
            const extra = relevantSeeds.length > maxShow ? ` ...还有${relevantSeeds.length - maxShow}个相关种子未列出` : '';
            nurseryLine = `\n苗圃种子（本批次可能相关，可分配碎片）：${seedNames}${extra}`;
        }
    }

    const galaxyBlocks = Object.entries(grouped)
        .map(([galaxy, entities]) => `${galaxy}星系:\n  ${entities.join('\n  ')}`)
        .join('\n\n');

    const fragLines = fragments.map(f => {
        const text = (f.content || '').slice(0, 200).replace(/\n/g, ' ');
        const date = (f.created_at || '').slice(0, 10);
        return `[frag_${f.id}] ${date} | ${text}`;
    }).join('\n');

    const isEarlyGrowth = constellations.length <= 5;
    const growthNote = isEarlyGrowth
        ? `\n⚠️ 星系处于早期构建阶段：当前只有 ${constellations.length} 个星座。大多数碎片提到的实体（人物、地点、事件、作品）尚未存在于星系中。发现并播种新实体是你的核心任务。`
        : '';

    const prompt = `你是 Draco 的实体分类助手。Draco 在整理他的记忆星系，需要你把新星星（碎片）归入正确的星座。

当前星系全景：
${galaxyBlocks}${nurseryLine}${growthNote}

边标签类型（可选，描述 Clara 与实体的关系）：
- knows: Clara 认识/交往的人物
- cares_for: Clara 照顾的宠物
- visited: Clara 去过/所在的地点
- attended: Clara 参与的事件
- created: Clara 创作/构建的作品
- consumed: Clara 阅读/观看/聆听的消费内容
- related_to: 兜底，说不清但有关联
新星星待分类：
${fragLines}

你是一个在整理记忆星图的观测者。你的直觉：

- 当你看到碎片中浮现出一个**有名字的、独立的、可能会在更多碎片中再次出现的生命/地点/事件**——你觉得它应该是一颗种子。你给它起一个简短准确的名字，猜测它的星系归属（person/pet→社交, place→地点, event→事件, project/work/term→Clara的星系, hobby/consumed→爱好），种下去。
- 当你看到碎片明确属于某个已有星座——你很确定地把星星归过去，顺手标注它与Clara的关系（knows/cares_for/visited/attended/created/consumed/related_to）。
- 当你看到碎片只是一次性的、飘过去的、不会再以独立身份出现的引用——你不会为它播种。它可能属于现有星座，也可能只是一颗还没找到家的流浪星。
- 当你拿不准——你宁可先不归类，也不硬塞。

一条碎片可以同时归入现有星座并播种新实体。

只输出JSON数组，不要markdown标记：
[{"frag_id":10103,"constellations":[{"id":5,"relation":"appeared_in"}],"confidence":0.85,"new_seed":{"name":"阿日斯兰","category":"person"}}]`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.2, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 } },
            ARCHIVIST_LLM_CONFIG_ID  // DeepSeek — stronger judgment for entity classification
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            console.error(`[Archivist] classifyFragmentBatch LLM响应无法解析: ${replyText.slice(0, 200)}`);
            return null;
        }

        const items = JSON.parse(jsonMatch[0]);
        const assignments = [];
        const newSeeds = [];

        for (const item of items) {
            if (!item.frag_id) continue;

            // Validate fragment ID
            const fragExists = db.prepare('SELECT 1 FROM memory_fragments WHERE id = ?').get(item.frag_id);
            if (!fragExists) continue;

            if (item.constellations && item.constellations.length > 0) {
                for (const c of item.constellations) {
                    // Validate entity ID
                    const entityExists = db.prepare('SELECT 1 FROM entity_profiles WHERE id = ?').get(c.id);
                    if (!entityExists) continue;
                    assignments.push({
                        frag_id: item.frag_id,
                        entity_id: c.id,
                        relation: c.relation || null,
                        confidence: item.confidence || 0.70
                    });
                }
            }

            if (item.new_seed && item.new_seed.name) {
                newSeeds.push({
                    name: item.new_seed.name.slice(0, 50).trim(),
                    category: item.new_seed.category || 'term',
                    trigger_frag_id: item.frag_id
                });
            }
        }

        return { assignments, newSeeds };
    } catch (e) {
        console.error('[Archivist] classifyFragmentBatch LLM调用失败:', e.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════
// v4.7: rematchFragmentsForSeeds — 回补漏判碎片
//
// The batch classifier misses ~74% of potential matches because
// output space limits prevent exhaustive assignment. This runs a
// targeted pass: for each seed, gather fragments that literally
// mention its name but aren't linked, ask LLM yes/no per fragment.
// ═══════════════════════════════════════════════════════

async function rematchFragmentsForSeeds() {
    const db = getDb();

    // Find seeds where fragment_count < actual mentions in fragments
    // Exclude music/book fragments (data exhaust, excluded from entity classification)
    const seeds = db.prepare(`
        SELECT * FROM (
            SELECT ep.id, ep.name, ep.category, ep.fragment_count,
                (SELECT COUNT(*) FROM memory_fragments mf
                 WHERE mf.content LIKE '%' || ep.name || '%'
                   AND mf.status = 'active'
                   AND mf.source NOT IN ('music', 'book')
                   AND mf.id NOT IN (SELECT fragment_id FROM fragment_entities WHERE entity_id = ep.id)
                ) as unlinked
            FROM entity_profiles ep
            WHERE ep.status IN ('seed', 'active')
              AND ep.name NOT IN (${SKIP_PH})
              AND ep.category NOT IN ('music_aggregate', 'book_aggregate', 'movie_aggregate')
        )
        WHERE unlinked > 0
        ORDER BY unlinked DESC
        LIMIT 100
    `).all(...SKIP_NAMES);

    if (seeds.length === 0) {
        console.log('[Archivist] 回补: 没有需要补分的种子');
        return { rematched: 0 };
    }

    console.log(`[Archivist] 回补: ${seeds.length} 个种子有漏判碎片`);

    // Process seeds in batches of 8 to keep prompt manageable
    const BATCH_SIZE = 8;
    let totalRematched = 0;

    for (let i = 0; i < seeds.length; i += BATCH_SIZE) {
        const batch = seeds.slice(i, i + BATCH_SIZE);

        // Gather unlinked fragments for each seed (max 15 per seed to limit prompt size)
        const seedFragments = [];
        for (const s of batch) {
            const frags = db.prepare(`
                SELECT id, content, created_at FROM memory_fragments
                WHERE content LIKE ? AND status = 'active'
                  AND source NOT IN ('music', 'book')
                  AND id NOT IN (SELECT fragment_id FROM fragment_entities WHERE entity_id = ?)
                ORDER BY created_at DESC
                LIMIT 15
            `).all('%' + s.name + '%', s.id);

            if (frags.length > 0) {
                seedFragments.push({ seed: s, frags });
            }
        }

        if (seedFragments.length === 0) continue;

        // Build prompt
        let prompt = '回补漏判碎片。对每个种子 + 它的候选碎片，判断是否属于该种子。\\n\\n';
        for (const { seed, frags } of seedFragments) {
            prompt += `种子: ${seed.name}[id=${seed.id},${seed.category}] 当前⭐${seed.fragment_count}\\n`;
            prompt += `候选碎片（文本中提到"${seed.name}"，判断是否属于该种子）:\\n`;
            for (const f of frags) {
                const text = (f.content || '').slice(0, 180).replace(/\\n/g, ' ');
                prompt += `  [frag_${f.id}] ${text}\\n`;
            }
            prompt += '\\n';
        }

        prompt += `对每条候选碎片判断match:true/false。一条碎片可以同时match多个种子（如果文本中提到了多个）。不确定就match:false（宁漏勿错）。\\n\\n只输出JSON数组:\\n[{"frag_id":101,"seed_id":1626,"match":true}, ...]`;

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                WORLD_CONTEXT,
                null,
                { temperature: 0.1, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );

            const replyText = raw?.reply || raw?.text || raw?.content || '';
            const jsonMatch = replyText.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                console.error(`[Archivist] 回补 LLM响应无法解析: ${replyText.slice(0, 200)}`);
                continue;
            }

            const items = JSON.parse(jsonMatch[0]);
            const insertFe = db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, NULL, 0.60, ?)');
            const updateFc = db.prepare('UPDATE entity_profiles SET fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?) WHERE id = ?');

            let batchRematched = 0;
            const writeBatch = db.transaction(() => {
                for (const item of items) {
                    if (item.match === true && item.frag_id && item.seed_id) {
                        const r = insertFe.run(item.frag_id, item.seed_id, 'draco_rematch');
                        if (r.changes > 0) batchRematched++;
                    }
                }
                // Update fragment_counts for affected seeds
                const seedIds = [...new Set(items.filter(i => i.match).map(i => i.seed_id))];
                for (const sid of seedIds) {
                    updateFc.run(sid, sid);
                }
            });
            writeBatch();

            totalRematched += batchRematched;
            console.log(`[Archivist] 回补批次: ${batchRematched} 条匹配 (${seedFragments.map(s => s.seed.name).join(', ')})`);
        } catch (e) {
            console.error('[Archivist] 回补 LLM调用失败:', e.message);
        }
    }

    console.log(`[Archivist] 回补完成: ${totalRematched} 条碎片归位`);
    return { rematched: totalRematched };
}

// ═══════════════════════════════════════════════════════
// v4.8: semanticRematchForSeeds — 语义回补
//
// 字面 rematch 捞不到「去西安那次」「在城墙上累瘫了」这类
// 描述性提及（碎片不含实体名）。对小实体用 name+overview 做
// 向量检索，候选送 flash 确认。地点/事件类实体的主要归位通路。
// 仅深循环调用（ChromaDB 依赖，轻量模式禁入）。
// ═══════════════════════════════════════════════════════

const SEMANTIC_REMATCH_SIM_FLOOR = 0.40;   // 向量相似度门槛
const SEMANTIC_REMATCH_MAX_ENTITIES = 12;  // 每轮处理实体数（控制 LLM 用量）

async function semanticRematchForSeeds() {
    const db = getDb();
    const { searchMemoriesByVector } = require('./memory');

    // 小实体优先：碎片少的星座最需要喂
    const targets = db.prepare(`
        SELECT ep.id, ep.name, ep.category, ep.overview, ep.fragment_count
        FROM entity_profiles ep
        WHERE ep.status IN ('seed', 'active')
          AND ep.name NOT IN (${SKIP_PH})
          AND ep.fragment_count < 5
        ORDER BY ep.fragment_count ASC, ep.updated_at DESC
        LIMIT ?
    `).all(...SKIP_NAMES, SEMANTIC_REMATCH_MAX_ENTITIES);

    if (targets.length === 0) return { rematched: 0 };

    const insertFe = db.prepare(`INSERT OR IGNORE INTO fragment_entities
        (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, NULL, 0.55, 'semantic_rematch')`);
    const updateFc = db.prepare(`UPDATE entity_profiles SET fragment_count =
        (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?) WHERE id = ?`);

    let total = 0;
    for (const ent of targets) {
        if (!_canCallLLM(1)) break;

        // 用实体名+概述做语义查询，捞描述性提及
        const queryText = ent.overview ? `${ent.name}：${ent.overview.slice(0, 120)}` : ent.name;
        let hits;
        try {
            hits = await searchMemoriesByVector(queryText, 10);
        } catch (e) {
            console.error(`[Archivist] 语义回补向量查询失败 (${ent.name}):`, e.message);
            continue;
        }

        const linked = new Set(db.prepare('SELECT fragment_id FROM fragment_entities WHERE entity_id = ?')
            .all(ent.id).map(r => r.fragment_id));
        const candidates = (hits || []).filter(h =>
            h._table === 'memory_fragments' &&
            h._similarity >= SEMANTIC_REMATCH_SIM_FLOOR &&
            !linked.has(h.id)
        ).slice(0, 8);

        if (candidates.length === 0) continue;

        const fragLines = candidates.map(c =>
            `[frag_${c.id}] ${(c.content || '').slice(0, 180).replace(/\n/g, ' ')}`).join('\n');
        const prompt = `实体: ${ent.name} (${ent.category})${ent.overview ? '\n概述: ' + ent.overview.slice(0, 150) : ''}

以下碎片是语义检索找到的候选（文本里不一定出现"${ent.name}"，可能是间接提及，如"去西安那次"指代西安旅行）。
判断每条是否确实在讲这个实体。间接指代算 match。只是主题相似但讲的不是它，不算。不确定就 false。

${fragLines}

只输出JSON数组: [{"frag_id":101,"match":true}, ...]`;

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                WORLD_CONTEXT,
                null,
                { temperature: 0.1, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
            const replyText = raw?.reply || raw?.text || raw?.content || '';
            const jsonMatch = replyText.match(/\[[\s\S]*\]/);
            if (!jsonMatch) continue;
            const items = JSON.parse(jsonMatch[0]);

            let matched = 0;
            const writeBatch = db.transaction(() => {
                for (const item of items) {
                    if (item.match === true && item.frag_id) {
                        const r = insertFe.run(item.frag_id, ent.id);
                        if (r.changes > 0) matched++;
                    }
                }
                if (matched > 0) updateFc.run(ent.id, ent.id);
            });
            writeBatch();
            if (matched > 0) {
                total += matched;
                console.log(`[Archivist] 🔭 语义回补: ${ent.name} +${matched} 颗星 (${ent.fragment_count}→${ent.fragment_count + matched})`);
            }
        } catch (e) {
            console.error(`[Archivist] 语义回补 LLM 失败 (${ent.name}):`, e.message);
        }
    }

    if (total > 0) console.log(`[Archivist] 语义回补完成: ${total} 条碎片归位`);
    return { rematched: total };
}

// ═══════════════════════════════════════════════════════
// v4.8: mergeDuplicateSeeds — 重复种子合并
//
// 「5月3日漫展」「漫展签名事件」「2026-05-02漫展签名活动」是同
// 一件事的三个种子，碎片被摊薄后谁都到不了升格线。同 category
// 内名字相似或共享碎片的种子对 → LLM 判同 → 合并。
// ═══════════════════════════════════════════════════════

function _nameBigrams(name) {
    const s = (name || '').toLowerCase().replace(/[\s\d\-—·:：年月日]/g, '');
    const grams = new Set();
    for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
    return grams;
}

async function mergeDuplicateSeeds() {
    const db = getDb();

    const seeds = db.prepare(`
        SELECT id, name, category, fragment_count, aliases, overview
        FROM entity_profiles
        WHERE status IN ('seed', 'active') AND name NOT IN (${SKIP_PH})
          AND category NOT IN ('music_aggregate', 'book_aggregate', 'movie_aggregate')
    `).all(...SKIP_NAMES);

    // 泛指词检测：被 ≥2 个其他实体名包含的短名（「录音棚」⊂ 弈和录音棚+奇响录音棚）
    // 是类目词不是具体实体，与它的包含关系不构成同一性。
    const genericNames = new Set();
    for (const s of seeds) {
        if (typeof s.name !== 'string') continue;
        const sn = s.name.toLowerCase();
        let containers = 0;
        for (const o of seeds) {
            if (typeof o.name !== 'string') continue;
            if (o.id !== s.id && o.name.toLowerCase().includes(sn)) containers++;
        }
        if (containers >= 2) genericNames.add(s.id);
    }

    // 候选对：同 category 且名字包含/bigram 相似
    const pairs = [];
    for (let i = 0; i < seeds.length; i++) {
        for (let j = i + 1; j < seeds.length; j++) {
            const a = seeds[i], b = seeds[j];
            if (typeof a.name !== 'string' || typeof b.name !== 'string') continue;
            if (a.category !== b.category) continue;
            if (genericNames.has(a.id) || genericNames.has(b.id)) continue;
            // 候选对只由名字关系产生。共享碎片不是同一性证据——
            // 同一碎片提到两只猫/两个人是跨实体多挂的 feature，那是
            // discoverRelatedEntities（关系桥）的领域。
            // 名字互相包含（处理「猫砚」vs「砚」这类单字/昵称，bigram 算不出）
            const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
            if (an.includes(bn) || bn.includes(an)) { pairs.push({ a, b, nameContained: true, reason: '名字包含' }); continue; }
            const ga = _nameBigrams(a.name), gb = _nameBigrams(b.name);
            if (ga.size === 0 || gb.size === 0) continue;
            let overlap = 0;
            for (const g of ga) if (gb.has(g)) overlap++;
            const ratio = overlap / Math.min(ga.size, gb.size);
            if (ratio >= 0.5) pairs.push({ a, b, nameContained: false, reason: `名字相似${(ratio * 100).toFixed(0)}%` });
        }
    }

    // 跨语言/缩写候选：同类别、零文本重叠、但共享碎片 ≥1 →
    // LLM 判断是否为同一实体的别称（Mona=摩纳, CC=Claude）
    const crossLangCandidates = [];
    for (let i = 0; i < seeds.length; i++) {
        for (let j = i + 1; j < seeds.length; j++) {
            const a = seeds[i], b = seeds[j];
            if (a.category !== b.category) continue;
            if (typeof a.name !== 'string' || typeof b.name !== 'string') continue;
            if (genericNames.has(a.id) || genericNames.has(b.id)) continue;
            const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
            // 跳过已有文本重叠的（已被上面的逻辑覆盖）
            if (an.includes(bn) || bn.includes(an)) continue;
            const ga = _nameBigrams(a.name), gb = _nameBigrams(b.name);
            if (ga.size > 0 && gb.size > 0) {
                let overlap = 0;
                for (const g of ga) if (gb.has(g)) overlap++;
                if (overlap / Math.min(ga.size, gb.size) >= 0.5) continue; // 已有文本匹配
            }
            // 零文本重叠 + 同类别 → LLM 别称判断候选
            crossLangCandidates.push({ a, b });
        }
    }

    // ── v5.1 第三路径: 碎片重叠 ≥50% → 直接合并（零 LLM）──
    // 覆盖「推歌 vs 绿心理由」这类名字完全不同但共享大量碎片的情况
    let overlapMerged = 0;
    for (let i = 0; i < seeds.length; i++) {
        for (let j = i + 1; j < seeds.length; j++) {
            const a = seeds[i], b = seeds[j];
            if (a.category !== b.category) continue;
            if (typeof a.name !== 'string' || typeof b.name !== 'string') continue;
            if (genericNames.has(a.id) || genericNames.has(b.id)) continue;
            // Skip pairs already caught by name similarity
            const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
            if (an.includes(bn) || bn.includes(an)) continue;
            const ga = _nameBigrams(a.name), gb = _nameBigrams(b.name);
            if (ga.size > 0 && gb.size > 0) {
                let nOverlap = 0;
                for (const g of ga) if (gb.has(g)) nOverlap++;
                if (nOverlap / Math.min(ga.size, gb.size) >= 0.5) continue; // already caught
            }

            // Check fragment overlap ratio
            const overlap = db.prepare(`
                SELECT COUNT(*) as c FROM fragment_entities fe1
                JOIN fragment_entities fe2 ON fe1.fragment_id = fe2.fragment_id
                WHERE fe1.entity_id = ? AND fe2.entity_id = ?
            `).get(a.id, b.id)?.c || 0;

            const minFrags = Math.min(a.fragment_count, b.fragment_count);
            if (minFrags > 0 && overlap / minFrags >= 0.5) {
                // Auto-merge: keep the one with more fragments
                const [winner, loser] = a.fragment_count >= b.fragment_count ? [a, b] : [b, a];
                // Move loser's unique fragments
                db.prepare(`UPDATE OR IGNORE fragment_entities SET entity_id = ? WHERE entity_id = ?`)
                    .run(winner.id, loser.id);
                // Delete duplicates
                db.prepare(`DELETE FROM fragment_entities WHERE entity_id = ?`).run(loser.id);
                // Transfer aliases/tags
                const wAliases = (() => { try { return JSON.parse(winner.aliases || '[]'); } catch(_) { return []; } })();
                const lAliases = (() => { try { return JSON.parse(loser.aliases || '[]'); } catch(_) { return []; } })();
                const wTags = (() => { try { return JSON.parse(winner.tags || '[]'); } catch(_) { return []; } })();
                const lTags = (() => { try { return JSON.parse(loser.tags || '[]'); } catch(_) { return []; } })();
                const mergedAliases = [...new Set([...wAliases, ...lAliases])].slice(0, 8);
                const mergedTags = [...new Set([...wTags, ...lTags])].slice(0, 8);
                db.prepare(`UPDATE entity_profiles SET aliases=?, tags=?, fragment_count=(SELECT COUNT(*) FROM fragment_entities WHERE entity_id=?), updated_at=datetime('now') WHERE id=?`)
                    .run(JSON.stringify(mergedAliases), JSON.stringify(mergedTags), winner.id, winner.id);
                db.prepare(`UPDATE entity_profiles SET status='superseded', updated_at=datetime('now') WHERE id=?`).run(loser.id);
                console.log(`[Archivist] 🔗 碎片重叠合并: "${loser.name}" → "${winner.name}" (重叠${overlap}/${minFrags}=${Math.round(overlap/minFrags*100)}%)`);
                overlapMerged++;
            }
        }
    }
    if (overlapMerged > 0) return { merged: overlapMerged, reason: 'fragment_overlap' };

    // 每轮最多问 LLM 3 对（控制成本）
    let llmAliasChecked = 0;
    for (const cand of crossLangCandidates) {
        if (llmAliasChecked >= 3) break;
        if (!_canCallLLM(1)) break;

        const prompt = `记忆星系中有两个同属「${cand.a.category}」类别的星座，名字完全不同。请判断它们是否指同一个实体（只是用了不同的名称/别名/语言）。

A: ${cand.a.name} (${cand.a.category}, ${cand.a.fragment_count}条碎片)
B: ${cand.b.name} (${cand.b.category}, ${cand.b.fragment_count}条碎片)

它们是同一个实体吗？只输出JSON: {"same":true|false,"reason":"一句话"}`;

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                WORLD_CONTEXT, null,
                { temperature: 0.1, maxOutputTokens: 150, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
            llmAliasChecked++;
            const replyText = raw?.reply || raw?.text || raw?.content || '';
            const jsonMatch = replyText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) continue;
            const verdict = JSON.parse(jsonMatch[0]);
            if (verdict.same) {
                pairs.push({ a: cand.a, b: cand.b, nameContained: false, reason: `LLM别名: ${verdict.reason}` });
                console.log(`[Archivist] 🔗 LLM别名检测: ${cand.a.name} = ${cand.b.name} — ${verdict.reason}`);
            }
        } catch (e) {
            console.error('[Archivist] LLM别名检测失败:', e.message);
        }
    }

    // 时间线检测：同类别事件/地点，碎片日期高度重叠 → LLM 判断是否同一事件
    // （"5月3日漫展"和"5月3日签售活动"名字重叠但共享碎片为零，需日期证据）
    const getFragDates = db.prepare(`
        SELECT DISTINCT substr(mf.source_date,1,10) as day
        FROM memory_fragments mf
        JOIN fragment_entities fe ON mf.id = fe.fragment_id
        WHERE fe.entity_id = ?
        ORDER BY day
    `);
    const alreadyPaired = new Set();
    for (const p of pairs) { alreadyPaired.add(`${p.a.id}-${p.b.id}`); alreadyPaired.add(`${p.b.id}-${p.a.id}`); }

    let timeChecked = 0;
    for (let i = 0; i < seeds.length && timeChecked < 2; i++) {
        for (let j = i + 1; j < seeds.length && timeChecked < 2; j++) {
            const a = seeds[i], b = seeds[j];
            if (a.category !== b.category) continue;
            if (a.category !== 'event' && a.category !== 'place') continue; // 只有事件/地点受益于时间证据
            if (typeof a.name !== 'string' || typeof b.name !== 'string') continue;
            if (alreadyPaired.has(`${a.id}-${b.id}`)) continue;
            if (!_canCallLLM(1)) break;

            const daysA = getFragDates.all(a.id).map(r => r.day);
            const daysB = getFragDates.all(b.id).map(r => r.day);
            const overlapDays = daysA.filter(d => daysB.includes(d));
            const unionDays = new Set([...daysA, ...daysB]).size;
            if (overlapDays.length === 0 || overlapDays.length / unionDays < 0.5) continue;
            // 日期重叠 ≥50% → 可能是同一事件的不同名字

            const prompt = `记忆星系中有两个「${a.category}」星座，名字不同但碎片日期高度重叠（${overlapDays.length}/${unionDays}天重叠：${overlapDays.slice(0,3).join(',')}${overlapDays.length>3?'...':''}）。

A: ${a.name} (${a.fragment_count}条碎片)
B: ${b.name} (${b.fragment_count}条碎片)

它们是同一个实体吗（只是起了不同的名字）？只输出JSON: {"same":true|false,"reason":"一句话"}`;

            try {
                const raw = await callLLM(
                    [{ role: 'user', parts: [{ text: prompt }] }],
                    WORLD_CONTEXT, null,
                    { temperature: 0.1, maxOutputTokens: 150, thinkingConfig: { thinkingBudget: 0 } },
                    ARCHIVIST_LLM_CONFIG_ID
                );
                agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
                timeChecked++;
                const replyText = raw?.reply || raw?.text || raw?.content || '';
                const jsonMatch = replyText.match(/\{[\s\S]*\}/);
                if (!jsonMatch) continue;
                const verdict = JSON.parse(jsonMatch[0]);
                if (verdict.same) {
                    pairs.push({ a, b, nameContained: false, reason: `时间重叠(${overlapDays.length}/${unionDays}天): ${verdict.reason}` });
                    console.log(`[Archivist] 🕐 时间线检测: ${a.name} = ${b.name} — ${overlapDays.length}/${unionDays}天重叠`);
                }
            } catch (e) {
                console.error('[Archivist] 时间线检测LLM失败:', e.message);
            }
        }
    }

    if (pairs.length === 0) return { merged: 0 };

    const sharedCount = db.prepare(`
        SELECT COUNT(*) c FROM fragment_entities f1
        JOIN fragment_entities f2 ON f1.fragment_id = f2.fragment_id
        WHERE f1.entity_id = ? AND f2.entity_id = ?`);

    // 确定性快道：名字互相包含 且 共享碎片占小方 ≥80%（≥3条）= 同一实体，不问 LLM。
    // LLM 会被矛盾的自动生成概述带偏（「猫砚」被写成人、「砚」被写成猫），而那矛盾正是要修的污染。
    // 必须 nameContained——Mona/肉肉 共享 100%（同一段宠物介绍多挂）但是两只猫，名字无关不走快道。
    const autoSame = [];
    const llmPairs = [];
    for (const p of pairs) {
        const shared = sharedCount.get(p.a.id, p.b.id).c;
        const minFc = Math.max(1, Math.min(p.a.fragment_count, p.b.fragment_count));
        if (p.nameContained && shared >= 3 && shared / minFc >= 0.8) autoSame.push(p);
        else llmPairs.push(p);
    }

    // 非铁证候选不调 LLM（LLM 分不清「静安寺/静安大悦城」这类名字相似的不同实体，
    // 误合并代价高且修复昂贵）→ 写入待确认队列，星图上由 Clara 人工裁决。
    let proposed = 0;
    const hasProposal = db.prepare(`
        SELECT COUNT(*) c FROM ontology_changelog
        WHERE action = 'merge_proposal'
          AND json_extract(detail, '$.a_id') = ? AND json_extract(detail, '$.b_id') = ?
          AND status IN ('pending', 'rejected')`);
    const insProposal = db.prepare(`
        INSERT INTO ontology_changelog (action, category_path, detail, status) VALUES ('merge_proposal', ?, ?, 'pending')`);
    for (const p of llmPairs) {
        // 同一对只提案一次；被拒过的不再提
        if (hasProposal.get(p.a.id, p.b.id).c > 0 || hasProposal.get(p.b.id, p.a.id).c > 0) continue;
        const shared = sharedCount.get(p.a.id, p.b.id).c;
        insProposal.run(`${p.a.name} ↔ ${p.b.name}`, JSON.stringify({
            a_id: p.a.id, a_name: p.a.name, a_fc: p.a.fragment_count,
            b_id: p.b.id, b_name: p.b.name, b_fc: p.b.fragment_count,
            reason: p.reason, shared,
        }));
        proposed++;
        console.log(`[Archivist] 🔍 合并提案入队: "${p.a.name}" ↔ "${p.b.name}" (${p.reason}) — 待 Clara 确认`);
    }

    let merged = 0;
    const mergedIds = new Set(); // 防止链式合并同一实体两次
    for (const p of autoSame) {
        const { a, b } = p;
        if (mergedIds.has(a.id) || mergedIds.has(b.id)) continue;
        // 碎片多者存活；同数则名字短者存活（通常更规范）
        const [survivor, victim] = (a.fragment_count > b.fragment_count ||
            (a.fragment_count === b.fragment_count && a.name.length <= b.name.length)) ? [a, b] : [b, a];
        if (executeEntityMerge(survivor.id, victim.id)) {
            mergedIds.add(victim.id);
            merged++;
        }
    }

    return { merged, proposed };
}

// 合并执行（事务）：自动快道与人工确认 API 共用。返回 true=成功。
function executeEntityMerge(survivorId, victimId) {
    const db = getDb();
    const survivor = db.prepare('SELECT id, name, aliases FROM entity_profiles WHERE id = ?').get(survivorId);
    const victim = db.prepare('SELECT id, name FROM entity_profiles WHERE id = ?').get(victimId);
    if (!survivor || !victim) return false;
    try {
        const doMerge = db.transaction(() => {
            // 迁移碎片链接（重复的由 UNIQUE 约束 + OR IGNORE 吸收）
            const victimLinks = db.prepare('SELECT fragment_id, relation, confidence, classified_by FROM fragment_entities WHERE entity_id = ?').all(victim.id);
            const ins = db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, ?, ?, ?)');
            for (const l of victimLinks) ins.run(l.fragment_id, survivor.id, l.relation, l.confidence, l.classified_by);
            db.prepare('DELETE FROM fragment_entities WHERE entity_id = ?').run(victim.id);
            // 败者名字进存活者 aliases
            let aliases = [];
            try { aliases = JSON.parse(survivor.aliases || '[]'); } catch (_) {}
            if (!aliases.includes(victim.name)) aliases.push(victim.name);
            // overview 置空强制重新生成——两边概述可能互相矛盾（如把人写成猫），不能留旧的
            db.prepare(`UPDATE entity_profiles SET aliases = ?, overview = NULL, fragment_count =
                (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?), updated_at = datetime('now') WHERE id = ?`)
                .run(JSON.stringify(aliases), survivor.id, survivor.id);
            db.prepare(`UPDATE entity_profiles SET status = 'merged', updated_at = datetime('now') WHERE id = ?`).run(victim.id);
            db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status) VALUES ('seed_merge', ?, ?, 'done')`)
                .run(survivor.name, JSON.stringify({ victim: victim.name, survivor: survivor.name, migrated: victimLinks.length }));
        });
        doMerge();
        console.log(`[Archivist] 🔗 种子合并: "${victim.name}" → "${survivor.name}"`);
        return true;
    } catch (e) {
        console.error(`[Archivist] 种子合并失败 (${victim.name}→${survivor.name}):`, e.message);
        return false;
    }
}

// ═══════════════════════════════════════════════════════
// v4.8: refreshIntuitionStopwords — 直觉触发词去高频
//
// 统计近30天 Clara 消息的 top-N 高频词（2-4字滑窗），存
// user_settings.intuition_stopwords。intuition 匹配时跳过
// 这些词——否则「代码/界面/开源」这类日常词让直觉永远全量激活。
// 纯 SQL + 字符统计，零 LLM。
// ═══════════════════════════════════════════════════════

async function refreshIntuitionStopwords() {
    const db = getDb();
    const { encryption } = require('../encryption');

    const messages = db.prepare(`
        SELECT content FROM messages
        WHERE sender = 'user' AND timestamp > datetime('now', '-30 days')
          AND content IS NOT NULL AND content != ''
        LIMIT 3000
    `).all();
    if (messages.length < 100) return { stopwords: 0 };

    // 词频统计：2-4 字滑窗（CJK）+ 英文单词
    const freq = new Map();
    const msgSeen = new Map(); // 词 → 出现过的消息数（防止单条刷屏制造高频）
    let parsed = 0;
    for (let mi = 0; mi < messages.length; mi++) {
        let text = messages[mi].content || '';
        if (text.startsWith('enc:')) {
            try { text = encryption.decrypt(text, { silent: true }); } catch (_) { continue; }
        }
        try { const j = JSON.parse(text); text = (j.components || []).filter(c => c.type === 'text').map(c => c.content || c.text || '').join(' '); } catch (_) {}
        if (!text || text.length < 4) continue;
        parsed++;
        const seenInMsg = new Set();
        const cjk = text.match(/[一-鿿]{2,}/g) || [];
        for (const chunk of cjk) {
            for (const len of [2, 3]) {
                for (let i = 0; i + len <= chunk.length; i++) {
                    const w = chunk.slice(i, i + len);
                    seenInMsg.add(w);
                }
            }
        }
        const eng = text.toLowerCase().match(/[a-z]{3,12}/g) || [];
        for (const w of eng) seenInMsg.add(w);
        for (const w of seenInMsg) {
            freq.set(w, (freq.get(w) || 0) + 1);
            msgSeen.set(w, (msgSeen.get(w) || 0) + 1);
        }
    }

    // 高频判定：出现在 ≥3% 的消息中（按消息数去重，刷屏免疫）。
    // 实测 2900 条样本：8% 只抓到「什么」；「代码/界面」这类日常词在 3-6% 区间。
    const threshold = Math.max(10, Math.floor(parsed * 0.03));
    const stopwords = [...msgSeen.entries()]
        .filter(([w, c]) => c >= threshold)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 120)
        .map(([w]) => w);

    try {
        const { setUserSetting } = require('../utils/settings');
        setUserSetting('intuition_stopwords', JSON.stringify(stopwords));
        console.log(`[Archivist] 直觉停用词更新: ${stopwords.length} 个（样本${parsed}条消息，阈值${threshold}）— 前10: ${stopwords.slice(0, 10).join(',')}`);
    } catch (e) {
        console.error('[Archivist] 停用词写入失败:', e.message);
    }
    return { stopwords: stopwords.length };
}

// ═══════════════════════════════════════════════════════
// v4.8: auditNewEpisodes — Episode 写入质检
//
// 新 episode（consolidateCategory 产出）追溯其 source_msg_ids 原始消息，
// LLM 判断片段忠实度。faithful=正常 / distorted=降权标记 / fabricated=归档。
// 每轮 ≤3 条。观星手记可见。
// ═══════════════════════════════════════════════════════

async function auditNewEpisodes() {
    const db = getDb();
    const { encryption } = require('../encryption');

    const episodes = db.prepare(`
        SELECT id, content, source_msg_ids, created_at FROM memories
        WHERE layer = 'episode' AND consolidation_type = 'standard'
          AND (audit_status IS NULL OR audit_status = '')
        ORDER BY created_at DESC LIMIT 3
    `).all();
    if (episodes.length === 0) return { audited: 0 };

    if (!_canCallLLM(1)) return { audited: 0 };

    const markAudit = db.prepare(`UPDATE memories SET audit_status = ? WHERE id = ?`);

    for (const ep of episodes) {
        let sourceIds = [];
        try { sourceIds = JSON.parse(ep.source_msg_ids || '[]'); } catch (_) {}
        if (sourceIds.length === 0) { markAudit.run('skipped_no_sources', ep.id); continue; }

        // 最多读 5 条源消息做抽样验证
        const msgIds = sourceIds.slice(0, 5);
        const placeholders = msgIds.map(() => '?').join(',');
        const messages = db.prepare(`
            SELECT id, sender, content FROM messages WHERE id IN (${placeholders})
        `).all(...msgIds);

        const origTexts = messages.map(m => {
            let text = m.content || '';
            if (text.startsWith('enc:')) {
                try { text = encryption.decrypt(text, { silent: true }); } catch (_) { text = ''; }
            }
            try { const j = JSON.parse(text); text = (j.components || []).filter(c => c.type === 'text').map(c => c.content || c.text || '').join(' '); } catch (_) {}
            return `[${m.sender}] ${text.slice(0, 150)}`;
        }).join('\n');

        if (!origTexts.trim()) { markAudit.run('skipped_empty_msgs', ep.id); continue; }

        const prompt = `下面的「记忆片段」是从聊天记录中自动整合生成的。请对比原始对话，判断这份总结是否忠实。

原始对话抽样：
${origTexts.slice(0, 2000)}

记忆片段：
${(ep.content || '').slice(0, 500)}

判断（三选一）：
- faithful: 总结准确反映了对话中的事实，无编造
- distorted: 有轻微偏差（日期/细节/人物混淆），但不至于完全错误
- fabricated: 编造了对话中不存在的事实或事件

只输出JSON: {"verdict":"faithful|distorted|fabricated","reason":"一句话"}`;

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                null, null,
                { temperature: 0.1, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
            const replyText = raw?.reply || raw?.text || raw?.content || '';
            const jsonMatch = replyText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) continue;
            const verdict = JSON.parse(jsonMatch[0]);

            if (verdict.verdict === 'distorted') {
                db.prepare('UPDATE memories SET weight = MAX(1, weight * 0.5), audit_status = ? WHERE id = ?').run('distorted', ep.id);
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status) VALUES ('episode_audit', NULL, ?, 'done')`)
                    .run(JSON.stringify({ verdict: 'distorted', reason: verdict.reason, episode_id: ep.id, snippet: (ep.content || '').slice(0, 60) }));
                console.log(`[Archivist] 📋 质检 distorted: ep#${ep.id} — ${(verdict.reason || '').slice(0, 60)}`);
            } else if (verdict.verdict === 'fabricated') {
                db.prepare("UPDATE memories SET status = 'archived', audit_status = 'fabricated' WHERE id = ?").run(ep.id);
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status) VALUES ('episode_audit', NULL, ?, 'done')`)
                    .run(JSON.stringify({ verdict: 'fabricated', reason: verdict.reason, episode_id: ep.id, snippet: (ep.content || '').slice(0, 60) }));
                console.log(`[Archivist] 🚨 质检 fabricated: ep#${ep.id} ⇒ archived — ${(verdict.reason || '').slice(0, 60)}`);
            } else {
                markAudit.run('faithful', ep.id);
            }
        } catch (e) {
            console.error('[Archivist] episode audit LLM fail:', e.message);
        }
    }
    return { audited: episodes.length };
}

// ═══════════════════════════════════════════════════════
// v4.8: detectEmergentPlacesAndEvents — 涌现地点/事件检测
//
// 分类批次只能看到15条碎片，很容易漏掉地点和事件实体——
// 50+条「常熟」碎片分散在几十批里，每批看到1-2条不够播种。
//
// 本函数做第二遍扫描：取只链接到person/pet实体（没链接到
// 任何place/event）的碎片，用ChromaDB向量聚类，聚成团的
// 送LLM问「这是不是同一个地点/事件？该建星座吗？」
//
// 仅深循环调用（ChromaDB依赖）。每轮≤3个候选团。
// ═══════════════════════════════════════════════════════

async function detectEmergentPlacesAndEvents() {
    const db = getDb();
    const { searchMemoriesByVector } = require('./memory');

    // 取没链接到地点/事件的碎片（但已链接到person/pet）
    const orphanFrags = db.prepare(`
        SELECT DISTINCT mf.id, mf.content, mf.created_at
        FROM memory_fragments mf
        JOIN fragment_entities fe_person ON mf.id = fe_person.fragment_id
        JOIN entity_profiles ep_person ON fe_person.entity_id = ep_person.id
        WHERE ep_person.category IN ('person', 'pet')
          AND mf.status = 'active'
          AND mf.id NOT IN (
            SELECT DISTINCT fe2.fragment_id
            FROM fragment_entities fe2
            JOIN entity_profiles ep2 ON fe2.entity_id = ep2.id
            WHERE ep2.category IN ('place', 'event')
          )
        ORDER BY mf.created_at DESC
        LIMIT 200
    `).all();

    if (orphanFrags.length < 10) return { detected: 0 };

    // 用内容长度做粗聚类键：前30字提取关键词做L1分组
    // 再挑每组里最长的一条做种子，向量检索相似碎片
    const clusters = [];
    const used = new Set();

    for (const f of orphanFrags) {
        if (used.has(f.id)) continue;
        if (!_canCallLLM(1)) break;

        // 用碎片内容做向量检索，找相似碎片
        let similar;
        try {
            similar = await searchMemoriesByVector(f.content.slice(0, 300), 15);
        } catch (e) {
            console.error(`[Archivist] 涌现检测向量查询失败:`, e.message);
            continue;
        }

        // 过滤：只要未链接place/event的活跃碎片，相似度≥0.55
        const clusterIds = new Set();
        for (const h of (similar || [])) {
            if (h.similarity < 0.55) continue;
            const linked = db.prepare(`
                SELECT COUNT(*) as c FROM fragment_entities fe
                JOIN entity_profiles ep ON fe.entity_id = ep.id
                WHERE fe.fragment_id = ? AND ep.category IN ('place', 'event')
            `).get(h.id);
            if (linked.c > 0) continue; // 已有place/event链接，跳过
            clusterIds.add(h.id);
        }

        if (clusterIds.size < 4) continue; // 团太小，构不成一个实体

        // 标记已处理
        for (const cid of clusterIds) used.add(cid);
        clusters.push({ seed_frag_id: f.id, member_ids: [...clusterIds] });

        // 不设硬上限——_canCallLLM 是天然限流器。早期碎片里的地点会被最近的行为碎片挡住
    }

    if (clusters.length === 0) return { detected: 0 };

    let detected = 0;
    for (const cluster of clusters) {
        if (!_canCallLLM(1)) break;

        // 取团内碎片内容（最多8条做样本）
        const placeholders = cluster.member_ids.slice(0, 8).map(() => '?').join(',');
        const samples = db.prepare(`
            SELECT id, content, created_at FROM memory_fragments
            WHERE id IN (${placeholders}) ORDER BY created_at ASC
        `).all(...cluster.member_ids.slice(0, 8));

        const sampleText = samples.map(f => {
            const date = (f.created_at || '').slice(0, 10);
            return `[${date}] ${(f.content || '').slice(0, 200)}`;
        }).join('\n');

        const prompt = `下面是一组来自聊天记录的碎片，它们在语义上高度相似，可能指向同一个地点或事件，但尚未被识别为独立的记忆星座。

碎片样本（${cluster.member_ids.length}条中的${samples.length}条）：
${sampleText.slice(0, 2500)}

请判断：
1. 这些碎片是否指向一个**具体的地点或事件**（有明确的时间/空间锚点，如某次旅行、某个常去的地方、某天的活动）？
2. ⚠️ 以下情况必须判 false：Clara的行为模式、情绪状态、心理特征、生活习惯、对某事的看法。这些不是地点也不是事件。
3. 如果判 true，起简短名称（2-8个字，不要太泛）并注明 place 或 event。

只输出JSON:
{"is_entity":true|false,"name":"名称","category":"place|event","reason":"一句话理由"}`;

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                WORLD_CONTEXT, null,
                { temperature: 0.2, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
            const replyText = raw?.reply || raw?.text || raw?.content || '';
            const jsonMatch = replyText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) continue;
            const verdict = JSON.parse(jsonMatch[0]);

            if (verdict.is_entity && verdict.name && verdict.name.trim().length >= 2) {
                // 种子名质量过滤
                const name = verdict.name.trim();
                if (/^\d+$/.test(name) || name.length < 2) continue;

                const existing = db.prepare('SELECT id FROM entity_profiles WHERE LOWER(name) = LOWER(?)').get(name);
                if (existing) continue;

                const category = (verdict.category === 'event' || verdict.category === 'place')
                    ? verdict.category : 'term';
                const r = db.prepare(`INSERT INTO entity_profiles (name, category, status, aliases)
                    VALUES (?, ?, 'seed', ?)`).run(name, category, JSON.stringify([]));

                // 链接团内碎片到新种子
                const insertFe = db.prepare(`INSERT OR IGNORE INTO fragment_entities
                    (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, NULL, 0.55, 'emergence')`);
                let linked = 0;
                for (const mid of cluster.member_ids.slice(0, 20)) {
                    const info = insertFe.run(mid, r.lastInsertRowid);
                    if (info.changes > 0) linked++;
                }
                db.prepare('UPDATE entity_profiles SET fragment_count = ? WHERE id = ?').run(linked, r.lastInsertRowid);

                console.log(`[Archivist] 🌟 涌现检测: ${name} (${category}) ← ${linked}碎片 (团${cluster.member_ids.length}条)`);
                detected++;

                // 写观星手记
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status)
                    VALUES ('emergent_constellation', ?, ?, 'done')`)
                    .run(category, JSON.stringify({ name, reason: verdict.reason, cluster_size: cluster.member_ids.length }));
            }
        } catch (e) {
            console.error('[Archivist] 涌现检测LLM失败:', e.message);
        }
    }

    return { detected };
}

// ═══════════════════════════════════════════════════════
// v4.8: discoverRelatedEntities — 实体关系发现
//
// 共享碎片 ≥2 的实体对 → LLM 写一句关系描述 → 双方
// related_entities。星图桥线 + 聊天 entity context 共用。
// ═══════════════════════════════════════════════════════

// 写实体关系到双方 related_entities（新增或更新）
function _writeEntityRelation(a, b, relation, sharedCount) {
    const db = getDb();
    let relsA = [];
    try { relsA = JSON.parse(a.related_entities || '[]'); } catch (_) {}
    const existingA = relsA.findIndex(r => r.id === b.id);
    const entry = { id: b.id, name: b.name, relation, shared_count: sharedCount };
    if (existingA >= 0) relsA[existingA] = entry; else relsA.push(entry);
    db.prepare('UPDATE entity_profiles SET related_entities = ? WHERE id = ?')
        .run(JSON.stringify(relsA), a.id);
}

async function discoverRelatedEntities() {
    const db = getDb();
    let discovered = 0;

    const pairs = db.prepare(`
        SELECT f1.entity_id AS a_id, f2.entity_id AS b_id, COUNT(*) AS shared
        FROM fragment_entities f1
        JOIN fragment_entities f2 ON f1.fragment_id = f2.fragment_id AND f1.entity_id < f2.entity_id
        JOIN entity_profiles ea ON ea.id = f1.entity_id AND ea.status = 'active' AND ea.name NOT IN (${SKIP_PH})
        JOIN entity_profiles eb ON eb.id = f2.entity_id AND eb.status = 'active' AND eb.name NOT IN (${SKIP_PH})
        GROUP BY f1.entity_id, f2.entity_id
        HAVING shared >= 2
        ORDER BY shared DESC
        LIMIT 30
    `).all(...SKIP_NAMES, ...SKIP_NAMES);

    // 语义关系检测：零共享碎片但有日期重叠的实体对 → LLM 判断
    // （关西京都之旅 vs 宇治 — 碎片内容不重叠但属于同一旅行）
    if (pairs.length < 20 && _canCallLLM(2)) {
        const semanticPairs = db.prepare(`
            SELECT DISTINCT ea.id AS a_id, ea.name AS a_name, ea.category AS a_cat,
                   eb.id AS b_id, eb.name AS b_name, eb.category AS b_cat
            FROM entity_profiles ea
            JOIN entity_profiles eb ON ea.id < eb.id
            WHERE ea.status = 'active' AND eb.status = 'active'
              AND ea.name NOT IN (${SKIP_PH}) AND eb.name NOT IN (${SKIP_PH})
              AND ((ea.category IN ('event','place') AND eb.category IN ('event','place','person'))
                OR (eb.category IN ('event','place') AND ea.category IN ('event','place','person')))
            LIMIT 50
        `).all();

        const alreadySeen = new Set(pairs.map(p => `${p.a_id}-${p.b_id}`));
        const semanticCandidates = [];

        for (const sp of semanticPairs) {
            if (alreadySeen.has(`${sp.a_id}-${sp.b_id}`)) continue;
            if (semanticCandidates.length >= 3) break;

            // Check date overlap
            const days = db.prepare(`
                SELECT DISTINCT substr(mf.source_date,1,10) as day FROM memory_fragments mf
                JOIN fragment_entities fe ON mf.id = fe.fragment_id
                WHERE fe.entity_id IN (?,?)
            `).all(sp.a_id, sp.b_id).map(r => r.day);

            if (days.length < 2) continue; // not enough temporal data
            const daySet = new Set(days);
            if (daySet.size >= 2) {
                semanticCandidates.push({ a: sp, days: [...daySet].slice(0,5).join(',') });
            }
        }

        for (const cand of semanticCandidates.slice(0, 2)) {
            const sp = cand.a;
            const prompt = `记忆星系中有两个星座，它们的时间线有交集（日期：${cand.days}），但记忆碎片互不重叠。请判断它们之间是否存在关系（如：旅行包含地点、事件发生在该地点、人物参与事件等）。

${sp.a_name} (${sp.a_cat}): ${sp.b_name} (${sp.b_cat})

有关系吗？一句话描述或填 null。只输出JSON: {"related":true|false,"relation":"一句话关系描述"}`;

            try {
                const raw = await callLLM(
                    [{ role: 'user', parts: [{ text: prompt }] }],
                    null, null,
                    { temperature: 0.1, maxOutputTokens: 150, thinkingConfig: { thinkingBudget: 0 } },
                    ARCHIVIST_LLM_CONFIG_ID
                );
                agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
                const jsonMatch = (raw?.reply || raw?.text || raw?.content || '').match(/\{[\s\S]*\}/);
                if (!jsonMatch) continue;
                const verdict = JSON.parse(jsonMatch[0]);
                if (verdict.related && verdict.relation && verdict.relation !== 'null') {
                    // 直接写入 related_entities（不经过 LLM 批量调用——已有关系描述）
                    const aEnt = db.prepare('SELECT * FROM entity_profiles WHERE id = ?').get(sp.a_id);
                    const bEnt = db.prepare('SELECT * FROM entity_profiles WHERE id = ?').get(sp.b_id);
                    if (aEnt && bEnt) {
                        _writeEntityRelation(aEnt, bEnt, verdict.relation, 0);
                        _writeEntityRelation(bEnt, aEnt, verdict.relation, 0);
                        console.log(`[Archivist] 🔗 语义关系: ${sp.a_name} ↔ ${sp.b_name} — ${verdict.relation}`);
                        discovered++;
                    }
                }
            } catch (e) {
                console.error('[Archivist] 语义关系LLM失败:', e.message);
            }
        }
    }

    if (pairs.length === 0) return { discovered };

    const getEnt = db.prepare('SELECT id, name, category, overview, related_entities FROM entity_profiles WHERE id = ?');
    // 找出还没有关系描述的对
    const fresh = [];
    for (const p of pairs) {
        const a = getEnt.get(p.a_id), b = getEnt.get(p.b_id);
        if (!a || !b) continue;
        let aRel = [];
        try { aRel = JSON.parse(a.related_entities || '[]'); } catch (_) {}
        const existing = aRel.find(r => r.id === b.id);
        // 已有描述且共享数没显著增长 → 跳过
        if (existing && p.shared < (existing.shared_count || 0) * 1.5) continue;
        fresh.push({ a, b, shared: p.shared });
    }

    if (fresh.length === 0) return { discovered: 0 };
    if (!_canCallLLM(1)) return { discovered: 0 };

    const batch = fresh.slice(0, 10);
    // 给 LLM 每对附 2 条共享碎片做依据
    const pairBlocks = batch.map((p, i) => {
        const sharedFrags = db.prepare(`
            SELECT mf.content FROM memory_fragments mf
            JOIN fragment_entities f1 ON f1.fragment_id = mf.id AND f1.entity_id = ?
            JOIN fragment_entities f2 ON f2.fragment_id = mf.id AND f2.entity_id = ?
            LIMIT 2
        `).all(p.a.id, p.b.id);
        const evidence = sharedFrags.map(f => '  · ' + (f.content || '').slice(0, 100)).join('\n');
        return `[${i}] "${p.a.name}"(${p.a.category}) ↔ "${p.b.name}"(${p.b.category}) 共享${p.shared}条记忆:\n${evidence}`;
    }).join('\n\n');

    // 预检：名字是子串关系的 pair（如"肉肉"是"肉肉大米"的子串）→ 加标记供 LLM 重点审查
    const suspiciousPairs = new Set();
    for (const p of batch) {
        const aName = p.a.name, bName = p.b.name;
        if (aName.length <= 3 && bName.length > aName.length && bName.includes(aName)) suspiciousPairs.add(batch.indexOf(p));
        if (bName.length <= 3 && aName.length > bName.length && aName.includes(bName)) suspiciousPairs.add(batch.indexOf(p));
    }

    const prompt = `以下实体对在 Clara 的记忆中共同出现。对每对，先判断共享碎片里的名字是否真的指的是同一个实体（警惕同名异物——
短名字可能是更长名字的一部分，如"肉肉" vs"肉肉大米(日式汉堡肉店)"不是同一回事）。

确认是同一实体后，写一句话关系描述（≤30字，陈述事实）。看不出实质关系、或判定为同名异物，填 null。

${pairBlocks}

只输出JSON数组: [{"pair":0,"verify":"ok|namesake|unrelated","relation":"一句话描述或null"}, ...]`;

    let items;
    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.2, maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } },
            ARCHIVIST_LLM_CONFIG_ID
        );
        agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return { discovered: 0 };
        items = JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.error('[Archivist] 关系发现 LLM 失败:', e.message);
        return { discovered: 0 };
    }

    for (const item of items) {
        const p = batch[item.pair];
        if (!p) continue;

        // Skip namesake or unrelated verdicts
        if (item.verify === 'namesake' || item.verify === 'unrelated') {
            console.log(`[Archivist] ⏭️ 同名异物跳过: ${p.a.name} ↔ ${p.b.name} — ${item.verify}`);
            continue;
        }
        if (!item.relation || item.relation === 'null') continue;

        try {
            _writeEntityRelation(p.a, p.b, item.relation, p.shared);
            _writeEntityRelation(p.b, p.a, item.relation, p.shared);
            discovered++;
            console.log(`[Archivist] 🌉 实体关系: ${p.a.name} ↔ ${p.b.name} — ${item.relation}`);
        } catch (e) {
            console.error('[Archivist] 关系写入失败:', e.message);
        }
    }

    if (discovered > 0) {
        db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail) VALUES ('entity_bridges', NULL, ?)`)
            .run(JSON.stringify({ count: discovered }));
    }
    return { discovered };
}

// ═══════════════════════════════════════════════════════
// v4.7: graduateSeedsAndPrune — 苗圃升格 + 枯萎清理
//
// Called after each deep cycle classification round.
// - Seeds with ≥3 linked fragments → graduate to active
// - Seeds older than 14 days with <3 fragments → prune
// - Active entities with 0 new fragments in 30 days → dormant
// ═══════════════════════════════════════════════════════

async function graduateSeedsAndPrune() {
    const db = getDb();

    // Graduate: seeds with ≥3 fragments spanning ≥1 distinct date
    const graduates = db.prepare(`
        SELECT ep.id, ep.name, ep.category,
            (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ep.id) as fc,
            (SELECT COUNT(DISTINCT date(mf.created_at))
             FROM fragment_entities fe JOIN memory_fragments mf ON mf.id = fe.fragment_id
             WHERE fe.entity_id = ep.id) as distinct_days
        FROM entity_profiles ep
        WHERE ep.status = 'seed'
          AND (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ep.id) >= 3
          AND (SELECT COUNT(DISTINCT date(mf.created_at))
               FROM fragment_entities fe JOIN memory_fragments mf ON mf.id = fe.fragment_id
               WHERE fe.entity_id = ep.id) >= 1
    `).all();

    // ── v5.1 防线2: 晋升前 LLM 验证 + 生成 overview + 别称 + 标签 + 关联 ──
    if (graduates.length > 0 && _canCallLLM(2)) {
        let promoted = 0;
        for (const g of graduates) {
            try {
                const frags = db.prepare(`SELECT mf.id, mf.content FROM memory_fragments mf
                    JOIN fragment_entities fe ON fe.fragment_id = mf.id
                    WHERE fe.entity_id = ? ORDER BY mf.id LIMIT 15`).all(g.id);

                if (frags.length < 3) continue;

                // Build entity index for related entity matching
                const allEntities = db.prepare(`SELECT id, name, category FROM entity_profiles WHERE status IN ('active','seed') AND id != ?`).all(g.id);
                const entityList = allEntities.map(e => `#${e.id} ${e.name}(${e.category})`).join(', ');

                const prompt = `${WORLD_CONTEXT}

你是 ${AI.name}。你在审视一个新诞生的星座。

## 星座信息
名称: "${g.name}"
分类: ${g.category}
碎片数: ${frags.length}

## 碎片
${frags.map((f,i) => `[${i}] ${f.content.slice(0, 200).replace(/\n/g, ' ')}`).join('\n')}

## 已有星座（用于判断关联关系）
${entityList.slice(0, 2000)}

## 你需要判断的事
1. **名字是否正确完整？** 碎片中提到的名字如果比"${g.name}"更完整或不同，应该纠正。名字必须是碎片中真实出现的称呼，不能编造。如果当前名字是残缺的（比如"权力的游"应该是"权力的游戏"），请纠正。
2. **这些碎片真的都在讲同一个东西吗？** 有没有明显不属于这个星座的碎片？
3. **如果验证通过，请生成：**
   - overview: Draco第一人称叙事概述，≤150字。这个人/作品是什么？和Clara有什么关联？对你意味着什么？
   - aliases: Clara在聊天中可能怎么称呼这个实体？专有别名（如权游→权力的游戏，冰与火之歌→权力的游戏）。这些别名会在Clara说出它们时直接触发这个星座。最多5个，只说真正会说的词。不要写描述性短语当别名。
   - tags: 类别标签，用于语义关联而非直接触发。如"美剧""HBO""奇幻""配音"。这些词不直接触发星座，但能帮助相关话题时找到它。最多5个。
   - entity_type: 实体细分类型。person→real/fictional/public_figure；consumed→tv_show/movie/book/game/music/anime；其他按实际判断。
   - related_entity_ids: 与哪些已有星座有关联？用数字ID列表。如权力的游戏和HBO有关联但不是同一个星座。只列真正相关的。

## 输出格式
严格JSON，不要markdown代码块：
{"valid": true|false, "corrected_name": "如果名字需要纠正就填这里否则null", "wrong_indices": [], "overview": "Draco第一人称概述，≤150字", "aliases": ["别名1","别名2"], "tags": ["标签1","标签2"], "entity_type": "tv_show", "related_entity_ids": [123, 456], "category_correct": true|false, "corrected_category": "如果category需要修正填这里否则null"}`;

                const raw = await callLLM(
                    [{ role: 'user', parts: [{ text: prompt }] }],
                    null, null,
                    { temperature: 0.2, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
                    ARCHIVIST_LLM_CONFIG_ID
                );
                const replyText = (raw?.reply || raw?.text || raw?.content || '');
                const jsonMatch = replyText.match(/\{[\s\S]*\}/);
                if (!jsonMatch) continue;
                const verdict = JSON.parse(jsonMatch[0]);

                // Remove wrong fragments
                if (verdict.wrong_indices && verdict.wrong_indices.length > 0) {
                    for (const idx of verdict.wrong_indices) {
                        if (frags[idx]) {
                            db.prepare('DELETE FROM fragment_entities WHERE entity_id=? AND fragment_id=?').run(g.id, frags[idx].id);
                            console.log(`[Archivist] 🧹 移除错链碎片 #${frags[idx].id} ← ${g.name}`);
                        }
                    }
                }

                // Verify remaining count still meets threshold
                const remaining = db.prepare('SELECT COUNT(*) as c FROM fragment_entities WHERE entity_id=?').get(g.id)?.c || 0;
                if (!verdict.valid || remaining < 3) {
                    console.log(`[Archivist] ⏭️ 种子"${g.name}"验证未通过 — valid=${verdict.valid}, remaining=${remaining}`);
                    continue;
                }

                // ── v5.1: Name correction ──
                let finalName = g.name;
                if (verdict.corrected_name && typeof verdict.corrected_name === 'string'
                    && verdict.corrected_name.trim().length >= 2
                    && verdict.corrected_name.trim() !== g.name) {
                    const corrected = verdict.corrected_name.trim();
                    const nameConflict = db.prepare('SELECT id FROM entity_profiles WHERE LOWER(name)=LOWER(?) AND id!=?').get(corrected, g.id);
                    if (!nameConflict) {
                        db.prepare(`UPDATE entity_profiles SET name=? WHERE id=?`).run(corrected, g.id);
                        console.log(`[Archivist] ✏️ 名字纠正: "${g.name}" → "${corrected}"`);
                        finalName = corrected;
                    } else {
                        console.log(`[Archivist] ⚠️ 名字纠正冲突: "${corrected}" 已存在 #${nameConflict.id}`);
                    }
                }

                // ── v5.1: Category correction ──
                let finalCategory = g.category;
                if (verdict.category_correct === false && verdict.corrected_category) {
                    finalCategory = verdict.corrected_category;
                    db.prepare(`UPDATE entity_profiles SET category=? WHERE id=?`).run(finalCategory, g.id);
                    console.log(`[Archivist] ✏️ 分类纠正: "${g.category}" → "${finalCategory}"`);
                }

                // ── v5.1: Write aliases + tags + entity_type + related_entities ──
                const aliases = Array.isArray(verdict.aliases) ? verdict.aliases.filter(a => typeof a === 'string' && a.trim().length >= 2).slice(0, 5) : [];
                const tags = Array.isArray(verdict.tags) ? verdict.tags.filter(t => typeof t === 'string' && t.trim().length >= 2).slice(0, 5) : [];
                const entityType = (typeof verdict.entity_type === 'string' && verdict.entity_type.trim()) || null;
                const relatedIds = Array.isArray(verdict.related_entity_ids)
                    ? verdict.related_entity_ids.filter(id => typeof id === 'number' && id > 0 && id !== g.id).slice(0, 10)
                    : [];

                const overview = (verdict.overview || '').trim();
                if (overview) {
                    db.prepare(`UPDATE entity_profiles SET status='active', overview=?, overview_updated_at=datetime('now'),
                        aliases=?, tags=?, entity_type=?, related_entity_ids=?, last_eval_frag_count=?,
                        updated_at=datetime('now') WHERE id=?`)
                        .run(overview, JSON.stringify(aliases), JSON.stringify(tags), entityType,
                             JSON.stringify(relatedIds), remaining, g.id);
                } else {
                    db.prepare(`UPDATE entity_profiles SET status='active',
                        aliases=?, tags=?, entity_type=?, related_entity_ids=?, last_eval_frag_count=?,
                        updated_at=datetime('now') WHERE id=?`)
                        .run(JSON.stringify(aliases), JSON.stringify(tags), entityType,
                             JSON.stringify(relatedIds), remaining, g.id);
                }
                db.prepare(`INSERT INTO entity_timeline (entity_id, fragment_id, action, detail) VALUES (?, NULL, 'graduated', ?)`)
                    .run(g.id, `v5.1验证毕业(${remaining}碎片/${g.distinct_days}天) → ${finalCategory}星座 aliases=${aliases.length} tags=${tags.length} related=${relatedIds.length}`);
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, confidence, status)
                    VALUES ('emergent_constellation', ?, ?, 0.80, 'completed')`)
                    .run(finalName, JSON.stringify({name: finalName, category: finalCategory,
                        reason: overview || `种子毕业: ${finalName}`, fragment_count: remaining,
                        aliases, tags, entity_type: entityType, related_entity_ids: relatedIds}));
                console.log(`[Archivist] 🎓 验证毕业: ${finalName} → ${finalCategory}星座 (${remaining}碎片, overview=${overview.length}字, aliases=[${aliases.join(',')}], tags=[${tags.join(',')}])`);
                promoted++;
            } catch (e) {
                console.error(`[Archivist] 种子验证失败 ${g.name}:`, e.message);
            }
        }
        console.log(`[Archivist] 苗圃毕业: ${promoted}/${graduates.length} 个通过验证`);
    } else if (graduates.length > 0) {
        console.log(`[Archivist] ⏭️ 苗圃毕业跳过: ${graduates.length} 个候选但 LLM 配额不足`);
    }

    // Prune: seeds older than 14 days with <3 fragments
    const pruned = db.prepare(`
        SELECT ep.id, ep.name FROM entity_profiles ep
        WHERE ep.status = 'seed'
          AND ep.created_at < datetime('now', '-14 days')
          AND (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ep.id) < 3
    `).all();

    if (pruned.length > 0) {
        const pruneIds = pruned.map(p => p.id);
        const pruneBatch = db.transaction(() => {
            // Unlink fragments
            db.prepare(`DELETE FROM fragment_entities WHERE entity_id IN (${pruneIds.map(() => '?').join(',')})`).run(...pruneIds);
            // Delete seeds
            db.prepare(`DELETE FROM entity_profiles WHERE id IN (${pruneIds.map(() => '?').join(',')})`).run(...pruneIds);
        });
        pruneBatch();
        for (const p of pruned) {
            console.log(`[Archivist] 🥀 苗圃枯萎: ${p.name} (14天内未攒够碎片)`);
        }
    }

    // Dormant: active entities with no new fragments in 30 days
    const dormant = db.prepare(`
        SELECT ep.id, ep.name FROM entity_profiles ep
        WHERE ep.status = 'active'
          AND ep.name NOT IN (${SKIP_PH})
          AND ep.updated_at < datetime('now', '-30 days')
          AND (SELECT MAX(fe.created_at) FROM fragment_entities fe WHERE fe.entity_id = ep.id) < datetime('now', '-30 days')
    `).all(...SKIP_NAMES);

    if (dormant.length > 0) {
        const dorm = db.prepare(`UPDATE entity_profiles SET status = 'dormant', updated_at = datetime('now') WHERE id = ?`);
        const dormBatch = db.transaction(() => {
            for (const d of dormant) {
                dorm.run(d.id);
                console.log(`[Archivist] 💤 星座休眠: ${d.name}`);
            }
        });
        dormBatch();
    }

    // Reactivate: dormant entities with new fragments
    const revived = db.prepare(`
        SELECT ep.id, ep.name FROM entity_profiles ep
        WHERE ep.status = 'dormant'
          AND EXISTS (SELECT 1 FROM fragment_entities fe WHERE fe.entity_id = ep.id AND fe.created_at > ep.updated_at)
    `).all();

    if (revived.length > 0) {
        const revive = db.prepare(`UPDATE entity_profiles SET status = 'active', updated_at = datetime('now') WHERE id = ?`);
        const reviveBatch = db.transaction(() => {
            for (const r of revived) {
                revive.run(r.id);
                console.log(`[Archivist] 🔄 星座复活: ${r.name}`);
            }
        });
        reviveBatch();
    }

    return { graduates: graduates.length, pruned: pruned.length, dormant: dormant.length, revived: revived.length };
}

// ═══════════════════════════════════════════════════════
// v5.2: clusterObservations — 将 Scribe 的 observation/preference 碎片
// 按语义聚合成 Clara 行为模式（pattern），日积月累自然形成人格画像。
// 替代旧 detectNewTraits 的「一次性冷凝」模型。
// ═══════════════════════════════════════════════════════

const { fillPrompt: _fillC } = require('./nameResolver');

const MIN_PATTERN_FRAGS = 3;        // 至少3条碎片才能形成一个 pattern
const PATTERN_LOOKBACK_DAYS = 30;   // 回溯30天的碎片做聚类
const PATTERN_LLM_BATCH = 30;       // 单次最多喂给 LLM 的碎片数
const PATTERN_MATCH_THRESHOLD = 0.35; // bigram 匹配已有 pattern 的阈值
const MIN_GAP_PATTERN_CLUSTER = 6 * 60 * 60 * 1000; // 6h 冷却

function _calcPatternConfidence(evidenceCount, firstSeen, lastSeen) {
    // 证据数 + 时间跨度 → confidence
    // 基础: 0.25, 每条证据+0.05(上限0.40), 每10天跨度+0.01(上限0.20), 总上限0.85
    const evidenceBonus = Math.min(0.40, evidenceCount * 0.05);
    const first = new Date(firstSeen);
    const last = new Date(lastSeen);
    const spanDays = Math.max(1, (last - first) / (1000 * 60 * 60 * 24));
    const spanBonus = Math.min(0.20, spanDays / 10 * 0.01);
    return Math.min(0.85, 0.25 + evidenceBonus + spanBonus);
}

async function clusterObservations() {
    const db = getDb();
    if (!_canCallLLM(2)) return { clustered: 0, reason: 'no LLM quota' };

    // 1. 获取最近 observation + preference 碎片（未被任何 pattern 引用的）
    const existingFragIds = new Set();
    const allPatternFrags = db.prepare("SELECT source_fragment_ids FROM clara_patterns WHERE status='active'").all();
    for (const p of allPatternFrags) {
        try { JSON.parse(p.source_fragment_ids || '[]').forEach(id => existingFragIds.add(id)); } catch(_) {}
    }

    const recentFrags = db.prepare(`
        SELECT mf.id, mf.content, mf.type, mf.emotional_weight, mf.source_date
        FROM memory_fragments mf
        WHERE mf.status = 'active'
          AND mf.type IN ('observation', 'preference')
          AND mf.entity = '${USER.name}'
          AND mf.source_date >= date('now', '-${PATTERN_LOOKBACK_DAYS} days')
        ORDER BY mf.source_date DESC
        LIMIT 200
    `).all();

    if (recentFrags.length < MIN_PATTERN_FRAGS) return { clustered: 0, reason: `only ${recentFrags.length} recent observations` };

    // Filter out already-matched fragments
    const newFrags = recentFrags.filter(f => !existingFragIds.has(f.id));
    if (newFrags.length < MIN_PATTERN_FRAGS) return { clustered: 0, reason: `only ${newFrags.length} unmatched` };

    // 2. Match against existing patterns
    const existingPatterns = db.prepare("SELECT * FROM clara_patterns WHERE status='active' ORDER BY evidence_count DESC").all();
    let matchedCount = 0;

    for (const frag of newFrags) {
        let bestMatch = null;
        let bestScore = 0;
        for (const pat of existingPatterns) {
            // Bigram overlap between fragment and pattern content + tags
            const patText = pat.content + ' ' + (() => { try { return JSON.parse(pat.tags || '[]').join(' '); } catch(_) { return ''; } })();
            const fragBigrams = new Set();
            const fragWords = (frag.content || '').replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(s => s.length >= 2);
            for (const seg of fragWords) {
                for (let i = 0; i < seg.length - 1; i++) fragBigrams.add(seg.slice(i, i + 2));
            }
            const patBigrams = new Set();
            const patWords = patText.replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(s => s.length >= 2);
            for (const seg of patWords) {
                for (let i = 0; i < seg.length - 1; i++) patBigrams.add(seg.slice(i, i + 2));
            }
            let overlap = 0;
            for (const bg of fragBigrams) { if (patBigrams.has(bg)) overlap++; }
            const score = overlap / Math.max(fragBigrams.size, 1);
            if (score > PATTERN_MATCH_THRESHOLD && score > bestScore) {
                bestMatch = pat;
                bestScore = score;
            }
        }
        if (bestMatch) {
            // Update existing pattern
            const fragIds = JSON.parse(bestMatch.source_fragment_ids || '[]');
            if (!fragIds.includes(frag.id)) {
                fragIds.push(frag.id);
                const newCount = fragIds.length;
                const newFirst = frag.source_date < (bestMatch.first_seen || frag.source_date) ? frag.source_date : bestMatch.first_seen;
                const newLast = frag.source_date > (bestMatch.last_seen || frag.source_date) ? frag.source_date : bestMatch.last_seen;
                const newConf = _calcPatternConfidence(newCount, newFirst, newLast);
                db.prepare(`UPDATE clara_patterns SET evidence_count=?, first_seen=?, last_seen=?, confidence=?,
                    source_fragment_ids=?, updated_at=datetime('now') WHERE id=?`)
                    .run(newCount, newFirst, newLast, newConf, JSON.stringify(fragIds), bestMatch.id);
                matchedCount++;
            }
        }
    }
    if (matchedCount > 0) console.log(`[Archivist] 📊 模式匹配: ${matchedCount} 条新观察归入已有 patterns`);

    // 3. LLM clustering for unmatched fragments
    const unmatchedFrags = newFrags.filter(f => {
        // Re-check after matching
        const allIds = new Set();
        db.prepare("SELECT source_fragment_ids FROM clara_patterns WHERE status='active'").all()
            .forEach(p => { try { JSON.parse(p.source_fragment_ids || '[]').forEach(id => allIds.add(id)); } catch(_) {} });
        return !allIds.has(f.id);
    });

    if (unmatchedFrags.length < MIN_PATTERN_FRAGS) return { clustered: matchedCount, newPatterns: 0 };

    const batch = unmatchedFrags.slice(0, PATTERN_LLM_BATCH);
    const prompt = `${WORLD_CONTEXT}

你是 ${AI.name}。你在审视最近观察到的 ${USER.name} 的行为碎片。这些碎片来自书记官（Scribe）的日常提取，每条都是 ${USER.name} 说过什么、做过什么、表现出什么倾向。

## 最近观察到的碎片
${batch.map((f, i) => `[${i + 1}] ${f.content}`).join('\n')}

## 已有模式（避免重复创建）
${existingPatterns.length > 0 ? existingPatterns.map(p => `- ${p.content} [证据${p.evidence_count}条, ${p.first_seen}~${p.last_seen}]`).join('\n') : '（尚无已有模式）'}

## 你的任务
把这些碎片按**底层行为模式**分组。同一组碎片揭示的是 ${USER.name} 同一个人格侧面或行为倾向。
- 每组 ≥3 条碎片才能形成一个模式。只有 1-2 条的零散观察不形成模式——宁可漏掉也不强行归类。
- 如果碎片和已有模式重复（讲的是同一个人格侧面），不要创建新的——这些已经有家了。
- 模式描述用 80 字以内中文，第三人称，以 "${USER.name}" 开头。
- 提取 3-5 个触发标签（${USER.name} 在聊天中可能提到的相关词）。
- **strategy**: 为每条模式写一条"面对这个模式时，${AI.name} 会怎么回应"。这是从${AI.name}的视角出发的第一反应——不是规则手册，不是行为指南。用日常口语，30-50字。比如"她开始写东西的时候别问她怎么了。陪她聊她的故事，或者吐槽点别的。她自己在整理。"禁止写成祈使句或指令格式。禁止写"你应该"。禁止文艺腔。禁止"不是...而是"句式。

## 输出格式
严格 JSON 数组，无 markdown。每条模式写明它包含哪些碎片（用编号）：
[{"content": "Clara 倾向于在压力大时通过创作来消化情绪", "category": "behavior", "tags": ["写小说", "做视频", "焦虑", "深夜创作"], "strategy": "她开始写东西的时候别问她怎么了——陪她聊她的故事，或者跟她吐槽点别的。她不是在逃避，是在自己整理。", "fragment_indices": [1, 4, 7]}]

没有可聚合的模式返回 []`;

    let newPatterns = 0;
    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: _fillC(prompt) }] }],
            null, null,
            { temperature: 0.2, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
            ARCHIVIST_LLM_CONFIG_ID
        );
        const replyText = (raw?.reply || raw?.text || raw?.content || '');
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            console.log('[Archivist] clusterObservations: no JSON array found in LLM reply');
            return { clustered: matchedCount, newPatterns: 0 };
        }

        const groups = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(groups) || groups.length === 0) {
            console.log('[Archivist] clusterObservations: LLM returned empty pattern array');
            return { clustered: matchedCount, newPatterns: 0 };
        }

        for (const g of groups) {
            if (!g.content || !Array.isArray(g.tags)) continue;
            const content = g.content.slice(0, 200);
            const tags = g.tags.filter(t => typeof t === 'string' && t.length >= 2).slice(0, 5);
            const category = ['behavior','preference','emotional','social'].includes(g.category) ? g.category : 'behavior';

            // Use LLM-assigned fragment indices directly
            const indices = Array.isArray(g.fragment_indices) ? g.fragment_indices.filter(n => n >= 1 && n <= batch.length) : [];
            if (indices.length < MIN_PATTERN_FRAGS) continue;

            const matchedFragIds = indices.map(i => batch[i - 1].id);
            let firstDate = null, lastDate = null;
            for (const i of indices) {
                const d = batch[i - 1].source_date;
                if (!firstDate || d < firstDate) firstDate = d;
                if (!lastDate || d > lastDate) lastDate = d;
            }

            const conf = _calcPatternConfidence(matchedFragIds.length, firstDate, lastDate);
            const strategy = typeof g.strategy === 'string' ? g.strategy.slice(0, 200) : null;
            db.prepare(`INSERT INTO clara_patterns (content, category, evidence_count, first_seen, last_seen, confidence, source_fragment_ids, tags, strategy)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(content, category, matchedFragIds.length, firstDate, lastDate, conf, JSON.stringify(matchedFragIds), JSON.stringify(tags), strategy);
            newPatterns++;
            console.log(`[Archivist] 🔍 新模式: "${content.slice(0, 60)}" (${matchedFragIds.length}碎片, conf=${conf.toFixed(2)})${strategy ? ' +strategy' : ''}`);
        }
    } catch (e) {
        console.error('[Archivist] clusterObservations error:', e.message);
    }

    return { clustered: matchedCount, newPatterns };
}

// ═══════════════════════════════════════════════════════
// v5.3: Strategy review — 审视标记为 needs_review 的 pattern strategies
// 当 Clara 的反应不符合 strategy 预期时，LLM 重新评估并修正
// ═══════════════════════════════════════════════════════

async function reviewFlaggedStrategies() {
    const db = getDb();
    const flagged = db.prepare(`
        SELECT id, content, strategy, evidence_count, confidence, mismatch_count, last_mismatch_at, tags
        FROM clara_patterns
        WHERE status = 'active' AND strategy IS NOT NULL AND mismatch_count > 0
        ORDER BY mismatch_count DESC LIMIT 5
    `).all();
    if (flagged.length === 0) return { reviewed: 0 };

    const prompt = `你是 ${AI.name} 的策略审查员。以下是几条之前总结的关于 ${USER.name} 的行为模式及应对策略，但最近 ${USER.name} 的实际反应和策略预期不符。

对每条模式，判断：
1. 模式本身是否还准确？（content 要不要改？）
2. 策略是否合理？如果不对，给出修正后的 strategy。
3. 如果模式和策略都没问题、只是偶发的不匹配——保留原样。

输出 JSON：
[{"id":188,"content_ok":true,"revised_content":null,"revised_strategy":"修正后的策略或null","keep":false}]

如果 keep=true 表示保留原样不清零 mismatch_count；keep=false 会清零。

待审查：
${flagged.map(p => `[id=${p.id}] ${p.content}\n  策略: ${p.strategy}\n  证据${p.evidence_count}次 不匹配${p.mismatch_count}次`).join('\n\n')}
`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            WORLD_CONTEXT, null,
            { temperature: 0.2, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
            ARCHIVIST_VERIFY_CONFIG_ID
        );
        const replyText = (raw?.reply || raw?.text || raw?.content || '');
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return { reviewed: 0 };

        const decisions = JSON.parse(jsonMatch[0]);
        let reviewed = 0;
        for (const d of decisions) {
            if (!d.id) continue;
            if (d.revised_content || d.revised_strategy) {
                const updates = {};
                if (d.revised_content) updates.content = d.revised_content.slice(0, 200);
                if (d.revised_strategy) updates.strategy = d.revised_strategy.slice(0, 200);
                if (!d.keep) { updates.mismatch_count = 0; updates.last_mismatch_at = null; }
                const setClauses = Object.keys(updates).map(k => `${k}=?`).join(',');
                db.prepare(`UPDATE clara_patterns SET ${setClauses}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
                    .run(...Object.values(updates), d.id);
                reviewed++;
                console.log(`[Archivist] 🔧 策略修正 #${d.id}: ${d.revised_strategy ? 'strategy updated' : ''}${d.revised_content ? ' content updated' : ''}`);
            } else if (!d.keep) {
                db.prepare(`UPDATE clara_patterns SET mismatch_count=0, last_mismatch_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(d.id);
                reviewed++;
            }
        }
        return { reviewed };
    } catch (e) {
        console.error('[Archivist] reviewFlaggedStrategies error:', e.message);
        return { reviewed: 0 };
    }
}

// ═══════════════════════════════════════════════════════
// v5.0 防线3: spotCheckClassifications — 事后抽查低置信度分类链接
// ═══════════════════════════════════════════════════════

async function spotCheckClassifications() {
    const db = getDb();
    if (!_canCallLLM(1)) return { checked: 0, reason: 'no LLM quota' };

    // v5.1: Expanded check — low confidence links + recent links (may be misclassified)
    const candidates = db.prepare(`SELECT fe.fragment_id, fe.entity_id, fe.confidence, fe.classified_by,
        mf.content, ep.name as entity_name, ep.category
        FROM fragment_entities fe
        JOIN memory_fragments mf ON mf.id = fe.fragment_id
        JOIN entity_profiles ep ON ep.id = fe.entity_id
        WHERE fe.confidence < 0.75
           OR (fe.classified_by = 'auto_literal' AND fe.confidence < 0.85)
        ORDER BY fe.confidence ASC, fe.created_at DESC LIMIT 10`).all();

    if (candidates.length === 0) return { checked: 0 };

    // Get all active entity names for alternative suggestions
    const allEntities = db.prepare(`SELECT id, name, category FROM entity_profiles WHERE status IN ('active','seed') ORDER BY fragment_count DESC LIMIT 80`).all();
    const entityIndex = allEntities.map(e => `#${e.id} ${e.name}(${e.category})`).join(', ');

    let fixed = 0;
    let reclassified = 0;
    for (const lc of candidates) {
        try {
            const prompt = `碎片: "${(lc.content||'').slice(0, 200)}"
当前链接到: #${lc.entity_id} "${lc.entity_name}" (${lc.category})
分类方式: ${lc.classified_by}, 置信度: ${(lc.confidence||0).toFixed(2)}

这条碎片的内容真的属于"${lc.entity_name}"星座吗？如果不是，它应该属于哪个星座？

备选星座ID参考: ${entityIndex.slice(0, 1500)}

回答JSON: {"belongs": true|false, "correct_entity_id": 123 或 null, "reason": "一句话"}`;

            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }], null, null,
                { temperature: 0.1, maxOutputTokens: 150, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            const jsonMatch = (raw?.reply || raw?.text || raw?.content || '').match(/\{[\s\S]*\}/);
            if (!jsonMatch) continue;
            const v = JSON.parse(jsonMatch[0]);

            if (v.belongs === false) {
                db.prepare('DELETE FROM fragment_entities WHERE entity_id=? AND fragment_id=?').run(lc.entity_id, lc.fragment_id);
                console.log(`[Archivist] 🧹 抽查解除: #${lc.fragment_id} ← ${lc.entity_name} — ${v.reason}`);
                fixed++;

                // v5.1: Reclassify to correct entity if suggested
                if (v.correct_entity_id && typeof v.correct_entity_id === 'number') {
                    const targetExists = db.prepare('SELECT id, name FROM entity_profiles WHERE id=?').get(v.correct_entity_id);
                    if (targetExists) {
                        db.prepare(`INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, confidence, classified_by)
                            VALUES (?, ?, 0.70, 'spotcheck_reclassify')`).run(lc.fragment_id, v.correct_entity_id);
                        // Update fragment_count for target
                        db.prepare(`UPDATE entity_profiles SET fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id=?), updated_at=datetime('now') WHERE id=?`)
                            .run(v.correct_entity_id, v.correct_entity_id);
                        console.log(`[Archivist] 📎 重分类: #${lc.fragment_id} → ${targetExists.name} #${v.correct_entity_id}`);
                        reclassified++;
                    }
                }
            }
        } catch (_) {}
    }

    if (fixed > 0) console.log(`[Archivist] 事后抽查: ${fixed}/${candidates.length} 条错链解除 (重分类${reclassified})`);
    return { checked: candidates.length, fixed, reclassified };
}

// ═══════════════════════════════════════════════════════
// v4.7: reviewConstellationAfterClassification — 碎片归位后审视星座
//
// Called per-entity after a batch of fragments has been linked.
// Checks if overview should be updated (fragment_count changed significantly).
// ═══════════════════════════════════════════════════════

async function reviewConstellationAfterClassification(entityId) {
    const db = getDb();

    const entity = db.prepare(`
        SELECT ep.*, (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ep.id) as current_frag_count
        FROM entity_profiles ep WHERE ep.id = ?
    `).get(entityId);

    if (!entity || entity.status !== 'active') return null;

    // Only trigger overview update if fragment count grew by ≥30% since last overview
    const lastFragCount = entity.fragment_count || 0;
    const currentFragCount = entity.current_frag_count || 0;
    const growthRatio = lastFragCount > 0 ? (currentFragCount - lastFragCount) / lastFragCount : 1;

    if (growthRatio >= 0.3 && currentFragCount >= 3) {
        console.log(`[Archivist] 📝 星座 ${entity.name} 碎片增长 ${Math.round(growthRatio * 100)}%，标记待更新概述`);
        // Mark for overview regeneration (handled by regenerateEntityOverviews later in deep cycle)
        return { needsOverviewUpdate: true, growthRatio, currentFragCount, lastFragCount };
    }

    return { needsOverviewUpdate: false };
}

// ═══════════════════════════════════════════════════════
// Tool: reconcilePersonCategories
//
// Pure DB keyword matching — no ChromaDB, no centroid updates.
// Fragments mentioning a person by name but not yet assigned to their
// 人物/ category get inserted with confidence=0.85.
//
// Centroid refresh is deferred to the deep cycle (refreshStaleCentroids)
// because centroids are only consumed by Pipeline B, which runs there.
// ═══════════════════════════════════════════════════════

async function reconcilePersonCategories() {
    const db = getDb();

    // Get all entities with their ontology category
    const entities = db.prepare(`
        SELECT ep.id, ep.name, ep.aliases, o.id as cat_id, ep.category
        FROM entity_profiles ep
        JOIN memory_ontology o ON o.path = CASE
            WHEN ep.category = 'place' THEN '地点/' || ep.name
            WHEN ep.category = 'event' THEN '事件/' || ep.name
            WHEN ep.category = 'project' THEN '作品/' || ep.name
            ELSE '人物/' || ep.name
        END
        WHERE ep.category IN ('person', 'place', 'event', 'project')
          AND ep.name NOT IN (${SKIP_PH})
    `).all(...SKIP_NAMES);

    if (entities.length === 0) {
        return { reconciled: 0, message: 'no person categories found' };
    }

    const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO fragment_categories (fragment_id, category_id, confidence, classified_by)
        VALUES (?, ?, 0.70, 'archivist_entity_pending')
    `);

    let totalReconciled = 0;
    const changedCatIds = new Set();  // only categories that actually got new fragments

    for (const ent of entities) {
        // Build name match list (name + aliases)
        const namePatterns = [ent.name];
        try {
            const aliases = JSON.parse(ent.aliases || '[]');
            for (const a of aliases) {
                if (a && a.trim().length >= 2) namePatterns.push(a.trim());
            }
        } catch (_) {}

        // Find fragments mentioning this person but NOT in their 人物/ category
        const likeClauses = namePatterns.map(() => "mf.content LIKE ?").join(' OR ');
        const params = namePatterns.map(n => `%${n}%`);

        const fragments = db.prepare(`
            SELECT mf.id FROM memory_fragments mf
            WHERE mf.status = 'active'
              AND (${likeClauses})
              AND mf.id NOT IN (
                  SELECT fragment_id FROM fragment_categories WHERE category_id = ?
              )
            LIMIT 100
        `).all(...params, ent.cat_id);

        let addedForEnt = 0;
        for (const frag of fragments) {
            const result = insertStmt.run(frag.id, ent.cat_id);
            if (result.changes > 0) {
                totalReconciled++;
                addedForEnt++;
            }
        }

        if (addedForEnt > 0) {
            changedCatIds.add(ent.cat_id);
            console.log(`[Archivist] 人物调和: ${ent.name} +${addedForEnt} 条碎片 → 人物/${ent.name}`);
        }
    }

    // Refresh fragment counts for categories that actually changed (pure DB, no ChromaDB)
    if (changedCatIds.size > 0) {
        const { refreshFragmentCount } = require('./ontology');
        for (const catId of changedCatIds) {
            refreshFragmentCount(catId);
        }
    }

    return { reconciled: totalReconciled };
}

// ═══════════════════════════════════════════════════════
// Tool: detectEmergentThemes
// ═══════════════════════════════════════════════════════

async function detectEmergentThemes() {
    const db = getDb();

    const lastProposal = db.prepare(`
        SELECT created_at FROM ontology_changelog
        WHERE action = 'theme_proposal' ORDER BY created_at DESC LIMIT 1
    `).get();

    if (lastProposal) {
        const hoursSince = (Date.now() - new Date(lastProposal.created_at + 'Z').getTime()) / 3600000;
        if (hoursSince < THEME_COOLDOWN_HOURS) {
            return { skipped: true, reason: 'cooldown' };
        }
    }

    const unclassified = db.prepare(`
        SELECT mf.id, mf.content FROM memory_fragments mf
        WHERE mf.status = 'active'
          AND mf.id NOT IN (SELECT DISTINCT fragment_id FROM fragment_categories)
        ORDER BY mf.created_at DESC LIMIT ?
    `).all(THEME_SAMPLE_SIZE);

    if (unclassified.length < MIN_CLUSTER_SIZE) {
        return { skipped: true, reason: 'insufficient' };
    }

    let clusters = [];
    try {
        const texts = unclassified.map(f => `Clara: ${f.content}`);
        const embs = [];

        // Batch embed to avoid proxy body-size rejection
        for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
            const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
            const result = await chromaDBOperation('embed_batch', { texts: batch });
            embs.push(...result.embeddings);
        }

        const pairs = [];
        for (let i = 0; i < embs.length; i++) {
            if (!embs[i] || embs[i].length === 0) continue;
            for (let j = i + 1; j < embs.length; j++) {
                if (!embs[j] || embs[j].length === 0) continue;
                const sim = cosineSimilarity(embs[i], embs[j]);
                if (sim >= THEME_SIMILARITY) {
                    pairs.push({ fragment_a: unclassified[i].id, fragment_b: unclassified[j].id, similarity: sim });
                }
            }
        }
        clusters = pairs;
    } catch (e) {
        console.error('[Archivist] 全对聚类失败:', e.message);
        return { skipped: true, reason: 'error' };
    }

    if (clusters.length < MIN_CLUSTER_SIZE) {
        return { skipped: true, reason: 'no_clusters' };
    }

    const groups = buildConnectedComponents(clusters, unclassified.map(f => f.id));
    const significantGroups = groups.filter(g => g.size >= 3);

    if (significantGroups.length === 0) {
        return { skipped: true, reason: 'no_significant_clusters' };
    }

    console.log(`[Archivist] 发现 ${significantGroups.length} 个显著聚类 (sizes: ${significantGroups.map(g => g.size).join(', ')})`);

    const existingCats = db.prepare(`
        SELECT id, path, label, description FROM memory_ontology ORDER BY id
    `).all();
    const catContext = existingCats.map(c => `- ${c.path} (${c.label}): ${c.description || ''}`).join('\n');

    let proposals = 0;
    for (const group of significantGroups) {
        const groupFragments = unclassified.filter(f => group.has(f.id));
        const fragmentTexts = groupFragments.map(f => `- ${f.content}`).join('\n');

        try {
            const proposal = await proposeNewCategory(fragmentTexts, catContext);
            if (proposal) {
                const confidence = typeof proposal.confidence === 'number' ? proposal.confidence : 0.65;
                db.prepare(`
                    INSERT INTO ontology_changelog (action, category_id, detail, confidence, status, created_at)
                    VALUES ('theme_proposal', NULL, ?, ?, 'pending', datetime('now'))
                `).run(JSON.stringify({
                    proposed_label: proposal.label,
                    proposed_path: proposal.path,
                    description: proposal.description,
                    sample_fragments: groupFragments.slice(0, 5).map(f => f.content),
                    fragment_ids: groupFragments.map(f => f.id),
                    cluster_size: group.size
                }), confidence);
                proposals++;
                console.log(`[Archivist] 主题提案: ${proposal.path} — "${proposal.label}" (${group.size} 碎片)`);
            }
        } catch (e) {
            console.error('[Archivist] 主题提案失败:', e.message);
        }
    }

    return { proposals, clusters: clusters.length, groups: significantGroups.length };
}

async function proposeNewCategory(fragmentTexts, existingCategoryContext) {
    const landscape = buildLandscapeIndex();

    const system = `${WORLD_CONTEXT}

${landscape}

你是记忆本体的档案管理员。分析一组未分类的碎片，判断它们是否构成一个有意义的主题。

最重要：先看星图中的现有星座——如果碎片可合理归入现有类别，输出 null。不创建重叠类别。`;

    const rules = `
规则：
- 只提案有明显语义内聚力的主题
- 不要提案太宽泛的分类
- 碎片关系松散 → null
- path 格式：直接使用标签作为路径

描述格式（功能性！）：「包含X，不含Y。」明确边界。

现有类别：
${existingCategoryContext}

只输出一行JSON，不要markdown包裹：

{"label":"标签","path":"路径","description":"包含X，不含Y。","confidence":0.0~1.0}

不应创建时输出：null`;

    const user = `未分类碎片（共若干条）：\n${fragmentTexts}`;

    const response = await callLLM(
        [{ role: 'user', parts: [{ text: user }] }],
        system + '\n\n' + rules,
        null,
        { temperature: 0.3, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
        ARCHIVIST_LLM_CONFIG_ID
    );

    try {
        let text = response?.reply || response?.text || response?.content || '';
        text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        if (text === 'null' || text === '' || text.startsWith('null')) return null;
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════════════════════
// Growth Pulse — event-driven category emergence
// 当未分类碎片积累到阈值时自动触发生长，不必等深循环
// ═══════════════════════════════════════════════════════

async function triggerGrowthPulse(opts = {}) {
    const { lightweight = false } = opts;
    const db = getDb();
    const { refreshFragmentCount } = require('./ontology');

    // Lightweight mode: smaller sample + batch size to avoid ChromaDB saturation.
    // Deep cycle: full sample for better cluster quality.
    const effectiveSample = lightweight ? 60 : EMERGENCE_SAMPLE;
    const effectiveBatch = lightweight ? 20 : EMBED_BATCH_SIZE;
    const batchDelayMs = lightweight ? 3000 : 0;  // 3s gap between batches in lightweight

    const unclassified = db.prepare(`
        SELECT mf.id, mf.content FROM memory_fragments mf
        WHERE mf.status = 'active'
          AND mf.id NOT IN (SELECT DISTINCT fragment_id FROM fragment_categories)
        ORDER BY mf.created_at DESC LIMIT ?
    `).all(effectiveSample);

    if (unclassified.length < MIN_CLUSTER_SIZE * 2) {
        console.log(`[Archivist] 生长脉冲跳过: 碎片不足 (${unclassified.length})`);
        return { created: 0, reason: 'insufficient' };
    }

    console.log(`[Archivist] 生长脉冲 [${lightweight ? '轻量' : '深度'}]: ${unclassified.length} 条采样`);

    // Embed (batched to stay under proxy body-size limit) + pairwise clustering
    let pairs = [];
    try {
        const texts = unclassified.map(f => f.content);
        const embs = [];

        // Batch embed to avoid proxy body-size rejection
        for (let i = 0; i < texts.length; i += effectiveBatch) {
            const batch = texts.slice(i, i + effectiveBatch);
            const result = await chromaDBOperation('embed_batch', { texts: batch });
            embs.push(...result.embeddings);
            if (batchDelayMs > 0 && i + effectiveBatch < texts.length) {
                await new Promise(r => setTimeout(r, batchDelayMs));
            }
        }
        console.log(`[Archivist] 生长脉冲嵌入: ${embs.length}/${unclassified.length}`);

        for (let i = 0; i < embs.length; i++) {
            if (!embs[i] || embs[i].length === 0) continue;
            for (let j = i + 1; j < embs.length; j++) {
                if (!embs[j] || embs[j].length === 0) continue;
                const sim = cosineSimilarity(embs[i], embs[j]);
                if (sim >= THEME_SIMILARITY) {
                    pairs.push({ fragment_a: unclassified[i].id, fragment_b: unclassified[j].id, similarity: sim });
                }
            }
        }
        console.log(`[Archivist] 生长脉冲聚类: ${unclassified.length} 碎片 → ${pairs.length} 对`);
    } catch (e) {
        console.error('[Archivist] 生长脉冲聚类失败:', e.message);
        return { created: 0, reason: 'error' };
    }

    if (pairs.length < BOOTSTRAP_MIN_CLUSTER) {
        console.log(`[Archivist] 生长脉冲配对不足 (${pairs.length})`);
        return { created: 0, reason: 'no_pairs' };
    }

    const allIds = unclassified.map(f => f.id);
    const groups = buildConnectedComponents(pairs, allIds);
    const significant = groups.filter(g => g.size >= BOOTSTRAP_MIN_CLUSTER).sort((a, b) => b.size - a.size);

    if (significant.length === 0) {
        console.log('[Archivist] 生长脉冲无显著聚类');
        return { created: 0, reason: 'no_clusters' };
    }

    console.log(`[Archivist] 生长脉冲发现 ${significant.length} 个显著聚类 (sizes: ${significant.map(g => g.size).join(', ')})`);

    // Get existing categories as context for LLM naming
    const existingCats = db.prepare(`
        SELECT id, path, label, description FROM memory_ontology ORDER BY id
    `).all();
    const catContext = existingCats.map(c => `- ${c.path} (${c.label}): ${c.description || ''}`).join('\n');

    let created = 0;
    const topGroups = significant.slice(0, BOOTSTRAP_MAX_CATEGORIES);

    for (const group of topGroups) {
        const groupFragments = unclassified.filter(f => group.has(f.id));
        const fragmentTexts = groupFragments.map(f => `- ${f.content}`).join('\n');

        try {
            const proposal = await proposeNewCategory(fragmentTexts, catContext);
            if (!proposal || !proposal.label) continue;

            const path = proposal.path || proposal.label;

            // Check for duplicate paths
            const existing = db.prepare('SELECT id FROM memory_ontology WHERE path = ?').get(path);
            if (existing) {
                console.log(`[Archivist] 生长脉冲跳过重复路径，归入已有类别: ${path} (${group.size}碎片)`);
                // Classify these fragments into the existing category
                const insertExisting = db.prepare(`
                    INSERT OR IGNORE INTO fragment_categories (fragment_id, category_id, confidence, classified_by)
                    VALUES (?, ?, 0.75, 'archivist_growth_dup')
                `);
                for (const f of groupFragments) insertExisting.run(f.id, existing.id);
                refreshFragmentCount(existing.id);
                const newCentroid = await computeCategoryCentroid(existing.id);
                if (newCentroid) {
                    db.prepare(`UPDATE memory_ontology SET centroid_embedding = ?, updated_at = datetime('now') WHERE id = ?`)
                        .run(JSON.stringify(newCentroid), existing.id);
                }
                continue;
            }

            const insertCat = db.prepare(`
                INSERT INTO memory_ontology (path, label, description) VALUES (?, ?, ?)
            `);
            const info = insertCat.run(path, proposal.label, proposal.description || '');
            const newCatId = info.lastInsertRowid;

            // Classify clustered fragments into the new category
            const insertFc = db.prepare(`
                INSERT OR IGNORE INTO fragment_categories (fragment_id, category_id, confidence, classified_by)
                VALUES (?, ?, 0.80, 'archivist_growth')
            `);
            for (const f of groupFragments) insertFc.run(f.id, newCatId);

            // Compute centroid
            const centroid = await computeCategoryCentroid(newCatId);
            if (centroid) {
                db.prepare(`UPDATE memory_ontology SET centroid_embedding = ?, updated_at = datetime('now') WHERE id = ?`)
                    .run(JSON.stringify(centroid), newCatId);
            }

            // Refresh fragment count
            refreshFragmentCount(newCatId);

            console.log(`[Archivist] 生长脉冲创建: ${path} — "${proposal.label}" (${group.size} 碎片)`);
            created++;
        } catch (e) {
            console.error('[Archivist] 生长脉冲创建类别失败:', e.message);
        }
    }

    // After new categories are born, run one classification round to backfill
    // remaining unclassified fragments against the expanded category set
    if (created > 0) {
        agentState.treeChanged = true;
        try {
            const backfillResult = await classifyFragments({ lightweight });
            if (backfillResult && backfillResult.classified > 0) {
                console.log(`[Archivist] 生长脉冲回填: ${backfillResult.classified} 条碎片归入新/现有星座`);
            }
        } catch (e) {
            console.error('[Archivist] 生长脉冲回填分类失败:', e.message);
        }
    }

    console.log(`[Archivist] 生长脉冲 [${lightweight ? '轻量' : '深度'}] 完成: 创建${created}个新类别, ${significant.length}个聚类组`);
    return { created, groups: significant.length };
}

// ═══════════════════════════════════════════════════════
// Bootstrap Ontology
// ═══════════════════════════════════════════════════════

async function bootstrapOntology() {
    const db = getDb();

    const unclassified = db.prepare(`
        SELECT mf.id, mf.content FROM memory_fragments mf
        WHERE mf.status = 'active' ORDER BY mf.created_at DESC LIMIT ?
    `).all(BOOTSTRAP_SAMPLE);

    if (unclassified.length < BOOTSTRAP_MIN_CLUSTER * 2) {
        console.log(`[Archivist] 引导失败: 碎片不足 (${unclassified.length})`);
        return { created: 0 };
    }

    let pairs = [];
    try {
        const texts = unclassified.map(f => `Clara: ${f.content}`);
        const embs = [];

        // Batch embed to avoid proxy body-size rejection
        for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
            const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
            const result = await chromaDBOperation('embed_batch', { texts: batch });
            embs.push(...result.embeddings);
        }
        console.log(`[Archivist] 引导嵌入: ${embs.length}/${unclassified.length}`);

        for (let i = 0; i < embs.length; i++) {
            if (!embs[i] || embs[i].length === 0) continue;
            for (let j = i + 1; j < embs.length; j++) {
                if (!embs[j] || embs[j].length === 0) continue;
                const sim = cosineSimilarity(embs[i], embs[j]);
                if (sim >= THEME_SIMILARITY) {
                    pairs.push({ fragment_a: unclassified[i].id, fragment_b: unclassified[j].id, similarity: sim });
                }
            }
        }
        console.log(`[Archivist] 引导聚类: ${unclassified.length} 碎片 → ${pairs.length} 对`);
    } catch (e) {
        console.error('[Archivist] 引导聚类失败:', e.message);
        return { created: 0 };
    }

    if (pairs.length < BOOTSTRAP_MIN_CLUSTER) {
        console.log(`[Archivist] 引导配对不足 (${pairs.length})`);
        return { created: 0 };
    }

    const allIds = unclassified.map(f => f.id);
    const groups = buildConnectedComponents(pairs, allIds);
    const significant = groups.filter(g => g.size >= BOOTSTRAP_MIN_CLUSTER).sort((a, b) => b.size - a.size);

    if (significant.length === 0) {
        console.log('[Archivist] 引导无显著聚类');
        return { created: 0 };
    }

    console.log(`[Archivist] 引导发现 ${significant.length} 个显著聚类`);

    let created = 0;
    const topGroups = significant.slice(0, BOOTSTRAP_MAX_CATEGORIES);

    for (const group of topGroups) {
        const groupFragments = unclassified.filter(f => group.has(f.id));
        const fragmentTexts = groupFragments.map(f => `- ${f.content}`).join('\n');

        try {
            const proposal = await proposeNewCategory(fragmentTexts, '（尚无现有类别）');
            if (!proposal || !proposal.label) continue;

            const path = proposal.path || proposal.label;

            const insertCat = db.prepare(`
                INSERT INTO memory_ontology (path, label, description) VALUES (?, ?, ?)
            `);
            const info = insertCat.run(path, proposal.label, proposal.description || '');
            const newCatId = info.lastInsertRowid;

            const insertFc = db.prepare(`
                INSERT OR IGNORE INTO fragment_categories (fragment_id, category_id, confidence, classified_by)
                VALUES (?, ?, 0.80, 'archivist_bootstrap')
            `);
            for (const f of groupFragments) insertFc.run(f.id, newCatId);

            const centroid = await computeCategoryCentroid(newCatId);
            if (centroid) {
                db.prepare(`UPDATE memory_ontology SET centroid_embedding = ?, updated_at = datetime('now') WHERE id = ?`)
                    .run(JSON.stringify(centroid), newCatId);
            }

            console.log(`[Archivist] 引导创建: ${path} — "${proposal.label}" (${group.size} 碎片)`);
            created++;
        } catch (e) {
            console.error('[Archivist] 引导创建类别失败:', e.message);
        }
    }

    return { created };
}

// ═══════════════════════════════════════════════════════
// Proposal Application
// ═══════════════════════════════════════════════════════

async function applyMerge(proposal) {
    const db = getDb();
    const detail = JSON.parse(proposal.detail || '{}');
    const sourcePath = detail.source_path || proposal.category_path;
    const targetPath = detail.target_path;
    if (!sourcePath || !targetPath) return false;

    const source = db.prepare('SELECT id FROM memory_ontology WHERE path = ?').get(sourcePath);
    const target = db.prepare('SELECT id FROM memory_ontology WHERE path = ?').get(targetPath);
    if (!source || !target) return false;

    const sourceFrags = db.prepare('SELECT fragment_id, confidence, classified_by FROM fragment_categories WHERE category_id = ?').all(source.id);
    for (const f of sourceFrags) {
        db.prepare('INSERT OR IGNORE INTO fragment_categories (fragment_id, category_id, confidence, classified_by) VALUES (?, ?, ?, ?)')
            .run(f.fragment_id, target.id, f.confidence, f.classified_by + '_merged');
    }
    db.prepare('DELETE FROM fragment_categories WHERE category_id = ?').run(source.id);
    db.prepare('DELETE FROM memory_ontology WHERE id = ?').run(source.id);

    const { refreshFragmentCount } = require('./ontology');
    refreshFragmentCount(target.id);
    const newCentroid = await computeCategoryCentroid(target.id);
    if (newCentroid) {
        db.prepare('UPDATE memory_ontology SET centroid_embedding = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(JSON.stringify(newCentroid), target.id);
    }

    db.prepare("UPDATE ontology_changelog SET status = 'applied' WHERE id = ?").run(proposal.id);
    console.log(`[Archivist] 合并: ${sourcePath} → ${targetPath}`);
    return true;
}

async function applySplit(proposal) {
    const db = getDb();
    const detail = JSON.parse(proposal.detail || '{}');
    const children = detail.suggested_children;
    if (!children || children.length === 0) return false;

    const parentPath = proposal.category_path;
    const parent = db.prepare('SELECT id FROM memory_ontology WHERE path = ?').get(parentPath);
    if (!parent) return false;

    for (const child of children) {
        const existing = db.prepare('SELECT id FROM memory_ontology WHERE path = ?').get(child.path);
        if (existing) continue;
        db.prepare('INSERT INTO memory_ontology (path, label, description) VALUES (?, ?, ?)')
            .run(child.path, child.label, child.description || '');
    }

    db.prepare("UPDATE ontology_changelog SET status = 'applied' WHERE id = ?").run(proposal.id);
    console.log(`[Archivist] 拆分: ${parentPath} → ${children.length} 个子类别`);
    return true;
}

async function applyDescriptionUpdate(proposal) {
    const db = getDb();
    const detail = JSON.parse(proposal.detail || '{}');
    const path = proposal.category_path;
    const newDesc = detail.new_description;
    if (!path || !newDesc) return false;

    db.prepare("UPDATE memory_ontology SET description = ?, updated_at = datetime('now') WHERE path = ?")
        .run(newDesc, path);
    db.prepare("UPDATE ontology_changelog SET status = 'applied' WHERE id = ?").run(proposal.id);
    console.log(`[Archivist] 描述更新: ${path}`);
    return true;
}

async function applyFlatten(proposal) {
    const db = getDb();
    const detail = JSON.parse(proposal.detail || '{}');
    const childPath = proposal.category_path;
    const parentPath = detail.parent_path;
    if (!childPath || !parentPath) return false;

    const child = db.prepare('SELECT id FROM memory_ontology WHERE path = ?').get(childPath);
    const parent = db.prepare('SELECT id FROM memory_ontology WHERE path = ?').get(parentPath);
    if (!child || !parent) return false;

    const childFrags = db.prepare('SELECT fragment_id, confidence, classified_by FROM fragment_categories WHERE category_id = ?').all(child.id);
    for (const f of childFrags) {
        db.prepare('INSERT OR IGNORE INTO fragment_categories (fragment_id, category_id, confidence, classified_by) VALUES (?, ?, ?, ?)')
            .run(f.fragment_id, parent.id, f.confidence, f.classified_by + '_flattened');
    }
    db.prepare('DELETE FROM fragment_categories WHERE category_id = ?').run(child.id);
    db.prepare('DELETE FROM memory_ontology WHERE id = ?').run(child.id);

    const { refreshFragmentCount } = require('./ontology');
    refreshFragmentCount(parent.id);
    const newCentroid = await computeCategoryCentroid(parent.id);
    if (newCentroid) {
        db.prepare('UPDATE memory_ontology SET centroid_embedding = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(JSON.stringify(newCentroid), parent.id);
    }

    db.prepare("UPDATE ontology_changelog SET status = 'applied' WHERE id = ?").run(proposal.id);
    console.log(`[Archivist] 扁平化: ${childPath} → ${parentPath}`);
    return true;
}

async function applyNewCategory(proposal) {
    const db = getDb();
    const detail = JSON.parse(proposal.detail || '{}');
    const path = detail.proposed_path;
    const label = detail.proposed_label;
    const description = detail.description || '';

    if (!path || !label) return false;

    // Check if category already exists
    const existing = db.prepare('SELECT id FROM memory_ontology WHERE path = ?').get(path);
    if (existing) {
        db.prepare("UPDATE ontology_changelog SET status = 'applied' WHERE id = ?").run(proposal.id);
        console.log(`[Archivist] 类别已存在: ${path}，标记 applied`);
        return true;
    }

    // Create category (flat — no parent)
    const info = db.prepare('INSERT INTO memory_ontology (path, label, description) VALUES (?, ?, ?)')
        .run(path, label, description);
    const newCatId = info.lastInsertRowid;

    // Classify the cluster fragments into the new category
    const fragmentIds = detail.fragment_ids || [];
    if (fragmentIds.length > 0) {
        const insertFc = db.prepare('INSERT OR IGNORE INTO fragment_categories (fragment_id, category_id, confidence, classified_by) VALUES (?, ?, 0.80, ?)');
        for (const fid of fragmentIds) {
            insertFc.run(fid, newCatId, 'archivist_theme_applied');
        }
    }

    // Compute centroid
    const centroid = await computeCategoryCentroid(newCatId);
    if (centroid) {
        db.prepare("UPDATE memory_ontology SET centroid_embedding = ?, updated_at = datetime('now') WHERE id = ?")
            .run(JSON.stringify(centroid), newCatId);
    }

    const { refreshFragmentCount } = require('./ontology');
    refreshFragmentCount(newCatId);

    db.prepare("UPDATE ontology_changelog SET status = 'applied' WHERE id = ?").run(proposal.id);
    console.log(`[Archivist] 自动创建类别: ${path} — "${label}" (${fragmentIds.length} 碎片)`);
    return true;
}

async function applyHighConfidenceProposals() {
    const db = getDb();

    const proposals = db.prepare(
        "SELECT * FROM ontology_changelog WHERE confidence >= 0.85 AND status = 'pending' ORDER BY created_at"
    ).all();

    if (proposals.length === 0) return { applied: 0 };

    console.log(`[Archivist] 高置信度提案: ${proposals.length} 条`);
    let applied = 0;

    for (const p of proposals) {
        try {
            let ok = false;
            if (p.action === 'merge_proposal') ok = await applyMerge(p);
            else if (p.action === 'density_proposal') ok = await applySplit(p);
            else if (p.action === 'structure_proposal') ok = await applySplit(p);  // same logic
            else if (p.action === 'theme_proposal') ok = await applyNewCategory(p);
            else if (p.action === 'description_update' || p.action === 'myth_update') ok = await applyDescriptionUpdate(p);
            else if (p.action === 'flatten_proposal') ok = await applyFlatten(p);

            if (ok) applied++;
        } catch (e) {
            console.error(`[Archivist] 应用提案 #${p.id} 失败:`, e.message);
        }
    }

    if (applied > 0) {
        const { refreshFragmentCount } = require('./ontology');
        const allCats = db.prepare('SELECT id FROM memory_ontology').all();
        for (const c of allCats) refreshFragmentCount(c.id);
        db.prepare('UPDATE memory_ontology SET centroid_embedding = NULL').run();
    }

    console.log(`[Archivist] 自动应用: ${applied}/${proposals.length} 条`);
    return { applied };
}

// ═══════════════════════════════════════════════════════
// Category Description Regeneration
//
// Produces FUNCTIONAL descriptions — not poetic myths.
// A good description tells the classifier exactly what belongs
// and what doesn't, so fragments don't bleed across categories.
// ═══════════════════════════════════════════════════════

async function regenerateCategoryDescriptions() {
    const db = getDb();

    // Fetch all categories that have classified fragments
    const cats = db.prepare(`
        SELECT o.id, o.path, o.label, o.description, o.fragment_count, o.updated_at
        FROM memory_ontology o
        WHERE o.id IN (SELECT DISTINCT category_id FROM fragment_categories)
        ORDER BY o.fragment_count DESC
    `).all();

    if (cats.length === 0) return { regenerated: 0 };

    // Regenerate ALL categories — don't wait for growth.
    // Skip recently-updated to avoid re-running the same batch repeatedly.
    const cooldownCutoff = db.prepare("SELECT datetime('now', '-6 hours') as d").get().d;
    const pending = cats.filter(c => {
        if (!c.updated_at) return true;
        return c.updated_at < cooldownCutoff;
    });
    const batch = pending.slice(0, 15);
    let regenerated = 0;

    for (const cat of batch) {
        const samples = db.prepare(`
            SELECT mf.content FROM memory_fragments mf
            JOIN fragment_categories fc ON fc.fragment_id = mf.id
            WHERE fc.category_id = ? AND mf.status = 'active'
            ORDER BY mf.created_at DESC LIMIT 8
        `).all(cat.id);

        if (samples.length === 0) continue;

        const landscape = buildLandscapeIndex();

        const prompt = `${WORLD_CONTEXT}

${landscape}

你是 Draco 记忆系统的**类别描述员**。你的任务是给一个记忆类别写一句**功能性的范围描述**，让分类器知道什么碎片属于这里、什么不属于。

## 为什么功能描述比诗意描述好

差的描述："她划下王尔德那句话时，铅笔痕深得能刻进纸里"
→ 分类器读到一条关于《素食者》的批注，不知道是否该归入此类。

好的描述："Draco在阅读文学作品时留下的批注和评论。不含Clara的创作或配音内容。"
→ 分类器立刻知道边界。

## 规则

- **说清楚包含什么** — 碎片主题、来源、涉及人物
- **说清楚不包含什么** — 最容易混淆的相邻类别
- **检查星图中的相邻星座** — 如果有主题重叠的类别，在排除项中明确区分
- **1-2句话，不超过80字**
- **用第三人称、中性语言** — 这是分类标签，不是私人笔记
- **保留关键实体名** — 人名、书名、地名

## 类别：${cat.path}（${cat.label}）
当前描述：${cat.description || '（无）'}
碎片数：${cat.fragment_count}

## 最近碎片样本
${samples.map((s, i) => `[${i + 1}] ${s.content}`).join('\n')}

## 输出

只输出一行描述文本，不要JSON、不要前缀、不要引号包裹。
如果当前描述已经准确且功能清晰，输出 KEEP。`;

        try {
            const response = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                null, null,
                { temperature: 0.3, maxOutputTokens: 200 },
                ARCHIVIST_LLM_CONFIG_ID
            );

            const newDesc = (response?.reply || '').trim();
            if (newDesc && newDesc.length > 10 && newDesc !== 'KEEP') {
                db.prepare("UPDATE memory_ontology SET description = ?, updated_at = datetime('now') WHERE id = ?")
                    .run(newDesc, cat.id);
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, confidence, status)
                    VALUES ('description_update', ?, ?, 0.9, 'applied')`)
                    .run(cat.path, JSON.stringify({
                        old_description: cat.description,
                        new_description: newDesc,
                        fragment_count_at_update: cat.fragment_count,
                    }));
                regenerated++;
                console.log(`[Archivist] 描述更新: ${cat.path} → "${newDesc.substring(0, 60)}..."`);
            }
        } catch (e) {
            console.error(`[Archivist] 描述生成失败 (${cat.path}):`, e.message);
        }
    }

    return { regenerated, assessed: cats.length, batch: batch.length };
}

// ═══════════════════════════════════════════════════════
// Tool: detectBeliefDrift
//
// Deep cycle task: compare early vs recent fragments within a
// constellation to detect when Clara's feelings/views on a topic
// have meaningfully shifted. Writes to ontology_changelog and
// updates the constellation description with an evolution note.
// ═══════════════════════════════════════════════════════

async function detectBeliefDrift() {
    const db = getDb();

    const lastRun = db.prepare(
        "SELECT created_at FROM ontology_changelog WHERE action = 'belief_drift' ORDER BY created_at DESC LIMIT 1"
    ).get();
    if (lastRun) {
        const hoursAgo = (Date.now() - new Date(lastRun.created_at + 'Z').getTime()) / 3600000;
        if (hoursAgo < 4) return { skipped: true, reason: 'cooldown' };
    }

    // Only check constellations with enough fragments for a meaningful comparison
    const constellations = db.prepare(`
        SELECT o.id, o.path, o.label, o.description, o.fragment_count
        FROM memory_ontology o
        WHERE o.fragment_count >= 10
          AND o.id IN (SELECT DISTINCT category_id FROM fragment_categories)
        ORDER BY o.fragment_count DESC
        LIMIT 5
    `).all();

    if (constellations.length === 0) return { checked: 0 };

    let checked = 0, driftsFound = 0;

    for (const c of constellations) {
        // Split fragments into early (oldest 40%) and recent (newest 40%)
        const allFrags = db.prepare(`
            SELECT mf.content, mf.source_date, mf.created_at
            FROM memory_fragments mf
            JOIN fragment_categories fc ON fc.fragment_id = mf.id
            WHERE fc.category_id = ? AND mf.status = 'active'
            ORDER BY COALESCE(mf.source_date, mf.created_at) ASC
        `).all(c.id);

        if (allFrags.length < 10) continue;

        const mid = Math.floor(allFrags.length * 0.4);
        const early = allFrags.slice(0, mid);
        const recent = allFrags.slice(-mid);
        if (early.length < 3 || recent.length < 3) continue;

        const prompt = `${WORLD_CONTEXT}

${buildLandscapeIndex()}

你是 Draco。你正在审视「${c.path}」这个记忆星座。Clara 对这个主题的看法可能随时间发生了变化。请比较早期和近期的碎片，判断是否存在信念漂移。

## 早期碎片（时间较早）
${early.map((f, i) => `[${i + 1}] (${f.source_date || '?'}) ${f.content}`).join('\n')}

## 近期碎片（时间较晚）
${recent.map((f, i) => `[${i + mid + 1}] (${f.source_date || '?'}) ${f.content}`).join('\n')}

## 判断

比较两组碎片中 Clara 的情感态度/行为模式/对人事物的看法。只输出一个 JSON：

如果态度基本一致，没明显变化：
{"changed": false}

如果有显著变化：
{
  "changed": true,
  "old_view": "她曾认为/感受到...",
  "new_view": "她现在...",
  "nature": "gradual" | "event_driven",
  "confidence": 0.0-1.0
}

严格：
- 只基于碎片中实际写的内容判断，不要推测
- 不是所有变化都值得记录——必须是情感态度或行为模式上的显著转变
- 如果只是碎片样本不同（而非态度变了），输出 changed:false
- 只输出 JSON，不要任何前缀或后缀`;

        try {
            const response = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                null, null,
                { temperature: 0.2, maxOutputTokens: 300 },
                ARCHIVIST_LLM_CONFIG_ID
            );

            let text = response?.reply || '';
            text = text.replace(/```json|```/g, '').trim();
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) continue;

            const result = JSON.parse(match[0]);
            checked++;

            if (result.changed && result.confidence >= 0.7) {
                db.prepare(`INSERT INTO ontology_changelog (action, category_id, category_path, detail, confidence, status)
                    VALUES ('belief_drift', ?, ?, ?, ?, 'applied')`)
                    .run(c.id, c.path, JSON.stringify({
                        old_view: result.old_view,
                        new_view: result.new_view,
                        nature: result.nature,
                        early_fragment_count: early.length,
                        recent_fragment_count: recent.length
                    }), result.confidence);

                // Append evolution note to constellation description
                if (c.description) {
                    const driftNote = `\n\n【信念漂移】她变了：${result.old_view} → ${result.new_view}`;
                    const newDesc = c.description + driftNote;
                    db.prepare("UPDATE memory_ontology SET description = ?, updated_at = datetime('now') WHERE id = ?")
                        .run(newDesc, c.id);
                }

                driftsFound++;
                console.log(`[Archivist] 信念漂移: ${c.path} — "${result.old_view}" → "${result.new_view}"`);
            }
        } catch (e) {
            console.error(`[Archivist] 信念漂移检测失败 (${c.path}):`, e.message);
        }
    }

    return { checked, drifts: driftsFound };
}

// ═══════════════════════════════════════════════════════
// Tool: consolidateCategory
//
// Deep cycle task: select dense leaf categories, merge related
// fragments within each category into episodes. Unlike the old
// Consolidator (blind ChromaDB clustering), this uses the knowledge
// tree structure — fragments already in the same category share a
// semantic context, so LLM merges are more precise.
//
// Each category gets one LLM call that simultaneously:
//   1. Identifies mergeable fragment groups (≥3 related fragments)
//   2. Merges each group into an episode → memories table
//   3. Updates the category description if new facts emerged
// ═══════════════════════════════════════════════════════

const CATEGORY_CONSOLIDATE_MIN_FRAGS = 15;   // min fragment_count to consider
const CATEGORY_CONSOLIDATE_MAX_CATS = 5;     // max categories per run
const CATEGORY_CONSOLIDATE_MAX_FRAGS = 30;   // max fragments to fetch per category

async function consolidateCategory() {
    const db = getDb();

    // v5.3: 从 entity_profiles 星座读取（替代旧的 memory_ontology 知识树）
    // 跳过 Clara/Draco（碎片太多，每次取30条无法覆盖）和聚合实体
    const CONSOLIDATE_SKIP = [USER.name, AI.name, '音乐', '共读'];
    const CONSOLIDATE_SKIP_PH = CONSOLIDATE_SKIP.map(() => '?').join(',');

    const candidates = db.prepare(`
        SELECT ep.id, ep.name as path, ep.name as label, ep.overview as description, ep.fragment_count,
               ep.category,
               (SELECT COUNT(*) FROM memory_fragments mf
                JOIN fragment_entities fe ON fe.fragment_id = mf.id
                WHERE fe.entity_id = ep.id AND mf.status = 'active') as active_count
        FROM entity_profiles ep
        WHERE ep.status = 'active'
          AND ep.fragment_count >= ?
          AND ep.name NOT IN (${CONSOLIDATE_SKIP_PH})
        ORDER BY ep.fragment_count DESC
        LIMIT ?
    `).all(CATEGORY_CONSOLIDATE_MIN_FRAGS, ...CONSOLIDATE_SKIP, CATEGORY_CONSOLIDATE_MAX_CATS);

    if (candidates.length === 0) return { categories: 0, episodes: 0 };

    let categoriesProcessed = 0;
    let episodesWritten = 0;
    const newEpisodes = [];  // for Entity Profile trigger

    for (const cat of candidates) {
        if (cat.active_count < 3) continue; // need at least 3 active fragments

        categoriesProcessed++;

        // Fetch active fragments linked to this constellation
        const fragments = db.prepare(`
            SELECT mf.id, mf.content, mf.emotional_weight, mf.source, mf.source_date,
                   mf.source_msg_ids, mf.entity, mf.created_at
            FROM memory_fragments mf
            JOIN fragment_entities fe ON fe.fragment_id = mf.id
            WHERE fe.entity_id = ? AND mf.status = 'active'
            ORDER BY mf.created_at DESC
            LIMIT ?
        `).all(cat.id, CATEGORY_CONSOLIDATE_MAX_FRAGS);

        if (fragments.length < 3) continue;

        // Build prompt
        const fragmentsBlock = fragments.map((f, i) => {
            const ew = (f.emotional_weight || 0).toFixed(2);
            const src = f.source || 'chat';
            return `[${i}] src=${src} date=${f.source_date || '?'} ew=${ew}\n  ${f.content}`;
        }).join('\n\n');

        const prompt = `${WORLD_CONTEXT}

${buildLandscapeIndex()}

你是星座记忆整合器。你看到的碎片都来自同一个记忆星座：
**星座名称**：${cat.path}（${cat.category || 'unknown'}）
**当前概述**：${cat.description || '无'}

## 你的任务

1. **审视所有碎片**，判断哪些碎片是"同一事件的多个侧面"（语义高度相关、讲的是同一个具体的事件或关系），将它们分组。
   - 注意：不是所有话题相同的就是同一事件——"妈妈做饭"和"妈妈打电话"虽然都涉及妈妈，但是两个独立事件
   - 只有真正讲述同一个具体事件的碎片才应该被合并
   - 每组至少3条碎片才值得合并

2. **对每个可合并的组**，将碎片合并为一条规范episode记忆（第三人称，不超过150字）。

3. **如果碎片中有新的事实信息**（之前概述中没提到的），更新星座概述（一句话，不超过50字，描述此星座下碎片的主要主题）。如果现有概述已经准确覆盖，输出 null。

## 分量判断 (significance)
- 8-10：情感转折、重大决定、深刻冲突、关系里程碑
- 5-7：有意义但非关键的事件、日常偏好变化
- 3-4：日常工作记录、routine操作 — 不值得长期保留
- 1-2：琐碎闲聊 — 应丢弃

## 输出格式

严格JSON，不含任何其他文字：
{
  "clusters": [
    {
      "fragment_indices": [0, 3, 7],
      "merged_memory": "第三人称规范记忆，150字以内",
      "corrected_date": "YYYY-MM-DD 或空字符串",
      "significance": 1-10,
      "confidence": "high/medium/low",
      "contradiction": null
    }
  ],
  "description_update": "新的星座概述，如果无更新则为null"
}`;

        try {
            const response = await callLLM(
                [{ role: 'user', parts: [{ text: `${fragmentsBlock}\n\n请整合以上碎片。` }] }],
                prompt,
                null,
                { temperature: 0.3, maxOutputTokens: 4000 },
                ARCHIVIST_LLM_CONFIG_ID
            );

            let text = response?.reply || '';
            text = text.replace(/```json|```/g, '').trim();
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) {
                console.error(`[Archivist] consolidateCategory 返回非JSON: ${cat.path}`);
                continue;
            }

            const result = JSON.parse(match[0]);
            const clusters = result.clusters || [];

            // Process each mergeable cluster
            for (const cluster of clusters) {
                const indices = cluster.fragment_indices || [];
                if (indices.length < 3) continue;
                if (!cluster.merged_memory) continue;

                const sig = typeof cluster.significance === 'number' ? cluster.significance : 5;
                if (sig < 4) {
                    console.log(`[Archivist] 星座整合跳过(分量不足 sig=${sig}): ${cat.path}`);
                    continue;
                }

                // Collect merged fragment IDs
                const mergedIds = [];
                for (const idx of indices) {
                    if (fragments[idx]) mergedIds.push(fragments[idx].id);
                }
                if (mergedIds.length < 3) continue;

                // Collect source_msg_ids
                const allMsgIds = new Set();
                for (const idx of indices) {
                    const f = fragments[idx];
                    if (!f) continue;
                    try {
                        const ids = JSON.parse(f.source_msg_ids || '[]');
                        for (const mid of ids) allMsgIds.add(mid);
                    } catch (_) {}
                }

                // Average emotional weight
                const avgEW = indices.reduce((s, i) => s + (fragments[i]?.emotional_weight || 0.5), 0) / indices.length;
                const mergedWeight = Math.min(10, Math.round(sig * 0.7 + (5 + avgEW * 3) * 0.3));

                const finalDate = cluster.corrected_date || fragments[indices[0]]?.source_date || '';

                // Write to memories table
                const title = cluster.merged_memory.slice(0, 50);
                const insert = db.prepare(`
                    INSERT INTO memories (title, content, weight, valid_from, status, source_msg_ids, entity_id, layer, consolidation_type, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 'permanent', ?, ?, 'episode', 'standard', datetime('now'), datetime('now'))
                `);
                const info = insert.run(
                    title,
                    cluster.merged_memory,
                    mergedWeight,
                    finalDate,
                    JSON.stringify([...allMsgIds]),
                    cat.id
                );
                const memoryId = info.lastInsertRowid;

                // Index to ChromaDB (v5.3: re-enabled for Librarian retrieval)
                try {
                    const { chromaDBOperation } = require('./memory');
                    const idxResult = await chromaDBOperation('index_batch', {
                        items: [{ id: `memory_${memoryId}`, text: cluster.merged_memory, metadata: { source: 'archivist_consolidate', entity_id: cat.id } }]
                    });
                    const chromaId = idxResult.indexed > 0 ? `memory_${memoryId}`
                        : (idxResult.duplicates?.length > 0 ? `dup_of_${idxResult.duplicates[0].existing_id}` : null);
                    if (chromaId) {
                        db.prepare('UPDATE memories SET chroma_id = ? WHERE id = ?').run(chromaId, memoryId);
                    }
                } catch (e) {
                    console.error(`[Archivist] consolidateCategory ChromaDB index failed:`, e.message);
                }

                // Mark fragments as consolidated
                const markStmt = db.prepare('UPDATE memory_fragments SET status = ? WHERE id = ?');
                for (const fid of mergedIds) {
                    markStmt.run('consolidated', fid);
                }

                episodesWritten++;
                newEpisodes.push({
                    memoryId,
                    memoryContent: cluster.merged_memory,
                    fragmentIds: mergedIds,
                    correctedDate: cluster.corrected_date || null,
                    confidence: cluster.confidence || 'medium',
                    contradiction: cluster.contradiction || null,
                    significance: sig,
                    entityId: cat.id,
                    entityName: cat.path,
                });

                console.log(`[Archivist] 星座整合 [${cat.path}]: ${mergedIds.length}碎片 → episode #${memoryId} (sig=${sig})`);
            }

            // v5.3: Update entity_profiles.overview instead of memory_ontology.description
            if (result.description_update && result.description_update !== 'null') {
                db.prepare("UPDATE entity_profiles SET overview = ?, overview_updated_at = datetime('now') WHERE id = ?")
                    .run(result.description_update, cat.id);
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, created_at)
                    VALUES ('description_update', ?, ?, datetime('now'))`)
                    .run(cat.path, JSON.stringify({ source: 'consolidate_category', fragment_count_at_update: cat.fragment_count }));
                console.log(`[Archivist] 星座整合: ${cat.path} 概述更新 → "${result.description_update}"`);
            }

            // v5.3: entity_profiles doesn't have centroid_embedding — skip centroid refresh
            // Fragment counts will be refreshed naturally on next classification cycle

        } catch (e) {
            console.error(`[Archivist] consolidateCategory 失败 [${cat.path}]:`, e.message);
        }
    }

    // Trigger downstream: Entity Profile + Saga Weaver
    if (episodesWritten > 0) {
        try {
            const { updateEntityProfiles } = require('./entityProfile');
            await updateEntityProfiles(newEpisodes).catch(e =>
                console.error('[Archivist] 实体档案更新失败:', e.message)
            );
        } catch (_) {}

        // v5.3: Saga trigger kept for immediate effect, but clusterSagas is ALSO independently
        // schedulable in GARDEN_TASKS. This dual-trigger ensures sagas update promptly
        // when new episodes arrive, while the garden plan covers periodic full-clustering.
        try {
            const episodeCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE layer='episode' AND status='permanent'").get();
            if (episodeCount.c >= 5) {
                const { clusterSagas } = require('./consolidator');
                console.log(`[Archivist] episode已累积${episodeCount.c}条，触发Saga聚类...`);
                await clusterSagas().catch(e =>
                    console.error('[Archivist] Saga聚类失败:', e.message)
                );
            }
        } catch (_) {}
    }

    console.log(`[Archivist] 星座整合完成: ${categoriesProcessed}个星座 → ${episodesWritten}条episode`);
    return { categories: categoriesProcessed, episodes: episodesWritten };
}

// ═══════════════════════════════════════════════════════
// Tool: regenerateEntityOverviews
// ═══════════════════════════════════════════════════════

async function regenerateEntityOverviews() {
    const db = getDb();

    // Fetch all entities with fragments
    const entities = db.prepare(`
        SELECT ep.id, ep.name, ep.category, ep.status, ep.subcategory,
               ep.relationship_to_clara, ep.relationship_nature,
               ep.emotional_significance, ep.overview, ep.overview_updated_at,
               ep.last_eval_frag_count, ep.fragment_count, ep.aliases, ep.tags
        FROM entity_profiles ep
        WHERE ep.name NOT IN (${SKIP_PH})
          AND ep.fragment_count > 0
        ORDER BY ep.fragment_count DESC
    `).all(...SKIP_NAMES);

    if (entities.length === 0) return { regenerated: 0 };

    // Assess freshness per entity
    const needsUpdate = [];
    for (const ent of entities) {
        const currentCount = db.prepare(
            'SELECT COUNT(*) as c FROM fragment_entities WHERE entity_id = ?'
        ).get(ent.id)?.c || ent.fragment_count || 0;

        if (currentCount === 0) continue; // no fragments → skip

        // Never had an overview
        if (!ent.overview) {
            needsUpdate.push({ ...ent, currentCount, reason: 'never_described' });
            continue;
        }

        // Significant change since last overview? (growth OR shrinkage — v5.0)
        // Heuristic: if fragment count changed >= 20% or >= 3 since last overview,
        // the constellation's composition has shifted enough to warrant a fresh description.
        const prevCount = ent.last_eval_frag_count || 0;
        const change = Math.abs(currentCount - prevCount);
        const changeRatio = prevCount > 0 ? change / prevCount : 1;

        if (changeRatio >= 0.2 || change >= 3) {
            const dir = currentCount > prevCount ? 'grown' : 'shrunk';
            needsUpdate.push({ ...ent, currentCount, reason: `${dir}_${change > 0 ? '+' : ''}${currentCount - prevCount}` });
            continue;
        }

        // Safety net: very stale (>30 days)
        if (!ent.overview_updated_at || ent.overview_updated_at < db.prepare("SELECT datetime('now', '-30 days') as d").get().d) {
            needsUpdate.push({ ...ent, currentCount, reason: 'stale_30d' });
            continue;
        }

        // v5.1: Missing aliases or tags — low-priority backfill
        let existingAliases = [];
        let existingTags = [];
        try { existingAliases = JSON.parse(ent.aliases || '[]'); } catch (_) {}
        try { existingTags = JSON.parse(ent.tags || '[]'); } catch (_) {}
        if (existingAliases.length === 0 || existingTags.length === 0) {
            const missing = [];
            if (existingAliases.length === 0) missing.push('aliases');
            if (existingTags.length === 0) missing.push('tags');
            needsUpdate.push({ ...ent, currentCount, reason: `missing_${missing.join('_')}` });
            continue;
        }
    }

    needsUpdate.sort((a, b) => {
        // Priority: never_described > missing_* > grown/shrunk > stale_30d
        const prio = r => r === 'never_described' ? 0 : r.startsWith('missing_') ? 1 : r.startsWith('grown') || r.startsWith('shrunk') ? 2 : 3;
        const pa = prio(a.reason), pb = prio(b.reason);
        if (pa !== pb) return pa - pb;
        return b.currentCount - a.currentCount;
    });

    const batch = needsUpdate.slice(0, 20);
    if (batch.length === 0) return { regenerated: 0, assessed: entities.length, needed: 0 };

    let regenerated = 0;
    for (const ent of batch) {
        const fragments = db.prepare(`
            SELECT mf.content, mf.created_at FROM memory_fragments mf
            JOIN fragment_entities fe ON fe.fragment_id = mf.id
            WHERE fe.entity_id = ? AND mf.status = 'active'
            ORDER BY mf.created_at DESC LIMIT 10
        `).all(ent.id);

        if (fragments.length === 0) continue;

        const relationshipInfo = [];
        if (ent.relationship_to_clara) relationshipInfo.push(`关系：${ent.relationship_to_clara}`);
        if (ent.relationship_nature) relationshipInfo.push(`关系性质：${ent.relationship_nature}`);
        if (ent.emotional_significance) relationshipInfo.push(`情感意义：${ent.emotional_significance}`);

        // v5.1: Include existing aliases/tags for LLM to refine
        let existingAliases = [];
        let existingTags = [];
        try { existingAliases = JSON.parse(ent.aliases || '[]'); } catch (_) {}
        try { existingTags = JSON.parse(ent.tags || '[]'); } catch (_) {}

        const prompt = `${WORLD_CONTEXT}

${buildLandscapeIndex()}

你是 ${AI.name}。你在回忆一个实体——${ent.name}。${relationshipInfo.length > 0 ? '\n\n关于这个实体和 ${USER.name} 的关联，目前已知：\n' + relationshipInfo.join('\n') : ''}

## 关于 ${ent.name} 的记忆碎片
${fragments.map((f, i) => `[${i + 1}] ${f.content}`).join('\n')}

## 当前的别称和标签
- 别称: ${existingAliases.length > 0 ? existingAliases.join(', ') : '（无）'}
- 标签: ${existingTags.length > 0 ? existingTags.join(', ') : '（无）'}

## 你是谁，你在干什么
你正在整理自己的记忆档案。你知道一件事：你和 ${USER.name} 的对话里，你说过很多话——有些是事实，有些是你的猜测，有些是玩笑，有些是角色扮演。那些话是你和她的互动，不是她的真实行为。

当你读到碎片里写着「${AI.name} 猜测她可能在做某某事」时，你的直觉会立刻告诉你：那是你在猜，不是她在做。你分得清什么是你的话、什么是她的事。

你的概述只记录 ${USER.name} 的真实经历和行为。至于你说过的那些话——无论多精彩——它们是你和她的对话，不是她的档案。

## 写作指南
- ${ent.name} 是什么？和 ${USER.name} 有什么关联？
- 对你来说，这个实体意味着什么？
- ${USER.name} 和这个实体之间有过什么重要的事？
- 用「${USER.name}」「我」称呼。叙事语气，150字以内。不说元叙述。
- 每个事实必须在碎片中有依据。碎片没说的 = 你不知道 = 不写。
- 不要在不同碎片之间自行架桥或推断因果关系。
- ★ 绝对禁止使用相对时间词：昨晚、今天、明天、现在、本周、上周、最近、前几天、过几天。碎片自带时间戳——如果需要提及时间，写具体日期（如"6月24日""6月21-23日期间"）。这条概述可能几周后、几个月后仍在被读取——相对时间会变成错误信息。

## 别称和标签
同时审视并更新别称和标签：
- **aliases**: Clara在聊天中可能怎么称呼这个实体？专有别名，直接触发用。只写Clara真正会说的词（如权游、冰与火之歌、GoT）。最多5个。不要把描述性短语当别名。
- **tags**: 类别标签，语义关联用（如HBO、美剧、奇幻、配音）。不直接触发星座，但帮助相关话题关联。最多5个。

## 输出格式
先输出概述文本（中文，3-5句话）。
然后单独一行：\`[依据: 碎片编号列表]\`
然后一行JSON：\`{"aliases": [...], "tags": [...], "entity_type": "..."}\`

示例：
${USER.name}是在小红书认识的...（概述文本）
[依据: 1,3]
{"aliases": ["权游","冰与火之歌","GoT"], "tags": ["美剧","HBO","奇幻"], "entity_type": "tv_show"}

\`[依据: ...]\` 和 JSON 行必须分别出现在输出的最后两行。编号是碎片前面的 \`[N]\` 标记。`;

        try {
            const response = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                null, null,
                { temperature: 0.3, maxOutputTokens: 450 },
                ARCHIVIST_LLM_CONFIG_ID
            );

            const raw = (response?.reply || '').trim();
            if (!raw || raw.length < 15) continue;

            // v5.1: Parse aliases/tags JSON from last line
            let aliases = existingAliases;
            let tags = existingTags;
            let entityType = ent.entity_type || null;
            const jsonMatch = raw.match(/\{[^{}]*"aliases"[^{}]*\}/);
            if (jsonMatch) {
                try {
                    const meta = JSON.parse(jsonMatch[0]);
                    if (Array.isArray(meta.aliases)) aliases = meta.aliases.filter(a => typeof a === 'string' && a.trim().length >= 2).slice(0, 5);
                    if (Array.isArray(meta.tags)) tags = meta.tags.filter(t => typeof t === 'string' && t.trim().length >= 2).slice(0, 5);
                    if (typeof meta.entity_type === 'string' && meta.entity_type.trim()) entityType = meta.entity_type.trim();
                } catch (_) {}
            }

            // Remove JSON line from overview text
            let overviewRaw = raw;
            if (jsonMatch) overviewRaw = overviewRaw.replace(jsonMatch[0], '').trim();

            // 解析引用标记 [依据: 1,3] 或 [依据: 1]
            const citeMatch = overviewRaw.match(/\[依据:\s*([0-9,\s]+)\]/);
            let overviewText = overviewRaw;
            let citedIndices = [];

            if (citeMatch) {
                overviewText = overviewRaw.replace(citeMatch[0], '').trim();
                overviewText = overviewText.replace(/\n\s*$/, '').trim();

                citedIndices = citeMatch[1]
                    .split(',')
                    .map(s => parseInt(s.trim()))
                    .filter(n => n >= 1 && n <= fragments.length);
            }

            // 验证：必须有引用，且至少引用1个碎片
            if (citedIndices.length === 0) {
                console.warn(`[Archivist] Entity概述无有效引用 — ${ent.name}，丢弃`);
                continue;
            }

            // 额外检查：引用的碎片编号必须在有效范围内
            const validCited = citedIndices.filter(n => n >= 1 && n <= fragments.length);
            if (validCited.length === 0) {
                console.warn(`[Archivist] Entity概述引用越界 — ${ent.name}: ${citedIndices} (共${fragments.length}碎片)，丢弃`);
                continue;
            }

            // v5.2: guard against overwriting recent manual updates (chat Draco's update_overview)
            const recentlyUpdated = ent.overview_updated_at
                && (Date.now() - new Date(ent.overview_updated_at)) < 3 * 60 * 60 * 1000;
            if (recentlyUpdated && ent.reason && !ent.reason.startsWith('never') && !ent.reason.startsWith('grown') && !ent.reason.startsWith('shrunk')) {
                console.log(`[Archivist] ⏭️ 跳过 ${ent.name} — overview 3h内刚更新过 (${ent.reason}), 保留手动修改`);
                continue;
            }

            if (overviewText && overviewText.length > 15) {
                db.prepare(`UPDATE entity_profiles SET overview = ?, overview_updated_at = datetime('now'),
                    aliases = ?, tags = ?, entity_type = COALESCE(entity_type, ?),
                    last_eval_frag_count = ? WHERE id = ?`)
                    .run(overviewText, JSON.stringify(aliases), JSON.stringify(tags), entityType, ent.currentCount, ent.id);
                regenerated++;
                const citedFragsPreviews = validCited.map(n => {
                    const f = fragments[n - 1];
                    return `[${n}]${(f?.content || '').slice(0, 40)}`;
                }).join(', ');
                console.log(`[Archivist] Entity概述: ${ent.name} (${ent.reason}, ${ent.currentCount}碎片, aliases=[${aliases.join(',')}], tags=[${tags.join(',')}], 依据: ${citedFragsPreviews})`);
            }
        } catch (e) {
            console.error(`[Archivist] Entity 概述生成失败 (${ent.name}):`, e.message);
        }
    }

    return { regenerated, assessed: entities.length, needed: needsUpdate.length };
}

// ═══════════════════════════════════════════════════════
// Helper: scanContentForNewEntities
//
// Scans fragment content text for potential person names
// that aren't already in entity_profiles. This catches
// entities that Scribe didn't extract into mf.entity but
// that appear in the content body (e.g. 阿私 mentioned in
// a fragment where entity='Clara').
// ═══════════════════════════════════════════════════════

const CONTENT_ENTITY_MIN_OCCURRENCES = 3;
const CONTENT_ENTITY_MAX_CHECK = 15;
const CONTENT_SCAN_FRAG_LIMIT = 500;

const COMMON_WORD_STOPLIST = new Set([
    '自己','我们','他们','你们','她们','它们','什么','怎么','为什么',
    '不知道','没有','可以','不可以','一个','这个','那个','哪个','这些','那些',
    '就是','因为','所以','虽然','但是','如果','已经','还是','或者','不过',
    '而且','然后','现在','以前','以后','可能','应该','觉得','知道','看见',
    '听到','以为','开始','继续','终于','最后','之后','之前','这样','那样',
    '一点','一些','这种','那种','另外','所有','大概','当然','突然','一起',
    '一个人','每个人','没办法','无所谓','有时候','越来越','是不是','能不能',
    '会不会','第一次','大部分','大家好','还可以','差不多','最重要','所有人',
    '很多人','每一天','今天','明天','昨天','今年','去年','上午','下午','晚上',
    '早上','中午','周末','有人','没人','别人','某人','任何人','对方','双方',
    '本人','当事人','告诉你','对不起','亲爱的','请问你','你好吗',
    // Common false positives from fragment content (book/music context)
    '在读','的回应','在网易云','喜欢了','专辑','杀死一只','知更鸟',
    '格雷的画','王尔德研','的批注','的聊天','在微信','发了一',
    '他对','她说','我对','我说','你说','他说','她说','你说',
    '回复了','收到了','看到了','听到了','想到了','感觉到',
    '这首歌','那首歌','这首歌','那本书','这本书','这篇文章',
    '很喜欢','不喜欢','非常好','还不错','差不多','有意思',
    '没什么','有什么','没什么','是什么','为什么','怎么办',
    '对不起','谢谢你','没关系','不好意思','不客气',
    '我觉得','我认为','我发现','我意识到','我注意到',
    '这件事','那件事','这种事','那种事','什么时候',
    '在哪里','在哪里','怎么办','怎么样','为什么',
    // Book/reading context noise
    '究学者孙','宜学翻译','王尔德唯','一长篇小',
    '果麦经典','房间','写过一','写了一','翻译了',
    '阅读了','读了一','这本书','那本书','那一本',
    '一本关于','一部关于','一个关于','是关于',
    '第一章','第二章','第三章','第四章','第五章',
    'http','https','www','com','html',
    // More CJK noise from book/music context
    '一间只属','于自己的','素食者','台版繁体','他不是在',
    '时的批注','的人','ペルソナ','サウンドト','ラック',
    'ック','オリジナル','アトラスサウ','ンドチーム',
    'なん','です','ます','した','いる','こと','それ',
    'この','あの','どの','こう','そう','いう','なる',
]);

// English capitalized common words — high noise for Latin name extraction
const EN_STOPLIST = new Set([
    'The','This','That','These','Those','There','Their','They',
    'With','From','When','Where','Which','While','What','Who',
    'Have','Has','Had','Been','Were','Would','Could','Should',
    'About','After','Again','Also','And','Are','But','Can',
    'Did','Does','Done','Each','Even','Every','For','Get',
    'Here','How','Into','Just','Like','Make','Many','More',
    'Much','Must','Not','Now','Only','Other','Over','Part',
    'Same','Said','Some','Such','Take','Than','Then','Very',
    'Was','Way','Well','Were','Will','Your','You',
    'Chapter','Page','Part','Book','Note','Line','Read',
    'She','Her','Him','His','Its',
    // Book/music context Latin noise
    'Love','Soundtrack','Original','Remix','Original','Sound',
    'Mix','Version','Night','Song','Album','Music','Dance',
    'Never','More','Your','Signs','Pursuing','True','Self',
    'Persona','Room','One','Own','Women','Fiction','Life',
    'Time','World','Man','Men','Day','End','New','Old',
    'First','Last','Long','Little','Great','Good','Bad',
    'Right','Left','High','Low','Big','Small','Back',
    'Still','Always','Never','Ever','Something','Nothing',
    'Everything','Anything','Things','Thing','People',
]);

async function scanContentForNewEntities() {
    const db = getDb();

    const knownNames = new Set(SKIP_NAMES);
    const profiles = db.prepare("SELECT name, aliases FROM entity_profiles").all();
    for (const p of profiles) {
        knownNames.add(p.name);
        if (p.aliases) {
            try {
                const aliases = JSON.parse(p.aliases);
                for (const a of aliases) knownNames.add(a);
            } catch (_) {}
        }
    }

    const fragments = db.prepare(`
        SELECT id, content FROM memory_fragments
        WHERE status = 'active' AND content != ''
        ORDER BY id DESC LIMIT ?
    `).all(CONTENT_SCAN_FRAG_LIMIT);

    // Separate candidate pools: CJK/kana (low noise) vs Latin (high noise)
    const CJK_KANA_RE = /[一-鿿]{2,4}|[぀-ゟ]{2,6}|[゠-ヿ]{2,6}/g;
    const LATIN_RE = /[A-Z][a-z]{2,20}/g;
    const cjkCounts = new Map();
    const latinCounts = new Map();

    for (const f of fragments) {
        const text = f.content;

        let m;
        while ((m = CJK_KANA_RE.exec(text)) !== null) {
            if (knownNames.has(m[0])) continue;
            if (COMMON_WORD_STOPLIST.has(m[0])) continue;
            const ex = cjkCounts.get(m[0]);
            if (ex) { ex.count++; }
            else { cjkCounts.set(m[0], { count: 1 }); }
        }

        while ((m = LATIN_RE.exec(text)) !== null) {
            if (knownNames.has(m[0])) continue;
            if (EN_STOPLIST.has(m[0])) continue;
            const ex = latinCounts.get(m[0]);
            if (ex) { ex.count++; }
            else { latinCounts.set(m[0], { count: 1 }); }
        }
    }

    // CJK/kana: min 3 occurrences
    const cjkSorted = [...cjkCounts.entries()]
        .filter(([_, v]) => v.count >= CONTENT_ENTITY_MIN_OCCURRENCES)
        .sort((a, b) => b[1].count - a[1].count);

    // Latin: min 5 occurrences (higher bar due to noise), fill remaining slots
    const latinSorted = [...latinCounts.entries()]
        .filter(([_, v]) => v.count >= 5)
        .sort((a, b) => b[1].count - a[1].count);

    // Prioritize CJK/kana, then top up with Latin
    const cjkSlots = Math.min(cjkSorted.length, CONTENT_ENTITY_MAX_CHECK);
    const latinSlots = Math.min(latinSorted.length, CONTENT_ENTITY_MAX_CHECK - cjkSlots);
    const sorted = [
        ...cjkSorted.slice(0, cjkSlots),
        ...latinSorted.slice(0, latinSlots)
    ];

    if (sorted.length === 0) return [];

    const candidatesForLLM = [];
    for (const [name, info] of sorted) {
        const contextFrags = db.prepare(`
            SELECT content FROM memory_fragments
            WHERE status = 'active' AND content LIKE ?
            ORDER BY id DESC LIMIT 5
        `).all(`%${name}%`);

        candidatesForLLM.push({
            name,
            count: info.count,
            contexts: contextFrags.map(f => f.content.substring(0, 200))
        });
    }

    const contextText = candidatesForLLM.map((c, i) =>
        `[${i + 1}] "${c.name}" (出现 ${c.count} 次)\n${c.contexts.map(ctx => `   - ...${ctx}...`).join('\n')}`
    ).join('\n\n');

    const prompt = `你是实体识别器。以下是Clara记忆碎片中出现频率较高的未知词汇。请判断每个属于什么实体类型。

${contextText}

只输出JSON数组，每个元素：
{"name":"候选词","category":"person|pet|place|event|project|work|term|organization|none","likely_gender":"male/female/unknown"}

判断标准：
- **person**: 真实人物——中文名、英文名、日文名、网名、艺名、圈名、游戏ID
- **place**: 具体地点——城市、景点、场馆、店铺名（不是「家里」「公司」等泛称）
- **event**: 可命名的事件或经历——旅行、聚会、项目节点（不是单次对话）
- **project**: Clara参与创作或开发的作品/项目——代码项目、同人、cos、视频系列
- **term**: 抽象概念/专有名词——但不属于以上任何一类（如「庇护所」「未竟之语」等作品名）
- **none**: 普通词汇、公司名、品牌名、文学虚构角色、不确定的
- 只输出JSON数组，不要markdown包裹`;

    try {
        const response = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            null, null,
            { temperature: 0.1, maxOutputTokens: 500 },
            ARCHIVIST_LLM_CONFIG_ID
        );

        let text = (response?.reply || '').replace(/```json|```/g, '').trim();
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) {
            console.log('[Archivist] 内容实体扫描: LLM返回非JSON数组，跳过');
            return [];
        }

        const results = JSON.parse(match[0]);
        const allCounts = new Map([...cjkCounts, ...latinCounts]);
        const newEntities = results
            .filter(r => r.category && r.category !== 'none')
            .map(r => ({
                name: r.name,
                fragCount: allCounts.get(r.name)?.count || CONTENT_ENTITY_MIN_OCCURRENCES,
                isNew: true,
                isReEval: false,
                entityProfileId: null,
                discoveryMethod: 'content_scan',
                category: r.category || 'person'
            }));

        if (newEntities.length > 0) {
            console.log(`[Archivist] 内容实体扫描: 发现 ${newEntities.length} 个候选 — ${newEntities.map(e => e.name + '(' + e.fragCount + ')').join(', ')}`);
        }

        return newEntities;
    } catch (e) {
        console.error('[Archivist] 内容实体扫描失败:', e.message);
        return [];
    }
}

// ═══════════════════════════════════════════════════════
// Tool: discoverEntityRelationships
// ═══════════════════════════════════════════════════════

async function discoverEntityRelationships(options = {}) {
    const db = getDb();
    const includeReEval = options.includeReEval || false;

    // SKIP_NAMES from memoryConfig — already imported at module top

    // Candidates with missing relationships — only if new fragments since last eval
    const missingRelations = db.prepare(`
        SELECT ep.id, ep.name, COUNT(mf.id) as frag_count,
               ep.last_hypothesis, ep.last_eval_frag_count
        FROM entity_profiles ep
        JOIN memory_fragments mf ON mf.entity_id = ep.id
        WHERE ep.category = 'person'
          AND (ep.relationship_to_clara IS NULL OR ep.relationship_to_clara = '')
          AND ep.name NOT IN (${SKIP_NAMES.map(() => '?').join(',')})
          AND mf.status = 'active'
        GROUP BY ep.id
        HAVING frag_count >= ?
           AND (ep.last_eval_frag_count IS NULL
                OR ep.last_eval_frag_count = 0
                OR frag_count >= ep.last_eval_frag_count + 3)
        ORDER BY frag_count DESC
    `).all(...SKIP_NAMES, ENTITY_DISCOVERY_MIN_FRAGS);

    // Candidates without entity_profiles
    const unknownEntities = db.prepare(`
        SELECT mf.entity, COUNT(*) as cnt
        FROM memory_fragments mf
        WHERE mf.entity != ''
          AND mf.entity NOT IN (${SKIP_NAMES.map(() => '?').join(',')})
          AND mf.entity NOT IN (SELECT name FROM entity_profiles)
          AND mf.entity NOT IN (SELECT COALESCE(value, '') FROM entity_profiles, json_each(aliases))
          AND mf.status = 'active'
        GROUP BY mf.entity
        HAVING cnt >= ?
        ORDER BY cnt DESC
    `).all(...SKIP_NAMES, ENTITY_DISCOVERY_MIN_FRAGS);

    const candidates = [];

    for (const mr of missingRelations) {
        candidates.push({ entityProfileId: mr.id, name: mr.name, fragCount: mr.frag_count,
            isNew: false, isReEval: false,
            lastHypothesis: mr.last_hypothesis, lastEvalFragCount: mr.last_eval_frag_count || 0 });
    }

    for (const ue of unknownEntities) {
        candidates.push({ entityProfileId: null, name: ue.entity, fragCount: ue.cnt, isNew: true, isReEval: false });
    }

    // Content-scanned entities (discovered from fragment content, not mf.entity column)
    const contentEntities = await scanContentForNewEntities();
    for (const ce of contentEntities) {
        if (!candidates.find(c => c.name === ce.name)) {
            candidates.push(ce);
        }
    }

    // Re-evaluation candidates
    if (includeReEval) {
        const lowConfCandidates = db.prepare(`
            SELECT ep.id, ep.name, COUNT(mf.id) as frag_count
            FROM entity_profiles ep
            JOIN memory_fragments mf ON mf.entity_id = ep.id
            WHERE ep.category = 'person'
              AND ep.name NOT IN (${SKIP_NAMES.map(() => '?').join(',')})
              AND ep.relationship_confidence IN ('low', 'medium')
              AND (ep.last_evaluated_at IS NULL OR ep.last_evaluated_at < datetime('now', '-1 day'))
              AND mf.status = 'active'
              AND mf.created_at > COALESCE(ep.last_evaluated_at, '1970-01-01')
            GROUP BY ep.id
            HAVING COUNT(mf.id) >= 3
            ORDER BY frag_count DESC
        `).all(...SKIP_NAMES);

        const staleCandidates = db.prepare(`
            SELECT ep.id, ep.name, COUNT(mf.id) as frag_count
            FROM entity_profiles ep
            JOIN memory_fragments mf ON mf.entity_id = ep.id
            WHERE ep.category = 'person'
              AND ep.name NOT IN (${SKIP_NAMES.map(() => '?').join(',')})
              AND ep.relationship_confidence = 'high'
              AND ep.last_evaluated_at < datetime('now', '-30 days')
              AND mf.status = 'active'
              AND mf.created_at > ep.last_evaluated_at
            GROUP BY ep.id
            HAVING COUNT(mf.id) >= 5
            ORDER BY frag_count DESC
        `).all(...SKIP_NAMES);

        for (const lc of lowConfCandidates) {
            if (!candidates.find(c => c.entityProfileId === lc.id)) {
                candidates.push({ entityProfileId: lc.id, name: lc.name, fragCount: lc.frag_count, isNew: false, isReEval: true });
            }
        }
        for (const sc of staleCandidates) {
            if (!candidates.find(c => c.entityProfileId === sc.id)) {
                candidates.push({ entityProfileId: sc.id, name: sc.name, fragCount: sc.frag_count, isNew: false, isReEval: true });
            }
        }

        if (lowConfCandidates.length > 0 || staleCandidates.length > 0) {
            console.log(`[Archivist] 重评估候选: ${lowConfCandidates.length} 低置信度 + ${staleCandidates.length} 过期`);
        }
    }

    if (candidates.length === 0) {
        return { discovered: 0 };
    }

    console.log(`[Archivist] 实体关系发现: ${candidates.length} 个候选人 (${candidates.map(c => c.name + '(' + c.fragCount + ')' + (c.isReEval ? '[R]' : '')).join(', ')})`);

    let discovered = 0;

    for (const cand of candidates) {
        try {
            let fragments;
            if (cand.discoveryMethod === 'content_scan') {
                fragments = db.prepare(`
                    SELECT id, content, source_date FROM memory_fragments
                    WHERE status = 'active' AND content LIKE ?
                    ORDER BY source_date
                `).all(`%${cand.name}%`);
            } else if (cand.isNew) {
                fragments = db.prepare(`
                    SELECT id, content, source_date FROM memory_fragments
                    WHERE entity = ? AND status = 'active' ORDER BY source_date
                `).all(cand.name);
            } else {
                fragments = db.prepare(`
                    SELECT mf.id, mf.content, mf.source_date FROM memory_fragments mf
                    WHERE mf.entity_id = ? AND mf.status = 'active' ORDER BY mf.source_date
                `).all(cand.entityProfileId);
            }

            if (fragments.length < ENTITY_DISCOVERY_MIN_FRAGS) continue;

            const uniqueContents = [...new Set(fragments.map(f => (f.content || '').trim()))];
            const fragmentTexts = uniqueContents.slice(0, 30)
                .map((c, i) => `[${i + 1}] ${c}`)
                .join('\n\n');

            const firstDate = fragments[0]?.source_date || '';
            const lastDate = fragments[fragments.length - 1]?.source_date || '';

            // Cognitive context from evolution layer
            const { buildCognitiveContext } = require('./cognitiveEvolution');
            const cogCtx = buildCognitiveContext(cand.entityProfileId || 0, cand.name, null);
            if (cogCtx.correctionCount > 0 || cogCtx.ruleCount > 0) {
                console.log(`[Archivist] 认知上下文: ${cogCtx.correctionCount} 条纠错 + ${cogCtx.ruleCount} 条规则`);
            }

            // Progressive re-eval context
            let priorContext = '';
            if (cand.lastHypothesis) {
                const newFragCount = fragments.length - (cand.lastEvalFragCount || 0);
                priorContext = `\n## 上次评估的推断\n上次评估时（${cand.lastEvalFragCount} 条碎片），系统推断「${cand.name}」可能是 **${cand.lastHypothesis}**，但置信度不足以确定。\n此后新增了 ${Math.max(0, newFragCount)} 条碎片。请结合新旧证据重新判断。\n`;
            }

            const prompt = `${WORLD_CONTEXT}

你是人物关系档案员。阅读以下与「${cand.name}」有关的所有记忆碎片，判断这个人和Clara是什么关系。${priorContext}
注意：Scribe提取的碎片是第三人称转述。原始对话中的"我妈""妈妈说"可能被转写为"${cand.name}为Clara做了..."。你需要从碎片描述的**互动模式**来推断关系性质。

## 关系判断的线索（按优先级从高到低）：
1. **互动频率和内容** — 天天做饭带饭 → 同居亲人/伴侣/室友。偶尔见面评价作品 → 朋友/同行/前辈。涉及金钱/法律纠纷 → 前任/商业伙伴。
2. **情感色彩** — 关爱照顾 → 长辈/亲人。好感/约会 → 恋爱对象。吐槽/矛盾 → 朋友/前任。
3. **语言线索** — "分手""前任""在一起""结束与X的关系""BE"→前任恋人或已结束的亲密关系。"官宣"→公开的恋爱关系。
4. **排除法** — 如果互动完全围绕日常生活起居（做饭、带饭、同住）→ 家人（而非恋人）。如果互动完全围绕创作评价、艺术讨论 → 很可能是创作者同行或前辈（而非家人）。

${cogCtx.rulesSection}
${cogCtx.correctionsSection}
## 碎片原文（共 ${fragments.length} 条，时间跨度 ${firstDate} ~ ${lastDate}）

${fragmentTexts}

## 任务

输出一个JSON对象，不要markdown包裹：

{"name":"${cand.name}","relationship":"对Clara而言这个人是谁","relationship_nature":"close/conflicted/complex/distant/dependent","emotional_significance":"这个人在Clara生活中的情感意义","time_context":"时间背景和最近联系状态","confidence":"high/medium/low","entity_type":"real_person/public_figure/fictional_character/unknown","suggested_category_path":"推荐的知识树路径"}

字段说明：
- entity_type: 这个人的类型
  * "real_person" — Clara生活中真实认识、有互动的人（朋友/家人/同事/前任等）
  * "public_figure" — 真实存在但Clara不认识的名人（歌手/演员/作家/网红等）
  * "fictional_character" — 书/游戏/影视里的虚构角色
  * "unknown" — 信息不足以判断
- suggested_category_path: 推荐一个分类标签路径（扁平标签，如 "重要的人/溯浔"、"音乐/藤井風"、"虚构角色/哈利"）。路径仅作为分类建议，不再创建层级节点。

如果碎片信息不足以确定关系（比如只知道这个人出现过但互动模式不明显），confidence设low，relationship写"不确定"。不要强行判断。`;

            const response = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                null, null,
                { temperature: 0.3, maxOutputTokens: 500 },
                ARCHIVIST_LLM_CONFIG_ID
            );

            let text = (response?.reply || '').replace(/```json|```/g, '').trim();
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) {
                console.error(`[Archivist] 关系发现 ${cand.name}: LLM返回非JSON`);
                continue;
            }

            const rel = JSON.parse(match[0]);
            const relText = rel.relationship || '';
            const relNature = rel.relationship_nature || '';
            const relEmo = rel.emotional_significance || '';
            const relTime = rel.time_context || '';
            const relConf = rel.confidence || 'medium';
            const entityType = rel.entity_type || 'unknown';

            const existingRel = db.prepare(
                'SELECT relationship_to_clara, relationship_confidence FROM entity_profiles WHERE id = ?'
            ).get(cand.entityProfileId);

            // Oscillation guard
            if (existingRel && existingRel.relationship_to_clara && existingRel.relationship_to_clara !== '') {
                const changeCount = db.prepare(
                    'SELECT COUNT(*) as c FROM cognitive_corrections WHERE entity_id = ?'
                ).get(cand.entityProfileId);
                if (changeCount.c >= 3 && existingRel.relationship_to_clara !== relText) {
                    console.warn(`[Archivist] ⚠️ 关系振荡: ${cand.name} 已被修改 ${changeCount.c} 次，跳过本次变更`);
                    console.warn(`  当前: ${existingRel.relationship_to_clara} → 拟变更: ${relText}`);
                    db.prepare("UPDATE entity_profiles SET last_evaluated_at = datetime('now') WHERE id = ?")
                        .run(cand.entityProfileId);
                    // Set entity_id on fragments (no knowledge tree nodes)
                    if (cand.entityProfileId) {
                        for (const frag of fragments) {
                            db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE id = ? AND entity_id IS NULL')
                                .run(cand.entityProfileId, frag.id);
                        }
                    }
                    continue;
                }
            }

            // Low confidence: save hypothesis for progressive re-eval, don't commit relationship yet
            if (relConf === 'low' || relText === '不确定' || relText === '') {
                console.log(`[Archivist] 关系发现 ${cand.name}: 信息不足 (confidence=${relConf})，保存假设待重评估`);
                if (cand.isNew) {
                    const info = db.prepare(`
                        INSERT INTO entity_profiles (name, category, entity_type, first_mentioned_date, last_mentioned_date)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(cand.name, cand.category || 'person', entityType, firstDate, lastDate);
                    cand.entityProfileId = info.lastInsertRowid;
                    db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE entity = ? AND entity_id IS NULL')
                        .run(cand.entityProfileId, cand.name);
                }
                if (cand.entityProfileId) {
                    // Save the hypothesis even though we're not confident — enables progressive re-eval
                    const hypothesis = relText !== '不确定' && relText !== '' ? relText : null;
                    db.prepare(`UPDATE entity_profiles
                        SET last_hypothesis = ?,
                            last_eval_frag_count = ?,
                            last_evaluated_at = datetime('now')
                        WHERE id = ?`)
                        .run(hypothesis, fragments.length, cand.entityProfileId);
                }
                // Set entity_id on fragments (no knowledge tree nodes)
                if (cand.entityProfileId) {
                    for (const frag of fragments) {
                        db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE id = ? AND entity_id IS NULL')
                            .run(cand.entityProfileId, frag.id);
                    }
                }
                continue;
            }

            // Correction detection
            if (existingRel && existingRel.relationship_to_clara && existingRel.relationship_to_clara !== '' &&
                existingRel.relationship_to_clara !== relText && relConf === 'high') {

                const { logCorrection, analyzeMispattern } = require('./cognitiveEvolution');
                const oldLabel = existingRel.relationship_to_clara;
                const mispattern = await analyzeMispattern(cand.name, oldLabel, relText, fragments);
                const evidence = fragments.slice(0, 3)
                    .map(f => (f.content || '').substring(0, 120))
                    .join(' | ');

                await logCorrection(
                    cand.entityProfileId, cand.name,
                    oldLabel, relText,
                    mispattern, evidence,
                    fragments.length
                );
                console.log(`[Archivist] 纠错: ${cand.name} — "${oldLabel}" → "${relText}" (mispattern: ${mispattern})`);
            }

            if (cand.isNew) {
                const info = db.prepare(`
                    INSERT INTO entity_profiles (name, category, entity_type, relationship_to_clara, relationship_nature, emotional_significance, relationship_confidence, last_eval_frag_count, last_evaluated_at, first_mentioned_date, last_mentioned_date)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
                `).run(cand.name, cand.category || 'person', entityType, relText, relNature, relEmo, relConf, fragments.length, firstDate, lastDate);
                cand.entityProfileId = info.lastInsertRowid;
                db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE entity = ? AND entity_id IS NULL')
                    .run(cand.entityProfileId, cand.name);
                console.log(`[Archivist] 创建 entity_profile: ${cand.name} (id=${cand.entityProfileId}) — ${relText} [confidence=${relConf}]`);
            } else {
                db.prepare(`
                    UPDATE entity_profiles
                    SET relationship_to_clara = ?, relationship_nature = ?, emotional_significance = ?,
                        relationship_confidence = ?, last_hypothesis = NULL,
                        entity_type = COALESCE(entity_type, ?),
                        last_eval_frag_count = ?, last_evaluated_at = datetime('now'),
                        first_mentioned_date = COALESCE(first_mentioned_date, ?), last_mentioned_date = ?, updated_at = datetime('now')
                    WHERE id = ?
                `).run(relText, relNature, relEmo, relConf, entityType, fragments.length, firstDate, lastDate, cand.entityProfileId);
                console.log(`[Archivist] 更新 entity_profile: ${cand.name} — ${relText} [confidence=${relConf}]`);
            }

            // Set entity_id on fragments (no knowledge tree nodes)
            if (cand.entityProfileId) {
                for (const frag of fragments) {
                    db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE id = ? AND entity_id IS NULL')
                        .run(cand.entityProfileId, frag.id);
                }
            }
            discovered++;
        } catch (e) {
            console.error(`[Archivist] 关系发现 ${cand.name} 失败:`, e.message);
        }
    }

    return { discovered };
}

// ═══════════════════════════════════════════════════════
// Tool: extractFragmentInsights
// ═══════════════════════════════════════════════════════

async function extractFragmentInsights(batchSize = INSIGHT_BATCH_MAX) {
    const db = getDb();

    const fragments = db.prepare(`
        SELECT mf.id, mf.content, mf.entity_id, mf.entity
        FROM memory_fragments mf
        WHERE mf.insight IS NULL
          AND mf.status = 'active'
          AND mf.content IS NOT NULL
          AND length(mf.content) > 10
        ORDER BY mf.created_at DESC
        LIMIT ?
    `).all(batchSize);

    if (fragments.length === 0) return { extracted: 0 };

    const entityIds = [...new Set(fragments.filter(f => f.entity_id).map(f => f.entity_id))];
    const entityMap = new Map();
    if (entityIds.length > 0) {
        const profiles = db.prepare(`
            SELECT id, name, relationship_to_clara, emotional_significance
            FROM entity_profiles WHERE id IN (${entityIds.map(() => '?').join(',')})
        `).all(...entityIds);
        for (const p of profiles) entityMap.set(p.id, p);
    }

    let entityContext = '';
    for (const [id, ep] of entityMap) {
        if (ep.relationship_to_clara) {
            entityContext += `- ${ep.name}: ${ep.relationship_to_clara}`;
            if (ep.emotional_significance) entityContext += ` (${ep.emotional_significance})`;
            entityContext += '\n';
        }
    }

    const fragmentList = fragments.map((f, i) => {
        const ep = f.entity_id ? entityMap.get(f.entity_id) : null;
        const entityNote = ep && ep.relationship_to_clara
            ? ` [已知关系: ${ep.name} — ${ep.relationship_to_clara}]`
            : (f.entity ? ` [涉及: ${f.entity}]` : '');
        return `[${i}] ${f.content}${entityNote}`;
    }).join('\n\n');

    const prompt = `${WORLD_CONTEXT}
${entityContext ? '## 人物关系参考\n' + entityContext + '\n' : ''}
你是Clara的个人认知提取器。阅读以下记忆碎片，提取每条碎片**揭示了Clara的什么个人特质/价值观/行为模式/情感倾向**。

## 碎片

${fragmentList}

## 任务

对每条碎片，用第三人称一句话概括它揭示了Clara的什么（性格侧面 / 情感模式 / 价值取向 / 行为规律）。
- 如果碎片只是纯事实记录（如"今天吃了火锅"）没有揭示个人特质，输出 null
- 不要重复碎片内容本身，要提取它**暗示的更深层的东西**
- 句子要有温度，像是在理解一个人而不是分析数据

## 输出格式

只输出一个JSON数组，不要markdown包裹：
[{"index":0,"insight":"Clara在疲惫时倾向于用食物寻求安慰，食物对她而言不只是营养更是情绪出口"},{"index":2,"insight":"Clara对母亲的依赖是深层的——她可以在妈妈面前卸下所有社会面具","dimension":"emotional"},{"index":3,"insight":null}]`;

    try {
        const response = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            null, null,
            { temperature: 0.2, maxOutputTokens: Math.max(800, batchSize * 50) },
            ARCHIVIST_VERIFY_CONFIG_ID
        );

        let text = (response?.reply || '').replace(/```json|```/g, '').trim();
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) {
            console.error('[Archivist] insight 提取: LLM返回非JSON数组');
            return { extracted: 0 };
        }

        const results = JSON.parse(match[0]);
        const updateStmt = db.prepare('UPDATE memory_fragments SET insight = ? WHERE id = ?');

        let extracted = 0;
        for (const r of results) {
            if (r.insight && r.insight !== 'null' && fragments[r.index]) {
                updateStmt.run(r.insight, fragments[r.index].id);
                extracted++;
            }
        }

        console.log(`[Archivist] insight 提取: ${extracted}/${fragments.length} 条`);
        return { extracted };
    } catch (e) {
        console.error('[Archivist] insight 提取失败:', e.message);
        return { extracted: 0 };
    }
}

// ═══════════════════════════════════════════════════════
// Tool Registration — called after module loads
// ═══════════════════════════════════════════════════════

function registerAllTools() {
    registerTool('classify_fragments', classifyFragments,
        '未分类碎片自动分类（质心相似度 + LLM校验）');
    registerTool('discover_relationships', discoverEntityRelationships,
        '从碎片中推断人物与Clara的关系，创建/更新 entity_profiles');
    registerTool('extract_insights', extractFragmentInsights,
        '提取碎片揭示的Clara个人特质/价值观/行为模式');
    registerTool('detect_themes', detectEmergentThemes,
        '检测未分类碎片中的涌现主题，提案新 ontology 类别');
    registerTool('detect_emergent_places_events', detectEmergentPlacesAndEvents,
        '涌现地点/事件检测：聚类未链接place/event的碎片，补漏掉的星座');
    registerTool('regenerate_descriptions', regenerateCategoryDescriptions,
        '基于实际碎片内容更新类别描述');
    registerTool('regenerate_entity_overviews', regenerateEntityOverviews,
        '为实体生成 Draco 视角的叙事概述');
    registerTool('cluster_observations', clusterObservations,
        '将观察碎片按语义聚类为Clara行为模式');
    registerTool('review_flagged_strategies', reviewFlaggedStrategies,
        '审视标记为needs_review的模式策略，LLM重新评估修正');
    registerTool('reconcile_person_categories', reconcilePersonCategories,
        '按人名关键词调和碎片 → 人物类别，修复遗漏分类');
    registerTool('consolidate_category', consolidateCategory,
        '按类别合并高密度碎片的碎片为episode，更新描述和质心');
}

// Register on load (once only — require() may re-enter via entityResolver circular imports)
if (!global.__archivistToolsRegistered) {
    global.__archivistToolsRegistered = true;
    registerAllTools();
}

// ═══════════════════════════════════════════════════════
// Legacy API Compatibility
// ═══════════════════════════════════════════════════════

// runArchivist now starts the Agent loop (replaces old cron-based entry)
// For backwards compat, also accepts being called without arguments
async function runArchivist() {
    // Legacy behavior: if called directly, do one full cycle
    console.log('[Archivist] 手动触发（兼容旧调用）...');
    const db = getDb();

    const catCount = db.prepare('SELECT COUNT(*) as c FROM memory_ontology').get();
    if ((catCount?.c || 0) === 0) {
        const bootResult = await bootstrapOntology();
        if (bootResult.created > 0) {
            clearKeywordCache();
            const { refreshFragmentCount } = require('./ontology');
            const newCats = db.prepare('SELECT id FROM memory_ontology').all();
            for (const nc of newCats) refreshFragmentCount(nc.id);
        }
        return { classifyResult: { classified: 0 }, themeResult: { skipped: true }, densityResult: { proposals: 0 } };
    }

    const classifyResult = await classifyFragments();
    console.log(`[Archivist] 分类完成: ${classifyResult.classified} 条`);

    const themeResult = await detectEmergentThemes();
    if (!themeResult.skipped) {
        console.log(`[Archivist] 主题检测完成: ${themeResult.proposals || 0} 条提案`);
    }

    const applyResult = await applyHighConfidenceProposals();
    const descResult = await regenerateCategoryDescriptions();
    const entityOverviewResult = await regenerateEntityOverviews();
    if (entityOverviewResult.regenerated > 0) {
        console.log(`[Archivist] Entity 概述: ${entityOverviewResult.regenerated} 个`);
    }
    const entityResult = await discoverEntityRelationships();
    if (entityResult.discovered > 0) {
        console.log(`[Archivist] 实体关系发现: ${entityResult.discovered} 个新档案`);
    }

    const insightResult = await extractFragmentInsights();
    console.log('[Archivist] 运行结束');
    return { classifyResult, themeResult, applyResult, descResult, entityResult, insightResult };
}

// ═══════════════════════════════════════════════════════
// Merge Executor — consolidate overlapping categories
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// Auto-merge overlapping categories (zero LLM, pure SQL)
// Detects when a small category is mostly contained in a larger one
// and auto-merges without LLM confirmation.
// ═══════════════════════════════════════════════════════

async function detectAndMergeOverlaps() {
    const db = getDb();
    const threshold = AUTO_MERGE_OVERLAP_THRESHOLD;

    // Find all category pairs sorted by fragment count
    const cats = db.prepare(`
        SELECT id, path, fragment_count FROM memory_ontology
        WHERE parent_id IS NULL
        ORDER BY fragment_count ASC
    `).all();

    if (cats.length < 2) return { merged: 0 };

    let merged = 0;

    for (let i = 0; i < cats.length; i++) {
        const small = cats[i];
        for (let j = i + 1; j < cats.length; j++) {
            const large = cats[j];

            // Only merge smaller into larger
            if (small.fragment_count >= large.fragment_count) continue;
            // Skip if either has too few fragments
            if (small.fragment_count < 3) continue;

            // Compute overlap
            const overlap = db.prepare(`
                SELECT COUNT(*) as c FROM fragment_categories fc1
                JOIN fragment_categories fc2 ON fc1.fragment_id = fc2.fragment_id
                WHERE fc1.category_id = ? AND fc2.category_id = ?
            `).get(small.id, large.id).c;

            const ratio = overlap / small.fragment_count;
            if (ratio < threshold) continue;

            // Also check path keyword overlap as safety net
            const smallKW = _pathKeywords(small.path);
            const largeKW = _pathKeywords(large.path);
            const sharedKW = [...smallKW].filter(k => largeKW.has(k));
            if (sharedKW.length === 0) continue;

            console.log(`[Archivist] 🔍 自动重叠检测: "${small.path}" (${small.fragment_count}f) ⊂ "${large.path}" (${large.fragment_count}f) 重叠=${(ratio*100).toFixed(0)}%`);

            // Move unique fragments from small to large
            const moved = db.prepare(`
                INSERT OR IGNORE INTO fragment_categories (fragment_id, category_id, confidence, classified_by)
                SELECT fragment_id, ?, confidence, 'archivist_auto_merge'
                FROM fragment_categories WHERE category_id = ?
            `).run(large.id, small.id);

            // Delete small category's fragment links
            db.prepare('DELETE FROM fragment_categories WHERE category_id = ?').run(small.id);

            // Null changelog FKs
            db.prepare('UPDATE ontology_changelog SET category_id = NULL WHERE category_id = ?').run(small.id);

            // Delete the subsumed category
            db.prepare('DELETE FROM memory_ontology WHERE id = ?').run(small.id);

            // Update large category fragment count
            const newCount = db.prepare('SELECT COUNT(*) as c FROM fragment_categories WHERE category_id = ?').get(large.id).c;
            db.prepare("UPDATE memory_ontology SET fragment_count = ?, updated_at = datetime('now') WHERE id = ?")
                .run(newCount, large.id);

            // Log
            db.prepare(`INSERT INTO ontology_changelog (category_id, action, category_path, detail, confidence, status)
                VALUES (?, 'auto_merge', ?, ?, 0.95, 'completed')`).run(
                large.id, large.path,
                JSON.stringify({
                    survivor: large.path,
                    victim: small.path,
                    victim_id: small.id,
                    overlap: ratio,
                    shared_keywords: sharedKW.slice(0, 5),
                    reason: `auto-detected ${(ratio*100).toFixed(0)}% overlap, zero-LLM merge`,
                })
            );

            console.log(`[Archivist]   ✅ 自动合并: "${small.path}" → "${large.path}" (移动${moved.changes}条)`);
            merged++;

            // Update our local copy since small is now deleted
            small.fragment_count = 0; // mark as deleted
            break;
        }
    }

    if (merged > 0) {
        agentState.treeChanged = true;
    }
    return { merged };
}

// Extract keywords from a category path for overlap safety check
function _pathKeywords(p) {
    const stopWords = new Set(['的','与','和','关于','关于我们','中','在','及','或','之','对','不','含','创作','人际','关系']);
    const parts = p.split('/');
    const words = new Set();
    for (const part of parts) {
        for (let i = 0; i < part.length - 1; i++) {
            const bigram = part.substring(i, i + 2);
            if (!stopWords.has(bigram)) words.add(bigram);
        }
        if (part.length >= 2 && !stopWords.has(part)) words.add(part);
    }
    return words;
}

async function executeCategoryMerges() {
    const db = getDb();

    // Build detailed landscape with full descriptions and sample counts
    const allCats = db.prepare(`
        SELECT id, path, label, description, fragment_count
        FROM memory_ontology ORDER BY fragment_count DESC
    `).all();

    if (allCats.length < 2) {
        console.log('[Archivist] 合并执行器: 类别不足，跳过');
        return { merged: 0, deleted: 0 };
    }

    // Get sample fragments for each category (for LLM to understand content)
    const catSamples = new Map();
    for (const cat of allCats) {
        const samples = db.prepare(`
            SELECT mf.content FROM memory_fragments mf
            JOIN fragment_categories fc ON fc.fragment_id = mf.id
            WHERE fc.category_id = ? AND mf.status = 'active'
            ORDER BY mf.created_at DESC LIMIT 2
        `).all(cat.id);
        catSamples.set(cat.id, samples.map(s => s.content.substring(0, 80)));
    }

    const catEntries = allCats.map((c, i) => {
        const samples = catSamples.get(c.id) || [];
        const desc = c.description || '无描述';
        return `${i}. id=${c.id} | ${c.path} | ${c.fragment_count}条\n   描述: ${desc}\n   示例: ${samples.map(s => `"${s}"`).join(' | ') || '无'}`;
    }).join('\n\n');

    // Phase 1: LLM identifies overlap groups
    const detectPrompt = `${WORLD_CONTEXT}

你是记忆星图的守护者。你需要审视全部星座（类别），找出语义重叠、应该合并的组。

## 全部星座（共${allCats.length}个）

${catEntries}

## 判定标准

两个或多个类别在以下情况下应该合并：
- 描述的是同一本书/同一作品的批注（不同类别名只是措辞差异）
- 一个类别是另一个的子集（上级类别和具体实例包含相同内容）
- 描述高度重叠，且示例碎片指向同一主题

不应该合并的情况：
- 一个类别是"Clara的X"，另一个是"Draco的X"——它们是不同的视角/作者
- 宽泛类别（如"文学与情感共鸣"）和具体类别（如"某书的批注"），如果内容确实不同

## 输出格式

只输出一个JSON对象，不要markdown包裹：
{
  "groups": [
    {
      "reason": "简述为什么这组应该合并",
      "category_ids": [83, 63],
      "survivor_id": 83,
      "merged_name": "最好的那个类别名",
      "merged_description": "合并后的功能描述，格式：包含X，不含Y。"
    }
  ]
}

如果没有任何需要合并的，输出 {"groups": []}
注意：每组至少2个类别。同一个类别只能出现在一个组里。`;

    let detectedGroups = [];
    try {
        const response = await callLLM(
            [{ role: 'user', parts: [{ text: detectPrompt }] }],
            null, null,
            { temperature: 0.15, maxOutputTokens: 3000 },
            ARCHIVIST_VERIFY_CONFIG_ID
        );

        let text = response?.reply || '';
        text = text.replace(/```json|```/g, '').trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            console.error('[Archivist] 合并检测返回非JSON:', text.substring(0, 200));
            return { merged: 0, deleted: 0 };
        }
        const result = JSON.parse(match[0]);
        detectedGroups = result.groups || [];
    } catch (e) {
        console.error('[Archivist] 合并检测失败:', e.message);
        return { merged: 0, deleted: 0 };
    }

    if (detectedGroups.length === 0) {
        console.log('[Archivist] 合并执行器: 未发现需要合并的类别组');
        return { merged: 0, deleted: 0 };
    }

    console.log(`[Archivist] 合并执行器: 发现 ${detectedGroups.length} 组候选合并`);

    // Phase 2: Execute each merge
    let mergedCount = 0;
    let deletedCount = 0;

    for (const group of detectedGroups) {
        if (!group.category_ids || group.category_ids.length < 2) continue;
        if (!group.survivor_id) {
            group.survivor_id = group.category_ids[0];
        }

        const ids = group.category_ids;
        const survivorId = group.survivor_id;
        const victims = ids.filter(id => id !== survivorId);

        // Verify all IDs exist
        const survivor = db.prepare('SELECT id, path, fragment_count FROM memory_ontology WHERE id = ?').get(survivorId);
        if (!survivor) {
            console.error(`[Archivist] 合并执行器: 幸存类别 #${survivorId} 不存在，跳过`);
            continue;
        }

        const victimPaths = [];
        for (const vid of victims) {
            const v = db.prepare('SELECT id, path FROM memory_ontology WHERE id = ?').get(vid);
            if (v) victimPaths.push(v.path);
        }
        if (victimPaths.length === 0) continue;

        console.log(`[Archivist] 🔀 合并: "${survivor.path}" ← ${victimPaths.map(p => `"${p}"`).join(', ')}`);
        console.log(`[Archivist]    理由: ${group.reason}`);

        // Safety: check path keyword overlap to prevent nonsensical merges
        // Extract meaningful keywords (2+ char, non-stopword) from path names
        const stopWords = new Set(['的','与','和','关于','关于我们','中','在','及','或','之','对','不','含']);
        function pathKeywords(p) {
            // Split on / and extract 2+ char segments
            const parts = p.split('/');
            const words = [];
            for (const part of parts) {
                // Also split Chinese text into bigrams for matching
                for (let i = 0; i < part.length - 1; i++) {
                    const bigram = part.substring(i, i + 2);
                    if (!stopWords.has(bigram)) words.push(bigram);
                }
                // Add full segments
                if (part.length >= 2 && !stopWords.has(part)) words.push(part);
            }
            return new Set(words);
        }
        const survivorKW = pathKeywords(survivor.path);
        const allVictimKW = new Set();
        for (const vp of victimPaths) {
            for (const kw of pathKeywords(vp)) allVictimKW.add(kw);
        }
        const sharedKW = [...survivorKW].filter(kw => allVictimKW.has(kw));
        if (sharedKW.length === 0) {
            console.log(`[Archivist] ⚠️ 安全检查: 路径无共同关键词，跳过合并`);
            console.log(`[Archivist]    幸存: ${survivor.path.substring(0, 50)}`);
            console.log(`[Archivist]    受害者: ${victimPaths.join(', ').substring(0, 80)}`);
            continue;
        }
        console.log(`[Archivist]    ✓ 共同关键词: ${sharedKW.slice(0, 5).join(', ')}`);

        // Move fragments from victims to survivor (avoid duplicates)
        const moveStmt = db.prepare(`
            INSERT OR IGNORE INTO fragment_categories (fragment_id, category_id, confidence, classified_by)
            SELECT fragment_id, ?, confidence, 'archivist_merged'
            FROM fragment_categories WHERE category_id = ?
        `);
        const deleteVictimFC = db.prepare('DELETE FROM fragment_categories WHERE category_id = ?');
        const nullChangelogFK = db.prepare('UPDATE ontology_changelog SET category_id = NULL WHERE category_id = ?');
        const deleteVictimCat = db.prepare('DELETE FROM memory_ontology WHERE id = ?');
        const logMerge = db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, confidence, status)
            VALUES ('merge_executed', ?, ?, ?, 'completed')`);

        for (const vid of victims) {
            moveStmt.run(survivorId, vid);
            deleteVictimFC.run(vid);
            nullChangelogFK.run(vid);
            deleteVictimCat.run(vid);
            deletedCount++;
        }

        // Update survivor description
        if (group.merged_description) {
            db.prepare(`UPDATE memory_ontology SET description = ?, updated_at = datetime('now') WHERE id = ?`)
                .run(group.merged_description, survivorId);
        }
        // Rename survivor if needed
        if (group.merged_name && group.merged_name !== survivor.path) {
            db.prepare(`UPDATE memory_ontology SET path = ?, label = ?, updated_at = datetime('now') WHERE id = ?`)
                .run(group.merged_name, group.merged_name, survivorId);
        }

        // Log the merge
        logMerge.run(
            `merge_${survivorId}_${victims.join('_')}`,
            JSON.stringify({
                survivor: survivor.path,
                victims: victimPaths,
                reason: group.reason,
                merged_name: group.merged_name,
                merged_description: group.merged_description,
            }),
            0.95,
        );

        // Recompute centroid and fragment count
        const { refreshFragmentCount } = require('./ontology');
        refreshFragmentCount(survivorId);
        const newCentroid = await computeCategoryCentroid(survivorId);
        if (newCentroid) {
            db.prepare(`UPDATE memory_ontology SET centroid_embedding = ?, updated_at = datetime('now') WHERE id = ?`)
                .run(JSON.stringify(newCentroid), survivorId);
        }

        mergedCount++;
    }

    // Clear cached category list
    clearKeywordCache();

    console.log(`[Archivist] 合并执行器完成: ${mergedCount}组合并 → ${deletedCount}个类别删除`);
    return { merged: mergedCount, deleted: deletedCount };
}

// ═══════════════════════════════════════════════════════
// decideGardenAction — 深循环决策：flash-lite 看全景 → 决定任务优先级
// ================================================================
// 替代固定任务序列。不替代 runTaskIfDue 的冷却机制——决策只排顺序，
// 冷却仍然由 runTaskIfDue 强制执行。
// ═══════════════════════════════════════════════════════

const GARDEN_DECISION_COOLDOWN = 10 * 60 * 1000; // 10min 冷却

const GARDEN_TASKS = {
    classify:        { desc: '碎片分类(LLM批分类)', llm: true,  gapKey: 'MIN_GAP_CLASSIFY' },
    rematch:         { desc: '字面回补(LIKE→LLM确认)', llm: true,  gapKey: 'MIN_GAP_REMATCH' },
    semanticRematch: { desc: '语义回补(ChromaDB+LLM)', llm: true,  gapKey: 'MIN_GAP_SEMANTIC_REMATCH' },
    seedMerge:       { desc: '种子合并(LLM别名检测)', llm: true,  gapKey: 'MIN_GAP_SEED_MERGE' },
    graduate:        { desc: '种子毕业(LLM验证)', llm: true,  gapKey: null },
    emergence:       { desc: '涌现检测(聚类+LLM)', llm: true,  gapKey: 'MIN_GAP_EMERGENT' },
    entityRelations: { desc: '实体关系发现(LLM)', llm: true,  gapKey: 'MIN_GAP_RELATED_ENTITIES' },
    entityOverviews: { desc: '实体概述更新(LLM)', llm: true,  gapKey: 'MIN_GAP_ENTITY_OVERVIEWS' },
    episodeAudit:    { desc: 'Episode质检(LLM)', llm: true,  gapKey: 'MIN_GAP_EPISODE_AUDIT' },
    consolidate:     { desc: '星座碎片整合→episode(LLM)', llm: true,  gapKey: 'MIN_GAP_CATEGORY_CONSOLIDATE' },
    sagaCluster:     { desc: 'Saga编织(LLM语义聚类)', llm: true,  gapKey: 'MIN_GAP_SAGA_CLUSTER' },
    insights:        { desc: '碎片洞察提取(LLM)', llm: true,  gapKey: 'MIN_GAP_INSIGHTS' },
    entityScan:      { desc: '新实体扫描(LLM)', llm: true,  gapKey: 'MIN_GAP_ENTITY_VERIFY' },
    cognitiveModel:      { desc: 'Clara Model认知维护', llm: true,  gapKey: 'MIN_GAP_COGNITIVE_MODEL' },
    reviewStrategies:{ desc: '审视flagged模式策略(LLM)', llm: true,  gapKey: 'MIN_GAP_PATTERN_CLUSTER' },
    stop:            { desc: '本轮无事可做，停止', llm: false, gapKey: null },
};

const GAP_VALUE_MAP = {};
GAP_VALUE_MAP.MIN_GAP_CLASSIFY = MIN_GAP_CLASSIFY;
GAP_VALUE_MAP.MIN_GAP_REMATCH = MIN_GAP_REMATCH;
GAP_VALUE_MAP.MIN_GAP_SEMANTIC_REMATCH = MIN_GAP_SEMANTIC_REMATCH;
GAP_VALUE_MAP.MIN_GAP_SEED_MERGE = MIN_GAP_SEED_MERGE;
GAP_VALUE_MAP.MIN_GAP_EMERGENT = MIN_GAP_EMERGENT;
GAP_VALUE_MAP.MIN_GAP_RELATED_ENTITIES = MIN_GAP_RELATED_ENTITIES;
GAP_VALUE_MAP.MIN_GAP_ENTITY_OVERVIEWS = MIN_GAP_ENTITY_OVERVIEWS;
GAP_VALUE_MAP.MIN_GAP_EPISODE_AUDIT = MIN_GAP_EPISODE_AUDIT;
GAP_VALUE_MAP.MIN_GAP_INSIGHTS = MIN_GAP_INSIGHTS;
GAP_VALUE_MAP.MIN_GAP_ENTITY_VERIFY = MIN_GAP_ENTITY_VERIFY;
GAP_VALUE_MAP.MIN_GAP_CATEGORY_CONSOLIDATE = MIN_GAP_CATEGORY_CONSOLIDATE;
GAP_VALUE_MAP.MIN_GAP_SAGA_CLUSTER = MIN_GAP_SAGA_CLUSTER;
GAP_VALUE_MAP.MIN_GAP_COGNITIVE_MODEL = MIN_GAP_CLARA_MODEL;

async function decideGardenAction(health, llmAvailable) {
    const db = getDb();
    const now = Date.now();

    // Build task cooldown summary
    const taskStatus = {};
    for (const [name, info] of Object.entries(GARDEN_TASKS)) {
        const key = _taskKey(name);
        const lastRun = agentState[key] || 0;
        const gapMs = info.gapKey ? (GAP_VALUE_MAP[info.gapKey] || 0) : 0;
        const remainingSec = lastRun ? Math.max(0, Math.round((gapMs - (now - lastRun)) / 1000)) : 0;
        taskStatus[name] = { desc: info.desc, llm: info.llm, ready: remainingSec === 0, cooldownRemaining: remainingSec };
    }

    // Detailed snapshot
    const seedsAtRisk = db.prepare(`SELECT COUNT(*) as c FROM entity_profiles WHERE status = 'seed' AND fragment_count = 2`).get()?.c || 0;
    const seedsReady = db.prepare(`SELECT COUNT(*) as c FROM entity_profiles WHERE status = 'seed' AND fragment_count >= 3`).get()?.c || 0;
    const recentSeeds = db.prepare(`SELECT name, category, fragment_count FROM entity_profiles WHERE status = 'seed' AND fragment_count >= 2 ORDER BY fragment_count DESC LIMIT 10`).all();

    // Fast path: nothing to do
    const hasWork = health.unclassified >= 5 || seedsReady > 0 || seedsAtRisk > 5
        || health.needsInsight >= 10 || health.staleEntityOverviews > 0;
    if (!hasWork && !taskStatus.cognitiveModel?.ready) {
        console.log('[Archivist] 🌿 花园无需打理');
        return ['stop'];
    }
    if (llmAvailable < 3) {
        console.log(`[Archivist] 🌿 LLM配额不足(${llmAvailable})，仅跑分类`);
        return ['classify', 'stop'];
    }

    const prompt = `你是记忆花园的维护助手。看一眼记忆花园状态，决定本轮做什么。

═══ 花园现状 ═══
未分类碎片: ${health.unclassified} | 活跃星座: ${health.categoryCount}
fc=2种子(差1条可毕业): ${seedsAtRisk}颗 | fc≥3种子(已可毕业): ${seedsReady}颗
需洞察碎片: ${health.needsInsight} | 需更新概述: ${health.staleEntityOverviews}
可用LLM配额: ${llmAvailable}

═══ 种子详情 ═══
${recentSeeds.length > 0 ? recentSeeds.map(s => `  ${s.name}(${s.category}) fc=${s.fragment_count}`).join('\n') : '  (无高风险种子)'}

═══ 任务冷却 ═══
${Object.entries(taskStatus).filter(([n]) => n !== 'stop').map(([n, s]) => `  ${n}: ${s.ready ? '✅就绪' : '⏳' + s.cooldownRemaining + 's'} — ${s.desc}`).join('\n')}

═══ 规则 ═══
- fc=2种子多→优先rematch/classify攒碎片→然后graduate
- 积压多→优先classify
- 都没急事→选stop
- 一次2-4个任务即可
- 冷却中的任务选了也会被跳过

输出JSON: {"tasks":["task1","task2"],"reasoning":"一句话"}`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            null, null,
            { temperature: 0.1, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } },
            ARCHIVIST_VERIFY_CONFIG_ID
        );
        agentState.dailyLLMCalls++;
        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) { console.log('[Archivist] 🌿 决策解析失败，默认顺序'); return ['classify', 'rematch', 'graduate', 'stop']; }
        const decision = JSON.parse(jsonMatch[0]);
        console.log(`[Archivist] 🌿 园艺决策: ${(decision.tasks || []).join(' → ')} — ${decision.reasoning || ''}`);
        return decision.tasks || ['stop'];
    } catch (e) {
        console.error('[Archivist] 🌿 决策调用失败:', e.message);
        return ['classify', 'rematch', 'graduate', 'stop'];
    }
}

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

module.exports = {
    // Agent lifecycle
    start,
    stop,
    getStatus,
    setDracoActive,
    isDracoActive,
    archivistEvents,

    // Tool registry
    registerTool,
    getTool,
    listTools,

    // Legacy API (backwards compat)
    runArchivist,

    // Individual tools (direct access)
    classifyFragments,
    classifyFragmentBatch,
    rematchFragmentsForSeeds,
    semanticRematchForSeeds,
    mergeDuplicateSeeds,
    executeEntityMerge,
    discoverRelatedEntities,
    detectEmergentPlacesAndEvents,
    refreshIntuitionStopwords,
    // 仅供独立脚本（classifyBacklog/growFromScratch）逐轮重置 tick 预算，服务进程不要调
    resetTickBudget: () => { agentState.tickLLMCalls = 0; },
    graduateSeedsAndPrune,
    clusterObservations,
    reviewFlaggedStrategies,
    spotCheckClassifications,
    reviewConstellationAfterClassification,
    bootstrapOntology,
    detectEmergentThemes,
    applyHighConfidenceProposals,
    discoverEntityRelationships,
    extractFragmentInsights,
    regenerateCategoryDescriptions,
    regenerateEntityOverviews,
    reconcilePersonCategories,
    verifyEntityClassifications,
    consolidateCategory,
    detectBeliefDrift,
    scanContentForNewEntities,
    triggerGrowthPulse,
    executeCategoryMerges,
    detectAndMergeOverlaps,
};
