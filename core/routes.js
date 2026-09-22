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
const checkinScheduler = require('./checkinScheduler');
const credits = require('./credits');
const adminAuth = require('./adminAuth');
const updater = require('./update');
const live = require('./live');

/* ============================ 状态对象 ============================ */

/** 自更新互斥标志：git pull + build 是重操作，禁止并发触发 */
let updateInFlight = false;

/**
 * 当前 HTTP server 句柄。自更新需要重启进程时，必须先把它关掉以释放端口，
 * 否则新进程会 EADDRINUSE。由 core/index.js 在 listen 后注入。
 */
let activeServer = null;
function setActiveServer(server) { activeServer = server; }

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
    autoCheckin: acct.autoCheckin === undefined ? true : !!acct.autoCheckin,
    frozen: !!acct.frozen,
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
    models: models.allModels(store.listModels(), store.getHiddenModels()),
  };
}

/* ============================ 系统配置 ============================ */

function accountsPayload() {
  const pool = sessionMod.getPoolConfig();
  const states = store.listCheckinStates();
  const autoCheckin = store.autoCheckinEnabled();
  const unhealthyMap = {};
  for (const u of sessionMod.listUnhealthy()) unhealthyMap[u.accountId] = u;
  const accounts = sessionMod.listAccounts().map(function (acct) {
    const pub = accountPublic(acct);
    const st = states[acct.id];
    pub.checkinLastDate = st ? st.lastDate : '';
    pub.checkinNextAt = st ? st.nextAt : 0;
    // 可用性：冻结（持久化）优先展示，其次是失败转移留下的临时冷却（内存态）
    if (pub.frozen) {
      pub.unhealthy = { until: 0, reason: 'frozen' };
    } else {
      const u = unhealthyMap[acct.id];
      pub.unhealthy = u ? { until: u.until, reason: u.reason } : null;
    }
    // 是否参与池轮询（冻结或冷却中都不参与）
    pub.selectable = !sessionMod.isAccountBlocked(acct);
    // 额度缓存（内存态，由调度器刷新）：供策略与前端展示
    const q = sessionMod.getQuotaCache(acct.id);
    pub.usageLeft = q ? q.usageLeft : null;
    pub.usageTotal = q ? q.usageTotal : null;
    pub.todayUsed = q ? q.todayUsed : null;
    return pub;
  });
  return { pool, accounts, autoCheckin, quotaReady: sessionMod.hasQuotaData() };
}

function parseBoolFlag(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

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
      models: models.allModels(store.listModels(), store.getHiddenModels()).map((m) => ({ id: m.id, name: m.name, hidden: !!m.hidden })),
    },
  };
}

/* ============================ 静态 / SPA ============================ */

function distMissingHtml() {
  const b = buildState.getBuildState();
  const title = b.built ? '管理页面已过期' : '管理页面尚未构建';
  const body = b.built
    ? '检测到前端源码更新，但尚未重新构建。<br>请先运行:  <b>pnpm install && pnpm run build</b><br>然后重启服务。'
    : '请先运行:  <b>pnpm install && pnpm run build</b><br>然后重启服务。';
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

  /* ---- 管理页鉴权守卫（开启时拦截所有管理接口/页面） ---- */
  const guardResult = adminAuth.guard(req, pathname, method);
  if (guardResult) {
    if (guardResult.__renew) {
      // 滑动续期成功，写回刷新后的 Cookie
      const c = adminAuth.cookieString(config.ADMIN_COOKIE, guardResult.__renew.token, { expiresAt: guardResult.__renew.expiresAt });
      res.setHeader('Set-Cookie', c);
    } else {
      util.sendJson(res, guardResult.status, guardResult.body);
      return;
    }
  }

  /* ---- 管理页鉴权：登录 / 登出 / 状态 / 改密 ---- */
  if (pathname === '/api/admin/status' && method === 'GET') {
    const authed = adminAuth.verifySession(req).ok;
    const resp = {
      enabled: store.adminAuthEnabled(),
      configured: store.adminConfigured(),
      authenticated: authed,
    };
    // 仅在已登录时返回用户名，避免向未认证的爆破者泄露账号名
    if (authed) resp.username = config.ADMIN_USERNAME;
    util.sendJson(res, 200, resp);
    return;
  }

  if (pathname === '/api/admin/login' && method === 'POST') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!password) { util.sendJson(res, 400, { error: { message: '密码不能为空' } }); return; }
      const uname = username || config.ADMIN_USERNAME;
      const rate = adminAuth.rateCheck(req, uname);
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfterSec));
        util.sendJson(res, 429, { error: { message: '登录失败次数过多，请稍后再试' } });
        return;
      }
      const v = store.verifyAdminPassword(uname, password);
      if (!v.ok) {
        adminAuth.rateRecordFailure(req, uname);
        logger.log('warn', 'auth', `管理页登录失败: ${uname}`);
        util.sendJson(res, 401, { error: { message: '用户名或密码错误' } });
        return;
      }
      adminAuth.rateReset(req, uname);
      const ua = String(req.headers['user-agent'] || '');
      const ip = adminAuth.clientIp(req);
      const sess = store.createAdminSession(uname, { userAgent: ua, ip });
      const cookie = adminAuth.cookieString(config.ADMIN_COOKIE, sess.token, { expiresAt: sess.expiresAt });
      res.setHeader('Set-Cookie', cookie);
      logger.log('info', 'auth', `管理页登录成功: ${uname}`);
      util.sendJson(res, 200, { ok: true, mustChange: v.mustChange, expiresAt: sess.expiresAt });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `登录失败: ${e.message}` } });
    }
    return;
  }

  if (pathname === '/api/admin/logout' && (method === 'POST' || method === 'GET')) {
    const token = adminAuth.extractToken(req);
    if (token) store.revokeAdminSession(token);
    const cookie = adminAuth.cookieString(config.ADMIN_COOKIE, '', { expiresAt: 0 });
    res.setHeader('Set-Cookie', cookie);
    logger.log('info', 'auth', '管理页已退出登录');
    util.sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/admin/change-password' && method === 'POST') {
    const v = adminAuth.verifySession(req);
    if (!v.ok) { util.sendJson(res, 401, { error: { message: '未登录或会话已失效', type: 'admin_auth_required' } }); return; }
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const next = typeof body.newPassword === 'string' ? body.newPassword : '';
      if (!next || next.length < 8) { util.sendJson(res, 400, { error: { message: '新密码至少 8 位' } }); return; }
      if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) { util.sendJson(res, 400, { error: { message: '新密码需同时包含字母和数字' } }); return; }
      const cur = store.verifyAdminPassword(v.username, current);
      if (!cur.ok) { util.sendJson(res, 400, { error: { message: '当前密码错误' } }); return; }
      store.setAdminPassword(v.username, next, { mustChange: false });
      logger.log('info', 'auth', `管理页密码已修改: ${v.username}`);
      util.sendJson(res, 200, { ok: true });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `修改失败: ${e.message}` } });
    }
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

  /* ---- 版本检查 / 自更新 ---- */
  // 只读检查，可被前端轮询；apply 会真的改磁盘，用互斥锁避免并发触发
  if (pathname === '/api/update/check' && method === 'GET') {
    util.sendJson(res, 200, await updater.checkRemoteVersion());
    return;
  }
  if (pathname === '/api/update/apply' && method === 'POST') {
    if (updateInFlight) {
      util.sendJson(res, 409, { error: { message: '已有更新正在进行，请稍候' } });
      return;
    }
    updateInFlight = true;
    try {
      logger.log('info', 'system', '收到自更新请求，开始 git pull + 构建');
      const result = await updater.applyUpdate();
      if (!result.ok) {
        const failed = result.steps.find((s) => !s.ok);
        util.sendJson(res, 400, { error: { message: (failed && failed.detail) || '更新失败' }, ...result });
        return;
      }

      // 更新成功后按运行环境决定如何重启：
      //   Linux/macOS（裸进程）—— 先写回响应，再原地重启进程，用户无需操作
      //   systemd 托管        —— 不能自己 spawn（会与 Restart=always 抢端口），
      //                          提示用户执行 systemctl restart
      //   Windows             —— 同理不自动重启，提示手动 npm start
      const canRestart = updater.supportsAutoRestart();
      result.canAutoRestart = canRestart;
      result.restartRequired = true;
      result.processPlatform = process.platform;
      result.restartHint = updater.restartHint();

      // 先结束响应，确保前端能收到 ok 与步骤信息，再重启（否则连接会被中断）
      util.sendJson(res, 200, result);

      if (canRestart) {
        logger.log('info', 'system', '更新完成，准备自动重启服务');
        // 留一点时间让上面的响应真正 flush 到客户端
        setTimeout(() => {
          updater.restartService({ server: activeServer }).catch((e) => {
            logger.log('error', 'system', `自动重启失败: ${e.message}`);
          });
        }, 600);
      } else if (updater.isUnderSystemd()) {
        logger.log('info', 'system', '更新完成，服务由 systemd 托管，请执行: sudo systemctl restart codebuddy-proxy');
      } else {
        logger.log('info', 'system', '更新完成，当前系统需手动重启服务才生效');
      }
    } catch (e) {
      logger.log('error', 'system', `自更新异常: ${e.message}`);
      util.sendJson(res, 500, { error: { message: `更新异常: ${e.message}` } });
    } finally {
      updateInFlight = false;
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
      const r = store.addApiKey({ name: body && body.name, key: body && body.key, accountId: body && body.accountId });
      if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
      logger.log('info', 'config', `新增 API 密钥: ${r.key.name}`);
      util.sendJson(res, 200, { key: r.key });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `新增密钥失败: ${e.message}` } });
    }
    return;
  }
  if (pathname.startsWith('/api/keys/') && method === 'PUT') {
    const id = decodeURIComponent(pathname.slice('/api/keys/'.length));
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const accountId = (body && body.accountId !== undefined) ? String(body.accountId).trim() : '';
      const r = store.setApiKeyAccount(id, accountId);
      if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
      logger.log('info', 'config', `API 密钥账号已更新: ${r.key.name} -> ${accountId || '(账号池)'}`);
      util.sendJson(res, 200, { key: r.key });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `更新密钥账号失败: ${e.message}` } });
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

  /* ---- 实时数据（Live Monitor） ---- */
  // SSE 长连接：ready → 历史回放 → 实时推送 → 15s 注释心跳，断开时清理订阅。
  if (pathname === '/api/live/stream' && method === 'GET') {
    const limit = parseInt(u.searchParams.get('limit'), 10) || 100;
    live.subscribe(res, { limit });
    // 客户端断开（或服务端主动 end）时注销订阅 + 清心跳，避免订阅者泄漏
    const cleanup = () => live.unsubscribe(res);
    req.on('close', cleanup);
    res.on('close', cleanup);
    return;
  }
  // 一次性快照：REST 回退方案（EventSource 不可用时前端轮询用）
  if (pathname === '/api/live/events' && method === 'GET') {
    const limit = parseInt(u.searchParams.get('limit'), 10) || 50;
    util.sendJson(res, 200, { events: live.snapshot(limit), stats: live.stats() });
    return;
  }
  if (pathname === '/api/live/events' && method === 'DELETE') {
    live.clear();
    logger.log('info', 'system', '实时数据已清空');
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
    util.sendJson(res, 200, accountsPayload());
    return;
  }

  if (pathname === '/api/accounts' && method === 'PUT') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      if (body.autoCheckin === undefined) {
        util.sendJson(res, 400, { error: { message: '没有可更新的字段' } });
        return;
      }
      const on = parseBoolFlag(body.autoCheckin);
      store.setAutoCheckinEnabled(on);
      const accounts = sessionMod.listAccounts();
      for (const acct of accounts) {
        try { sessionMod.updateAccount(acct.id, { autoCheckin: on }); } catch (e) { /* ignore */ }
      }
      logger.log('info', 'config', '全局自动签到已' + (on ? '开启' : '关闭'));
      if (on) {
        try { await checkinScheduler.tick(); } catch (e) { /* ignore */ }
      }
      util.sendJson(res, 200, accountsPayload());
    } catch (e) {
      util.sendJson(res, 400, { error: { message: '更新失败: ' + e.message } });
    }
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
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        util.sendJson(res, 400, { error: { message: '请求体必须是 JSON 对象' } });
        return;
      }
      // 只透传白名单字段，具体校验在 sessionMod.setPoolConfig 内完成
      const allowed = ['mode', 'strategy', 'pinnedId', 'stickyEnabled', 'stickyTtlMin',
        'stickyGranularity', 'switchEnabled', 'switchIntervalMin', 'switchJitterMin',
        'quotaRefreshMin', 'failoverEnabled'];
      const patch = {};
      for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
      if (!Object.keys(patch).length) {
        util.sendJson(res, 400, { error: { message: '没有可更新的字段' } });
        return;
      }
      const pool = sessionMod.setPoolConfig(patch);
      logger.log('info', 'config', '账号池配置已更新', pool);
      util.sendJson(res, 200, pool);
    } catch (e) {
      util.sendJson(res, 400, { error: { message: '更新失败: ' + e.message } });
    }
    return;
  }

  /** 当前活跃的会话绑定（排查「为什么这个任务用了某个账号」用） */
  if (pathname === '/api/pool/sessions' && method === 'GET') {
    try {
      const accounts = sessionMod.listAccounts();
      const nameOf = {};
      for (const a of accounts) nameOf[a.id] = a.name || (a.account && a.account.uid) || a.id;
      const bindings = store.listSessionBindings().map(function (b) {
        return {
          sessionKey: b.sessionKey,
          accountId: b.accountId,
          accountName: nameOf[b.accountId] || '(已删除)',
          boundAt: b.boundAt,
          lastSeenAt: b.lastSeenAt,
          reqCount: b.reqCount,
        };
      });
      // 冻结（持久化）与冷却（内存态）合并为同一份「未参与轮询的账号」列表
      const unavailable = sessionMod.listAccounts()
        .filter(function (a) { return sessionMod.isAccountBlocked(a); })
        .map(function (a) {
          const u = sessionMod.getUnhealthy(a.id);
          const frozen = sessionMod.isFrozen(a);
          return {
            accountId: a.id,
            accountName: nameOf[a.id] || a.id,
            frozen,
            reason: frozen ? 'frozen' : (u ? u.reason : ''),
            until: !frozen && u ? u.until : 0,
          };
        });
      util.sendJson(res, 200, {
        bindings,
        unavailable,
        // 兼容旧前端字段：仅保留非冻结的冷却项
        unhealthy: unavailable
          .filter(function (u) { return !u.frozen; })
          .map(function (u) { return { accountId: u.accountId, accountName: u.accountName, until: u.until, reason: u.reason }; }),
      });
    } catch (e) {
      util.sendJson(res, 500, { error: { message: e.message } });
    }
    return;
  }

  if (pathname.startsWith('/api/accounts/') && method === 'PUT' && !pathname.includes('/login')) {
    const id = decodeURIComponent(pathname.slice('/api/accounts/'.length));
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const patch = {};
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) { util.sendJson(res, 400, { error: { message: 'name 不能为空' } }); return; }
        patch.name = body.name;
      }
      if (body.autoCheckin !== undefined) patch.autoCheckin = parseBoolFlag(body.autoCheckin);
      if (body.frozen !== undefined) patch.frozen = parseBoolFlag(body.frozen);
      if (!Object.keys(patch).length) { util.sendJson(res, 400, { error: { message: '没有可更新的字段' } }); return; }
      const acct = sessionMod.updateAccount(id, patch);
      if (!acct) { util.sendJson(res, 404, { error: { message: '未找到该账号' } }); return; }
      if (patch.name) logger.log('info', 'config', '账号已重命名: ' + acct.name);
      if (patch.autoCheckin !== undefined) logger.log('info', 'config', '账号自动签到已' + (patch.autoCheckin ? '开启' : '关闭') + ': ' + acct.name);
      if (patch.frozen !== undefined) {
        // 冻结等价于无限期冷却：解冻时顺手清掉失败转移留下的临时冷却标记
        if (patch.frozen) {
          sessionMod.markUnhealthy(id, 365 * 24 * 60 * 60 * 1000, 'frozen:manual');
        } else {
          sessionMod.markHealthy(id);
        }
        logger.log('info', 'config', '账号已' + (patch.frozen ? '冻结' : '解冻') + ': ' + acct.name);
      }
      util.sendJson(res, 200, accountPublic(acct));
    } catch (e) {
      util.sendJson(res, 400, { error: { message: '更新账号失败: ' + e.message } });
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

  /* ---- 积分余额（可指定账号） ---- */
  if (pathname === '/api/credits' && method === 'GET') {
    try {
      const accountId = u.searchParams.get('accountId') || '';
      const r = await credits.getCredits(accountId);
      if (!r.ok) { util.sendJson(res, 502, { error: { message: r.error || '查询积分余额失败' } }); return; }
      util.sendJson(res, 200, r);
    } catch (e) {
      const status = e && e.status === 404 ? 404 : 502;
      util.sendJson(res, status, { error: { message: '查询积分余额失败: ' + e.message } });
    }
    return;
  }

  /* ---- 模型列表（内置 + 自定义合并） ---- */
  if (pathname === '/v1/models') {
    const keyCheck = auth.verifyClientKey(req);
    if (!keyCheck.ok) { util.sendJson(res, keyCheck.rateLimited ? 429 : 401, { error: { message: keyCheck.message, type: 'authentication_error' } }); return; }
    util.sendJson(res, 200, models.modelsResponse(store.listModels(), store.getHiddenModels()));
    return;
  }
  if (pathname === '/models' && method === 'GET') {
    const accept = String(req.headers.accept || '');
    if (accept.includes('text/html')) { serveIndex(res); return; }
    const keyCheck = auth.verifyClientKey(req);
    if (!keyCheck.ok) { util.sendJson(res, keyCheck.rateLimited ? 429 : 401, { error: { message: keyCheck.message, type: 'authentication_error' } }); return; }
    util.sendJson(res, 200, models.modelsResponse(store.listModels(), store.getHiddenModels()));
    return;
  }

  /* ---- 自定义模型管理 API ---- */
  if (pathname === '/api/models' && method === 'GET') {
    util.sendJson(res, 200, { models: models.allModels(store.listModels(), store.getHiddenModels()) });
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
  if (pathname.startsWith('/api/models/') && method === 'PUT' && pathname.endsWith('/hidden')) {
    const id = decodeURIComponent(pathname.slice('/api/models/'.length, -'/hidden'.length));
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const hidden = body && (body.hidden === true || body.hidden === 'true' || body.hidden === 1 || body.hidden === '1');
      const r = store.setModelHidden(id, hidden);
      if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
      logger.log('info', 'config', (hidden ? '隐藏模型: ' : '显示模型: ') + id);
      util.sendJson(res, 200, { ok: true, id, hidden });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: '更新模型隐藏状态失败: ' + e.message } });
    }
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
  // 兜底：SSE 长连接之外的路径若意外挂上了订阅（例如未来新增的收尾分支），
  // 这里保证订阅者集合不会被写坏的 res 长期占住。
  live.unsubscribe(res);
}

module.exports = { route, statusObject, setActiveServer };