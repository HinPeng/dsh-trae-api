/**
 * anthropic-format.js - Convert Trae SSE events to Anthropic-compatible format
 *
 * Supports:
 *   - text content block
 *   - tool_use content block (parsed from [[TOOL_CALL]]...[[/TOOL_CALL]])
 *   - ping event (Anthropic official streaming spec)
 *   - stop_reason = tool_use when tool calls detected
 *   - token usage estimation
 */

const { v4: uuidv4 } = require('uuid');

const TOOL_MARKERS = [
  { open: '[[TOOL_CALL]]', close: '[[/TOOL_CALL]]' },
  { open: '<tool_call>', close: '</tool_call>' },
];
const OPEN_TAG = TOOL_MARKERS[0].open;
const CLOSE_TAG = TOOL_MARKERS[0].close;

function decodeXmlText(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&amp;/g, '&');
}

function normalizeToolCallPayload(raw) {
    const text = String(raw).trim();

    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.name === 'string') {
            return { name: parsed.name, input: parsed.arguments || parsed.input || parsed.parameters || {} };
        }
    } catch {}

    // Models sometimes ignore the requested [[TOOL_CALL]] format and emit an
    // XML-like tool call with arg_key/arg_value pairs. Claude Code does not
    // execute that syntax, so normalize it to a native tool_use block.
    if (/<arg_key>[\s\S]*<\/arg_key>/.test(text)) {
        const nameMatch = text.match(/^([\w.-]+)\s*(?:<|>|[\[{])/);
        const input = {};
        const argPattern = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
        let argMatch;
        while ((argMatch = argPattern.exec(text)) !== null) {
            input[decodeXmlText(argMatch[1].trim())] = decodeXmlText(argMatch[2]);
        }
        if (nameMatch && Object.keys(input).length > 0) {
            return { name: nameMatch[1], input };
        }
    }

    // Some models output `{"ToolName"}` followed by an arguments object.
    // Normalize both common variants before giving up.
    const compact = text.replace(/\s+/g, ' ').trim();
    const match = compact.match(/^\{\s*"([^"]+)"\s*\}\s*(\{[\s\S]*\})$/);
    if (match) {
        try {
            return { name: match[1], input: JSON.parse(match[2]) };
        } catch {}
    }

    const argMatch = compact.match(/^\{\s*"([^"]+)"\s*"\s*:\s*(\{[\s\S]*\})\s*\}$/);
    if (argMatch) {
        try {
            return { name: argMatch[1], input: JSON.parse(argMatch[2]) };
        } catch {}
    }

    // Handle model-invented wrappers such as [[tool_bash]] followed by args.
    const wrapperMatch = compact.match(/^\[\[tool[_-]([^\]]+)\]\]\s*(\{[\s\S]*\})$/i);
    if (wrapperMatch) {
        const name = wrapperMatch[1]
            .replace(/(^.|[_-][a-z])/g, c => c.toUpperCase())
            .replace(/[_-]/g, '');
        try {
            return { name, input: JSON.parse(wrapperMatch[2]) };
        } catch {}
    }

    return null;
}

function parseToolCalls(text) {
    const result = [];
    const patterns = TOOL_MARKERS.map(marker => ({
        marker,
        regex: new RegExp(`${marker.open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*([\\s\\S]*?)\\s*${marker.close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'),
    }));
    const matches = [];
    for (const {marker, regex} of patterns) {
        let match;
        while ((match = regex.exec(text)) !== null) {
            matches.push({ index: match.index, end: regex.lastIndex, marker, payload: match[1] });
        }
    }
    matches.sort((a, b) => a.index - b.index || a.end - b.end);

    let lastIndex = 0;
    for (const match of matches) {
        if (match.index >= lastIndex) {
            const before = text.substring(lastIndex, match.index);
            if (before.trim()) result.push({ type: 'text', text: before });
            const parsed = normalizeToolCallPayload(match.payload);
            if (parsed) {
                result.push({ type: 'tool_use', name: parsed.name, input: parsed.input });
            } else {
                result.push({ type: 'text', text: text.substring(match.index, match.end) });
            }
            lastIndex = match.end;
        }
    }

    if (lastIndex < text.length) {
        const after = text.substring(lastIndex);
        if (after.trim()) result.push({ type: 'text', text: after });
    }

    return result;
}

class StreamingToolCallParser {
    constructor() {
        this.buffer = '';
        this.marker = null;
    }

    push(chunk) {
        this.buffer += chunk;
    }

    takeBlocks() {
        const blocks = [];

        while (true) {
            if (this.marker) {
                const endIdx = this.buffer.indexOf(this.marker.close);
                if (endIdx === -1) break;
                const payload = this.buffer.substring(0, endIdx).trim();
                this.buffer = this.buffer.substring(endIdx + this.marker.close.length);
                const parsed = normalizeToolCallPayload(payload);
                if (parsed) {
                    blocks.push({ type: 'tool_use', name: parsed.name, input: parsed.input });
                } else {
                    blocks.push({ type: 'text', text: this.marker.open + payload + this.marker.close });
                }
                this.marker = null;
            } else {
                const candidates = [];
                for (const marker of TOOL_MARKERS) {
                    const startIdx = this.buffer.indexOf(marker.open);
                    if (startIdx !== -1) candidates.push({ startIdx, marker });
                }
                candidates.sort((a, b) => a.startIdx - b.startIdx);
                const candidate = candidates[0];

                if (!candidate) {
                    // Keep a possible partial opener in the buffer. Check every
                    // '<' and '[' so UTF-8/chunk boundaries cannot split a tag.
                    let holdFrom = this.buffer.length;
                    for (let i = this.buffer.length - 1; i >= 0; i--) {
                        const ch = this.buffer[i];
                        if (ch !== '<' && ch !== '[') continue;
                        const tail = this.buffer.substring(i);
                        if (TOOL_MARKERS.some(marker => marker.open.startsWith(tail))) {
                            holdFrom = i;
                            break;
                        }
                    }
                    if (holdFrom > 0) {
                        blocks.push({ type: 'text', text: this.buffer.substring(0, holdFrom) });
                    }
                    this.buffer = this.buffer.substring(holdFrom);
                    break;
                }

                if (candidate.startIdx > 0) {
                    blocks.push({ type: 'text', text: this.buffer.substring(0, candidate.startIdx) });
                }
                this.buffer = this.buffer.substring(candidate.startIdx + candidate.marker.open.length);
                this.marker = candidate.marker;
            }
        }
        return blocks;
    }

    flush() {
        const blocks = [];
        if (this.marker) {
            blocks.push({ type: 'text', text: this.marker.open + this.buffer });
            this.buffer = '';
            this.marker = null;
        } else if (this.buffer) {
            blocks.push({ type: 'text', text: this.buffer });
            this.buffer = '';
        }
        return blocks;
    }
}

function estimateTokens(text) {
    if (!text) return 0;
    let tokens = 0;
    for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (code > 0x2000) tokens += 1.5;
        else tokens += 0.25;
    }
    return Math.ceil(tokens);
}

async function handleAnthropicResponse(fetchResponse, model, stream, inputTokens) {
    const inTokens = inputTokens || 0;
    if (!stream) {
        return await collectNonStreaming(fetchResponse, model, inTokens);
    }
    return streamGenerator(fetchResponse, model, inTokens);
}

async function collectNonStreaming(fetchResponse, model, inputTokens) {
    const text = await fetchResponse.text();
    const lines = text.split('\n');
    let fullContent = '';
    let finishReason = 'end_turn';

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('event:output')) continue;
        if (trimmed.startsWith('data:')) {
            const data = trimmed.substring(5).trim();
            try {
                const parsed = JSON.parse(data);
                if (parsed.response) fullContent += parsed.response;
                if (parsed.finish_reason) {
                    finishReason = parsed.finish_reason === 'stop' ? 'end_turn' : parsed.finish_reason;
                }
            } catch {}
        }
    }

    const blocks = parseToolCalls(fullContent);
    const content = [];
    let hasToolUse = false;

    for (const block of blocks) {
        if (block.type === 'text') {
            if (block.text.trim()) {
                content.push({ type: 'text', text: block.text });
            }
        } else if (block.type === 'tool_use') {
            content.push({
                type: 'tool_use',
                id: `toolu_${uuidv4().replace(/-/g, '')}`,
                name: block.name,
                input: block.input,
            });
            hasToolUse = true;
        }
    }

    if (content.length === 0) {
        content.push({ type: 'text', text: '' });
    }

    const outputTokens = estimateTokens(fullContent);

    return {
        id: `msg_${uuidv4().replace(/-/g, '')}`,
        type: 'message',
        role: 'assistant',
        content,
        model,
        stop_reason: hasToolUse ? 'tool_use' : finishReason,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
}

async function* streamGenerator(fetchResponse, model, inputTokens) {
    const reader = fetchResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const msgId = `msg_${uuidv4().replace(/-/g, '')}`;
    const parser = new StreamingToolCallParser();

    let blockIndex = -1;
    let currentBlockType = null;
    let totalOutputText = '';
    let hasToolUse = false;
    let finishReason = 'end_turn';
    let doneReceived = false;

    const messageStart = `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
    })}\n\n`;

    const pingEvent = `event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`;

    function startTextBlock() {
        blockIndex++;
        currentBlockType = 'text';
        return `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
        })}\n\n`;
    }

    function startToolUseBlock(name, id) {
        blockIndex++;
        currentBlockType = 'tool_use';
        return `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id, name, input: {} },
        })}\n\n`;
    }

    function textDelta(text) {
        return `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text },
        })}\n\n`;
    }

    function inputJsonDelta(json) {
        return `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: json },
        })}\n\n`;
    }

    function closeCurrentBlock() {
        if (currentBlockType === null) return '';
        const out = `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: blockIndex,
        })}\n\n`;
        currentBlockType = null;
        return out;
    }

    function processBlocks(blocks) {
        let out = '';
        for (const block of blocks) {
            if (block.type === 'text') {
                if (!block.text) continue;
                if (currentBlockType !== 'text') {
                    out += closeCurrentBlock();
                    out += startTextBlock();
                }
                out += textDelta(block.text);
            } else if (block.type === 'tool_use') {
                out += closeCurrentBlock();
                const toolId = `toolu_${uuidv4().replace(/-/g, '')}`;
                out += startToolUseBlock(block.name, toolId);
                out += inputJsonDelta(JSON.stringify(block.input));
                out += closeCurrentBlock();
                hasToolUse = true;
            }
        }
        return out;
    }

    yield messageStart;
    yield pingEvent;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = null;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '') continue;
            if (trimmed.startsWith('event:')) {
                currentEvent = trimmed.substring(6).trim();
                continue;
            }
            if (!trimmed.startsWith('data:')) continue;

            const data = trimmed.substring(5).trim();

            if (currentEvent === 'done') {
                doneReceived = true;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.finish_reason) {
                        finishReason = parsed.finish_reason === 'stop' ? 'end_turn' : parsed.finish_reason;
                    }
                } catch {}

                const finalBlocks = parser.flush();
                const out1 = processBlocks(finalBlocks);
                if (out1) yield out1;
                const closeOut = closeCurrentBlock();
                if (closeOut) yield closeOut;

                yield `event: message_delta\ndata: ${JSON.stringify({
                    type: 'message_delta',
                    delta: {
                        stop_reason: hasToolUse ? 'tool_use' : finishReason,
                        stop_sequence: null,
                    },
                    usage: { output_tokens: estimateTokens(totalOutputText) },
                })}\n\n`;

                yield `event: message_stop\ndata: ${JSON.stringify({
                    type: 'message_stop',
                })}\n\n`;
                return;
            }

            try {
                const parsed = JSON.parse(data);
                if (parsed.response !== undefined && parsed.response !== null) {
                    const text = parsed.response;
                    if (text) {
                        totalOutputText += text;
                        parser.push(text);
                        const blocks = parser.takeBlocks();
                        const out = processBlocks(blocks);
                        if (out) yield out;
                    }
                }
                if (parsed.finish_reason) {
                    finishReason = parsed.finish_reason === 'stop' ? 'end_turn' : parsed.finish_reason;
                }
            } catch {}

            currentEvent = null;
        }
    }

    if (!doneReceived) {
        const finalBlocks = parser.flush();
        const out1 = processBlocks(finalBlocks);
        if (out1) yield out1;
        const closeOut = closeCurrentBlock();
        if (closeOut) yield closeOut;

        yield `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: {
                stop_reason: hasToolUse ? 'tool_use' : finishReason,
                stop_sequence: null,
            },
            usage: { output_tokens: estimateTokens(totalOutputText) },
        })}\n\n`;
        yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
    }
}

module.exports = { handleAnthropicResponse, parseToolCalls, normalizeToolCallPayload, estimateTokens, StreamingToolCallParser };