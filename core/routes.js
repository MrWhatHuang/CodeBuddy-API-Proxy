'use strict';

/** HTTP 路由：状态/登录/代理/管理 API/静态页面 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const config = require('./config');
const store = require('./store');
const logger = require('./logger');
const util = require('./util');
const models = require('./models');
const sessionMod = require('./session');
const vscode = require('./vscode');
const auth = require('./auth');
const openai = require('./openai');
const responses = require('./responses');

/* ============================ 状态对象 ============================ */

function statusObject() {
  const session = sessionMod.getSession();
  const a = session ? session.account : null;
  const au = session ? session.auth : null;
  return {
    loggedIn: sessionMod.isLoggedIn(),
    source: sessionMod.getSessionSource(),
    endpoint: config.ENDPOINT,
    baseUrl: `http://${config.HOST}:${config.PORT}`,
    openaiBaseUrl: `http://${config.HOST}:${config.PORT}/v1`,
    account: a ? { uid: a.uid, nickname: a.nickname, type: a.type, enterpriseId: a.enterpriseId || '' } : null,
    auth: au ? {
      accessToken: util.maskedToken(au.accessToken),
      refreshToken: util.maskedToken(au.refreshToken),
      domain: au.domain || config.ENDPOINT_HOST,
      expiresAt: au.expiresAt || 0,
      expiresInSeconds: au.expiresAt ? Math.round((au.expiresAt - Date.now()) / 1000) : 0,
    } : null,
    models: models.allModels(store.listModels()),
  };
}

/* ============================ 系统配置 ============================ */

function configResponse() {
  return {
    values: store.publicValues(),
    runtime: {
      version: config.VERSION,
      port: config.PORT,
      host: config.HOST,
      endpoint: config.ENDPOINT,
      platform: config.PLATFORM,
      sessionFile: config.SESSION_FILE,
      dbFile: config.DB_FILE,
      dataDir: config.DATA_DIR,
    },
    options: {
      levels: config.LOG_LEVELS,
      categories: config.LOG_CATEGORIES,
      models: models.allModels(store.listModels()).map((m) => ({ id: m.id, name: m.name })),
    },
  };
}

/* ============================ 静态 / SPA ============================ */

function distMissingHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>CodeBuddy API Proxy</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f1115;color:#e6e8eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}pre{background:#1b1f24;padding:20px 24px;border-radius:10px;line-height:1.7;border:1px solid #2a2f36}</style>
</head><body><pre>管理页面尚未构建。
请先运行:  <b>npm install && npm run build</b>
然后重启服务。</pre></body></html>`;
}

function serveIndex(res) {
  const indexFile = path.join(config.DIST_DIR, 'index.html');
  if (fs.existsSync(indexFile)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    fs.createReadStream(indexFile).pipe(res);
  } else {
    util.sendHtml(res, 200, distMissingHtml());
  }
}

/** 服务 dist 静态资源；非文件路径（无扩展名）回退到 SPA index.html */
function serveDist(res, pathname) {
  if (pathname === '/') { serveIndex(res); return; }
  const rel = pathname.replace(/^\/+/, '');
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(config.DIST_DIR, safe);
  if (!filePath.startsWith(config.DIST_DIR) || safe.includes('..')) {
    util.sendJson(res, 404, { error: { message: 'Not Found' } });
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    util.sendFile(res, filePath);
    return;
  }
  if (!path.extname(safe)) {
    serveIndex(res); // SPA 路由回退
    return;
  }
  util.sendJson(res, 404, { error: { message: `Not Found: ${pathname}` } });
}

/* ============================ 路由 ============================ */

async function route(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = u.pathname;
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, util.corsHeaders());
    res.end();
    return;
  }

  /* ---- 健康检查 ---- */
  if (pathname === '/health') { util.sendJson(res, 200, { ok: true, loggedIn: sessionMod.isLoggedIn() }); return; }

  /* ---- 状态 ---- */
  if (pathname === '/api/status') { util.sendJson(res, 200, statusObject()); return; }

  /* ---- 系统配置 ---- */
  if (pathname === '/api/config' && method === 'GET') { util.sendJson(res, 200, configResponse()); return; }
  if (pathname === '/api/config' && method === 'PUT') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const patch = store.applyPublicPatch(body);
      if (!Object.keys(patch).length) { util.sendJson(res, 400, { error: { message: '没有可更新的配置项' } }); return; }
      store.setConfig(patch);
      logger.log('info', 'config', `配置已更新: ${Object.keys(patch).join(', ')}`, patch);
      util.sendJson(res, 200, configResponse());
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `配置更新失败: ${e.message}` } });
    }
    return;
  }

  /* ---- 日志 ---- */
  if (pathname === '/api/logs' && method === 'GET') {
    const q = {
      level: u.searchParams.get('level') || '',
      category: u.searchParams.get('category') || '',
      q: u.searchParams.get('q') || '',
      from: u.searchParams.get('from') || '',
      to: u.searchParams.get('to') || '',
      limit: u.searchParams.get('limit') || '100',
      offset: u.searchParams.get('offset') || '0',
    };
    util.sendJson(res, 200, store.queryLogs(q));
    return;
  }
  if (pathname === '/api/logs' && method === 'DELETE') {
    store.clearLogs();
    logger.log('info', 'system', '日志已清空');
    util.sendJson(res, 200, { ok: true });
    return;
  }

  /* ---- 日志统计 ---- */
  if (pathname === '/api/stats') { util.sendJson(res, 200, store.stats()); return; }

  /* ---- 从 VSCode 导入登录态 ---- */
  if (pathname === '/api/import-vscode') {
    const r = vscode.readVscodeSession();
    if (r && r.session) {
      sessionMod.setSession(r.session, 'vscode');
      sessionMod.saveSession();
      logger.log('info', 'auth', `已从 VSCode (${r.source}) 导入登录态，策略: ${r.strategy}`);
      util.sendJson(res, 200, { ok: true, source: r.source, strategy: r.strategy, account: sessionMod.getSession().account });
    } else {
      util.sendJson(res, 200, { ok: false, error: '未能在 VSCode 中找到有效的 CodeBuddy 登录态' });
    }
    return;
  }

  /* ---- 会话 ---- */
  if (pathname === '/session') {
    if (!sessionMod.isLoggedIn()) { util.sendJson(res, 401, { error: { message: '未登录', type: 'authentication_error' } }); return; }
    util.sendJson(res, 200, statusObject());
    return;
  }

  /* ---- 登录 ---- */
  if (pathname === '/login/state' && method === 'GET') {
    try {
      const data = await auth.fetchAuthState();
      auth.pendingLogins.set(data.state, { status: 'pending', startedAt: Date.now() });
      auth.completeLogin(data.state);
      util.sendJson(res, 200, { state: data.state, authUrl: data.authUrl });
    } catch (e) { util.sendJson(res, 502, { error: e.message }); }
    return;
  }

  if (pathname === '/login/status' && method === 'GET') {
    const state = u.searchParams.get('state');
    if (!state) { util.sendJson(res, 400, { error: '缺少 state 参数' }); return; }
    const entry = auth.pendingLogins.get(state);
    if (!entry) { util.sendJson(res, 404, { error: '未知 state' }); return; }
    if (entry.status === 'success') { util.sendJson(res, 200, { status: 'success', account: entry.account }); auth.pendingLogins.delete(state); return; }
    if (entry.status === 'error') { util.sendJson(res, 200, { status: 'error', error: entry.error }); auth.pendingLogins.delete(state); return; }
    if (Date.now() - entry.startedAt > config.LOGIN_TIMEOUT_MS) { entry.status = 'timeout'; util.sendJson(res, 200, { status: 'timeout', error: '登录超时' }); auth.pendingLogins.delete(state); return; }
    util.sendJson(res, 200, { status: 'pending' });
    return;
  }

  if (pathname === '/api/logout' && (method === 'POST' || method === 'GET')) {
    sessionMod.clearSession();
    logger.log('info', 'auth', '已退出登录');
    util.sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/logout' && (method === 'GET' || method === 'POST')) {
    sessionMod.clearSession();
    logger.log('info', 'auth', '已退出登录');
    res.writeHead(302, { Location: '/home' });
    res.end();
    return;
  }

  /* ---- 模型列表（内置 + 自定义合并） ---- */
  if (pathname === '/v1/models') { util.sendJson(res, 200, models.modelsResponse(store.listModels())); return; }
  if (pathname === '/models' && method === 'GET') {
    const accept = String(req.headers.accept || '');
    if (accept.includes('text/html')) { serveIndex(res); return; }
    util.sendJson(res, 200, models.modelsResponse(store.listModels()));
    return;
  }

  /* ---- 自定义模型管理 API ---- */
  if (pathname === '/api/models' && method === 'GET') {
    util.sendJson(res, 200, { models: models.allModels(store.listModels()) });
    return;
  }
  if (pathname === '/api/models' && method === 'POST') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const r = store.addModel(body);
      if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
      logger.log('info', 'config', `新增自定义模型: ${r.model.id}`, r.model);
      util.sendJson(res, 200, { model: r.model });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `新增模型失败: ${e.message}` } });
    }
    return;
  }
  if (pathname.startsWith('/api/models/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/models/'.length));
    const r = store.removeModel(id);
    if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
    if (!r.deleted) { util.sendJson(res, 404, { error: { message: '未找到该模型' } }); return; }
    logger.log('info', 'config', `删除自定义模型: ${id}`);
    util.sendJson(res, 200, { ok: true, id });
    return;
  }

  /* ---- Responses API ---- */
  if (method === 'POST' && (pathname === '/v1/responses' || pathname === '/responses')) { await responses.handleResponses(req, res); return; }

  /* ---- OpenAI 兼容转发 ---- */
  if (method === 'POST' && openai.UPSTREAM_MAP[pathname]) { await openai.handleProxy(req, res, pathname); return; }

  /* ---- 静态资源 / SPA（仅 GET，且不拦截 API / 代理路径） ---- */
  if (method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/v1/') && !pathname.startsWith('/v2/')) {
    serveDist(res, pathname);
    return;
  }

  util.sendJson(res, 404, { error: { message: `Not Found: ${method} ${pathname}` } });
}

module.exports = { route, statusObject };
