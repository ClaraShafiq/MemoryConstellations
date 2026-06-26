// =================================================================
// openai-compat.js - Gemini ↔ OpenAI 格式转换层
// 当使用反代（OpenAI兼容端点）时，自动转换请求和响应格式
// =================================================================

/**
 * 判断是否为 OpenAI 兼容端点（反代）
 * 空端点或含 googleapis.com → Gemini 原生
 * 其他 → OpenAI 兼容
 */
function isOpenAICompat(endpoint) {
    if (!endpoint || endpoint.trim() === '') return false;
    if (endpoint.includes('googleapis.com')) return false;
    return true;
}

/**
 * 构建 OpenAI 兼容的请求 URL 和 Headers
 */
function buildOpenAIRequestMeta(endpoint, apiKey) {
    let baseUrl = endpoint.replace(/\/+$/, '');
    return {
        url: `${baseUrl}/chat/completions`,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        }
    };
}

/**
 * 将 Gemini 格式的 parts 转换为 OpenAI 格式的 content
 * 处理文本、图片（inline_data → image_url）、文件
 */
function convertPartsToContent(parts) {
    if (!parts || parts.length === 0) return '';

    // 如果只有一个纯文本 part，直接返回字符串
    if (parts.length === 1 && parts[0].text) {
        return parts[0].text;
    }

    // 多个 parts 或含有非文本内容 → 返回数组
    const content = [];
    for (const part of parts) {
        if (part.text) {
            content.push({ type: 'text', text: part.text });
            } else if (part.inline_data) {
                const dataUri = `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
                content.push({
                    type: 'image_url',
                    image_url: { url: dataUri }
                });
        } else if (part.functionCall) {
            // functionCall 在 parts 里不转 content，跳过
            continue;
        } else if (part.functionResponse) {
            // functionResponse 也跳过，单独处理
            continue;
        }
    }

    // 如果最终只有一个文本，简化为字符串
    if (content.length === 1 && content[0].type === 'text') {
        return content[0].text;
    }

    return content;
}

/**
 * 将 Gemini contents 数组转换为 OpenAI messages 数组
 * 同时处理 systemInstruction
 */
function convertContentsToMessages(contents, systemInstruction) {
    const messages = [];

    // 系统提示
    if (systemInstruction?.parts?.[0]?.text) {
        messages.push({
            role: 'system',
            content: systemInstruction.parts[0].text
        });
    }

    for (const item of contents) {
        const role = item.role === 'model' ? 'assistant' : 'user';

        // 检查是否包含 functionCall（model 的工具调用）
        const functionCalls = item.parts?.filter(p => p.functionCall) || [];
        if (functionCalls.length > 0) {
            // 先处理文本部分
            const textParts = item.parts.filter(p => p.text);
            const textContent = textParts.map(p => p.text).join('');

            // 构建 assistant 消息 + tool_calls
            const toolCalls = functionCalls.map((fc, idx) => ({
                id: `call_${Date.now()}_${idx}`,
                type: 'function',
                function: {
                    name: fc.functionCall.name,
                    arguments: JSON.stringify(fc.functionCall.args || {})
                },
                ...(fc.functionCall.thought_signature && { thought_signature: fc.functionCall.thought_signature })
            }));

            messages.push({
                role: 'assistant',
                content: textContent || null,
                tool_calls: toolCalls
            });
            continue;
        }

        // 检查是否包含 functionResponse（工具结果）
        const functionResponses = item.parts?.filter(p => p.functionResponse) || [];
        if (functionResponses.length > 0) {
            // 找到上一条 assistant 消息中对应的 tool_call_id
            const lastAssistantMsg = [...messages].reverse().find(
                m => m.role === 'assistant' && m.tool_calls
            );

            for (let i = 0; i < functionResponses.length; i++) {
                const fr = functionResponses[i];
                // 匹配 tool_call_id：按名字找，或按索引
                let toolCallId = `call_fallback_${i}`;
                if (lastAssistantMsg?.tool_calls) {
                    const match = lastAssistantMsg.tool_calls.find(
                        tc => tc.function.name === fr.functionResponse.name
                    );
                    if (match) toolCallId = match.id;
                }

                messages.push({
                    role: 'tool',
                    tool_call_id: toolCallId,
                    content: JSON.stringify(fr.functionResponse.response || {})
                });
            }
            continue;
        }

        // 普通消息
        const convertedContent = convertPartsToContent(item.parts);
        messages.push({
            role,
            content: convertedContent
        });
            }

            return messages;
        }

/**
 * 将 Gemini functionDeclarations 转换为 OpenAI tools 格式
 */
function convertToolsToOpenAI(geminiTools) {
    if (!geminiTools) return undefined;

    const declarations = geminiTools.functionDeclarations || [];
    if (declarations.length === 0) return undefined;

    return declarations.map(fd => ({
        type: 'function',
        function: {
            name: fd.name,
            description: fd.description || '',
            parameters: convertGeminiSchema(fd.parameters)
        }
    }));
}

/**
 * 递归转换 Gemini schema（大写 TYPE）→ OpenAI schema（小写 type）
 */
function convertGeminiSchema(schema) {
    if (!schema) return {};

    const result = {};
    if (schema.type) {
        result.type = schema.type.toLowerCase();
    }
    if (schema.description) {
        result.description = schema.description;
    }
    if (schema.properties) {
        result.properties = {};
        for (const [key, val] of Object.entries(schema.properties)) {
            result.properties[key] = convertGeminiSchema(val);
        }
    }
    if (schema.required) {
        result.required = schema.required;
    }
    if (schema.items) {
        result.items = convertGeminiSchema(schema.items);
    }
    if (schema.enum) {
        result.enum = schema.enum;
    }
    return result;
}

/**
 * 构建完整的 OpenAI 兼容请求体
 */
function buildOpenAIRequestBody(geminiRequestBody, modelName) {
    const body = {
        model: modelName,
        stream: true,
        messages: convertContentsToMessages(
            geminiRequestBody.contents,
            geminiRequestBody.systemInstruction
        )
    };

    // 生成参数
    const gc = geminiRequestBody.generationConfig;
    if (gc) {
        if (gc.maxOutputTokens) body.max_tokens = gc.maxOutputTokens;
        if (gc.temperature !== undefined) body.temperature = gc.temperature;
        if (gc.topP !== undefined) body.top_p = gc.topP;
        // topK 在 OpenAI 格式中不支持，忽略
    }

    // 工具
    if (geminiRequestBody.tools?.[0]) {
        const openaiTools = convertToolsToOpenAI(geminiRequestBody.tools[0]);
        if (openaiTools && openaiTools.length > 0) {
            body.tools = openaiTools;
        }
    }
    // 安全设置（Gemini默认过滤会拦截生理期/健康等正常对话，必须传BLOCK_NONE）
    if (geminiRequestBody.safetySettings && geminiRequestBody.safetySettings.length > 0) {
        body.safety_settings = geminiRequestBody.safetySettings;
    }
    // GLM/DeepSeek/Gemini 禁用thinking，避免消耗额外token
    // Gemini thinking 会吃掉输出预算导致空回复/截断（即使3.x也未修复）
    const modelLower = (modelName || '').toLowerCase();
    if (modelLower.includes('glm') || modelLower.includes('deepseek') || modelLower.includes('gemini')) {
        body.thinking = { type: "disabled" };
    }
    return body;
}

// =================================================================
// SSE 响应解析：OpenAI 流式格式 → 统一内部格式
// =================================================================

/**
 * 解析 OpenAI SSE 的一行数据
 * 返回: { type: 'text'|'tool_call'|'tool_call_delta'|'done'|null, ... }
 * 
 * OpenAI 的 tool_calls 是增量发送的：
 *   第一个 chunk: tool_calls[0] = { id, function: { name, arguments: "" } }
 *   后续 chunks: tool_calls[0] = { function: { arguments: "..." } }  (增量拼接)
 *   finish_reason: "tool_calls" 表示所有工具调用完成
 */
function parseOpenAISSEChunk(jsonStr) {
    if (jsonStr === '[DONE]') {
        return { type: 'done' };
    }

    try {
        const data = JSON.parse(jsonStr);
        const choice = data.choices?.[0];
        if (!choice) return null;

        // 检查结束原因
        if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
            return { type: 'tool_calls_complete' };
        }
        if (choice.finish_reason === 'stop') {
            return { type: 'done' };
        }
        // Gemini 安全过滤器拦截（即使设了BLOCK_NONE也可能触发，尤其在OpenAI兼容路径丢失safety_settings时）
        if (choice.finish_reason === 'error' || choice.native_finish_reason === 'SAFETY') {
            return { type: 'safety_block', native_reason: choice.native_finish_reason || 'ERROR' };
        }

        const delta = choice.delta;
        if (!delta) return null;

        // 文本内容
        if (delta.content) {
            return { type: 'text', text: delta.content };
        }

        // 工具调用（增量）
        if (delta.tool_calls && delta.tool_calls.length > 0) {
            return {
                type: 'tool_call_delta',
                tool_calls: delta.tool_calls.map(tc => ({
                    index: tc.index,
                    id: tc.id || null,
                    name: tc.function?.name || null,
                    arguments_delta: tc.function?.arguments || '',
                    thought_signature: tc.thought_signature || null
                }))
            };
        }

        return null;
    } catch (e) {
        return null;
    }
}

/**
 * 工具调用累积器
 * OpenAI 流式中 tool_calls 是增量发送的，需要累积完整的调用信息
 */
class ToolCallAccumulator {
    constructor() {
        // { [index]: { id, name, arguments } }
        this.calls = {};
    }

    /**
     * 处理一个增量 delta
     */
    feed(toolCallDeltas) {
        for (const delta of toolCallDeltas) {
            const idx = delta.index;
            if (!this.calls[idx]) {
                this.calls[idx] = { id: '', name: '', arguments: '', thought_signature: null };
            }
            if (delta.id) this.calls[idx].id = delta.id;
            if (delta.name) this.calls[idx].name = delta.name;
            if (delta.thought_signature) this.calls[idx].thought_signature = delta.thought_signature;
            this.calls[idx].arguments += delta.arguments_delta;
        }
    }

    /**
     * 获取所有完整的工具调用
     * 返回: [{ id, name, args }]
     */
    getCompletedCalls() {
        const results = [];
        for (const idx of Object.keys(this.calls).sort((a, b) => a - b)) {
            const call = this.calls[idx];
            let args = {};
            try {
                args = JSON.parse(call.arguments);
            } catch (e) {
                console.error(`⚠️ [OpenAI兼容] 工具参数解析失败:`, call.arguments);
            }
            results.push({
                id: call.id,
                name: call.name,
                args: args,
                thought_signature: call.thought_signature || null
            });
        }
        return results;
    }

    /**
     * 重置累积器（新一轮工具调用时）
     */
    reset() {
        this.calls = {};
    }
}

/**
 * 构建工具调用结果的 messages（用于下一轮请求）
 * @param {Array} toolCalls - [{ id, name, args }] 从 accumulator 获取
 * @param {Array} toolResults - 对应的执行结果
 * @param {string|null} textBeforeTools - 工具调用前的文本（如果有）
 */
function buildToolResultMessages(toolCalls, toolResults, textBeforeTools) {
    const messages = [];

    // assistant 消息：包含 tool_calls
    const assistantMsg = {
        role: 'assistant',
        content: textBeforeTools || null,
        tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
                name: tc.name,
                arguments: JSON.stringify(tc.args)
            }
        }))
    };
    messages.push(assistantMsg);

    // tool 消息：每个工具调用一条
    for (let i = 0; i < toolCalls.length; i++) {
        messages.push({
            role: 'tool',
            tool_call_id: toolCalls[i].id,
            content: JSON.stringify(toolResults[i] || {})
        });
    }

    return messages;
}

module.exports = {
    isOpenAICompat,
    buildOpenAIRequestMeta,
    buildOpenAIRequestBody,
    convertContentsToMessages,
    convertToolsToOpenAI,
    parseOpenAISSEChunk,
    ToolCallAccumulator,
    buildToolResultMessages
};