'use strict';

/** HTTP 路由：状态/登录/代理/管理 API/静态页面 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const config = require('./config');
const store = require('./store');
const logger = require('./logger');
const util = require('./util');
const buildState = require('./build');
const models = require('./models');
const sessionMod = require('./session');
const vscode = require('./vscode');
const auth = require('./auth');
const openai = require('./openai');
const responses = require('./responses');
const checkin = require('./checkin');

/* ============================ 状态对象 ============================ */

function accountPublic(acct) {
  if (!acct) return null;
  const a = acct.account || {};
  const au = acct.auth || {};
  return {
    id: acct.id,
    name: acct.name || '',
    source: acct.source || 'file',
    addedBy: acct.addedBy || acct.source || 'file',
    uid: a.uid || '',
    nickname: a.nickname || '',
    type: a.type || 'personal',
    enterpriseId: a.enterpriseId || '',
    domain: au.domain || config.ENDPOINT_HOST,
    expiresAt: au.expiresAt || 0,
    expiresInSeconds: au.expiresAt ? Math.round((au.expiresAt - Date.now()) / 1000) : 0,
    hasToken: !!au.accessToken,
    lastUsedAt: acct.lastUsedAt || 0,
    useCount: acct.useCount || 0,
    createdAt: acct.createdAt || 0,
  };
}

function statusObject() {
  const pool = sessionMod.getPoolConfig();
  const active = sessionMod.getActiveAccount();
  const a = active ? active.account : null;
  return {
    loggedIn: sessionMod.isLoggedIn(),
    source: sessionMod.getSessionSource(),
    endpoint: config.ENDPOINT,
    baseUrl: `http://${config.HOST}:${config.PORT}`,
    openaiBaseUrl: `http://${config.HOST}:${config.PORT}/v1`,
    pool: Object.assign({}, pool),
    accounts: sessionMod.listAccounts().map(accountPublic),
    account: a ? { uid: a.uid, nickname: a.nickname, type: a.type, enterpriseId: a.enterpriseId || '' } : null,
    auth: active ? {
      accessToken: util.maskedToken(active.auth.accessToken),
      refreshToken: util.maskedToken(active.auth.refreshToken),
      domain: active.auth.domain || config.ENDPOINT_HOST,
      expiresAt: active.auth.expiresAt || 0,
      expiresInSeconds: active.auth.expiresAt ? Math.round((active.auth.expiresAt - Date.now()) / 1000) : 0,
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
      build: buildState.getBuildState(),
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
  const b = buildState.getBuildState();
  const title = b.built ? '管理页面已过期' : '管理页面尚未构建';
  const body = b.built
    ? '检测到前端源码更新，但尚未重新构建。<br>请先运行:  <b>npm install && npm run build</b><br>然后重启服务。'
    : '请先运行:  <b>npm install && npm run build</b><br>然后重启服务。';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>CodeBuddy API Proxy</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f1115;color:#e6e8eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}pre{background:#1b1f24;padding:20px 24px;border-radius:10px;line-height:1.7;border:1px solid #2a2f36}</style>
</head><body><pre>${title}。
${body}</pre></body></html>`;
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

  /* ---- API 密钥管理 ---- */
  if (pathname === '/api/keys' && method === 'GET') {
    util.sendJson(res, 200, { keys: store.listApiKeysPublic(), enabled: store.clientKeyVerificationEnabled() });
    return;
  }
  if (pathname === '/api/keys' && method === 'POST') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const r = store.addApiKey({ name: body && body.name, key: body && body.key });
      if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
      logger.log('info', 'config', `新增 API 密钥: ${r.key.name}`);
      util.sendJson(res, 200, { key: r.key });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `新增密钥失败: ${e.message}` } });
    }
    return;
  }
  if (pathname.startsWith('/api/keys/regenerate/') && method === 'POST') {
    const id = decodeURIComponent(pathname.slice('/api/keys/regenerate/'.length));
    const r = store.regenerateApiKey(id);
    if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
    logger.log('info', 'config', `重新生成 API 密钥: ${r.key.name}`);
    util.sendJson(res, 200, { key: r.key });
    return;
  }
  if (pathname.startsWith('/api/keys/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/keys/'.length));
    const r = store.removeApiKey(id);
    if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
    logger.log('info', 'config', `删除 API 密钥: ${id}`);
    util.sendJson(res, 200, { ok: true, id });
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
  if (pathname === '/api/stats') {
    const s = store.stats();
    s.usage = store.usageTotals();
    util.sendJson(res, 200, s);
    return;
  }

  /* ---- 用量记录 ---- */
  if (pathname === '/api/usage' && method === 'GET') {
    const q = {
      from: u.searchParams.get('from') || '',
      to: u.searchParams.get('to') || '',
      accountId: u.searchParams.get('accountId') || '',
      apiKeyId: u.searchParams.get('apiKeyId') || '',
      model: u.searchParams.get('model') || '',
      status: u.searchParams.get('status') || '',
      limit: u.searchParams.get('limit') || '50',
      offset: u.searchParams.get('offset') || '0',
    };
    util.sendJson(res, 200, store.queryUsage(q));
    return;
  }
  if (pathname === '/api/usage/stats' && method === 'GET') {
    const dimension = u.searchParams.get('dimension') === 'apiKey' ? 'apiKey' : 'account';
    const result = store.usageStatsByDay({
      dimension,
      from: u.searchParams.get('from') || '',
      to: u.searchParams.get('to') || '',
    });
    util.sendJson(res, 200, { dimension, ...result, totals: store.usageTotals() });
    return;
  }

  /* ---- 从 VSCode 导入登录态 ---- */
  if (pathname === '/api/import-vscode') {
    // 已添加过（来源为 vscode）则不再重复导入
    if (sessionMod.listAccounts().some(function (a) { return a.source === 'vscode'; })) {
      util.sendJson(res, 200, { ok: false, alreadyAdded: true, error: '已从 VSCode 插件读取过账号，无需重复导入' });
      return;
    }
    const r = vscode.readVscodeSession();
    if (r && r.session) {
      const acct = sessionMod.addAccount({
        name: '',
        source: 'vscode',
        addedBy: 'vscode',
        account: r.session.account,
        auth: r.session.auth,
        accounts: r.session.accounts || [],
        lastUsedAt: 0,
        useCount: 0,
        createdAt: Date.now(),
      });
      logger.log('info', 'auth', `已从 VSCode (${r.source}) 导入登录态，策略: ${r.strategy}`);
      util.sendJson(res, 200, { ok: true, source: r.source, strategy: r.strategy, account: acct ? acct.account : null });
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
      const name = u.searchParams.get('name') || '';
      auth.pendingLogins.set(data.state, { status: 'pending', startedAt: Date.now(), name });
      auth.completeLogin(data.state, name);
      util.sendJson(res, 200, { state: data.state, authUrl: data.authUrl });
    } catch (e) { util.sendJson(res, 502, { error: e.message }); }
    return;
  }

  if (pathname === '/login/status' && method === 'GET') {
    const state = u.searchParams.get('state');
    if (!state) { util.sendJson(res, 400, { error: '缺少 state 参数' }); return; }
    const entry = auth.pendingLogins.get(state);
    if (!entry) { util.sendJson(res, 404, { error: '未知 state' }); return; }
    if (entry.status === 'success') { util.sendJson(res, 200, { status: 'success', accountId: entry.accountId, account: entry.account }); auth.pendingLogins.delete(state); return; }
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

  /* ---- 账号池管理 ---- */
  if (pathname === '/api/accounts' && method === 'GET') {
    const pool = sessionMod.getPoolConfig();
    const accounts = sessionMod.listAccounts().map(accountPublic);
    util.sendJson(res, 200, { pool, accounts });
    return;
  }

  if (pathname === '/api/accounts/login' && method === 'POST') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const name = (body && typeof body.name === 'string') ? body.name.trim() : '';
      const data = await auth.fetchAuthState();
      auth.pendingLogins.set(data.state, { status: 'pending', startedAt: Date.now(), name });
      auth.completeLogin(data.state, name);
      util.sendJson(res, 200, { state: data.state, authUrl: data.authUrl, name });
    } catch (e) { util.sendJson(res, 502, { error: e.message }); }
    return;
  }

  if (pathname === '/api/accounts/login/status' && method === 'GET') {
    const state = u.searchParams.get('state');
    if (!state) { util.sendJson(res, 400, { error: '缺少 state 参数' }); return; }
    const entry = auth.pendingLogins.get(state);
    if (!entry) { util.sendJson(res, 404, { error: '未知 state' }); return; }
    if (entry.status === 'success') { util.sendJson(res, 200, { status: 'success', accountId: entry.accountId, account: entry.account }); auth.pendingLogins.delete(state); return; }
    if (entry.status === 'error') { util.sendJson(res, 200, { status: 'error', error: entry.error }); auth.pendingLogins.delete(state); return; }
    if (Date.now() - entry.startedAt > config.LOGIN_TIMEOUT_MS) { entry.status = 'timeout'; util.sendJson(res, 200, { status: 'timeout', error: '登录超时' }); auth.pendingLogins.delete(state); return; }
    util.sendJson(res, 200, { status: 'pending' });
    return;
  }

  if (pathname === '/api/accounts/import' && method === 'POST') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const refreshToken = (body && typeof body.refreshToken === 'string') ? body.refreshToken.trim() : '';
      const name = (body && typeof body.name === 'string') ? body.name.trim() : '';
      const domain = (body && typeof body.domain === 'string') ? body.domain.trim() : '';
      if (!refreshToken) { util.sendJson(res, 400, { error: { message: 'refreshToken 不能为空' } }); return; }
      const acct = await auth.importByRefreshToken(refreshToken, name, domain);
      util.sendJson(res, 200, { account: accountPublic(acct) });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: '导入失败: ' + e.message } });
    }
    return;
  }

  if (pathname === '/api/pool' && method === 'GET') {
    util.sendJson(res, 200, sessionMod.getPoolConfig());
    return;
  }
  if (pathname === '/api/pool' && method === 'PUT') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const patch = {};
      if (body.mode === 'pool' || body.mode === 'pinned') patch.mode = body.mode;
      if (typeof body.strategy === 'string' && body.strategy) patch.strategy = body.strategy;
      if (body.pinnedId !== undefined) patch.pinnedId = body.pinnedId || null;
      const pool = sessionMod.setPoolConfig(patch);
      logger.log('info', 'config', '账号池配置已更新', pool);
      util.sendJson(res, 200, pool);
    } catch (e) {
      util.sendJson(res, 400, { error: { message: '更新失败: ' + e.message } });
    }
    return;
  }

  if (pathname.startsWith('/api/accounts/') && method === 'PUT' && !pathname.includes('/login')) {
    const id = decodeURIComponent(pathname.slice('/api/accounts/'.length));
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      if (typeof body.name !== 'string' || !body.name.trim()) { util.sendJson(res, 400, { error: { message: 'name 不能为空' } }); return; }
      const acct = sessionMod.updateAccount(id, { name: body.name });
      if (!acct) { util.sendJson(res, 404, { error: { message: '未找到该账号' } }); return; }
      logger.log('info', 'config', '账号已重命名: ' + acct.name);
      util.sendJson(res, 200, accountPublic(acct));
    } catch (e) {
      util.sendJson(res, 400, { error: { message: '重命名失败: ' + e.message } });
    }
    return;
  }

  if (pathname.startsWith('/api/accounts/') && method === 'DELETE' && !pathname.includes('/login')) {
    const id = decodeURIComponent(pathname.slice('/api/accounts/'.length));
    const removed = sessionMod.removeAccount(id);
    if (!removed) { util.sendJson(res, 404, { error: { message: '未找到该账号' } }); return; }
    logger.log('info', 'auth', '账号已删除: ' + id);
    util.sendJson(res, 200, { ok: true, id });
    return;
  }

  /* ---- 每日签到（可指定账号） ---- */
  if (pathname === '/api/checkin/status' && method === 'GET') {
    try {
      const accountId = u.searchParams.get('accountId') || '';
      const r = await checkin.checkinStatus(accountId);
      if (!r.ok) { util.sendJson(res, 502, { error: { message: r.error || '查询签到状态失败' } }); return; }
      util.sendJson(res, 200, r);
    } catch (e) {
      const status = e && e.status === 404 ? 404 : 502;
      util.sendJson(res, status, { error: { message: '查询签到状态失败: ' + e.message } });
    }
    return;
  }
  if (pathname === '/api/checkin' && method === 'POST') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const accountId = (body && typeof body.accountId === 'string' && body.accountId) ? body.accountId : '';
      const r = await checkin.dailyCheckin(accountId);
      if (!r.ok) { util.sendJson(res, 502, { error: { message: r.error || '签到失败' } }); return; }
      util.sendJson(res, 200, r);
    } catch (e) {
      const status = e && e.status === 404 ? 404 : 502;
      util.sendJson(res, status, { error: { message: '签到失败: ' + e.message } });
    }
    return;
  }

  /* ---- 模型列表（内置 + 自定义合并） ---- */
  if (pathname === '/v1/models') {
    const keyCheck = auth.verifyClientKey(req);
    if (!keyCheck.ok) { util.sendJson(res, 401, { error: { message: keyCheck.message, type: 'authentication_error' } }); return; }
    util.sendJson(res, 200, models.modelsResponse(store.listModels()));
    return;
  }
  if (pathname === '/models' && method === 'GET') {
    const accept = String(req.headers.accept || '');
    if (accept.includes('text/html')) { serveIndex(res); return; }
    const keyCheck = auth.verifyClientKey(req);
    if (!keyCheck.ok) { util.sendJson(res, 401, { error: { message: keyCheck.message, type: 'authentication_error' } }); return; }
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