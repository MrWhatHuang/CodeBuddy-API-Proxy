'use strict';

/** OpenAI 兼容转发：/v1/chat/completions、/v1/completions、/v1/embeddings */

const config = require('./config');
const store = require('./store');
const logger = require('./logger');
const util = require('./util');
const auth = require('./auth');
const sessionMod = require('./session');
const live = require('./live');
// 仅用于复用请求体日志（logRequestBody 内部按配置判断是否写入，无循环依赖：
// responses.js 引用 openai.js 的 aggregateSseToCompletion 是运行时延迟引用）
const responses = require('./responses');

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

  const keyCheck = auth.verifyClientKey(req);
  if (!keyCheck.ok) {
    const status = keyCheck.rateLimited ? 429 : 401;
    util.sendJson(res, status, { error: { message: keyCheck.message, type: 'authentication_error' } });
    return true;
  }

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
  // 完整请求体日志（默认关闭，见「系统配置 → 记录完整请求体」）
  responses.logRequestBody('proxy', pathname, payload, null);
  const jsonBody = JSON.stringify(payload);

  const accountKey = auth.extractAccountKey(req, payload);
  // 会话粘性：算出本请求属于哪个会话，让同一任务始终用同一账号
  const sessionEnd = auth.isSessionEnd(req, payload);
  const sessionKey = auth.extractSessionKey(req, payload, keyCheck.keyId || '', sessionEnd);
  let acct;
  try { acct = await auth.pickAccountForRequest(accountKey, keyCheck.accountId || '', { sessionKey }); }
  catch (e) {
    logger.log('warn', 'proxy', `${pathname} 拒绝: ${e.message}`, { pathname, model: payload.model });
    util.sendJson(res, 401, { error: { message: e.message, type: 'authentication_error' } });
    return true;
  }

  let accountId = acct ? acct.id : '';
  let accountName = acct ? (acct.name || (acct.account && (acct.account.nickname || acct.account.uid)) || '') : '';

  // 实时数据埋点：payload 已定稿（含 model/stream），accountId/accountName 也已确定。
  // 注意必须放在 accountId/accountName 声明之后，否则会触发 TDZ 错误。
  live.publish({
    source: pathname,
    kind: 'openai',
    model: payload.model || '',
    stream: isStream,
    accountId,
    accountName,
    apiKeyId: keyCheck.keyId || '',
    apiKeyName: keyCheck.keyName || '',
    headers: util.clientHeaders(req),
    ...util.parseBodyForLive(body),
  });

  // 记录一次用量
  const record = (usage, status) => {
    store.recordUsage({
      source: pathname,
      model: payload.model || '',
      stream: !!payload.stream,
      accountId, accountName,
      apiKeyId: keyCheck.keyId || '', apiKeyName: keyCheck.keyName || '',
      promptTokens: usage && usage.prompt_tokens,
      completionTokens: usage && usage.completion_tokens,
      totalTokens: usage && usage.total_tokens,
      cachedTokens: usage && (usage.prompt_cache_hit_tokens || (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)),
      durationMs: Date.now() - startedAt,
      status,
    });
  };

  /**
   * 上游返回错误时：标记账号不健康 + 尝试换号重试一次（失败转移）。
   * 仅在「还未向客户端写任何数据」时才允许重试，否则只能原样透传。
   * 成功后会把外层的 acct / accountId / accountName 更新为新账号。
   * @returns {Promise<{acct: object}|null>} 换号成功返回新账号，否则 null
   */
  const tryFailover = async (status, bodyText) => {
    if (!res.headersSent && auth.recordUpstreamFailure(accountId, status, bodyText)) {
      try {
        const next = await auth.pickFailoverAccount(accountId, sessionKey);
        if (next) {
          logger.log('warn', 'proxy', `${pathname} 换号重试: ${accountName} → ${next.name || next.id}`);
          acct = next;                       // 同步更新，后续 buildAuthHeaders(acct) 才用新账号
          accountId = next.id;
          accountName = next.name || (next.account && (next.account.nickname || next.account.uid)) || '';
          return { acct: next };
        }
      } catch (e2) {
        logger.log('warn', 'proxy', `${pathname} 换号失败: ${e2.message}`);
      }
    }
    return null;
  };

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
        auth.recordUpstreamSuccess(accountId);
        const completion = aggregateSseToCompletion(r.body);
        logger.log('info', 'proxy', `${pathname} 完成 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: false, status: 200, durationMs: Date.now() - startedAt, tokens: completion.usage && completion.usage.total_tokens }));
        record(completion.usage, 'ok');
        util.sendJson(res, 200, completion);
      } else if (r.status !== 200 && await tryFailover(r.status, r.body)) {
        // 换号重试（失败转移）：用新账号（acct 已被 tryFailover 更新）再发一次，仍按 SSE 聚合处理
        const retryHeaders = {
          ...auth.buildAuthHeaders(acct),
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        };
        const retry = await util.requestRaw(targetUrl, { method: 'POST', headers: retryHeaders, body: jsonBody, timeoutMs });
        const rct = (retry.headers && retry.headers['content-type']) || '';
        if (retry.status === 200 && (rct.includes('text/event-stream') || retry.body.includes('chat.completion.chunk'))) {
          auth.recordUpstreamSuccess(accountId);
          const completion = aggregateSseToCompletion(retry.body);
          logger.log('info', 'proxy', `${pathname} 换号后完成 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: false, status: 200, durationMs: Date.now() - startedAt, tokens: completion.usage && completion.usage.total_tokens }));
          record(completion.usage, 'ok');
          util.sendJson(res, 200, completion);
          return true;
        }
        auth.recordUpstreamFailure(accountId, retry.status, retry.body);
        record(null, 'error');
        res.writeHead(retry.status, { 'Content-Type': rct || 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(retry.body);
      } else {
        if (r.status === 200) auth.recordUpstreamSuccess(accountId); else auth.recordUpstreamFailure(accountId, r.status, r.body);
        logger.log('warn', 'proxy', `${pathname} 上游非流式响应 ${r.status}`, logger.requestSummary(payload, { status: r.status, durationMs: Date.now() - startedAt }));
        record(null, r.status === 200 ? 'ok' : 'error');
        res.writeHead(r.status, { 'Content-Type': ct || 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(r.body);
      }
    } else if (isStream) {
      await util.pipeSseToClient(res, targetUrl, {
        method: 'POST', headers, body: jsonBody,
        extraHeaders: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
      }, ({ usage, status, httpStatus, errorBody }) => {
        // 流已开始写数据后无法重试，这里只做健康度记账
        if (status === 'error' || (httpStatus && httpStatus !== 200)) {
          auth.recordUpstreamFailure(accountId, httpStatus || 0, errorBody || '');
        } else {
          auth.recordUpstreamSuccess(accountId);
        }
        record(usage, status);
      });
      logger.log('info', 'proxy', `${pathname} 流式结束 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: true, durationMs: Date.now() - startedAt }));
    } else {
      const r = await util.requestJson(targetUrl, { method: 'POST', headers, body: jsonBody, timeoutMs });
      if (r.status === 200) auth.recordUpstreamSuccess(accountId);
      else if (await tryFailover(r.status, r.body)) {
        // acct 已被 tryFailover 换成新账号，用新账号重建请求头重试
        const retryHeaders = { ...auth.buildAuthHeaders(acct), 'Content-Type': 'application/json', 'Accept': 'application/json' };
        const retry = await util.requestJson(targetUrl, { method: 'POST', headers: retryHeaders, body: jsonBody, timeoutMs });
        if (retry.status === 200) auth.recordUpstreamSuccess(accountId); else auth.recordUpstreamFailure(accountId, retry.status, retry.body);
        logger.log('info', 'proxy', `${pathname} 换号后完成 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: false, status: retry.status, durationMs: Date.now() - startedAt }));
        record(retry.json && retry.json.usage, retry.status === 200 ? 'ok' : 'error');
        res.writeHead(retry.status, {
          'Content-Type': (retry.headers && retry.headers['content-type']) || 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(retry.body);
        return true;
      }
      logger.log('info', 'proxy', `${pathname} 完成 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: false, status: r.status, durationMs: Date.now() - startedAt }));
      record(r.json && r.json.usage, r.status === 200 ? 'ok' : 'error');
      res.writeHead(r.status, {
        'Content-Type': (r.headers && r.headers['content-type']) || 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(r.body);
    }
  } catch (e) {
    logger.log('error', 'proxy', `${pathname} 上游错误: ${e.message}`, logger.requestSummary(payload, { stream: isStream, durationMs: Date.now() - startedAt }));
    record(null, 'error');
    if (!res.headersSent) util.sendJson(res, 502, { error: { message: `upstream error: ${e.message}`, type: 'proxy_upstream_error' } });
    else res.end();
  } finally {
    // 会话结束：释放绑定，让下一个任务可以换账号
    if (sessionKey && sessionEnd) sessionMod.releaseSession(sessionKey);
  }
  return true;
}

module.exports = { UPSTREAM_MAP, aggregateSseToCompletion, handleProxy };