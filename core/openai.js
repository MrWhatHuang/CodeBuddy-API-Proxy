'use strict';

/** OpenAI 兼容转发：/v1/chat/completions、/v1/completions、/v1/embeddings */

const config = require('./config');
const store = require('./store');
const logger = require('./logger');
const util = require('./util');
const auth = require('./auth');

const UPSTREAM_MAP = {
  '/v1/chat/completions': '/v2/chat/completions',
  '/v1/completions': '/v2/completions',
  '/v1/embeddings': '/v2/embeddings',
  '/v2/chat/completions': '/v2/chat/completions',
  '/v2/completions': '/v2/completions',
  '/v2/embeddings': '/v2/embeddings',
};

/** 把 CodeBuddy 的 SSE 流聚合成一个 OpenAI 非流式 chat.completion 响应 */
function aggregateSseToCompletion(sseText) {
  const chunks = [];
  for (const rawLine of sseText.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { chunks.push(JSON.parse(data)); } catch { /* skip malformed */ }
  }

  let id = ''; let model = ''; let created = 0; let finishReason = 'stop'; let usage = null;
  let content = ''; let reasoning = '';
  const toolCalls = {};

  for (const c of chunks) {
    if (c.id) id = c.id;
    if (c.model) model = c.model;
    if (c.created) created = c.created;
    if (c.usage) usage = c.usage;
    const choice = (c.choices || [])[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index || 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.type) toolCalls[idx].type = tc.type;
        if (tc.function) {
          if (tc.function.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
    }
  }

  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  const toolCallList = Object.keys(toolCalls).sort().map((k) => toolCalls[k]);
  if (toolCallList.length) {
    message.tool_calls = toolCallList.map((tc) => ({
      id: tc.id, type: tc.type, function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }

  return {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

async function handleProxy(req, res, pathname) {
  const upstreamPath = UPSTREAM_MAP[pathname];
  if (!upstreamPath) return false;

  let body;
  try { body = await util.readBody(req); }
  catch (e) { util.sendJson(res, 400, { error: { message: `read body failed: ${e.message}` } }); return true; }

  let payload = null;
  if (body.length) { try { payload = JSON.parse(body.toString('utf8')); } catch { payload = null; } }
  if (payload == null) payload = {};

  const cfg = store.getConfig();
  const timeoutMs = store.getRequestTimeoutMs();
  if (cfg.forceModel) payload.model = cfg.forceModel;
  else if (!payload.model) payload.model = cfg.defaultModel || 'default';

  const isStream = payload.stream === true;
  const isChat = upstreamPath === '/v2/chat/completions';
  const needAggregate = isChat && !isStream;

  if (needAggregate) payload.stream = true;
  const jsonBody = JSON.stringify(payload);

  const accountKey = auth.extractAccountKey(req, payload);
  let acct;
  try { acct = await auth.pickAccountForRequest(accountKey); }
  catch (e) {
    logger.log('warn', 'proxy', `${pathname} 拒绝: ${e.message}`, { pathname, model: payload.model });
    util.sendJson(res, 401, { error: { message: e.message, type: 'authentication_error' } });
    return true;
  }

  const headers = {
    ...auth.buildAuthHeaders(acct),
    'Content-Type': 'application/json',
    'Accept': (isStream || needAggregate) ? 'text/event-stream' : 'application/json',
  };
  const targetUrl = `${config.ENDPOINT}${upstreamPath}`;
  const startedAt = Date.now();

  try {
    if (needAggregate) {
      const r = await util.requestRaw(targetUrl, { method: 'POST', headers, body: jsonBody, timeoutMs });
      const ct = (r.headers && r.headers['content-type']) || '';
      if (ct.includes('text/event-stream') || r.body.includes('chat.completion.chunk')) {
        const completion = aggregateSseToCompletion(r.body);
        logger.log('info', 'proxy', `${pathname} 完成 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: false, status: 200, durationMs: Date.now() - startedAt, tokens: completion.usage && completion.usage.total_tokens }));
        util.sendJson(res, 200, completion);
      } else {
        logger.log('warn', 'proxy', `${pathname} 上游非流式响应 ${r.status}`, logger.requestSummary(payload, { status: r.status, durationMs: Date.now() - startedAt }));
        res.writeHead(r.status, { 'Content-Type': ct || 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(r.body);
      }
    } else if (isStream) {
      await util.pipeToClient(res, targetUrl, {
        method: 'POST', headers, body: jsonBody,
        extraHeaders: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
      });
      logger.log('info', 'proxy', `${pathname} 流式结束 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: true, durationMs: Date.now() - startedAt }));
    } else {
      const r = await util.requestJson(targetUrl, { method: 'POST', headers, body: jsonBody, timeoutMs });
      logger.log('info', 'proxy', `${pathname} 完成 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: false, status: r.status, durationMs: Date.now() - startedAt }));
      res.writeHead(r.status, {
        'Content-Type': (r.headers && r.headers['content-type']) || 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(r.body);
    }
  } catch (e) {
    logger.log('error', 'proxy', `${pathname} 上游错误: ${e.message}`, logger.requestSummary(payload, { stream: isStream, durationMs: Date.now() - startedAt }));
    if (!res.headersSent) util.sendJson(res, 502, { error: { message: `upstream error: ${e.message}`, type: 'proxy_upstream_error' } });
    else res.end();
  }
  return true;
}

module.exports = { UPSTREAM_MAP, aggregateSseToCompletion, handleProxy };