'use strict';

/**
 * 会话状态：账号池（多 OAuth / VSCode / 手工导入账号）、归一化、读写本地存储、退出清理。
 *
 * 存储已从本地 session.json 迁移到 SQLite（core/store.js 的 accounts / account_pool 表）。
 * 本模块保留原有对外 API 不变，仅把持久化后端替换为数据库；首次启动时自动迁移旧 session.json。
 */

const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');
const store = require('./store');

let state = null;          // 内存态：{ version, pool, accounts[] }
let sessionSource = '';    // 最近一次账号来源：vscode | oauth | manual | file

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
  const source = acct.source || acct.addedBy || 'file';
  return {
    id: acct.id || genId(),
    name: acct.name || n.account.nickname || n.account.uid || '未命名',
    source,
    addedBy: acct.addedBy || source,
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
      addedBy: sessionSource || 'file',
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

/** 从 SQLite 载入账号池到内存态 */
function loadFromDb() {
  const accounts = store.listAccountRows().map(function (r) {
    return {
      id: r.id,
      name: r.name,
      source: r.source,
      addedBy: r.addedBy,
      account: r.account,
      auth: r.auth,
      accounts: r.accounts,
      lastUsedAt: r.lastUsedAt,
      useCount: r.useCount,
      createdAt: r.createdAt,
    };
  });
  const poolCfg = store.getAccountPool();
  state = {
    version: 2,
    pool: poolCfg.pool || { mode: 'pool', strategy: 'round-robin', pinnedId: null, cursor: 0 },
    accounts,
  };
  return true;
}

/**
 * 一次性迁移：若 DB 尚无账号、且旧 session.json 存在，则把旧文件里的账号导入 DB，
 * 并把来源标记为 migrate（保留原始 source 到 addedBy 之外单独用 source 存原值，便于追溯）。
 */
function migrateLegacySession() {
  if (store.accountCount() > 0) return false;
  const file = config.SESSION_FILE;
  if (!fs.existsSync(file)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pool = normalizePool(raw);
    if (!pool || !pool.accounts.length) return false;
    for (const acct of pool.accounts) {
      store.insertAccount({
        id: acct.id,
        name: acct.name,
        source: acct.source || 'file',
        addedBy: 'migrate',               // 添加方式统一标记为 migrate（从旧 session.json 迁移）
        account: acct.account,
        auth: acct.auth,
        accounts: acct.accounts,
        lastUsedAt: acct.lastUsedAt,
        useCount: acct.useCount,
        createdAt: acct.createdAt,
      });
    }
    store.setAccountPool(pool);
    logger.log('info', 'system', '已从旧 session.json 迁移 ' + pool.accounts.length + ' 个账号到数据库');
    // 迁移成功后重命名旧文件，避免后续被误读（保留一份可回滚的 .migrated 备份）
    const bak = file + '.migrated';
    try {
      if (fs.existsSync(bak)) fs.unlinkSync(bak);
      fs.renameSync(file, bak);
      logger.log('info', 'system', '旧 session.json 已重命名为 session.json.migrated');
    } catch (e2) {
      logger.log('warn', 'system', '重命名旧 session.json 失败（不影响迁移）: ' + e2.message);
    }
    return true;
  } catch (e) {
    logger.log('warn', 'system', '迁移旧 session.json 失败: ' + e.message);
    return false;
  }
}

function loadSession() {
  try {
    migrateLegacySession();
    loadFromDb();
    if (state.accounts.length) {
      sessionSource = state.accounts[0].source || 'file';
    }
    return state.accounts.length > 0;
  } catch (e) {
    logger.log('warn', 'system', '加载账号池失败: ' + e.message);
    state = emptyPool();
    return false;
  }
}

/** 把内存态整体写回数据库（账号 + 池配置） */
function persistPool() {
  if (!state) return;
  try {
    store.setAccountPool(state);
    // 账号行以逐条 upsert 同步（以内存态为准）
    const knownIds = new Set(state.accounts.map(function (a) { return a.id; }));
    for (const acct of state.accounts) {
      store.insertAccount({
        id: acct.id,
        name: acct.name,
        source: acct.source,
        addedBy: acct.addedBy || acct.source,
        account: acct.account,
        auth: acct.auth,
        accounts: acct.accounts,
        lastUsedAt: acct.lastUsedAt,
        useCount: acct.useCount,
        createdAt: acct.createdAt,
      });
    }
    // 删除 DB 中已不在内存态的账号
    for (const r of store.listAccountRows()) {
      if (!knownIds.has(r.id)) store.deleteAccountRow(r.id);
    }
  } catch (e) {
    logger.log('error', 'system', '保存账号池失败: ' + e.message);
  }
}

function saveSession() { persistPool(); }

function clearSession() {
  state = emptyPool();
  sessionSource = '';
  try {
    for (const r of store.listAccountRows()) store.deleteAccountRow(r.id);
    store.setAccountPool(emptyPool());
  } catch (e) { /* ignore */ }
}

function getPool() { return state; }

function setPool(pool, source) {
  state = normalizePool(pool) || emptyPool();
  if (source) sessionSource = source;
  persistPool();
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
    if (patch.addedBy) acct.addedBy = patch.addedBy;
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
      existing.addedBy = existing.addedBy || source;
    } else {
      addAccount({
        id: genId(),
        name: norm.account.nickname || norm.account.uid || '账号 1',
        source: source || 'oauth',
        addedBy: source || 'oauth',
        account: norm.account,
        auth: norm.auth,
        accounts: norm.accounts,
        lastUsedAt: 0,
        useCount: 0,
        createdAt: Date.now(),
      });
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
