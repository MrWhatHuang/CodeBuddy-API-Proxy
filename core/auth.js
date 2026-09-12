'use strict';

/** 认证逻辑：请求头构建、账号级 token 刷新、OAuth 登录流程（多账号池） */

const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');
const util = require('./util');
const store = require('./store');
const sessionMod = require('./session');
const adminAuth = require('./adminAuth');

const pendingLogins = new Map();

function buildNoAuthHeaders() {
  return {
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    'X-Domain': config.ENDPOINT_HOST,
    'User-Agent': 'CodeBuddy-Proxy/1.0',
  };
}

function authPath(sub) { return config.ENDPOINT + '/v2' + config.PREFIX_PATH + sub; }

function isExpiring(auth) { return sessionMod.isExpiringAuth(auth); }

/** 刷新指定账号的 token，并写回池 */
async function refreshToken(acct) {
  if (!acct || !acct.auth || !acct.auth.refreshToken) throw new Error('无 refreshToken，需要重新登录');
  const headers = {
    'X-Refresh-Token': acct.auth.refreshToken,
    'X-Auth-Refresh-Source': 'plugin',
    'X-Domain': acct.auth.domain || config.ENDPOINT_HOST,
    'Content-Type': 'application/json',
    'User-Agent': 'CodeBuddy-Proxy/1.0',
  };
  const r = await util.requestJson(authPath('/auth/token/refresh'), { method: 'POST', headers, body: {}, timeoutMs: 30000 });
  const data = r.json && r.json.data;
  if (r.json && r.json.code === 0 && data && data.accessToken) {
    const oldAuth = acct.auth;
    data.lastRefreshTime = Date.now();
    if (!data.expiresAt && data.expiresIn) data.expiresAt = Date.now() + data.expiresIn * 1000;
    if (!data.refreshToken) data.refreshToken = oldAuth.refreshToken;
    if (!data.domain) data.domain = oldAuth.domain;
    acct.auth = data;
    sessionMod.updateAccount(acct.id, { auth: data });
    logger.log('info', 'auth', 'accessToken 已刷新: ' + (acct.name || acct.account.uid));
    return acct.auth;
  }
  throw new Error('刷新 token 失败: ' + (r.json ? (r.json.msg || r.json.code) : r.body));
}

/** 校验并（必要时）刷新某个账号，返回该账号对象 */
async function getValidAccount(acct) {
  if (!acct) throw new Error('未登录，请先打开管理页登录');
  if (!acct.auth || !acct.auth.accessToken) throw new Error('账号「' + (acct.name || acct.account.uid) + '」无有效 token');
  if (isExpiring(acct.auth)) {
    try { await refreshToken(acct); }
    catch (e) { logger.log('warn', 'auth', '自动刷新失败（继续用旧 token 尝试）: ' + e.message); }
  }
  return acct;
}

/** 兼容旧接口：返回「活跃账号」并校验 */
async function getValidSession() {
  if (!sessionMod.isLoggedIn()) throw new Error('未登录，请先打开管理页登录');
  const acct = sessionMod.getActiveAccount();
  return getValidAccount(acct);
}

/**
 * 根据请求选择账号并校验。
 * 优先级：header/body 显式指定 > 关闭池模式（pinned 强制账号）> 密钥绑定账号 > 账号池（含会话粘性）。
 * @param {string} [explicitKey] 来自 header/body 的显式账号指定
 * @param {string} [keyAccountId] API 密钥绑定的账号 id（空 = 未绑定）
 * @param {object} [opts] { sessionKey } 会话指纹（为空则不做粘性）
 */
async function pickAccountForRequest(explicitKey, keyAccountId, opts) {
  const pool = sessionMod.getPoolConfig();
  const sessionKey = (opts && opts.sessionKey) || '';
  let acct = null;
  if (explicitKey) {
    acct = sessionMod.findAccountByIdOrName(explicitKey);
  } else if (pool.mode === 'pinned' && pool.pinnedId) {
    acct = sessionMod.getAccount(pool.pinnedId);
  } else if (keyAccountId) {
    acct = sessionMod.findAccountByIdOrName(keyAccountId);
  } else {
    acct = sessionMod.pickAccount(null, sessionKey);
  }
  if (!acct) throw new Error('未登录，请先打开管理页登录');
  const valid = await getValidAccount(acct);
  sessionMod.markUsed(valid.id);
  return valid;
}

/**
 * 从上一次失败的账号换到另一个账号（失败转移）。
 * 返回新账号或 null（无可换账号 / 未开启失败转移）。
 * @param {string} failedAccountId 刚失败的账号 id
 * @param {string} sessionKey 会话指纹；换号后会把绑定改到新账号
 */
async function pickFailoverAccount(failedAccountId, sessionKey) {
  const pool = sessionMod.getPoolConfig();
  if (!pool.failoverEnabled) return null;
  // pinned / 密钥绑定场景下不换号，避免违背用户显式意图
  if (pool.mode === 'pinned' && pool.pinnedId) return null;
  const next = sessionMod.pickAccount(null, '');
  if (!next || next.id === failedAccountId) return null;
  const valid = await getValidAccount(next);
  // 会话绑定改指新账号，后续请求继续跟着新账号走
  if (sessionKey && pool.stickyEnabled) sessionMod.bindSession(sessionKey, valid.id);
  sessionMod.markUsed(valid.id);
  return valid;
}

/** 从请求中提取账号指定值（header / body），并从 payload 中移除 */
function extractAccountKey(req, payload) {
  const h = req.headers || {};
  const key = h['x-codebuddy-account'] || h['x-account-id'] || h['x-account-name'];
  if (key) return String(key).trim() || null;
  if (payload && typeof payload === 'object') {
    const v = payload.accountId || payload.accountName || payload.account;
    if (v != null && v !== '') {
      delete payload.accountId;
      delete payload.accountName;
      delete payload.account;
      return String(v).trim();
    }
  }
  return null;
}

/**
 * 计算本次请求的会话指纹（用于会话粘性）。
 * 见 sessionMod.computeSessionKey：X-Session-Id 头 > API 密钥 > 对话前缀指纹。
 * @param {object} req HTTP 请求
 * @param {object} payload 已解析的请求体（Responses 场景传转换后的 chat 结构）
 * @param {string} apiKeyId 命中的 API 密钥 id
 * @param {boolean} [sessionEnd] 客户端显式声明会话结束
 */
function extractSessionKey(req, payload, apiKeyId, sessionEnd) {
  if (sessionEnd) return '';
  const h = (req && req.headers) || {};
  const headerSessionId = h['x-session-id'] || h['x-conversation-id'] || h['x-codebuddy-session'] || '';
  const granularity = sessionMod.getPoolConfig().stickyGranularity || 'auto';
  return sessionMod.computeSessionKey({
    headerSessionId: headerSessionId ? String(headerSessionId).trim() : '',
    apiKeyId: apiKeyId || '',
    payload,
    granularity,
  });
}

/** 客户端是否显式声明「本次请求结束了一个会话」 */
function isSessionEnd(req, payload) {
  const h = (req && req.headers) || {};
  const v = h['x-session-end'];
  if (v === '1' || v === 'true') return true;
  const b = payload && typeof payload === 'object' ? payload.sessionEnd : undefined;
  if (b === true || b === 'true' || b === 1) return true;
  if (payload && typeof payload === 'object' && payload.metadata && payload.metadata.sessionEnd === true) return true;
  return false;
}

function buildAuthHeaders(acct) {
  const sess = acct || sessionMod.getActiveAccount();
  if (!sess) return {};
  const { account, auth } = sess;
  const h = { 'Authorization': 'Bearer ' + auth.accessToken, 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'CodeBuddy-Proxy/1.0' };
  if (account && account.uid) h['X-User-Id'] = account.uid;
  if (account && account.enterpriseId) { h['X-Enterprise-Id'] = account.enterpriseId; h['X-Tenant-Id'] = account.enterpriseId; }
  if (auth.domain) h['X-Domain'] = auth.domain;
  return h;
}

/* ============================ OAuth 登录流程 ============================ */

async function fetchAuthState() {
  const r = await util.requestJson(authPath('/auth/state') + '?platform=' + encodeURIComponent(config.PLATFORM), {
    method: 'POST', headers: buildNoAuthHeaders(), body: {}, timeoutMs: 15000,
  });
  const data = r.json && r.json.data;
  if (!r.json || r.json.code !== 0 || !data || !data.state || !data.authUrl) {
    throw new Error('获取登录 state 失败: ' + (r.json ? (r.json.msg || r.json.code) : r.body));
  }
  return data;
}

async function pollAuthToken(state) {
  const deadline = Date.now() + config.LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, config.LOGIN_POLL_INTERVAL_MS); });
    try {
      const r = await util.requestJson(authPath('/auth/token') + '?state=' + encodeURIComponent(state), {
        method: 'GET', headers: buildNoAuthHeaders(), timeoutMs: 15000,
      });
      const data = r.json && r.json.data;
      if (r.json && r.json.code === 0 && data && data.accessToken) {
        if (!data.expiresAt && data.expiresIn) data.expiresAt = Date.now() + data.expiresIn * 1000;
        return data;
      }
      if (r.json && r.json.code === 11217) continue;
      if (r.json && r.json.code !== 0) return { __error: '登录未完成或失败: ' + (r.json.msg || r.json.code) };
    } catch (e) { /* 网络抖动继续 */ }
  }
  return { __error: '登录超时' };
}

async function fetchAccount(state, auth) {
  const headers = Object.assign({}, buildNoAuthHeaders(), { 'Authorization': 'Bearer ' + auth.accessToken });
  delete headers['X-No-Authorization'];
  delete headers['X-No-User-Id'];
  delete headers['X-No-Enterprise-Id'];
  delete headers['X-No-Department-Info'];
  const r = await util.requestJson(authPath('/login/account') + '?state=' + encodeURIComponent(state), {
    method: 'GET', headers, timeoutMs: 15000,
  });
  if (!r.json || r.json.code !== 0 || !r.json.data) {
    throw new Error('获取账号失败: ' + (r.json ? (r.json.msg || r.json.code) : r.body));
  }
  return r.json.data;
}

async function fetchAccounts(auth) {
  const headers = { 'Authorization': 'Bearer ' + auth.accessToken, 'X-Domain': auth.domain || config.ENDPOINT_HOST, 'User-Agent': 'CodeBuddy-Proxy/1.0' };
  const r = await util.requestJson(authPath('/accounts'), { method: 'GET', headers, timeoutMs: 15000 });
  if (r.json && r.json.code === 0 && Array.isArray(r.json.data)) return r.json.data;
  return [];
}

/** 用 refresh_token 手工导入账号：换 accessToken 并拉取账号信息 */
async function importByRefreshToken(refreshToken, name, domain) {
  if (!refreshToken || typeof refreshToken !== 'string' || !refreshToken.trim()) {
    throw new Error('refreshToken 不能为空');
  }
  const rt = refreshToken.trim();
  const dom = (domain && String(domain).trim()) || config.ENDPOINT_HOST;
  const headers = {
    'X-Refresh-Token': rt,
    'X-Auth-Refresh-Source': 'plugin',
    'X-Domain': dom,
    'Content-Type': 'application/json',
    'User-Agent': 'CodeBuddy-Proxy/1.0',
  };
  const r = await util.requestJson(authPath('/auth/token/refresh'), { method: 'POST', headers, body: {}, timeoutMs: 30000 });
  const data = r.json && r.json.data;
  if (!r.json || r.json.code !== 0 || !data || !data.accessToken) {
    throw new Error('刷新失败（refresh_token 可能已失效）: ' + (r.json ? (r.json.msg || r.json.code) : r.body));
  }
  if (!data.expiresAt && data.expiresIn) data.expiresAt = Date.now() + data.expiresIn * 1000;
  if (!data.refreshToken) data.refreshToken = rt;
  if (!data.domain) data.domain = dom;
  // 拉取账号信息（accessToken 换取）
  let account = null;
  try { account = await fetchAccountByToken(data); }
  catch (e) { logger.log('warn', 'auth', '导入账号时获取账号信息失败: ' + e.message); account = { uid: '', nickname: '', type: 'personal' }; }
  const accounts = await fetchAccounts(data).catch(function () { return []; });
  const acct = sessionMod.addAccount({
    name: (name && String(name).trim()) || '',
    source: 'manual',
    addedBy: 'manual',
    account: account,
    auth: data,
    accounts: accounts,
    lastUsedAt: 0,
    useCount: 0,
    createdAt: Date.now(),
  });
  if (!acct) throw new Error('账号写入失败');
  logger.log('info', 'auth', '手工导入账号成功: ' + (acct.name || acct.account.nickname || acct.account.uid));
  return acct;
}

/** 用 accessToken 拉取当前账号信息 */
async function fetchAccountByToken(auth) {
  const headers = Object.assign({}, buildNoAuthHeaders(), { 'Authorization': 'Bearer ' + auth.accessToken });
  delete headers['X-No-Authorization'];
  delete headers['X-No-User-Id'];
  delete headers['X-No-Enterprise-Id'];
  delete headers['X-No-Department-Info'];
  const r = await util.requestJson(authPath('/login/account'), { method: 'GET', headers, timeoutMs: 15000 });
  if (!r.json || r.json.code !== 0 || !r.json.data) {
    throw new Error('获取账号失败: ' + (r.json ? (r.json.msg || r.json.code) : r.body));
  }
  return r.json.data;
}

/** 登录成功后把账号追加进池（携带 name 参数） */
async function completeLogin(state, name) {
  const entry = pendingLogins.get(state);
  try {
    const auth = await pollAuthToken(state);
    if (!auth || auth.__error) { if (entry) { entry.status = 'error'; entry.error = (auth && auth.__error) || '未知错误'; } return; }
    let account = null;
    try { account = await fetchAccount(state, auth); }
    catch (e) { logger.log('warn', 'auth', '获取账号信息失败: ' + e.message); account = { uid: '', nickname: '', type: 'personal' }; }
    const accounts = await fetchAccounts(auth).catch(function () { return []; });
    const acct = sessionMod.addAccount({
      name: (name && String(name).trim()) || '',
      source: 'oauth',
      addedBy: 'oauth',
      account: account,
      auth: auth,
      accounts: accounts,
      lastUsedAt: 0,
      useCount: 0,
      createdAt: Date.now(),
    });
    if (!acct) throw new Error('账号写入失败');
    if (entry) { entry.status = 'success'; entry.accountId = acct.id; entry.account = acct; }
    logger.log('info', 'auth', 'OAuth 登录成功: ' + (acct.name || acct.account.nickname || acct.account.uid));
  } catch (e) {
    logger.log('error', 'auth', '登录流程出错: ' + e.message);
    if (entry) { entry.status = 'error'; entry.error = e.message; }
  }
}

/**
 * 校验客户端 API 密钥。
 * 当「校验开关」开启时，请求必须携带 `Authorization: Bearer <key>` 或 `X-API-Key: <key>`，
 * 且该密钥必须是 api_keys 表（或兼容的 CODEBUDDY_API_KEY）中已存在的。
 * 返回 { ok: true, keyId, keyName, accountId } 或 { ok: false, message }。
 * 校验开关关闭时始终放行（keyId/keyName/accountId 为空）。
 */
function verifyClientKey(req) {
  if (!store.clientKeyVerificationEnabled()) return { ok: true, keyId: '', keyName: '' };
  const h = (req && req.headers) || {};
  const authHeader = String(h['authorization'] || h['Authorization'] || '');
  let provided = '';
  if (authHeader.startsWith('Bearer ')) provided = authHeader.slice(7).trim();
  else if (authHeader.startsWith('bearer ')) provided = authHeader.slice(7).trim();
  else provided = String(h['x-api-key'] || h['X-Api-Key'] || '').trim();

  if (!provided) return { ok: false, message: '缺少 API 密钥（请在 Authorization: Bearer 或 X-API-Key 头提供）' };

  // API 密钥爆破限流：按客户端 IP 持久化计数，防止对短自定义密钥无限试错
  const ip = adminAuth.clientIp(req);
  const rlKey = 'apikey:' + ip;
  const rl = store.rateLimitCheck(rlKey, { scope: 'apikey', maxFails: 20, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 });
  if (!rl.allowed) {
    return { ok: false, message: 'API 密钥校验失败次数过多，请稍后再试', rateLimited: true, retryAfterSec: rl.retryAfterSec };
  }

  const matched = store.resolveApiKey(provided);
  if (!matched) {
    store.rateLimitRecordFailure(rlKey, { scope: 'apikey', maxFails: 20, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 });
    return { ok: false, message: 'API 密钥无效' };
  }
  store.rateLimitReset(rlKey);
  return { ok: true, keyId: matched.id, keyName: matched.name, accountId: matched.accountId || '' };
}

/**
 * 记录一次上游失败，必要时把账号标记为不健康（冷却期内不再被选中）。
 * 由 openai.js / responses.js 在收到上游错误响应后调用。
 * @param {string} accountId
 * @param {number} status HTTP 状态码
 * @param {string} bodyText 响应体文本（用于识别额度类错误）
 * @returns {boolean} 是否已标记为不健康
 */
function recordUpstreamFailure(accountId, status, bodyText) {
  if (!accountId) return false;
  const text = String(bodyText || '');
  const lower = text.toLowerCase();

  // 额度耗尽 / 配额不足：冷却较久，因为短期不会恢复
  const quotaHit = /quota|insufficient|balance|credit|额度|积分不足|次数已用完|exceeded/.test(lower);
  if (quotaHit) {
    sessionMod.markUnhealthy(accountId, 30 * 60 * 1000, 'quota:' + (status || ''));
    logger.log('warn', 'proxy', `账号额度不足，标记 ${accountId} 冷却 30 分钟`);
    return true;
  }
  // 鉴权失败：可能 token 失效，短期冷却
  if (status === 401 || status === 403) {
    sessionMod.markUnhealthy(accountId, 5 * 60 * 1000, 'auth:' + status);
    logger.log('warn', 'proxy', `账号鉴权失败(${status})，标记 ${accountId} 冷却 5 分钟`);
    return true;
  }
  // 上游限流：短暂冷却
  if (status === 429) {
    sessionMod.markUnhealthy(accountId, 60 * 1000, 'rate-limit');
    logger.log('warn', 'proxy', `账号被上游限流，标记 ${accountId} 冷却 1 分钟`);
    return true;
  }
  return false;
}

/** 请求成功后清除账号的不健康标记 */
function recordUpstreamSuccess(accountId) {
  if (accountId) sessionMod.markHealthy(accountId);
}

module.exports = {
  buildNoAuthHeaders, buildAuthHeaders, authPath, isExpiring,
  refreshToken, getValidAccount, getValidSession,
  pickAccountForRequest, pickFailoverAccount, extractAccountKey,
  extractSessionKey, isSessionEnd,
  recordUpstreamFailure, recordUpstreamSuccess,
  verifyClientKey,
  fetchAuthState, pollAuthToken, fetchAccount, fetchAccounts, completeLogin,
  importByRefreshToken, fetchAccountByToken,
  pendingLogins,
};