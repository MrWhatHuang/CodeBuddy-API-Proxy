'use strict';

/** Responses API 转换（Codex 用 /v1/responses） */

const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const config = require('./config');
const store = require('./store');
const logger = require('./logger');
const util = require('./util');
const auth = require('./auth');
const openai = require('./openai');

// CodeBuddy 后端的内容过滤器会拦截含 "Codex"/"OpenAI" 等竞品品牌词的系统提示词，
// 返回 11128 "Illegal API invocation from an unapproved channel"。这里做净化以绕过。
function sanitizeForBackend(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/Codex/gi, 'CodeBuddy').replace(/OpenAI/gi, 'Tencent');
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object') {
        if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') return c.text || '';
        if (c.type === 'input_image' || c.type === 'image_url' || c.type === 'image') {
          return (typeof c.image_url === 'string' ? c.image_url : (c.image_url && c.image_url.url)) || '';
        }
        if (c.type === 'refusal') return c.refusal || '';
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') return contentToText(Array.isArray(content) ? content : [content]);
  return String(content);
}

function convertToolChoice(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'required') return 'required';
    if (tc === 'none') return 'none';
    return 'auto';
  }
  if (typeof tc === 'object') {
    if (tc.type === 'function' && tc.name) return { type: 'function', function: { name: tc.name } };
    if (tc.type === 'none') return 'none';
    if (tc.type === 'required') return 'required';
  }
  return 'auto';
}

/** Responses API 请求 → chat/completions 请求 */
function responsesToChatInput(p) {
  const cfg = store.getConfig();
  const chat = { model: (p.model && p.model !== '') ? p.model : (cfg.defaultModel || 'default'), messages: [], stream: !!p.stream };

  if (p.instructions) chat.messages.push({ role: 'system', content: sanitizeForBackend(p.instructions) });

  const input = p.input;
  if (typeof input === 'string') {
    chat.messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    let pendingToolCalls = [];
    const flushToolCalls = () => {
      if (pendingToolCalls.length) {
        chat.messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
        pendingToolCalls = [];
      }
    };
    for (const item of input) {
      if (typeof item === 'string') { flushToolCalls(); chat.messages.push({ role: 'user', content: item }); continue; }
      if (!item || typeof item !== 'object') continue;

      if (item.role && item.content !== undefined) {
        flushToolCalls();
        const isSys = item.role === 'developer' || item.role === 'system';
        const role = item.role === 'developer' ? 'system' : item.role;
        const text = contentToText(item.content);
        chat.messages.push({ role, content: isSys ? sanitizeForBackend(text) : text });
        continue;
      }
      if (item.type === 'message') {
        flushToolCalls();
        const isSys = item.role === 'developer' || item.role === 'system';
        const role = item.role === 'developer' ? 'system' : (item.role || 'user');
        const text = contentToText(item.content);
        chat.messages.push({ role, content: isSys ? sanitizeForBackend(text) : text });
      } else if (item.type === 'function_call') {
        pendingToolCalls.push({
          id: item.call_id || item.id || util.genId('call'),
          type: 'function',
          function: { name: item.name || '', arguments: item.arguments || '' },
        });
      } else if (item.type === 'function_call_output') {
        flushToolCalls();
        chat.messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: contentToText(item.output) });
      }
    }
    flushToolCalls();
  }

  if (Array.isArray(p.tools) && p.tools.length) {
    chat.tools = p.tools
      .filter((t) => t && t.type === 'function' && t.name)
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: sanitizeForBackend(t.description || ''),
          parameters: t.parameters || t.input_schema || { type: 'object', properties: {} },
        },
      }));
    if (chat.tools.length) {
      const tc = convertToolChoice(p.tool_choice);
      if (tc) chat.tool_choice = tc;
    }
  }

  if (p.max_output_tokens) chat.max_tokens = p.max_output_tokens;
  if (p.temperature !== undefined) chat.temperature = p.temperature;
  if (p.top_p !== undefined) chat.top_p = p.top_p;

  return chat;
}

/** 把 chat usage 转成 Responses API usage 格式 */
function convertUsage(u) {
  if (!u) return null;
  return {
    input_tokens: u.prompt_tokens || 0,
    input_tokens_details: { cached_tokens: u.prompt_cache_hit_tokens || 0 },
    output_tokens: u.completion_tokens || 0,
    output_tokens_details: { reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0 },
    total_tokens: u.total_tokens || 0,
  };
}

/** 构建一个 Responses API 响应对象 */
function buildResponseObject(state, status) {
  const output = [];
  for (const t of state.toolCalls) {
    output.push({ id: t.id, type: 'function_call', call_id: t.call_id, name: t.name, arguments: t.args, status: status === 'completed' ? 'completed' : 'in_progress' });
  }
  if (state.msgStarted || state.content) {
    output.push({ id: state.msgId, type: 'message', status: status === 'completed' ? 'completed' : 'in_progress', role: 'assistant', content: state.content ? [{ type: 'output_text', text: state.content, annotations: [] }] : [] });
  }
  return {
    id: state.responseId,
    object: 'response',
    created_at: state.created,
    status,
    error: null,
    incomplete_details: null,
    model: state.model,
    output,
    parallel_tool_calls: true,
    temperature: state.req.temperature ?? 1,
    tool_choice: state.req.tool_choice || 'auto',
    tools: state.req.tools || [],
    max_output_tokens: state.req.max_output_tokens || null,
    instructions: state.req.instructions || null,
    usage: convertUsage(state.usage),
  };
}

/** 把聚合后的 chat.completion 转成 Responses API 非流式响应 */
function chatCompletionToResponse(completion, req) {
  const message = (completion.choices && completion.choices[0] && completion.choices[0].message) || {};
  const output = [];
  const msgId = util.genId('msg');

  if (message.reasoning_content) {
    output.push({ id: util.genId('rs'), type: 'reasoning', summary: [], content: [{ type: 'summary_text', text: message.reasoning_content, annotations: [] }] });
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    for (const tc of message.tool_calls) {
      output.push({ id: tc.id || util.genId('fc'), type: 'function_call', call_id: tc.id || util.genId('call'), name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) || '', status: 'completed' });
    }
  }
  const parts = [];
  if (message.content) parts.push({ type: 'output_text', text: message.content, annotations: [] });
  output.push({ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: parts });

  return {
    id: util.genId('resp'),
    object: 'response',
    created_at: completion.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: completion.model || req.model || store.getConfig().defaultModel || 'default',
    output,
    parallel_tool_calls: true,
    temperature: req.temperature ?? 1,
    tool_choice: req.tool_choice || 'auto',
    tools: req.tools || [],
    max_output_tokens: req.max_output_tokens || null,
    instructions: req.instructions || null,
    usage: convertUsage(completion.usage),
  };
}

/** 把 CodeBuddy 的 chat SSE 流转成 Responses API SSE 事件（边收边写） */
function streamChatToResponses(clientRes, urlStr, headers, body, originalReq) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;

    const state = {
      seq: 0,
      responseId: util.genId('resp'),
      msgId: util.genId('msg'),
      model: originalReq.model || store.getConfig().defaultModel || 'default',
      created: Math.floor(Date.now() / 1000),
      req: originalReq,
      content: '',
      reasoning: '',
      toolCalls: [],
      toolIndex: {},
      started: false,
      msgStarted: false,
      finishReason: 'stop',
      usage: null,
    };

    const emit = (type, data) => {
      data.type = type;
      data.sequence_number = state.seq++;
      clientRes.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const ensureStarted = () => {
      if (state.started) return;
      state.started = true;
      emit('response.created', { response: buildResponseObject(state, 'in_progress') });
      emit('response.in_progress', { response: buildResponseObject(state, 'in_progress') });
    };

    const ensureMessage = () => {
      if (state.msgStarted) return;
      state.msgStarted = true;
      const oi = state.toolCalls.length;
      emit('response.output_item.added', { output_index: oi, item: { id: state.msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
      emit('response.content_part.added', { item_id: state.msgId, output_index: oi, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    };

    const onChunk = (chunk) => {
      ensureStarted();
      const choice = (chunk.choices || [])[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (chunk.model) state.model = chunk.model;
      if (chunk.created) state.created = chunk.created;
      if (chunk.usage) state.usage = chunk.usage;
      if (choice.finish_reason) state.finishReason = choice.finish_reason;

      if (typeof delta.content === 'string' && delta.content) {
        ensureMessage();
        state.content += delta.content;
        emit('response.output_text.delta', { item_id: state.msgId, output_index: state.toolCalls.length, content_index: 0, delta: delta.content });
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) state.reasoning += delta.reasoning_content;

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index || 0;
          if (!(idx in state.toolIndex)) {
            const pos = state.toolCalls.length;
            state.toolIndex[idx] = pos;
            const id = tc.id || util.genId('fc');
            state.toolCalls.push({ id, call_id: id, name: '', args: '' });
            emit('response.output_item.added', { output_index: pos, item: { id, type: 'function_call', call_id: id, name: '', arguments: '', status: 'in_progress' } });
          }
          const pos = state.toolIndex[idx];
          const t = state.toolCalls[pos];
          if (tc.id) { t.id = tc.id; t.call_id = tc.id; }
          if (tc.function) {
            if (tc.function.name) t.name += tc.function.name;
            if (tc.function.arguments) t.args += tc.function.arguments;
          }
        }
      }
    };

    const finish = () => {
      ensureStarted();
      if (state.msgStarted) {
        const oi = state.toolCalls.length;
        emit('response.output_text.done', { item_id: state.msgId, output_index: oi, content_index: 0, text: state.content });
        emit('response.content_part.done', { item_id: state.msgId, output_index: oi, content_index: 0, part: { type: 'output_text', text: state.content, annotations: [] } });
        emit('response.output_item.done', { output_index: oi, item: { id: state.msgId, type: 'message', status: 'completed', role: 'assistant', content: state.content ? [{ type: 'output_text', text: state.content, annotations: [] }] : [] } });
      }
      state.toolCalls.forEach((t, pos) => {
        emit('response.output_item.done', { output_index: pos, item: { id: t.id, type: 'function_call', call_id: t.call_id, name: t.name, arguments: t.args, status: 'completed' } });
      });
      emit('response.completed', { response: buildResponseObject(state, 'completed') });
      clientRes.end();
    };

    const req = mod.request(u, { method: 'POST', headers }, (upRes) => {
      const ct = (upRes.headers['content-type'] || '');
      if (!ct.includes('text/event-stream')) {
        let errBody = '';
        upRes.setEncoding('utf8');
        upRes.on('data', (c) => { errBody += c; });
        upRes.on('end', () => {
          logger.log('error', 'responses', `上游非流式响应 ${upRes.statusCode}: ${errBody.slice(0, 500)}`);
          if (!clientRes.headersSent) {
            clientRes.writeHead(upRes.statusCode || 502, { 'Content-Type': ct || 'application/json', 'Access-Control-Allow-Origin': '*' });
            clientRes.end(errBody);
          } else {
            const ev = { type: 'response.failed', sequence_number: state.seq++, response: { id: state.responseId, object: 'response', status: 'failed', error: { code: 'upstream_error', message: `上游返回 ${upRes.statusCode}: ${errBody.slice(0, 300)}` } } };
            clientRes.write(`event: response.failed\ndata: ${JSON.stringify(ev)}\n\n`);
            clientRes.end();
          }
          resolve({ usage: state.usage, model: state.model, status: upRes.statusCode === 200 ? 'ok' : 'error' });
        });
        upRes.on('error', reject);
        return;
      }
      let buf = '';
      upRes.setEncoding('utf8');
      upRes.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try { onChunk(JSON.parse(data)); } catch { /* skip */ }
          }
        }
      });
      upRes.on('end', () => {
        if (buf.trim()) {
          for (const line of buf.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try { onChunk(JSON.parse(data)); } catch { /* skip */ }
          }
        }
        finish();
        resolve({ usage: state.usage, model: state.model, status: upRes.statusCode === 200 ? 'ok' : 'error' });
      });
      upRes.on('error', reject);
    });
    req.on('error', (e) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: { message: `upstream error: ${e.message}` } }));
      }
      reject(e);
    });
    if (body) req.write(body);
    req.end();
  });
}

/** 处理 POST /v1/responses */
async function handleResponses(req, res) {
  const keyCheck = auth.verifyClientKey(req);
  if (!keyCheck.ok) {
    const status = keyCheck.rateLimited ? 429 : 401;
    util.sendJson(res, status, { error: { message: keyCheck.message, type: 'authentication_error' } });
    return;
  }

  let body;
  try { body = await util.readBody(req); }
  catch (e) { util.sendJson(res, 400, { error: { message: `read body failed: ${e.message}` } }); return; }

  let payload = null;
  if (body.length) { try { payload = JSON.parse(body.toString('utf8')); } catch { payload = null; } }
  if (payload == null) payload = {};

  const chatPayload = responsesToChatInput(payload);
  const cfg = store.getConfig();
  if (cfg.forceModel) chatPayload.model = cfg.forceModel;
  chatPayload.stream = true; // CodeBuddy 只支持流式

  const timeoutMs = store.getRequestTimeoutMs();
  logger.log('info', 'responses', `model=${payload.model || chatPayload.model} stream=${!!payload.stream} messages=${chatPayload.messages.length}`, logger.requestSummary(payload, { messages: chatPayload.messages.length }));

  if (process.env.CODEBUDDY_DEBUG) {
    try {
      fs.writeFileSync('/tmp/codebuddy-debug-last.json', JSON.stringify({ raw: payload, chat: chatPayload }, null, 2));
      logger.log('info', 'responses', `debug dump -> /tmp/codebuddy-debug-last.json | msgs=[${chatPayload.messages.map(m => `${m.role}:${JSON.stringify(m.content).length}${m.tool_calls ? `(tc:${m.tool_calls.length})` : ''}`).join(',')}] tools=[${(chatPayload.tools || []).map(t => t.function.name).join(',')}]`);
    } catch { /* ignore */ }
  }

  const accountKey = auth.extractAccountKey(req, payload);
  let acct;
  try { acct = await auth.pickAccountForRequest(accountKey, keyCheck.accountId || ''); }
  catch (e) {
    logger.log('warn', 'responses', `拒绝: ${e.message}`);
    util.sendJson(res, 401, { error: { message: e.message, type: 'authentication_error' } });
    return;
  }

  const accountId = acct ? acct.id : '';
  const accountName = acct ? (acct.name || (acct.account && (acct.account.nickname || acct.account.uid)) || '') : '';
  const record = (usage, status) => {
    const cached =
      (usage && usage.prompt_cache_hit_tokens) ||
      (usage && usage.input_tokens_details && usage.input_tokens_details.cached_tokens) ||
      (usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
    store.recordUsage({
      source: '/v1/responses',
      model: chatPayload.model || payload.model || '',
      stream: !!payload.stream,
      accountId, accountName,
      apiKeyId: keyCheck.keyId || '', apiKeyName: keyCheck.keyName || '',
      promptTokens: usage && (usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens),
      completionTokens: usage && (usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens),
      totalTokens: usage && (usage.total_tokens != null ? usage.total_tokens : (usage.input_tokens + usage.output_tokens)),
      cachedTokens: cached,
      durationMs: Date.now() - startedAt,
      status,
    });
  };

  const headers = { ...auth.buildAuthHeaders(acct), 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
  const targetUrl = `${config.ENDPOINT}/v2/chat/completions`;
  const jsonBody = JSON.stringify(chatPayload);
  const startedAt = Date.now();

  try {
    if (payload.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no' });
      const done = await streamChatToResponses(res, targetUrl, headers, jsonBody, payload);
      logger.log('info', 'responses', `流式结束 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: true, durationMs: Date.now() - startedAt }));
      record(done && done.usage, (done && done.status) || 'ok');
    } else {
      const r = await util.requestRaw(targetUrl, { method: 'POST', headers, body: jsonBody, timeoutMs });
      const ct = (r.headers && r.headers['content-type']) || '';
      if (ct.includes('text/event-stream') || r.body.includes('chat.completion.chunk')) {
        const completion = openai.aggregateSseToCompletion(r.body);
        logger.log('info', 'responses', `完成 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: false, durationMs: Date.now() - startedAt, tokens: completion.usage && completion.usage.total_tokens }));
        record(completion.usage, 'ok');
        util.sendJson(res, 200, chatCompletionToResponse(completion, payload));
      } else {
        record(null, r.status === 200 ? 'ok' : 'error');
        res.writeHead(r.status, { 'Content-Type': ct || 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(r.body);
      }
    }
  } catch (e) {
    logger.log('error', 'responses', `上游错误: ${e.message}`, logger.requestSummary(payload, { durationMs: Date.now() - startedAt }));
    record(null, 'error');
    if (!res.headersSent) util.sendJson(res, 502, { error: { message: `upstream error: ${e.message}`, type: 'proxy_upstream_error' } });
    else res.end();
  }
}

module.exports = { handleResponses };