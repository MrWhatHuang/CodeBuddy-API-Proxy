'use strict';

/** 认证逻辑：请求头构建、token 刷新、OAuth 登录流程 */

const config = require('./config');
const logger = require('./logger');
const util = require('./util');
const sessionMod = require('./session');

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

function authPath(sub) { return `${config.ENDPOINT}/v2${config.PREFIX_PATH}${sub}`; }

function isExpiring(auth) {
  if (!auth || !auth.expiresAt) return true;
  const expiresAt = typeof auth.expiresAt === 'number'
    ? (auth.expiresAt > 1e12 ? auth.expiresAt : auth.expiresAt * 1000)
    : Date.parse(auth.expiresAt);
  return Date.now() + config.REFRESH_AHEAD_MS >= expiresAt;
}

async function refreshToken() {
  const session = sessionMod.getSession();
  if (!session || !session.auth || !session.auth.refreshToken) throw new Error('无 refreshToken，需要重新登录');
  const headers = {
    'X-Refresh-Token': session.auth.refreshToken,
    'X-Auth-Refresh-Source': 'plugin',
    'X-Domain': session.auth.domain || config.ENDPOINT_HOST,
    'Content-Type': 'application/json',
    'User-Agent': 'CodeBuddy-Proxy/1.0',
  };
  const r = await util.requestJson(authPath('/auth/token/refresh'), { method: 'POST', headers, body: {}, timeoutMs: 30000 });
  const data = r.json && r.json.data;
  if (r.json && r.json.code === 0 && data && data.accessToken) {
    const oldAuth = session.auth;
    data.lastRefreshTime = Date.now();
    if (!data.expiresAt && data.expiresIn) data.expiresAt = Date.now() + data.expiresIn * 1000;
    if (!data.refreshToken) data.refreshToken = oldAuth.refreshToken;
    if (!data.domain) data.domain = oldAuth.domain;
    session.auth = data;
    sessionMod.saveSession();
    logger.log('info', 'auth', 'accessToken 已刷新');
    return session.auth;
  }
  throw new Error(`刷新 token 失败: ${r.json ? (r.json.msg || r.json.code) : r.body}`);
}

async function getValidSession() {
  if (!sessionMod.isLoggedIn()) throw new Error('未登录，请先打开管理页登录');
  if (isExpiring(sessionMod.getSession().auth)) {
    try { await refreshToken(); }
    catch (e) { logger.log('warn', 'auth', `自动刷新失败（继续用旧 token 尝试）: ${e.message}`); }
  }
  return sessionMod.getSession();
}

function buildAuthHeaders(sess) {
  const { account, auth } = sess;
  const h = { 'Authorization': `Bearer ${auth.accessToken}`, 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'CodeBuddy-Proxy/1.0' };
  if (account && account.uid) h['X-User-Id'] = account.uid;
  if (account && account.enterpriseId) { h['X-Enterprise-Id'] = account.enterpriseId; h['X-Tenant-Id'] = account.enterpriseId; }
  if (auth.domain) h['X-Domain'] = auth.domain;
  return h;
}

/* ============================ OAuth 登录流程 ============================ */

async function fetchAuthState() {
  const r = await util.requestJson(`${authPath('/auth/state')}?platform=${encodeURIComponent(config.PLATFORM)}`, {
    method: 'POST', headers: buildNoAuthHeaders(), body: {}, timeoutMs: 15000,
  });
  const data = r.json && r.json.data;
  if (!r.json || r.json.code !== 0 || !data || !data.state || !data.authUrl) {
    throw new Error(`获取登录 state 失败: ${r.json ? (r.json.msg || r.json.code) : r.body}`);
  }
  return data;
}

async function pollAuthToken(state) {
  const deadline = Date.now() + config.LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, config.LOGIN_POLL_INTERVAL_MS));
    try {
      const r = await util.requestJson(`${authPath('/auth/token')}?state=${encodeURIComponent(state)}`, {
        method: 'GET', headers: buildNoAuthHeaders(), timeoutMs: 15000,
      });
      const data = r.json && r.json.data;
      if (r.json && r.json.code === 0 && data && data.accessToken) {
        if (!data.expiresAt && data.expiresIn) data.expiresAt = Date.now() + data.expiresIn * 1000;
        return data;
      }
      if (r.json && r.json.code === 11217) continue; // 登录中
      if (r.json && r.json.code !== 0) return { __error: `登录未完成或失败: ${r.json.msg || r.json.code}` };
    } catch { /* 网络抖动继续 */ }
  }
  return { __error: '登录超时' };
}

async function fetchAccount(state, auth) {
  const headers = { ...buildNoAuthHeaders(), 'Authorization': `Bearer ${auth.accessToken}` };
  delete headers['X-No-Authorization'];
  delete headers['X-No-User-Id'];
  delete headers['X-No-Enterprise-Id'];
  delete headers['X-No-Department-Info'];
  const r = await util.requestJson(`${authPath('/login/account')}?state=${encodeURIComponent(state)}`, {
    method: 'GET', headers, timeoutMs: 15000,
  });
  if (!r.json || r.json.code !== 0 || !r.json.data) {
    throw new Error(`获取账号失败: ${r.json ? (r.json.msg || r.json.code) : r.body}`);
  }
  return r.json.data;
}

async function fetchAccounts(auth) {
  const headers = { 'Authorization': `Bearer ${auth.accessToken}`, 'X-Domain': auth.domain || config.ENDPOINT_HOST, 'User-Agent': 'CodeBuddy-Proxy/1.0' };
  const r = await util.requestJson(authPath('/accounts'), { method: 'GET', headers, timeoutMs: 15000 });
  if (r.json && r.json.code === 0 && Array.isArray(r.json.data)) return r.json.data;
  return [];
}

async function completeLogin(state) {
  const entry = pendingLogins.get(state);
  try {
    const auth = await pollAuthToken(state);
    if (!auth || auth.__error) { if (entry) { entry.status = 'error'; entry.error = (auth && auth.__error) || '未知错误'; } return; }
    let account = null;
    try { account = await fetchAccount(state, auth); }
    catch (e) { logger.log('warn', 'auth', `获取账号信息失败: ${e.message}`); account = { uid: '', nickname: '', type: 'personal' }; }
    const accounts = await fetchAccounts(auth).catch(() => []);
    sessionMod.setSession(sessionMod.normalizeSession({ account, auth, accounts }), 'oauth');
    sessionMod.saveSession();
    if (entry) { entry.status = 'success'; entry.account = sessionMod.getSession().account; }
    logger.log('info', 'auth', `OAuth 登录成功: ${sessionMod.getSession().account.nickname || sessionMod.getSession().account.uid}`);
  } catch (e) {
    logger.log('error', 'auth', `登录流程出错: ${e.message}`);
    if (entry) { entry.status = 'error'; entry.error = e.message; }
  }
}

module.exports = {
  buildNoAuthHeaders, buildAuthHeaders, authPath, isExpiring,
  refreshToken, getValidSession,
  fetchAuthState, pollAuthToken, fetchAccount, fetchAccounts, completeLogin,
  pendingLogins,
};
