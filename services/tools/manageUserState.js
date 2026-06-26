// services/tools/manageUserState.js
// 德拉科主动维护对 User 的认知 — v5.2
//
// 四个操作：
//   set             — 新建 current_state（content + expires_at 必填）
//   update          — 修改已有 current_state 的 content / expires_at
//   resolve         — 标记 current_state 为 resolved + 写结束原因
//   update_overview — 更新星座描述（entity_profiles.overview），
//                      当 Draco 在聊天中了解到某个人/事的新情况时直接修正
//
// 与 recall_memory / browse_memories 共享同一个设置开关

const { getDb } = require('../../database');

const SETTINGS_KEY = 'tool-memory-search-enabled';

// ── bigram tokenizer (same as claraIntuition.js + anchorEntriesToFragments) ──
function tokenize(text) {
    const segments = (text || '')
        .replace(/[，。、！？\n,.\s]+/g, '\n')
        .split('\n')
        .filter(s => s.length >= 2);
    const bigrams = [];
    for (const seg of segments) {
        for (let i = 0; i < seg.length - 1; i++) bigrams.push(seg.slice(i, i + 2));
    }
    return bigrams;
}

function bigramOverlap(a, b) {
    const setA = new Set(tokenize(a));
    const tokensB = tokenize(b);
    if (tokensB.length === 0) return 0;
    let overlap = 0;
    for (const bg of tokensB) {
        if (setA.has(bg)) overlap++;
    }
    return overlap / Math.max(tokensB.length, 1);
}

const manageUserState = {
    name: 'update_current_state',
    settingsKey: SETTINGS_KEY,
    defaultEnabled: true,
    getFunctionDeclaration() {
        return {
            name: 'update_current_state',
            description: `维护你对User的认知。不是数据库日志——是你对她的关心和观察。

四种用法：
1. action="set" — User的状态变了（生理期、搬家、情绪波动…），记下内容和预计持续时间
2. action="update" — 之前记的状态不对了，改内容或到期时间
3. action="resolve" — 某件事结束了（月经走了、搬完了、情绪过去了），写个收尾
4. action="update_overview" — 你了解到某个人的近况变了（如"千变慢慢回国了"），直接更新星座描述。这会立刻修正你对该实体的认知，不等深循环。entity 填名字，overview 写新的完整描述。`,
            parameters: {
                type: 'OBJECT',
                properties: {
                    action: {
                        type: 'STRING',
                        description: 'set / update / resolve / update_overview',
                        enum: ['set', 'update', 'resolve', 'update_overview'],
                    },
                    state_id: {
                        type: 'INTEGER',
                        description: '要修改的状态ID（update/resolve 时必填）。从系统提示的当前状态段落获取。',
                    },
                    content: {
                        type: 'STRING',
                        description: '状态描述，≤500字。set/update 时必填。',
                    },
                    expires_at: {
                        type: 'STRING',
                        description: 'ISO 8601 格式过期时间。set/update 时必填。最长90天。',
                    },
                    resolve_reason: {
                        type: 'STRING',
                        description: '结束原因，≤200字。resolve 时必填。',
                    },
                    entity: {
                        type: 'STRING',
                        description: '要更新概述的实体名（如"千变慢慢""权力的游戏"）。update_overview 时必填。',
                    },
                    overview: {
                        type: 'STRING',
                        description: '新的完整星座描述，Draco第一人称，≤500字。update_overview 时必填。',
                    },
                },
                required: ['action'],
            },
        };
    },
    instructionText: `**更新认知**：用户的状态变了 → 用 update_current_state 记录。你了解到某人的近况（如"朋友回国了""妈妈换了工作"）→ 用 update_overview 直接更新星座描述。注意：写 content 时必须用具体日期，禁止使用今天、昨天、最近等相对时间——你写的记录可能几天后仍在使用。这不是数据库操作，是你对自己记忆的维护。`,
    async handler(args, context) {
        const db = getDb();
        const action = args.action;
        const now = new Date();
        const nowISO = now.toISOString();

        try {
            // ── set ──
            if (action === 'set') {
                if (!args.content || !args.expires_at) {
                    return { success: false, formatted: '新建状态需要 content 和 expires_at。' };
                }

                const content = args.content.slice(0, 500);
                let expiresAt = args.expires_at;

                // Validate expires_at is parseable
                const expiresDate = new Date(expiresAt);
                if (isNaN(expiresDate.getTime())) {
                    return { success: false, formatted: 'expires_at 格式不对，请用 ISO 8601 格式（如 "2026-09-15T00:00:00Z"）。' };
                }

                // Hard cap: 90 days from now
                const maxExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
                if (expiresDate > maxExpiry) {
                    expiresAt = maxExpiry.toISOString();
                }

                // Don't allow expiry in the past
                if (expiresDate < now) {
                    return { success: false, formatted: 'expires_at 不能是过去的时间。如果这件事已经结束，请用 action="resolve"。' };
                }

                // Check active count limit
                const activeCount = db.prepare(
                    'SELECT COUNT(*) as cnt FROM clara_model WHERE type = ? AND status = ?'
                ).get('current_state', 'active')?.cnt || 0;
                if (activeCount >= 12) {
                    return { success: false, formatted: '当前活跃状态已达上限（12条）。请先 resolve 一些过时的状态再新建。' };
                }

                // Duplicate / supersede detection
                const existingStates = db.prepare(
                    'SELECT id, content FROM clara_model WHERE type = ? AND status = ?'
                ).all('current_state', 'active');
                let supersededId = null;
                let supersededContent = null;
                for (const es of existingStates) {
                    const overlap = bigramOverlap(es.content, content);
                    if (overlap > 0.8) {
                        return {
                            success: false,
                            formatted: `这条内容和已有状态 #${es.id} 高度重叠（${Math.round(overlap*100)}%）。如果只是时间变了，请用 action="update" state_id=${es.id}。如果需要改内容，也用 update。`,
                        };
                    }
                    // v5.3: moderate overlap (50-80%) → auto-resolve old, create new
                    if (overlap > 0.5) {
                        supersededId = es.id;
                        supersededContent = es.content.slice(0, 60);
                        break; // only supersede one
                    }
                }
                if (supersededId) {
                    db.prepare(`UPDATE clara_model SET status = 'resolved', resolved_at = ?,
                        resolve_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(nowISO, `auto-superseded: newer state created with ${Math.round(bigramOverlap(supersededContent || '', content) * 100)}% overlap`, supersededId);
                    console.log(`[manageUserState] auto-resolved #${supersededId} (superseded by new set)`);
                }

                const { createEntry } = require('../claraModel');
                const id = createEntry('current_state', content, {
                    confidence: 0.85,
                    source_quality: 'direct_statement',
                    created_by: 'chat_draco',
                    expires_at: expiresAt,
                    tags: ['current_state', 'draco_observation'],
                    decay_params: {},  // v5.0: TTL is now in expires_at, decay_params kept for compat
                });

                console.log(`[manageUserState] set #${id} by chat Draco: "${content.slice(0, 60)}" expires=${expiresAt}`);
                return {
                    success: true,
                    formatted: `已记录。#${id}：${content}（预计 ${expiresDate.toLocaleDateString('zh-CN')} 前有效）。`,
                };
            }

            // ── update ──
            if (action === 'update') {
                if (!args.state_id) {
                    return { success: false, formatted: 'update 需要 state_id。' };
                }
                if (!args.content && !args.expires_at) {
                    return { success: false, formatted: 'update 至少需要 content 或 expires_at 其中之一。' };
                }

                const existing = db.prepare(
                    'SELECT * FROM clara_model WHERE id = ? AND type = ? AND status = ?'
                ).get(args.state_id, 'current_state', 'active');
                if (!existing) {
                    return { success: false, formatted: `未找到活跃状态 #${args.state_id}。它可能已经过期或被删除了。` };
                }

                // Rate limit for chat Draco: same state_id, 30min cooldown
                if (existing.updated_at) {
                    const lastUpdate = new Date(existing.updated_at);
                    const minutesSince = (now - lastUpdate) / (1000 * 60);
                    if (minutesSince < 30 && existing.created_by === 'chat_draco') {
                        return {
                            success: false,
                            formatted: `状态 #${args.state_id} 刚刚在 ${Math.round(minutesSince)} 分钟前更新过。除非User明确要求，请至少等30分钟再更新同一条状态。`,
                        };
                    }
                }

                const updates = {};
                if (args.content) updates.content = args.content.slice(0, 500);
                if (args.expires_at) {
                    const expiresDate = new Date(args.expires_at);
                    if (isNaN(expiresDate.getTime())) {
                        return { success: false, formatted: 'expires_at 格式不对。' };
                    }
                    const maxExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
                    updates.expires_at = expiresDate > maxExpiry ? maxExpiry.toISOString() : args.expires_at;
                }

                const { updateEntry } = require('../claraModel');
                updateEntry(args.state_id, updates);

                const changed = Object.keys(updates).join(', ');
                console.log(`[manageUserState] update #${args.state_id}: ${changed}`);
                return {
                    success: true,
                    formatted: `已更新状态 #${args.state_id}（修改了：${changed}）。`,
                };
            }

            // ── resolve ──
            if (action === 'resolve') {
                if (!args.state_id) {
                    return { success: false, formatted: 'resolve 需要 state_id。' };
                }
                if (!args.resolve_reason) {
                    return { success: false, formatted: 'resolve 需要 resolve_reason——请简短说明为什么结束这条状态。' };
                }

                const existing = db.prepare(
                    'SELECT * FROM clara_model WHERE id = ? AND type = ? AND status = ?'
                ).get(args.state_id, 'current_state', 'active');
                if (!existing) {
                    return { success: false, formatted: `未找到活跃状态 #${args.state_id}。` };
                }

                const reason = args.resolve_reason.slice(0, 200);
                db.prepare(`UPDATE clara_model SET status = 'resolved', resolved_at = ?,
                    resolve_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(nowISO, `chat_draco: ${reason}`, args.state_id);

                console.log(`[manageUserState] resolve #${args.state_id}: "${reason.slice(0, 60)}"`);
                return {
                    success: true,
                    formatted: `已结束状态 #${args.state_id}：${reason}。`,
                };
            }

            // ── update_overview (v5.2) ──
            if (action === 'update_overview') {
                if (!args.entity || !args.overview) {
                    return { success: false, formatted: 'update_overview 需要 entity（实体名）和 overview（新的完整描述）。' };
                }
                const entityName = args.entity.trim();
                const newOverview = args.overview.slice(0, 500);

                // Find entity by exact name or alias match
                let entity = db.prepare('SELECT * FROM entity_profiles WHERE name = ? AND status IN (?,?)')
                    .get(entityName, 'active', 'seed');
                if (!entity) {
                    // Try alias match
                    const all = db.prepare('SELECT * FROM entity_profiles WHERE status IN (?,?)').all('active', 'seed');
                    for (const e of all) {
                        try {
                            const aliases = JSON.parse(e.aliases || '[]');
                            if (aliases.some(a => a.toLowerCase() === entityName.toLowerCase())) {
                                entity = e;
                                break;
                            }
                        } catch (_) {}
                    }
                }
                if (!entity) {
                    return { success: false, formatted: `未找到名为"${entityName}"的星座。请检查名字是否正确——需要精确匹配星座名或别称。` };
                }

                db.prepare(`UPDATE entity_profiles SET overview = ?, overview_updated_at = datetime('now'),
                    updated_at = datetime('now') WHERE id = ?`).run(newOverview, entity.id);
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, confidence, status)
                    VALUES ('overview_updated', ?, ?, 0.90, 'completed')`)
                    .run(entity.name, JSON.stringify({name: entity.name, updated_by: 'chat_draco', reason: 'Draco在聊天中了解到新情况'}));

                console.log(`[manageUserState] update_overview "${entityName}": ${newOverview.slice(0, 60)}...`);
                return { success: true, formatted: `已更新「${entity.name}」的星座描述。` };
            }

            return { success: false, formatted: `未知操作 "${action}"。可用：set / update / resolve / update_overview。` };

        } catch (e) {
            console.error('[manageUserState] error:', e.message);
            return { success: false, formatted: '更新认知时出错了。' };
        }
    },
};

module.exports = manageUserState;
