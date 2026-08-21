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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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

module.exports = {
  requestJson, requestRaw, pipeToClient, readBody,
  sendJson, sendHtml, sendFile, MIME_TYPES, corsHeaders,
  escapeHtml, maskedToken, genId,
};
