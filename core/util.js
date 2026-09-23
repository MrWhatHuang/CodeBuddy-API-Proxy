'use strict';

/** 通用工具：HTTP 请求封装、响应发送、字符串工具等 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

/** JSON 请求，返回 { status, headers, body, json } */
function requestJson(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (payload != null && !finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
    if (payload != null) finalHeaders['Content-Length'] = Buffer.byteLength(payload);

    const req = mod.request(u, { method, headers: finalHeaders, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode || 0, headers: res.headers, body: text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** 原始请求，返回 { status, headers, body } 字符串（用于收集 SSE 流） */
function requestRaw(urlStr, { method = 'POST', headers = {}, body = null, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (payload != null && !finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
    if (payload != null) finalHeaders['Content-Length'] = Buffer.byteLength(payload);

    const req = mod.request(u, { method, headers: finalHeaders, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** 把上游响应透传给客户端（用于 SSE 流式转发） */
function pipeToClient(clientRes, urlStr, { method = 'POST', headers = {}, body = null, extraHeaders = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (payload != null && !finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
    if (payload != null) finalHeaders['Content-Length'] = Buffer.byteLength(payload);

    const upstream = mod.request(u, { method, headers: finalHeaders }, (upRes) => {
      const respHeaders = { ...(upRes.headers || {}), ...extraHeaders };
      clientRes.writeHead(upRes.statusCode || 502, respHeaders);
      upRes.pipe(clientRes);
      upRes.on('end', resolve);
      upRes.on('error', reject);
    });
    upstream.on('error', (e) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: { message: `upstream error: ${e.message}`, type: 'proxy_upstream_error' } }));
      }
      reject(e);
    });
    if (payload != null) upstream.write(payload);
    upstream.end();
  });
}

/**
 * 把上游 SSE 流转发到客户端，同时解析其中的 token 用量。
 * onDone({ usage, status }) 在流结束时回调。usage 为 OpenAI chat.completion.chunk 里的 usage 对象。
 * 兼容 `stream_options.include_usage` 的最后一块，也兼容流结束后单独追加的 usage 块。
 */
function pipeSseToClient(clientRes, urlStr, { method = 'POST', headers = {}, body = null, extraHeaders = {} }, onDone) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (payload != null && !finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
    if (payload != null) finalHeaders['Content-Length'] = Buffer.byteLength(payload);

    let usage = null;
    let status = 'ok';
    let httpStatus = 0;
    let errorBody = '';
    const report = () => { if (onDone) try { onDone({ usage, status, httpStatus, errorBody }); } catch { /* ignore */ } };

    const upstream = mod.request(u, { method, headers: finalHeaders }, (upRes) => {
      const respHeaders = { ...(upRes.headers || {}), ...extraHeaders };
      clientRes.writeHead(upRes.statusCode || 502, respHeaders);
      httpStatus = upRes.statusCode || 0;
      if (upRes.statusCode !== 200) status = 'error';

      let buf = '';
      upRes.setEncoding('utf8');
      upRes.on('data', (chunk) => {
        buf += chunk;
        // 边写边解析，尽量低延迟转发
        clientRes.write(chunk);
        // 非 200 时把响应体留作错误诊断（用于识别额度/鉴权类错误），不额外缓存成功流
        if (httpStatus !== 200 && errorBody.length < 4096) errorBody += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const obj = JSON.parse(data);
              if (obj && obj.usage) usage = obj.usage;
            } catch { /* skip */ }
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
            try {
              const obj = JSON.parse(data);
              if (obj && obj.usage) usage = obj.usage;
            } catch { /* skip */ }
          }
        }
        clientRes.end();
        report();
        resolve();
      });
      upRes.on('error', (e) => { status = 'error'; report(); reject(e); });
    });
    upstream.on('error', (e) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: { message: `upstream error: ${e.message}`, type: 'proxy_upstream_error' } }));
      }
      status = 'error';
      report();
      reject(e);
    });
    if (payload != null) upstream.write(payload);
    upstream.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 「实时数据」请求头白名单：只下发这些无关机密的头，其余一律不下发 */
const LIVE_HEADER_WHITELIST = [
  'content-type', 'accept', 'authorization', 'x-api-key', 'user-agent', 'host',
  'content-length', 'x-session-id', 'x-codebuddy-account', 'x-account-id', 'x-account-name',
];
/** 请求头值的展示上限，避免超长 UA / Cookie 撑爆事件 */
const LIVE_HEADER_VALUE_MAX = 512;

/**
 * 请求体脱敏：这些键名的值一律替换成 '***'。
 * 客户端凭据可能出现在请求体里（Continue / Cline / Roo 等客户端会发 api_key / authToken），
 * 而本代理会把这些字段原样转发给上游，因此实时面板必须同样脱敏，否则
 * GET /api/live/events 会把明文密钥回显。
 * 只匹配「整段等于或结尾等于」这些词，避免误伤 max_tokens、tokens 之类的正常字段。
 */
const LIVE_SECRET_KEY_RE = /(^|_|\b)(api[_-]?key|apikey|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|client[_-]?secret|cookie|token)$/i;
/**
 * 值形如已知密钥前缀的长串：即使键名不在上面的名单里也脱敏。
 * 含本项目自己的 `cb-<48hex>` 形态（store.js 的 generateApiKey）——客户端把配置
 * dump 进请求体时，会把一把仍然有效的密钥写进 ring buffer，这里一并拦掉。
 */
const LIVE_SECRET_VALUE_RE = /^(sk|pk|cb|cbp|ghp|gho|xox[baprs])[-_][A-Za-z0-9_\-]{8,}$/;
const LIVE_MASK = '***';
const LIVE_MASK_DEPTH = 12;

/** 递归脱敏：命中敏感键名或密钥样式值的一律替换为 '***' */
function maskSecrets(value, depth) {
  if (depth > LIVE_MASK_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, depth + 1));
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (LIVE_SECRET_KEY_RE.test(k)) { out[k] = LIVE_MASK; continue; }
    if (typeof v === 'string' && LIVE_SECRET_VALUE_RE.test(v)) { out[k] = LIVE_MASK; continue; }
    out[k] = maskSecrets(v, depth + 1);
  }
  return out;
}

/** 收集客户端请求头（白名单 + 脱敏），供「实时数据」展示 */
function clientHeaders(req) {
  const out = {};
  try {
    const h = (req && req.headers) || {};
    for (const key of LIVE_HEADER_WHITELIST) {
      const raw = h[key];
      if (raw === undefined || raw === null) continue;
      // authorization / x-api-key 一律改写，绝不回显任何真实密钥
      if (key === 'authorization' || key === 'x-api-key') { out[key] = '***'; continue; }
      const value = Array.isArray(raw) ? raw.join(', ') : String(raw);
      out[key] = value.length > LIVE_HEADER_VALUE_MAX ? value.slice(0, LIVE_HEADER_VALUE_MAX) : value;
    }
  } catch { /* 请求头异常不能影响代理主流程 */ }
  return out;
}

/**
 * 按 UTF-8 字节数安全截断字符串：不切碎多字节字符，返回结果 <= maxBytes 字节。
 * Buffer#subarray 会在字符中间切断，残留字节解码为 U+FFFD（3 字节），
 * 使「截断后」反而比上限更大，所以需要根据末字节判断需要回退几个字节。
 * （与 core/responses.js 的同名逻辑一致，这里独立实现以免跨模块耦合）
 */
function truncateUtf8Bytes(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(text);
  if (buf.length <= maxBytes) return text;

  // 从 maxBytes 往前找第一个 UTF-8 前导字节（非 10xxxxxx 续字节），
  // 并确认该字符的完整字节数能放进 maxBytes，否则继续回退。
  let end = maxBytes;
  while (end > 0) {
    const b = buf[end];
    if (b === undefined || (b & 0xc0) !== 0x80) break; // 找到下一个字符的起始
    end--;
  }
  return buf.subarray(0, end).toString('utf8');
}

/**
 * 把 Buffer / string 安全转成可发送的 { body, bodyText, bodyBytes, truncated, parseError }。
 * 供「实时数据」事件使用：任何输入（超大 / 非 JSON / undefined）都不抛异常。
 * bodyBytes 是客户端原始请求体的真实字节数；bodyText 是实际下发的文本。
 */
function parseBodyForLive(raw) {
  const result = { body: null, bodyText: '', bodyBytes: 0, truncated: false, parseError: null };
  try {
    if (raw === undefined || raw === null) return result;

    let text;
    if (Buffer.isBuffer(raw)) {
      result.bodyBytes = raw.length;
      text = raw.toString('utf8');
    } else {
      text = typeof raw === 'string' ? raw : String(raw);
      result.bodyBytes = Buffer.byteLength(text);
    }

    const maxBytes = 1024 * 1024; // MAX_BODY_BYTES：单条事件上限 1MB
    if (result.bodyBytes > maxBytes) {
      result.truncated = true;
      text = truncateUtf8Bytes(text, maxBytes);
    }
    result.bodyText = text;

    // 空体（比如没有 body 的请求）不算错误，body 保持 null
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text);
        // 只接受对象/数组：`123` / `"str"` 这类合法但无意义的 JSON 视为 body=null
        if (parsed && typeof parsed === 'object') {
          // 脱敏后再下发：body 与 bodyText 必须同源，否则前端「原始/美化」切换会漏出明文
          const masked = maskSecrets(parsed, 0);
          result.body = masked;
          result.bodyText = JSON.stringify(masked);
        } else {
          result.parseError = '请求体不是 JSON 对象/数组';
        }
      } catch (e) {
        result.parseError = `JSON 解析失败: ${(e && e.message) || 'unknown'}`;
      }
    }
  } catch (e) {
    // 兜底：任何意外都不向调用方抛异常，否则代理主流程会被埋点带崩
    result.parseError = `解析请求体失败: ${(e && e.message) || 'unknown'}`;
  }
  return result;
}

function corsHeaders() {
  let origin = '*';
  try { origin = require('./store').getCorsOrigin() || '*'; } catch { /* store 尚未就绪 */ }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...corsHeaders(),
  });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() });
  res.end(html);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** 以正确的 MIME 流式返回一个静态文件 */
function sendFile(res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      sendJson(res, 404, { error: { message: 'Not Found' } });
      return;
    }
    const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': st.size,
      ...corsHeaders(),
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function maskedToken(tok) {
  if (!tok) return '';
  if (tok.length <= 8) return '***';
  return `${tok.slice(0, 6)}…${tok.slice(-4)}`;
}

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * 把客户端传来的「思考强度」归一化成上游唯一认识的 `reasoning_effort` 字符串。
 *
 * CodeBuddy 上游（Go）把该字段声明为 string：
 *   - 传 bool / number / 对象 / 数组 → 400 11101 "cannot unmarshal ... into Go struct
 *     field Request.reasoning_effort of type string"
 *   - 完全不传、传 null 或传空串  → 200，但**不会返回 reasoning_content**（思考默认关闭）
 *   - 传任意非空字符串（官方插件用 low/medium/high）→ 200 且正常返回 reasoning_content
 *
 * 官方插件（tencent-cloud.coding-copilot）的做法是：先由模型配置的
 * reasoning.supportedEfforts / effort / defaultEffort 解析出 effort，再写进
 * providerOptions，最终作为 `reasoning_effort` 发出；解析不出 effort 时**整个字段不发**。
 *
 * 这里兼容各家客户端的不同传法：
 *   reasoning_effort: "high" | reasoning: {effort:"high"} | reasoning_effort: 1..5
 * 并丢弃非字符串/空值，避免把 bool 之类的值透传上去撞 400。
 *
 * @param {object} payload 客户端原始请求体
 * @returns {string|undefined} 归一化后的 effort；无法解析时返回 undefined（调用方应删除该字段）
 */
function normalizeReasoningEffort(payload) {
  if (!payload || typeof payload !== 'object') return undefined;

  // 数字档位（部分客户端用 1-5 表示强度）映射到上游认的字符串
  const LEVELS = { 1: 'minimal', 2: 'low', 3: 'medium', 4: 'high', 5: 'high' };
  const fromNumber = (n) => (Number.isFinite(n) ? LEVELS[Math.round(n)] : undefined);

  const candidates = [
    payload.reasoning_effort,
    payload.reasoningEffort,
    payload.reasoning && typeof payload.reasoning === 'object' ? payload.reasoning.effort : payload.reasoning,
    payload.thinking && typeof payload.thinking === 'object' ? payload.thinking.effort : undefined,
  ];

  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim()) {
      const v = raw.trim();
      // 上游对 "none"/"off" 等并非真的关闭思考（实测仍会返回 reasoning_content），
      // 统一按「关闭」处理，由调用方解析成 undefined。
      if (['none', 'off', 'disabled', 'false'].includes(v.toLowerCase())) continue;
      return v;
    }
    if (typeof raw === 'number') {
      const mapped = fromNumber(raw);
      if (mapped) return mapped;
    }
  }
  return undefined;
}

/**
 * 客户端是否**显式**表达了「思考开关」（无论开还是关）。
 *
 * 用于区分两种「解析不出 effort」：
 *   - 客户端压根没提 reasoning/thinking → 应回落到配置的默认档位；
 *   - 客户端显式传了 "" / null / false / {type:"disabled"} → 用户想关掉思考，
 *     不应再套用默认档位，否则关不掉。
 */
function hasExplicitReasoningIntent(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if ('reasoning_effort' in payload || 'reasoningEffort' in payload) return true;
  if ('reasoning' in payload && payload.reasoning != null) return true;
  if ('thinking' in payload && payload.thinking != null) return true;
  if ('enableThinking' in payload && payload.enableThinking != null) return true;
  return false;
}

/**
 * 客户端是否显式要求「关闭思考」。
 * 覆盖 reasoning_effort:""|"none"|"off"、"reasoning":null|false、
 * thinking:{type:"disabled"} 等常见写法。
 */
function isReasoningDisabled(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const vals = [payload.reasoning_effort, payload.reasoningEffort, payload.reasoning, payload.thinking, payload.enableThinking];
  for (const v of vals) {
    if (v === false || v === null) return true;
    if (typeof v === 'string' && ['', 'none', 'off', 'disabled', 'false'].includes(v.trim().toLowerCase())) return true;
    if (v && typeof v === 'object') {
      if (v.enabled === false || v.disabled === true) return true;
      if (typeof v.type === 'string' && ['disabled', 'none', 'off'].includes(v.type.trim().toLowerCase())) return true;
      if (v.effort != null && typeof v.effort === 'string' && ['', 'none', 'off', 'disabled'].includes(v.effort.trim().toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * 客户端是否显式要求「打开思考」但没给出具体档位。
 * 例如 reasoning_effort:true、thinking:{type:"enabled"}、reasoning:{enabled:true}。
 * 这类请求意图明确为「开」，应套用默认档位，而不是被当成解析失败而丢掉。
 */
function isReasoningEnabled(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const vals = [payload.reasoning_effort, payload.reasoningEffort, payload.reasoning, payload.thinking, payload.enableThinking];
  for (const v of vals) {
    if (v === true) return true;
    if (v && typeof v === 'object') {
      if (v.enabled === true || v.disabled === false) return true;
      if (typeof v.type === 'string' && ['enabled', 'auto', 'on', 'true'].includes(v.type.trim().toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * 就地规范化 payload 中的思考相关字段，供上游请求直接使用。
 * 返回本次实际启用的 effort（无则 undefined）。
 *
 * 注意：一律删除客户端原始字段，只保留一个干净的 `reasoning_effort` 字符串，
 * 否则残留的 bool/对象会被上游 Go 反序列化拒绝。
 */
function applyReasoningEffort(payload) {
  const effort = normalizeReasoningEffort(payload);
  // 清掉所有可能被上游拒绝的别名/原字段
  delete payload.reasoning;
  delete payload.reasoningEffort;
  delete payload.thinking;
  delete payload.enableThinking;
  if (effort) payload.reasoning_effort = effort;
  else delete payload.reasoning_effort;
  return effort;
}

/**
 * 清理 payload 中的思考字段并解析出最终要发给上游的 effort。
 *
 * 规则（与官方插件一致：解析不出 effort 就不发该字段）：
 *   1. 客户端显式要求关闭 → 不发 reasoning_effort（思考关闭）
 *   2. 客户端给了可解析的强度 → 用客户端的值
 *   3. 客户端没提这件事 → 用 defaultEffort（为空则不发，保持上游默认行为）
 *
 * @param {object} payload 待清洗的请求体（就地修改）
 * @param {string} [defaultEffort] 未指定时使用的默认强度
 * @returns {string|undefined} 实际写入的 effort
 */
function resolveReasoningEffort(payload, defaultEffort) {
  const explicit = normalizeReasoningEffort(payload);
  const disabled = isReasoningDisabled(payload);
  const enabled = isReasoningEnabled(payload);
  const mentioned = hasExplicitReasoningIntent(payload);

  // 注意：以下 delete 会清掉原始字段，所以上面几个判断必须在删除之前完成。
  // 清掉所有会被上游拒绝的别名/原字段（bool、对象等）
  delete payload.reasoning;
  delete payload.reasoningEffort;
  delete payload.thinking;
  delete payload.enableThinking;
  delete payload.reasoning_effort;

  let effort;
  if (explicit) effort = explicit;                 // 客户端显式强度优先
  else if (disabled) effort = undefined;           // 显式关思考 → 不发该字段
  else if (enabled || !mentioned) {
    // 显式「开」但没给档位，或压根没提 → 用默认档位
    effort = normalizeReasoningEffort({ reasoning: { effort: defaultEffort } });
  } else {
    effort = undefined;                            // 提了但无法解析（如只给 max_tokens）→ 不发
  }

  if (effort) payload.reasoning_effort = effort;
  return effort;
}

/**
 * 把 OpenAI 的 `developer` 角色就地改写成 `system`。
 *
 * 上游 CodeBuddy **不认 `developer` 角色**：
 *   - `role: "system"`    → 200
 *   - `role: "developer"` → 400 11128 "Illegal API invocation from an unapproved channel"
 *
 * 这个坑很容易踩到，因为下游客户端会在「模型支持思考」时自动把系统提示词
 * 发成 `developer`：pi-ai（dsh 的 LLM 层）的判断是
 *   `useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`
 * 而 `supportsDeveloperRole` 对自定义 baseURL 网关默认为 true，于是
 * 「自定义网关 + 推理模型」必然发出 `developer`，请求必 400。
 *
 * `developer` 与 `system` 在 OpenAI 语义里是同一角色的新旧名字（前者只是
 * 取代后者），且本地上游只区分「系统提示词」与「对话消息」，改写不丢信息：
 * 顺序与内容都原样保留，只换角色名。`/v1/responses` 路径早已做过同样的映射
 * （见 responses.js 的 `responsesToChatInput`），这里补齐 chat 路径。
 *
 * @param {object} payload 待清洗的请求体（就地修改）
 * @returns {number} 被改写的消息条数（0 表示无需改写）
 */
function normalizeDeveloperRole(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  if (!Array.isArray(payload.messages)) return 0;

  let changed = 0;
  for (const msg of payload.messages) {
    if (msg && typeof msg === 'object' && msg.role === 'developer') {
      msg.role = 'system';
      changed++;
    }
  }
  return changed;
}

module.exports = {
  requestJson, requestRaw, pipeToClient, pipeSseToClient, readBody,
  clientHeaders, parseBodyForLive,
  sendJson, sendHtml, sendFile, MIME_TYPES, corsHeaders,
  escapeHtml, maskedToken, genId,
  normalizeReasoningEffort, applyReasoningEffort,
  hasExplicitReasoningIntent, isReasoningDisabled, isReasoningEnabled, resolveReasoningEffort,
  normalizeDeveloperRole,
};
