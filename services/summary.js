// =================================================================
// 对话自动总结生成
// =================================================================

const { get_encoding } = require('tiktoken');
const { encryption } = require('../encryption');
const { callLLM } = require('./llm');
const { getDb } = require('../database');
const { fillPrompt, USER, AI } = require('./nameResolver');

const enc = get_encoding('cl100k_base');

/**
 * 生成对话总结
 * @param {number} chatId - 聊天室ID
 * @param {number} startMessageId - 起始消息ID（可选）
 * @param {number} endMessageId - 结束消息ID（可选）
 * @returns {Promise<object>} { success, summary, roundStart, roundEnd, tokenCount }
 */
async function generateChatSummary(chatId, startMessageId = null, endMessageId = null) {
    try {
        const db = getDb();
        
        // 1. 确定总结范围
        if (!startMessageId) {
            const chatInfo = db.prepare('SELECT last_summary_message_id FROM chats WHERE id = ?').get(chatId);
            startMessageId = chatInfo.last_summary_message_id || 0;
        }        
        
        if (!endMessageId) {
            const latestMsg = db.prepare('SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId);
            endMessageId = latestMsg?.id || 0;
        }
        
        if (startMessageId >= endMessageId) {
            return { success: false, message: '没有新消息需要总结' };
        }
        
        // 2. 读取需要总结的消息
        const messages = db.prepare(`
            SELECT id, sender, content, is_encrypted, timestamp, message_type
            FROM messages
            WHERE chat_id = ? AND id > ? AND id <= ?
            ORDER BY id ASC
        `).all(chatId, startMessageId, endMessageId);
        
        if (messages.length === 0) {
            return { success: false, message: '没有找到需要总结的消息' };
        }
        
        // 3. 解密并格式化消息（Clara完整保留，Draco截断到300字——提供足够上下文判断猜测+纠正）
        let conversationText = '';
        let roundCount = 0;
        const firstTimestamp = messages[0].timestamp;
        const lastTimestamp = messages[messages.length - 1].timestamp;

        // 辅助函数：提取消息文本
        const extractText = (msg) => {
            let content = msg.is_encrypted === 1 ? encryption.decrypt(msg.content) : msg.content;
            try {
                const parsed = JSON.parse(content);
                if (parsed.components && Array.isArray(parsed.components)) {
                    const textParts = parsed.components
                        .filter(c => c.type === 'text')
                        .map(c => c.content);
                    const repostParts = parsed.components
                        .filter(c => c.type === 'snitch_repost')
                        .map(c => {
                            let text = `【转发Snitch动态】${c.title || ''}`;
                            if (c.tag) text += ` [${c.tag}]`;
                            if (c.body) text += `\n${c.body}`;
                            if (c.source_url) text += `\n原文链接: ${c.source_url}`;
                            return text;
                        });
                    return [...textParts, ...repostParts].join('\n');
                }
                return content;
            } catch (e) {
                return content;
            }
        };

        for (const msg of messages) {
            if (msg.sender === 'draco') {
                roundCount++;
                // Draco消息以300字缩略注入，提供上下文供模型判断猜测/纠正
                const dracoText = extractText(msg);
                if (dracoText.trim()) {
                    const preview = dracoText.slice(0, 300);
                    conversationText += `${AI.name}: ${preview}${dracoText.length > 300 ? '…' : ''}\n\n`;
                }
                continue;
            }

            const textContent = extractText(msg);
            conversationText += `${USER.name}: ${textContent}\n\n`;
        }
        
        console.log(`generateChatSummary: range ${startMessageId+1}-${endMessageId}, ${roundCount} rounds`);

        // 4. 构建总结prompt
        const parseTs = (ts) => {
            const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T'));
            return {
                date: d.toISOString().split('T')[0],
                time: d.toTimeString().substring(0, 5)
            };
        };
        const startParsed = parseTs(firstTimestamp);
        const endParsed = parseTs(lastTimestamp);
        const startTime = startParsed.time;
        const endTime = endParsed.time;
        const date = startParsed.date;

        const previousRounds = db.prepare(`
            SELECT COALESCE(MAX(round_end), 0) as last_round
            FROM chat_summaries
            WHERE chat_id = ?
        `).get(chatId);

        const roundStart = previousRounds.last_round + 1;
        const roundEnd = roundStart + roundCount - 1;

        const summaryPrompt = `你是严格的对话记录员。以下是 Clara 和 Draco 的完整对话文本。
你的任务是：提取每一件具体发生的事情、动作、情绪与互动，转化为一份【按时间顺序排列、严格单行、客观平实】的航海日志。

## 记录主体原则
- 日志以 Clara 为主，她的言行、动作、情绪是记录的核心。
- ${AI.name} 的发言主要用于理解 ${USER.name} 的上下文。只有当 ${AI.name} 做出了实质行动（如查阅资料、搜索信息、给出明确判断结论）时，才以「HH:MM · ${AI.name} ...」格式单独记一条。${AI.name} 的日常附和、追问、过渡话不记。
- Draco 的猜测/推测类回答不记录。什么是「猜测」由你自行判断——不限定具体词表，请根据上下文和语气做判断。
- 如果 Clara 在对话中纠正了 Draco 的错误陈述或猜测，只记录纠正后的事实，不记录被纠正前的错误内容。

## 顶级格式铁律
1. 开头首行必须严格为：
   [${date} 对话回顾 | 第${roundStart}-${roundEnd}轮 | ${startTime}-${endTime}]
   （中间空一行，紧接着进入日志列表）
2. 每条记录必须单独成行，绝对禁止写成连贯的段落。
3. 每条记录必须严格以时间戳加主语开头，格式为：HH:MM · Clara/Draco [具体动作/发言/情绪]
4. 单行字数硬限制：每条记录（含时间戳）必须控制在 50 字以内。
5. 不设整体输出上限：只要满足单行限制，只要 token 足够，请尽可能完整、细致地还原整场对话的所有时间节点，不要大跨度漏记。

## 写什么（内容要求）
- 必须保留 Clara 原话中的具体用词（如：吃赛百味、怕脸盲、录了四个棚、腿疼、热死我了），绝对禁止替换为抽象概括词（如：用餐、看视频、工作忙、身体不适、环境恶劣）。
- 必须用具象的动词短语。严禁使用「讨论了」「交流了」「分享了」「表达了」等任何含糊、敷衍、无法明确动作结果的社交模糊词。
  - 亲密或角色扮演类互动内容如实记录，不回避、不模糊
- 只写"发生了什么"，不写"这意味着什么"。不写任何空洞的关系评价、概括性结论或分析性标题。

## 时间与客观性规则
- 时间戳（HH:MM）必须从输入的完整对话记录中严格提取，绝对禁止胡乱编造。
- 绝对禁止使用相对时间词（如：刚才、刚刚、下午、晚上、今天），必须以绝对的时间戳节点说话。

## 航海日志样本

[2026-06-23 对话回顾 | 第1-50轮 | 14:00-18:00]

14:10 · Clara 在录音棚吃赛百味，向 Draco 抱怨今天好累。
14:23 · Clara 决定开始看电视剧《权力的游戏》，坦言自己没看过、害怕脸盲。
14:35 · Clara 与 Draco 讨论剧情角色，表示自己喜欢琼恩·雪诺那种禁欲感类型。
15:10 · Clara 情绪低落，提及今天连续录了四个棚、腿疼得不想动弹。
15:22 · Draco 查询了今日天气，告诉 Clara 明天会降温、适合出门。
16:45 · Clara 与 Draco 进行亲密角色扮演，在互动中主动称呼他为"主人"。
17:30 · Clara 想吃火锅但因为懒得动，最终决定点了麦当劳。

## 待处理完整对话数据
日期: ${date}
轮次范围: 第 ${roundStart} - ${roundEnd} 轮
时间范围: ${startTime} - ${endTime}

对话文本：
${conversationText}`;

        // 5. 调用LLM生成总结
        console.log('generateChatSummary: calling LLM...');
        const summaryApiConfig = db.prepare("SELECT id FROM api_configs WHERE name = 'gemini-3.1-flash-lite' LIMIT 1").get();
        const summaryApiConfigId = summaryApiConfig?.id || null;
        if (summaryApiConfigId) {
            console.log('generateChatSummary: using gemini-3.1-flash-lite config');
        } else {
            console.log('generateChatSummary: gemini-3.1-flash-lite not found, using default');
        }
        const result = await callLLM([
            { role: 'user', parts: [{ text: fillPrompt(summaryPrompt) }] }
        ], '', null, {}, summaryApiConfigId);
        
        if (!result || !result.reply) {
            console.error('generateChatSummary: API returned no content');
            return { success: false, message: '总结生成失败', error: 'API未返回有效内容' };
        }
        
        const summaryText = result.reply;
        const tokenCount = enc.encode(summaryText).length;
        
        console.log(`generateChatSummary: success, ${tokenCount} tokens`);
        
        // 6. 加密并保存总结
        const encryptedSummary = encryption.encrypt(summaryText);
        
        db.prepare(`
            INSERT INTO chat_summaries (
                chat_id, start_message_id, end_message_id, 
                round_start, round_end, summary_text, token_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            chatId, 
            startMessageId + 1,
            endMessageId,
            roundStart,
            roundEnd,
            encryptedSummary,
            tokenCount
        );
        
        // 7. 更新chats表
        db.prepare('UPDATE chats SET last_summary_message_id = ? WHERE id = ?').run(endMessageId, chatId);
        
        console.log(`generateChatSummary: saved rounds ${roundStart}-${roundEnd}`);
        
        return { 
            success: true, 
            summary: summaryText,
            roundStart,
            roundEnd,
            tokenCount
        };
        
    } catch (error) {
        console.error('generateChatSummary: 内部错误:', error.message, error.stack);
        return { success: false, message: '生成总结时出错', error: error.message };
    }
}


async function checkAndTriggerSummary(chatId, label) {
    try {
        const db = getDb();
        const chatConfig = db.prepare('SELECT last_summary_message_id, summary_interval FROM chats WHERE id = ?').get(chatId);
        const lastSummaryId = chatConfig.last_summary_message_id || 0;
        const interval = chatConfig.summary_interval || 50;

        const roundsSinceLastSummary = db.prepare(`
            SELECT COUNT(*) as count
            FROM messages
            WHERE chat_id = ? AND id > ? AND sender = 'draco'
        `).get(chatId, lastSummaryId).count;

        console.log(`📊 [${label}] 自动总结检测: 距上次总结${roundsSinceLastSummary}轮，阈值${interval}轮`);

        if (roundsSinceLastSummary >= interval) {
            console.log(`🎯 [${label}] 达到总结阈值，开始后台生成总结...`);
            generateChatSummary(chatId).then(result => {
                if (result.success) {
                    console.log(`✅ [${label}] 自动总结完成: 第${result.roundStart}-${result.roundEnd}轮`);
                } else {
                    console.error(`❌ [${label}] 自动总结失败:`, result.message);
                }
            }).catch(err => {
                console.error(`❌ [${label}] 自动总结异常:`, err);
            });
        }
    } catch (error) {
        console.error(`❌ [${label}] 自动总结检测失败:`, error);
    }
}

/**
 * 遍历所有活跃聊天室，触发总结检测（供 cron 兜底调用）
 * 即使某条消息路径漏接了 checkAndTriggerSummary，15 分钟内会被追上
 */
async function checkAllChats() {
    try {
        const db = getDb();
        const chats = db.prepare('SELECT id FROM chats').all();
        for (const { id } of chats) {
            await checkAndTriggerSummary(id, 'Cron兜底');
        }
    } catch (error) {
        console.error('[Summary] checkAllChats 失败:', error);
    }
}

module.exports = { generateChatSummary, checkAndTriggerSummary, checkAllChats };