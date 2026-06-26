// =================================================================
// 文本处理工具函数
// =================================================================

// 思考链过滤：去掉LLM在输出中"自言自语"的推理过程
// 应用于流式输出的每个句子 + 主动消息的后处理
const REASONING_PREFIX_CN = /^(?:让我(?:想想|分析|思考|考虑|来看|整理|先说|确认|检查|看看|来想|想一[想下])|我来(?:分析|看看|想想|思考|整理)|思考中|分析一下|考虑到|我在想|经过分析|我需要先|首先[，,]\s*)/;
const REASONING_PREFIX_EN = /^(?:Let me\s+(?:analyze|think|break\s*down|consider|figure\s*out|write|say|respond|reply|check|see|look|process)|I(?:\s|')ll\s+(?:think|analyze|check|see)|I need to\s|First[，,]\s|(?:Okay|OK)[，,]?\s*(?:so\s*)?(?:let(?:\s|')s\s+)?(?:think|analyze|see)?|Alright[，,]\s*(?:let(?:\s|')s\s+)?|So\s+(?:let me|I'll|we need)|Hmm[，,]\s*let me|Wait[，,]\s*let me)/i;
const REASONING_PREFIX = new RegExp(
    REASONING_PREFIX_CN.source + '|' + REASONING_PREFIX_EN.source,
    'i'
);
const NUMBERED_STEP = /^\d+[\.、)\s]\s*\S/;  // "1. xxx" or "1) xxx"

const filterThinkingProcess = (text) => {
    if (!text) return text;

    // 分段落处理：如果文本包含编号步骤 + 推理前缀 → 尝试提取最后一段干净内容
    const paragraphs = text.split(/\n{2,}/);
    if (paragraphs.length > 1 && REASONING_PREFIX.test(paragraphs[0])) {
        for (let i = paragraphs.length - 1; i >= 0; i--) {
            const p = paragraphs[i].trim();
            if (p && !NUMBERED_STEP.test(p) && !REASONING_PREFIX.test(p) && p.length >= 4) {
                // 找到最后一个非推理段落，返回它（丢弃前面的思考链）
                return p;
            }
        }
        return '';  // 所有段落都是推理
    }

    // 单段落：逐行过滤推理行
    let result = text
        // 去掉整行的推理前缀开头
        .split('\n')
        .filter(line => {
            const trimmed = line.trim();
            if (!trimmed) return false;  // 空行过滤
            if (NUMBERED_STEP.test(trimmed)) return false;  // 编号步骤
            if (REASONING_PREFIX.test(trimmed)) return false;  // 推理前缀
            if (/^第[一二三四五六七八九十\d]+[步][：:]/.test(trimmed)) return false;  // "第X步：..."
            if (/^(?:Step\s*\d|Phase\s*\d)[：:]/i.test(trimmed)) return false;  // "Step 1:..."
            return true;
        })
        .join('\n')
        // 去掉括号/方括号内的元评论
        .replace(/\([^)]*(?:思考|分析|考虑|推理|检查|确认)[^)]*\)/g, '')
        .replace(/\[[^\]]*(?:思考|分析|考虑|推理|检查|确认)[^\]]*\]/g, '')
        // 对话历史的系统元数据标记（stream.js 注入的 [系统 · ...] 标签），禁止输出
        .replace(/\[系统\s*·\s*[^\]]*\]/g, '')
        // Draco 从不主动使用【】括号，任何出现的【】内容都是 prompt 泄露
        .replace(/【[^】]*】/g, '')
        // 去掉"XXX：思考/分析..."格式的整行
        .split('\n')
        .filter(line => !/^.*(?:思考|分析|推理|考虑)[:：]\s*\S/.test(line.trim()))
        .join('\n')
        // 去掉"我觉得需要..."、"我需要先..."行
        .split('\n')
        .filter(line => !/^(?:我觉得需要|我需要先|我应该先)/.test(line.trim()))
        .join('\n')
        // 规范化多余空行
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return result;
};

// 句子分割
function splitIntoSentences(text) {
    const sentences = [];
    const lines = text.split('\n');

    for (const line of lines) {
        if (!line.trim()) continue;

        let current = '';
        let inQuote = false;
        let zhDepth = 0;  // {zh: ...} 块深度 — 内部标点不切句

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            current += ch;

            // 追踪 {zh: ...} 块，内部标点忽略；块结束时切句
            if (ch === '{' && /^\{zh\s*:/i.test(line.substring(i))) {
                zhDepth++;
            } else if (ch === '}' && zhDepth > 0) {
                zhDepth--;
                if (zhDepth === 0) {
                    // {zh:...} 块结束 → 切句
                    sentences.push(current);
                    current = '';
                    continue;
                }
            }

            if (ch === '“' || ch === '「' || ch === '『') inQuote = true;
            if (ch === '”' || ch === '」' || ch === '』') inQuote = false;

            if (inQuote || zhDepth > 0) continue;

            if (/[。！？?!;；]/.test(ch)) {
                while (i + 1 < line.length && /[！？!?]/.test(line[i + 1])) {
                    i++;
                    current += line[i];
                }
                while (i + 1 < line.length && /[”」』""'']/.test(line[i + 1])) {
                    i++;
                    current += line[i];
                    inQuote = false;
                }
                const next = line[i + 1];
                if (next && /[，,]/.test(next)) continue;

                // 如果后面紧跟 {zh: ...} 块，不切 — 它属于当前句子
                const rest = line.substring(i + 1).trimStart();
                if (/^\{zh\s*:/i.test(rest)) continue;

                sentences.push(current);
                current = '';
            }
        }

        if (current.trim()) sentences.push(current);
    }

    const merged = [];
    for (const s of sentences) {
        if (merged.length > 0 && /^[\*_`~\s“”''「」【】（）]+$/.test(s.trim())) {
            merged[merged.length - 1] += s;
        } else {
            merged.push(s);
        }
    }
    return merged.length > 0 ? merged : [text];
}

// 刷新文本缓冲区
// onSentence: 可选回调，每句生成后调用，用于SSE广播到其他Tab
function flushTextBuffer(textBuffer, res, components, onSentence) {
    let text = textBuffer.trim();
    if (!text) return;

    text = text.replace(/<meta[^>]*>[\s\S]*?<\/meta>/gi, '').trim();

    try {
        const parsed = JSON.parse(text);
        if (parsed.components && Array.isArray(parsed.components)) {
            const extracted = parsed.components
                .filter(c => c.type === 'text' && c.content)
                .map(c => c.content)
                .join('\n\n');
            if (extracted) {
                text = extracted;
                console.warn('[flushTextBuffer] AI输出了JSON格式，已自动提取文本内容');
            } else {
                return;
            }
        }
    } catch (e) {
        // 正常情况：不是JSON，继续处理
    }

    if (!text) return;

    const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(p => p && !/^[""】）\s]*$/.test(p));

    // 收集所有句子，段落间保留空行以便filterThinkingProcess识别段落结构
    const paraTexts = paragraphs.map(p =>
        splitIntoSentences(p).join('\n')
    );
    const fullText = paraTexts.join('\n\n');

    // 过滤思考链：以整个buffer为上下文判断是否有推理泄露
    const cleanedText = filterThinkingProcess(fullText);

    // 如果过滤后为空，说明整段都是推理——全部丢弃
    if (!cleanedText) {
        console.log('[flushTextBuffer] 整段被思考链过滤丢弃');
        return;
    }

    // 重新切句后发送（清洗后的文本可能丢了标点/行边界，再切一次保证正确）
    const cleanParagraphs = cleanedText.split(/\n\n+/).map(p => p.trim()).filter(p => p);
    cleanParagraphs.forEach(paragraph => {
        splitIntoSentences(paragraph).forEach(sentence => {
            res.write(`data: ${JSON.stringify({ type: 'sentence', text: sentence })}\n\n`);
            components.push({ type: 'text', content: sentence });
            if (onSentence) {
                try { onSentence(sentence); } catch {}
            }
        });
    });
}

module.exports = { filterThinkingProcess, splitIntoSentences, flushTextBuffer };
