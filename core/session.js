'use strict';

/** 会话状态：账号池（多 OAuth 账号）、归一化、读写本地缓存、退出清理 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');

let state = null;
let sessionSource = '';

function genId() {
  return 'acct_' + crypto.randomBytes(12).toString('hex');
}

function normalizeSession(data) {
  if (!data || !data.auth || !data.auth.accessToken) return null;
  const account = data.account || {};
  const auth = data.auth || {};
  if (auth.expiresIn && !auth.expiresAt) auth.expiresAt = Date.now() + auth.expiresIn * 1000;
  if (auth.refreshExpiresIn && !auth.refreshExpiresAt) auth.refreshExpiresAt = Date.now() + auth.refreshExpiresIn * 1000;
  return {
    account: {
      uid: account.uid || account.id || '',
      nickname: account.nickname || account.label || '',
      type: account.type || 'personal',
      enterpriseId: account.enterpriseId || '',
      departmentFullName: account.departmentFullName || '',
      lastLogin: true,
    },
    auth: {
      accessToken: auth.accessToken || '',
      refreshToken: auth.refreshToken || '',
      tokenType: auth.tokenType || 'Bearer',
      domain: auth.domain || config.ENDPOINT_HOST,
      scope: auth.scope || '',
      expiresIn: auth.expiresIn || 0,
      expiresAt: auth.expiresAt || 0,
      refreshExpiresIn: auth.refreshExpiresIn || 0,
      refreshExpiresAt: auth.refreshExpiresAt || 0,
      lastRefreshTime: auth.lastRefreshTime || Date.now(),
    },
    accounts: data.accounts || [],
  };
}

function normalizePoolAccount(acct) {
  if (!acct || !acct.auth || !acct.auth.accessToken) return null;
  const n = normalizeSession({ account: acct.account, auth: acct.auth, accounts: acct.accounts });
  if (!n) return null;
  return {
    id: acct.id || genId(),
    name: acct.name || n.account.nickname || n.account.uid || '未命名',
    source: acct.source || 'file',
    account: n.account,
    auth: n.auth,
    accounts: n.accounts,
    lastUsedAt: acct.lastUsedAt || 0,
    useCount: acct.useCount || 0,
    createdAt: acct.createdAt || Date.now(),
  };
}

/** 把旧版（单账号 session）或新版（池）数据归一化成池结构 */
function normalizePool(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.version === 2 && Array.isArray(data.accounts) && data.pool) {
    const accounts = data.accounts.map(normalizePoolAccount).filter(Boolean);
    return {
      version: 2,
      pool: {
        mode: data.pool.mode === 'pinned' ? 'pinned' : 'pool',
        strategy: data.pool.strategy || 'round-robin',
        pinnedId: data.pool.pinnedId || null,
        cursor: typeof data.pool.cursor === 'number' ? data.pool.cursor : 0,
      },
      accounts,
    };
  }
  const norm = normalizeSession(data);
  if (!norm) return null;
  return {
    version: 2,
    pool: { mode: 'pool', strategy: 'round-robin', pinnedId: null, cursor: 0 },
    accounts: [{
      id: genId(),
      name: norm.account.nickname || norm.account.uid || '账号 1',
      source: sessionSource || 'file',
      account: norm.account,
      auth: norm.auth,
      accounts: norm.accounts,
      lastUsedAt: 0,
      useCount: 0,
      createdAt: Date.now(),
    }],
  };
}

function emptyPool() {
  return { version: 2, pool: { mode: 'pool', strategy: 'round-robin', pinnedId: null, cursor: 0 }, accounts: [] };
}

function loadSession() {
  try {
    if (fs.existsSync(config.SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(config.SESSION_FILE, 'utf8'));
      const pool = normalizePool(data);
      if (pool) {
        state = pool;
        sessionSource = 'file';
        if (pool.accounts.length) persistPool();
        return true;
      }
    }
  } catch (e) { logger.log('warn', 'system', '加载本地 session 失败: ' + e.message); }
  return false;
}

function persistPool() {
  try {
    fs.mkdirSync(path.dirname(config.SESSION_FILE), { recursive: true });
    fs.writeFileSync(config.SESSION_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (e) { logger.log('error', 'system', '保存 session 失败: ' + e.message); }
}

function saveSession() { persistPool(); }

function clearSession() {
  state = emptyPool(); sessionSource = '';
  try { if (fs.existsSync(config.SESSION_FILE)) fs.unlinkSync(config.SESSION_FILE); } catch (e) { /* ignore */ }
}

function getPool() { return state; }

function setPool(pool, source) {
  state = normalizePool(pool) || emptyPool();
  if (source) sessionSource = source;
}

/* ---------------- 账号操作 ---------------- */

function listAccounts() {
  return state ? state.accounts.slice() : [];
}

function getAccount(id) {
  if (!state) return null;
  return state.accounts.find(function (a) { return a.id === id; }) || null;
}

function findAccountByIdOrName(key) {
  if (!state || !key) return null;
  const k = String(key);
  return state.accounts.find(function (a) { return a.id === k || a.name === k; }) || null;
}

function addAccount(acct) {
  if (!state) state = emptyPool();
  const normalized = normalizePoolAccount(acct);
  if (!normalized) return null;
  state.accounts.push(normalized);
  persistPool();
  return normalized;
}

function updateAccount(id, patch) {
  const acct = getAccount(id);
  if (!acct) return null;
  if (patch && typeof patch === 'object') {
    if (typeof patch.name === 'string' && patch.name.trim()) acct.name = patch.name.trim();
    if (patch.auth && typeof patch.auth === 'object') acct.auth = normalizeSession({ account: acct.account, auth: patch.auth }).auth;
    if (patch.account && typeof patch.account === 'object') acct.account = Object.assign({}, acct.account, patch.account);
    if (patch.lastUsedAt != null) acct.lastUsedAt = patch.lastUsedAt;
    if (patch.useCount != null) acct.useCount = patch.useCount;
    if (patch.source) acct.source = patch.source;
  }
  persistPool();
  return acct;
}

function removeAccount(id) {
  if (!state) return false;
  const before = state.accounts.length;
  state.accounts = state.accounts.filter(function (a) { return a.id !== id; });
  if (state.pool && state.pool.pinnedId === id) state.pool.pinnedId = null;
  const removed = state.accounts.length < before;
  if (removed) persistPool();
  return removed;
}

/* ---------------- 池模式 / 选号 ---------------- */

function getPoolConfig() {
  return state ? Object.assign({}, state.pool) : { mode: 'pool', strategy: 'round-robin', pinnedId: null, cursor: 0 };
}

function setPoolConfig(patch) {
  if (!state) state = emptyPool();
  const p = state.pool;
  if (patch.mode === 'pinned' || patch.mode === 'pool') p.mode = patch.mode;
  if (patch.strategy) p.strategy = patch.strategy;
  if (patch.pinnedId !== undefined) p.pinnedId = patch.pinnedId || null;
  persistPool();
  return getPoolConfig();
}

function isExpiringAuth(auth) {
  if (!auth || !auth.expiresAt) return true;
  const expiresAt = typeof auth.expiresAt === 'number'
    ? (auth.expiresAt > 1e12 ? auth.expiresAt : auth.expiresAt * 1000)
    : Date.parse(auth.expiresAt);
  return Date.now() + config.REFRESH_AHEAD_MS >= expiresAt;
}

/** 挑出一个账号（不自动刷新；刷新由 auth.js 负责）。返回账号或 null */
function pickAccount(explicitKey) {
  if (!state || !state.accounts.length) return null;
  const p = state.pool;
  if (explicitKey) {
    const found = findAccountByIdOrName(explicitKey);
    return found || null;
  }
  if (p.mode === 'pinned' && p.pinnedId) {
    const pinned = getAccount(p.pinnedId);
    if (pinned) return pinned;
  }
  const valid = state.accounts.filter(function (a) { return a.auth && a.auth.accessToken; });
  if (!valid.length) return state.accounts[0];
  const cursor = ((p.cursor || 0) % valid.length + valid.length) % valid.length;
  p.cursor = (cursor + 1) % valid.length;
  persistPool();
  return valid[cursor];
}

/** 标记某账号被使用 */
function markUsed(id) {
  const acct = getAccount(id);
  if (!acct) return;
  acct.lastUsedAt = Date.now();
  acct.useCount = (acct.useCount || 0) + 1;
  persistPool();
}

/* ---------------- 兼容旧 API ---------------- */

function isLoggedIn() { return !!(state && state.accounts.some(function (a) { return a.auth && a.auth.accessToken; })); }

/** 返回「活跃账号」用于启动日志 / 状态展示兼容：pinned 或第一个 */
function getActiveAccount() {
  if (!state || !state.accounts.length) return null;
  if (state.pool.mode === 'pinned' && state.pool.pinnedId) {
    const pinned = getAccount(state.pool.pinnedId);
    if (pinned) return pinned;
  }
  return state.accounts[0];
}

function getSession() { return getActiveAccount(); }
function setSession(s, source) {
  if (!state) state = emptyPool();
  const norm = normalizeSession(s);
  if (norm) {
    const existing = state.accounts[0];
    if (existing) {
      existing.account = norm.account;
      existing.auth = norm.auth;
      existing.accounts = norm.accounts;
      if (!existing.name) existing.name = norm.account.nickname || norm.account.uid || '账号 1';
      existing.source = source || existing.source;
    } else {
      addAccount({ id: genId(), name: norm.account.nickname || norm.account.uid || '账号 1', source: source || 'oauth', account: norm.account, auth: norm.auth, accounts: norm.accounts, lastUsedAt: 0, useCount: 0, createdAt: Date.now() });
    }
    persistPool();
  }
  if (source) sessionSource = source;
}
function getSessionSource() { return sessionSource; }

module.exports = {
  normalizeSession, normalizePool, loadSession, saveSession, clearSession,
  getPool, setPool, getPoolConfig, setPoolConfig,
  listAccounts, getAccount, findAccountByIdOrName,
  addAccount, updateAccount, removeAccount,
  isExpiringAuth, pickAccount, markUsed, getActiveAccount,
  isLoggedIn, getSession, setSession, getSessionSource,
};
