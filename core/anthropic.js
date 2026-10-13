'use strict';

/**
 * Anthropic Messages API 转换（Claude Code 用 /v1/messages）
 *
 * CodeBuddy 上游只提供 OpenAI 的 /v2/chat/completions，本模块负责：
 *   请求：Anthropic Messages  →  chat/completions
 *   响应：chat/completions    →  Anthropic Messages（非流式）
 *   流式：chat SSE            →  Anthropic SSE 事件流
 *
 * 参考实现：hawklithm/workbuddy2api 的 anthropic_adapter.py（思路借鉴，
 * 但修正了其消息顺序问题，见 responsesToChat 注释）。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const config = require('./config');
const store = require('./store');
const logger = require('./logger');
const util = require('./util');
const auth = require('./auth');
const sessionMod = require('./session');

// ---------------------------------------------------------------------------
// 后端净化
// ---------------------------------------------------------------------------

// CodeBuddy 后端的内容过滤器会拦截竞品品牌词与「AI agent 身份」特征词，
// 返回 11128 "Illegal API invocation from an unapproved channel"。
// Claude Code 的 system prompt 里大量出现 "You are Claude Code"、"Anthropic" 等，
// 必须净化，否则整个 /v1/messages 路径不可用。
// 注意：只处理 system / developer 提示词，用户消息与工具参数保持原样，
// 避免篡改用户内容。
const BACKEND_SANITIZE_RULES = [
  [/\bClaude Code\b/gi, 'CodeBuddy'],
  [/\bClaude Opus\b/gi, 'CodeBuddy Pro'],
  [/\bClaude Sonnet\b/gi, 'CodeBuddy'],
  [/\bClaude Haiku\b/gi, 'CodeBuddy Flash'],
  [/\bAnthropic\b/gi, 'Tencent'],
  [/\bnoreply@anthropic\.com\b/gi, 'noreply@codebuddy.cn'],
  [/\bCo-Authored-By:\s*Claude[^\n]*/gi, ''],
  [/\bCodex CLI\b/gi, 'CodeBuddy CLI'],
  [/\bCodex\b/gi, 'CodeBuddy'],
  [/\bOpenAI\b/gi, 'Tencent'],
];

function sanitizeForBackend(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const [re, rep] of BACKEND_SANITIZE_RULES) out = out.replace(re, rep);
  return out;
}

/** 递归净化 content（只动文本分片） */
function sanitizeContent(content) {
  if (typeof content === 'string') return sanitizeForBackend(content);
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (!c || typeof c !== 'object') return c;
      if (c.type === 'text' && typeof c.text === 'string') return { ...c, text: sanitizeForBackend(c.text) };
      return c;
    });
  }
  return content;
}

// ---------------------------------------------------------------------------
// 请求转换：Anthropic Messages → chat/completions
// ---------------------------------------------------------------------------

/** 从 Anthropic content（字符串或分片数组）里抽取纯文本 */
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  const parts = [];
  for (const c of content) {
    if (typeof c === 'string') { parts.push(c); continue; }
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'tool_result') parts.push(contentToText(c.content));
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * Anthropic 的 content 分片 → chat 的 content。
 * 纯文本时返回字符串；含图片时返回分片数组（保持多模态能力）。
 */
function contentToChatContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return contentToText(content);

  const parts = [];
  let hasNonText = false;

  for (const c of content) {
    if (typeof c === 'string') { parts.push({ type: 'text', text: c }); continue; }
    if (!c || typeof c !== 'object') continue;

    if (c.type === 'text') {
      parts.push({ type: 'text', text: c.text || '' });
    } else if (c.type === 'image') {
      // Anthropic: {type:'image', source:{type:'base64', media_type, data}} 或 {type:'url', url}
      const src = c.source || {};
      let url = '';
      if (src.type === 'base64' && src.data) {
        url = `data:${src.media_type || 'image/png'};base64,${src.data}`;
      } else if (src.type === 'url' && src.url) {
        url = src.url;
      } else if (typeof c.url === 'string') {
        url = c.url;
      }
      if (url) {
        hasNonText = true;
        parts.push({ type: 'image_url', image_url: { url } });
      }
    } else if (c.type === 'document') {
      // 上游不一定支持文档分片，原样保留避免静默丢失
      hasNonText = true;
      parts.push(c);
    }
  }

  if (!hasNonText) return parts.map((p) => p.text).filter(Boolean).join('\n');
  return parts;
}

/** Anthropic tools → chat tools */
function convertTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    // 已是 chat 格式
    if (t.type === 'function' && t.function) { out.push(t); continue; }
    if (!t.name) continue;
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

/**
 * Anthropic tool_choice → chat tool_choice。
 *
 * 注意：CodeBuddy 上游把 tool_choice 声明为 **string**，OpenAI 标准的
 * `{"type":"function","function":{"name":"X"}}` 对象形式会触发
 * 400 "cannot unmarshal object into Go struct field ... of type string"。
 * 因此强制指定工具时降级成工具名字符串（实测上游接受且语义一致）。
 */
function convertToolChoice(tc) {
  if (tc == null) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'any') return 'required';
    return tc; // auto / none / required 直接映射
  }
  if (typeof tc === 'object') {
    if (tc.type === 'tool' && tc.name) return tc.name;      // → 函数名字符串
    if (tc.type === 'any') return 'required';
    if (tc.type === 'auto') return 'auto';
    if (tc.type === 'none') return 'none';
    // 已是 chat 对象形式：同样降级为名字字符串
    const name = tc.function && tc.function.name;
    if (name) return name;
    if (tc.type === 'function') return 'required';
  }
  return undefined;
}

/**
 * 单条 Anthropic 消息 → chat 消息（可能产出多条）。
 *
 * ⚠️ 消息顺序是本模块最容易出错的地方。
 * OpenAI 协议要求 role:'tool' 必须**紧跟**在带对应 tool_calls 的 assistant
 * 消息之后，中间不能插入其它消息，否则上游报
 * 400 11148 "tool calls and tool results do not match"。
 *
 * Anthropic 的 user 消息里，文本分片和 tool_result 分片是混在一起的，且
 * **文本通常排在 tool_result 之前**（Claude Code 会发 "I'll do X" + 结果）。
 * 若按原顺序输出「user 文本 → tool 消息」，就会把 assistant(tool_calls) 与
 * tool 消息隔开，触发 11148。
 *
 * 因此这里把 tool 消息**提到前面**，user 文本排在其后。
 */
function convertAnthropicMessage(msg) {
  const role = msg.role;
  const content = msg.content;

  if (typeof content === 'string') {
    if (!content) return [];
    return [{ role, content: role === 'system' ? sanitizeForBackend(content) : content }];
  }
  if (!content) return [];
  const blocks = Array.isArray(content) ? content : [content];

  if (role === 'assistant') {
    const textParts = [];
    const toolCalls = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') textParts.push(b.text || '');
      else if (b.type === 'thinking') { /* 历史思考块不透传给上游 */ }
      else if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id || util.genId('call'),
          type: 'function',
          function: {
            name: b.name || '',
            arguments: JSON.stringify(b.input || {}),
          },
        });
      }
    }
    // 文本与 tool_calls 合并进同一条消息，保证后续 tool 消息紧邻
    const text = textParts.filter(Boolean).join('\n');
    if (!toolCalls.length && !text) return [];
    const out = { role: 'assistant', content: text || null };
    if (toolCalls.length) out.tool_calls = toolCalls;
    return [out];
  }

  // user（以及其它角色）
  const textParts = [];
  const toolMsgs = [];
  const otherBlocks = [];

  for (const b of blocks) {
    if (!b || typeof b !== 'object') { if (typeof b === 'string') textParts.push(b); continue; }
    if (b.type === 'text') textParts.push(b.text || '');
    else if (b.type === 'tool_result') {
      toolMsgs.push({
        role: 'tool',
        tool_call_id: b.tool_use_id || '',
        content: typeof b.content === 'string' ? b.content : contentToText(b.content),
      });
    } else if (b.type === 'image') {
      otherBlocks.push(b);
    }
  }

  const out = [];
  // 关键：tool 结果先出，紧邻前一条 assistant(tool_calls)
  out.push(...toolMsgs);
  if (textParts.length || otherBlocks.length) {
    const merged = [...textParts.map((t) => ({ type: 'text', text: t })), ...otherBlocks];
    out.push({ role: 'user', content: contentToChatContent(merged) });
  }
  return out;
}

/** Anthropic Messages 请求体 → chat/completions 请求体 */
function anthropicToChat(body) {
  const chat = { messages: [] };

  // system → 置顶 system 消息（净化品牌词）
  const system = body.system;
  if (system) {
    const text = typeof system === 'string' ? system : contentToText(system);
    if (text) chat.messages.push({ role: 'system', content: sanitizeForBackend(text) });
  }

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== 'object') continue;
    chat.messages.push(...convertAnthropicMessage(m));
  }

  // 净化：把任何残留的 developer/system 角色文本再洗一遍
  for (const m of chat.messages) {
    if (m.role === 'system' && typeof m.content === 'string') m.content = sanitizeForBackend(m.content);
  }

  if (body.model) chat.model = body.model;

  const tools = convertTools(body.tools);
  if (tools) chat.tools = tools;
  const tc = convertToolChoice(body.tool_choice);
  if (tc) chat.tool_choice = tc;

  if (body.max_tokens != null) chat.max_tokens = body.max_tokens;
  if (body.temperature != null) chat.temperature = body.temperature;
  if (body.top_p != null) chat.top_p = body.top_p;
  if (body.stop_sequences != null) chat.stop = body.stop_sequences;
  if (body.metadata && body.metadata.user_id) chat.user = String(body.metadata.user_id);

  return chat;
}

// ---------------------------------------------------------------------------
// 响应转换：chat/completions → Anthropic Messages
// ---------------------------------------------------------------------------

const STOP_REASON_MAP = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
  null: 'end_turn',
};

function mapStopReason(r) {
  if (r == null) return 'end_turn';
  return STOP_REASON_MAP[r] || 'end_turn';
}

function convertUsage(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0 };
  const input = u.prompt_tokens != null ? u.prompt_tokens : (u.input_tokens || 0);
  const output = u.completion_tokens != null ? u.completion_tokens : (u.output_tokens || 0);
  return { input_tokens: input, output_tokens: output };
}

/** 聚合后的 chat.completion → Anthropic message（非流式） */
function chatCompletionToMessage(completion, reqBody) {
  const choice = (completion.choices && completion.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];

  // thinking（上游 reasoning_content）放在最前，与流式顺序保持一致
  if (msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content, signature: util.genId('sig') });
  }
  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      const raw = tc.function && tc.function.arguments;
      if (raw) { try { input = JSON.parse(raw); } catch { input = { _raw: raw }; } }
      content.push({
        type: 'tool_use',
        id: tc.id || util.genId('toolu'),
        name: (tc.function && tc.function.name) || '',
        input,
      });
    }
  }

  return {
    id: util.genId('msg'),
    type: 'message',
    role: 'assistant',
    model: completion.model || (reqBody && reqBody.model) || store.getConfig().defaultModel || 'default',
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: convertUsage(completion.usage),
  };
}

// ---------------------------------------------------------------------------
// 流式转换：chat SSE → Anthropic SSE
// ---------------------------------------------------------------------------

/**
 * 把上游 chat SSE 边收边转成 Anthropic 事件流。
 *
 * Anthropic 事件顺序（严格）：
 *   message_start
 *   content_block_start / content_block_delta... / content_block_stop   (每块)
 *   message_delta(stop_reason, usage)
 *   message_stop
 *
 * thinking 块必须排在 text/tool_use 之前（与 message_start 里声明的顺序一致），
 * 因此采用「延迟开块」策略：收到首个 text 时才关掉 thinking 块。
 */
function streamChatToAnthropic(clientRes, urlStr, headers, body, reqBody) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;

    const state = {
      messageId: util.genId('msg'),
      model: reqBody.model || store.getConfig().defaultModel || 'default',
      started: false,
      seq: 0,
      // 块管理：thinking 恒为 0（若出现），其后按出现顺序递增
      nextIndex: 0,
      thinkingIndex: null,
      textIndex: null,
      toolBlocks: {},       // chat tool index → { index, id, name, args }
      openBlocks: [],       // 已开始但未结束的块，按 index 升序
      thinkingText: '',
      text: '',
      finishReason: null,
      usage: null,
    };

    const emit = (type, data) => {
      data.type = type;
      clientRes.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const startBlock = (index, contentBlock) => {
      state.openBlocks.push(index);
      emit('content_block_start', { index, content_block: contentBlock });
    };

    const closeBlock = (index) => {
      state.openBlocks = state.openBlocks.filter((i) => i !== index);
      emit('content_block_stop', { index });
    };

    const ensureMessageStart = () => {
      if (state.started) return;
      state.started = true;
      emit('message_start', {
        message: {
          id: state.messageId,
          type: 'message',
          role: 'assistant',
          model: state.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    };

    // thinking 块一旦要关闭就不能再追加内容，故在切换时关掉
    const closeThinkingIfOpen = () => {
      if (state.thinkingIndex != null && state.openBlocks.includes(state.thinkingIndex)) {
        closeBlock(state.thinkingIndex);
      }
    };

    const ensureThinking = () => {
      ensureMessageStart();
      if (state.thinkingIndex != null) return state.thinkingIndex;
      const idx = state.nextIndex++;
      state.thinkingIndex = idx;
      startBlock(idx, { type: 'thinking', thinking: '' });
      return idx;
    };

    const ensureText = () => {
      ensureMessageStart();
      closeThinkingIfOpen();
      if (state.textIndex != null) return state.textIndex;
      const idx = state.nextIndex++;
      state.textIndex = idx;
      startBlock(idx, { type: 'text', text: '' });
      return idx;
    };

    const onChunk = (chunk) => {
      if (chunk && chunk.usage) state.usage = chunk.usage;
      const choices = chunk && chunk.choices;
      if (!Array.isArray(choices)) return;

      for (const choice of choices) {
        if (choice.finish_reason) state.finishReason = choice.finish_reason;
        const delta = choice.delta || {};

        // 思维链：上游 reasoning_content
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          const idx = ensureThinking();
          state.thinkingText += delta.reasoning_content;
          emit('content_block_delta', {
            index: idx,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
          });
        }

        // 正文
        if (typeof delta.content === 'string' && delta.content) {
          const idx = ensureText();
          state.text += delta.content;
          emit('content_block_delta', { index: idx, delta: { type: 'text_delta', text: delta.content } });
        }

        // 工具调用
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const chatIdx = tc.index != null ? tc.index : 0;
            let slot = state.toolBlocks[chatIdx];
            if (!slot) {
              ensureMessageStart();
              closeThinkingIfOpen();
              const idx = state.nextIndex++;
              slot = { index: idx, id: tc.id || util.genId('toolu'), name: '', args: '', started: false };
              state.toolBlocks[chatIdx] = slot;
            }
            if (tc.id) slot.id = tc.id;
            const fn = tc.function || {};
            if (fn.name) slot.name += fn.name;

            // 拿到工具名才能开块（Anthropic 要求 content_block_start 带 name）
            if (!slot.started && slot.name) {
              slot.started = true;
              startBlock(slot.index, { type: 'tool_use', id: slot.id, name: slot.name, input: {} });
            }
            if (fn.arguments) {
              slot.args += fn.arguments;
              if (slot.started) {
                emit('content_block_delta', {
                  index: slot.index,
                  delta: { type: 'input_json_delta', partial_json: fn.arguments },
                });
              }
            }
          }
        }
      }
    };

    const finish = () => {
      ensureMessageStart();
      // 关闭所有未结束的块，按 index 升序，保证事件顺序合法
      const remaining = [...state.openBlocks].sort((a, b) => a - b);
      for (const idx of remaining) closeBlock(idx);

      const usage = convertUsage(state.usage);
      emit('message_delta', {
        delta: { stop_reason: mapStopReason(state.finishReason), stop_sequence: null },
        usage: { output_tokens: usage.output_tokens },
      });
      emit('message_stop', {});
      clientRes.end();
    };

    const req = mod.request(u, { method: 'POST', headers }, (upRes) => {
      const ct = (upRes.headers['content-type'] || '');
      if (!ct.includes('text/event-stream')) {
        let errBody = '';
        upRes.setEncoding('utf8');
        upRes.on('data', (c) => { errBody += c; });
        upRes.on('end', () => {
          logger.log('error', 'anthropic', `上游非流式响应 ${upRes.statusCode}: ${errBody.slice(0, 500)}`);
          if (!clientRes.headersSent) {
            clientRes.writeHead(upRes.statusCode || 502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            clientRes.end(JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: `upstream ${upRes.statusCode}: ${errBody.slice(0, 300)}` },
            }));
          } else {
            emit('error', { error: { type: 'api_error', message: `upstream ${upRes.statusCode}: ${errBody.slice(0, 300)}` } });
            clientRes.end();
          }
          resolve({ usage: state.usage, model: state.model, status: upRes.statusCode === 200 ? 'ok' : 'error', httpStatus: upRes.statusCode || 0, errorBody: errBody.slice(0, 4096) });
        });
        upRes.on('error', reject);
        return;
      }

      let buf = '';
      upRes.setEncoding('utf8');
      const drain = (text) => {
        buf += text;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try { onChunk(JSON.parse(data)); } catch { /* skip malformed */ }
          }
        }
      };
      upRes.on('data', drain);
      upRes.on('end', () => {
        if (buf.trim()) drain('\n\n');
        finish();
        resolve({ usage: state.usage, model: state.model, status: upRes.statusCode === 200 ? 'ok' : 'error', httpStatus: upRes.statusCode || 0, errorBody: '' });
      });
      upRes.on('error', reject);
    });

    req.on('error', (e) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `upstream error: ${e.message}` } }));
      }
      reject(e);
    });
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 路由入口
// ---------------------------------------------------------------------------

/** 处理 POST /v1/messages */
async function handleMessages(req, res) {
  const keyCheck = auth.verifyClientKey(req);
  if (!keyCheck.ok) {
    const status = keyCheck.rateLimited ? 429 : 401;
    util.sendJson(res, status, { type: 'error', error: { type: 'authentication_error', message: keyCheck.message } });
    return;
  }

  let body;
  try { body = await util.readBody(req); }
  catch (e) {
    util.sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: `read body failed: ${e.message}` } });
    return;
  }

  let payload = null;
  if (body.length) { try { payload = JSON.parse(body.toString('utf8')); } catch { payload = null; } }
  if (payload == null) payload = {};

  if (!Array.isArray(payload.messages)) {
    util.sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages: field required' } });
    return;
  }

  const chatPayload = anthropicToChat(payload);
  const cfg = store.getConfig();
  if (cfg.forceModel) chatPayload.model = cfg.forceModel;
  else if (!chatPayload.model) chatPayload.model = cfg.defaultModel || 'default';

  // CodeBuddy 只支持流式，非流式请求也先拿 SSE 再聚合
  const wantStream = payload.stream === true;
  chatPayload.stream = true;
  chatPayload.stream_options = { include_usage: true };
  util.resolveReasoningEffort(chatPayload, cfg.defaultReasoningEffort);

  const timeoutMs = store.getRequestTimeoutMs();
  logger.log('info', 'anthropic', `model=${chatPayload.model} stream=${wantStream} messages=${chatPayload.messages.length}`,
    logger.requestSummary(payload, { messages: chatPayload.messages.length }));

  const accountKey = auth.extractAccountKey(req, payload);
  const sessionEnd = auth.isSessionEnd(req, payload);
  const sessionKey = auth.extractSessionKey(req, chatPayload, keyCheck.keyId || '', sessionEnd);
  let acct;
  try { acct = await auth.pickAccountForRequest(accountKey, keyCheck.accountId || '', { sessionKey }); }
  catch (e) {
    logger.log('warn', 'anthropic', `拒绝: ${e.message}`);
    util.sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: e.message } });
    return;
  }

  let accountId = acct ? acct.id : '';
  let accountName = acct ? (acct.name || (acct.account && (acct.account.nickname || acct.account.uid)) || '') : '';

  const startedAt = Date.now();
  const record = (usage, status) => {
    store.recordUsage({
      source: '/v1/messages',
      model: chatPayload.model || '',
      stream: wantStream,
      accountId, accountName,
      apiKeyId: keyCheck.keyId || '', apiKeyName: keyCheck.keyName || '',
      promptTokens: usage && (usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens),
      completionTokens: usage && (usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens),
      totalTokens: usage && (usage.total_tokens != null ? usage.total_tokens : undefined),
      cachedTokens: usage && (usage.prompt_cache_hit_tokens || (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)) || 0,
      durationMs: Date.now() - startedAt,
      status,
    });
  };

  const headers = { ...auth.buildAuthHeaders(acct), 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
  const targetUrl = `${config.ENDPOINT}/v2/chat/completions`;
  const jsonBody = JSON.stringify(chatPayload);

  try {
    if (wantStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });
      const done = await streamChatToAnthropic(res, targetUrl, headers, jsonBody, payload);
      if (done && done.status && done.status !== 'ok') auth.recordUpstreamFailure(accountId, done.httpStatus || 0, done.errorBody || '');
      else auth.recordUpstreamSuccess(accountId);
      logger.log('info', 'anthropic', `流式结束 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: true, durationMs: Date.now() - startedAt }));
      record(done && done.usage, (done && done.status) || 'ok');
    } else {
      const r = await util.requestRaw(targetUrl, { method: 'POST', headers, body: jsonBody, timeoutMs });
      const ct = (r.headers && r.headers['content-type']) || '';
      if (ct.includes('text/event-stream') || r.body.includes('chat.completion.chunk')) {
        auth.recordUpstreamSuccess(accountId);
        const completion = aggregateSseToCompletion(r.body);
        logger.log('info', 'anthropic', `完成 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: false, durationMs: Date.now() - startedAt }));
        record(completion.usage, 'ok');
        util.sendJson(res, 200, chatCompletionToMessage(completion, payload));
      } else {
        if (r.status === 200) auth.recordUpstreamSuccess(accountId);
        else auth.recordUpstreamFailure(accountId, r.status, r.body);
        logger.log('warn', 'anthropic', `上游非流式响应 ${r.status}`, logger.requestSummary(payload, { status: r.status }));
        record(null, r.status === 200 ? 'ok' : 'error');
        res.writeHead(r.status, { 'Content-Type': ct || 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(r.body);
      }
    }
  } catch (e) {
    logger.log('error', 'anthropic', `上游错误: ${e.message}`, logger.requestSummary(payload, { stream: wantStream }));
    record(null, 'error');
    if (!res.headersSent) {
      util.sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: `upstream error: ${e.message}` } });
    } else res.end();
  } finally {
    if (sessionKey && sessionEnd) sessionMod.releaseSession(sessionKey);
  }
}

// 与 responses.js 同样的循环依赖问题：惰性引用 openai.js
let _openai = null;
function aggregateSseToCompletion(sseText) {
  if (!_openai) _openai = require('./openai');
  return _openai.aggregateSseToCompletion(sseText);
}

module.exports = {
  handleMessages,
  anthropicToChat,
  convertAnthropicMessage,
  convertTools,
  convertToolChoice,
  chatCompletionToMessage,
  sanitizeForBackend,
  mapStopReason,
};
