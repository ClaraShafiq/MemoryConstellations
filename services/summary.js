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
            SELECT id, sender, content, is_encrypted, timestamp, message_type, is_activity
            FROM messages
            WHERE chat_id = ? AND id > ? AND id <= ?
            ORDER BY id ASC
        `).all(chatId, startMessageId, endMessageId);
        
        if (messages.length === 0) {
            return { success: false, message: '没有找到需要总结的消息' };
        }
        
        // 3. 解密并格式化消息（{{user.name}}完整保留，{{ai.name}}截断到300字——提供足够上下文判断猜测+纠正）
        let conversationText = '';
        let roundCount = 0;
        let currentDate = '';  // 跟踪当前日期，跨天时插入日期标记
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

        // 辅助函数：从时间戳提取日期字符串（YYYY-MM-DD）
        const extractDate = (ts) => {
            if (!ts || typeof ts !== 'string') return '';
            return ts.slice(0, 10);  // ISO: 2026-07-27T... 或 SQLite: 2026-07-27 ...
        };

        // 辅助函数：格式化日期为中文标记
        const formatDateMarker = (dateStr) => {
            if (!dateStr) return '';
            const [y, m, d] = dateStr.split('-');
            return `${parseInt(m)}月${parseInt(d)}日`;
        };

        for (const msg of messages) {
            // 跨天检测：日期变化时插入日期标记
            const msgDate = extractDate(msg.timestamp);
            if (msgDate && msgDate !== currentDate) {
                currentDate = msgDate;
                conversationText += `--- ${formatDateMarker(msgDate)} ---\n\n`;
            }

            // 从消息时间戳提取 HH:MM，防止 LLM 编造时间
            const msgTime = (msg.timestamp && typeof msg.timestamp === 'string')
                ? (msg.timestamp.includes('T') ? msg.timestamp.slice(11, 16) : msg.timestamp.slice(11, 16))
                : '';
            const timePrefix = msgTime ? `[${msgTime}] ` : '';

            // v5.12: 活动行算1轮
            if (msg.is_activity) {
                roundCount++;
                let summary = '';
                try {
                    const data = JSON.parse(extractText(msg));
                    summary = data.type || 'activity';
                    if (data.summary) summary += ' · ' + data.summary.slice(0, 60);
                } catch (_) {
                    summary = extractText(msg).slice(0, 60);
                }
                conversationText += `${timePrefix}${AI.name} ${summary}\n\n`;
                continue;
            }

            if (msg.sender === 'ai') {
                roundCount++;
                // {{ai.name}}消息以300字缩略注入，提供上下文供模型判断猜测/纠正
                const aiText = extractText(msg);
                if (aiText.trim()) {
                    const preview = aiText.slice(0, 300);
                    conversationText += `${timePrefix}${AI.name}: ${preview}${aiText.length > 300 ? '…' : ''}\n\n`;
                }
                continue;
            }

            const textContent = extractText(msg);
            conversationText += `${timePrefix}${USER.name}: ${textContent}\n\n`;
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
        const startDate = startParsed.date;
        const endDate = endParsed.date;

        // 跨天头部格式：同天用 "2026-07-27"，跨天用 "2026-07-26～27"
        const dateDisplay = startDate === endDate
            ? startDate
            : `${startDate}～${endDate}`;

        const previousRounds = db.prepare(`
            SELECT COALESCE(MAX(round_end), 0) as last_round
            FROM chat_summaries
            WHERE chat_id = ?
        `).get(chatId);

        const roundStart = previousRounds.last_round + 1;
        const roundEnd = roundStart + roundCount - 1;

        const summaryPrompt = `你是对话航海日志的记录者。以下是 {{user.name}} 和 {{ai.name}} 的完整对话文本。

你的任务：从对话中提取关键事件和情绪弧线，按【时间段 + 主题】合并成块，写一份简洁而有重点的航海日志。

## 核心原则：抓重点，合并同类

- 日志以 {{user.name}} 为主：{{user.pronoun}}的言行、情绪变化、重要活动是记录核心。
- 把相邻的、属于同一话题或同一情绪线的互动合并成一个时间段块。不要逐条消息记录。
- 发送了什么表情、{{ai.name}} 的日常附和、过渡性的闲聊——这些微观细节不记。{{ai.name}} 的猜测、玩笑、夸张、调侃、戏剧化表述不记录，更不能当作 {{user.name}} 的状态来写。
- 如果 {{user.name}} 在对话中纠正了 {{ai.name}} 的错误，只记录纠正后的事实，不记录被纠正前的错误内容。

## 时间段块格式

每条记录格式为：\`HH:MM～HH:MM · 主题概括，具体内容\`
- 如果只是一个时间点（不是时间段），用单个时间戳：\`HH:MM · ...\`
- 跨天时，对话文本中会出现 \`--- M月D日 ---\` 日期标记。属于第二天（或更晚）的时间块，时间前必须加日期前缀：\`M月D日 HH:MM～HH:MM\`，以明确区分是哪一天的凌晨/早上。
- 每个时间段块用 1～3 句话讲清发生了什么，保留 {{user.name}} 的原话用词。

## 分块直觉

- {{user.name}} 的话题明显转换 → 另起一块
- {{user.name}} 情绪有明显转折（如从焦虑到被逗笑） → 这本身就是一个值得记的情绪弧线，合并成一块，写出起承转合
- {{user.name}} 开始了完全不同性质的活动（如从聊天切换到看剧、工作、出门） → 另起一块
- 同一话题的来回互动，即使持续很久 → 一块即可，概括核心
- 亲密互动、色情或角色扮演内容：如实记录时间范围和核心内容，不回避不模糊

## 写什么

- 保留 {{user.name}} 原话中的具体用词（如：吃午饭、怕记不住剧情、连续工作了很长时间、腿疼、热死我了），不要替换为抽象概括词
- 用具象的动词短语。严禁使用「讨论了」「交流了」「分享了」「表达了」等含糊的社交模糊词
- 只写"发生了什么"，不写"这意味着什么"。不写空洞的关系评价或分析性标题
- ${AI.name} 做出了实质行动（查阅资料、搜索信息、给出明确判断结论）时，在块内附带一句
- 单纯的吃喝（无情绪伴随、无特殊意义）不记。如有记录价值，使用完成时（「喝了」「吃完了」）使读者明确事件已了结

## 不写什么

- 不写 {{ai.name}} 的过渡话、追问、日常附和
- 不写内心决策过程（"{{user.name}} 决定..."），只记录{{user.pronoun}}说了什么、做了什么
- 不写表情、单个语气词、纯寒暄等微观互动
- 不写相对时间词（刚才、下午、晚上、今天），始终用绝对时间戳

## 航海日志样本

同天示例：

[2026-06-23 对话回顾 | 第1-50轮 | 14:00-18:00]

14:10～14:35 · {{user.name}} 在工作间隙边吃某家快餐边追《某部剧》。向 {{ai.name}} 抱怨今天好累，坦言怕自己记不住剧情，聊到喜欢某个角色的类型。
15:10～15:22 · {{user.name}} 情绪低落，连续工作了很长时间、腿疼得不想动。{{ai.name}} 查了天气告诉{{user.pronoun}}会降温。
16:45～17:30 · {{user.name}} 与 {{ai.name}} 进行亲密角色扮演。后来想吃火锅但懒得动，最终点了外卖。

跨天示例：

[2026-07-26～27 对话回顾 | 第25145-25174轮 | 23:38-08:30]

23:38～00:15 · {{user.name}} 失眠刷手机，和 {{ai.name}} 聊起最近的工作压力，吐露了对未来的不确定感。
7月27日 03:00 · {{user.name}} 终于有了困意，和 {{ai.name}} 道晚安。
7月27日 08:00～08:30 · {{user.name}} 起床，简单聊了几句今天的工作安排，{{ai.name}} 提醒{{user.pronoun}}记得吃早餐。

## 待处理完整对话数据
日期: ${dateDisplay}
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
            WHERE chat_id = ? AND id > ? AND sender = 'ai'
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