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

/**
 * 账号健康度（内存态，不落库；重启即重置）。
 * key = accountId, value = { until, reason }；until 之前该账号不参与选号。
 */
const unhealthy = new Map();

/**
 * 额度缓存（内存态，不落库）。由 sessionScheduler 每 quotaRefreshMin 分钟刷新一次，
 * 选号时只读这里，绝不发网络请求。key = accountId,
 * value = { usageLeft, usageTotal, todayUsed, at }
 */
const quotaCache = new Map();

/** 账号池配置的默认值（新增字段都在这里，老库读取时自动补齐） */
const POOL_DEFAULTS = {
  stickyEnabled: true,          // 会话粘性（默认开：修掉「每请求换号」的 bug 级行为）
  stickyTtlMin: 30,             // 绑定空闲多久后释放
  stickyGranularity: 'auto',    // auto | fingerprint | apikey
  switchEnabled: false,         // 定时切换（默认关：不擅自改变消耗分布）
  switchIntervalMin: 60,        // 切换间隔
  switchJitterMin: 10,          // 间隔抖动
  switchLastAt: 0,              // 上次切换时间
  quotaRefreshMin: 10,          // 额度缓存刷新间隔
  failoverEnabled: true,        // 失败转移
};

function genId() {
  return 'acct_' + crypto.randomBytes(12).toString('hex');
}

/** 把 pool 配置补齐默认值（base 为已归一化的核心字段，extra 为库里的其余字段） */
function withPoolDefaults(base, extra) {
  const out = Object.assign({}, POOL_DEFAULTS, base || {});
  if (extra && typeof extra === 'object') {
    // 只接纳已知的新字段，避免库里残留的脏字段覆盖默认值
    for (const k of Object.keys(POOL_DEFAULTS)) {
      if (extra[k] !== undefined && extra[k] !== null) out[k] = extra[k];
    }
  }
  return out;
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
    autoCheckin: acct.autoCheckin === undefined ? true : !!acct.autoCheckin,
    frozen: !!acct.frozen,
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
      pool: withPoolDefaults({
        mode: data.pool.mode === 'pinned' ? 'pinned' : 'pool',
        strategy: data.pool.strategy || 'round-robin',
        pinnedId: data.pool.pinnedId || null,
        cursor: typeof data.pool.cursor === 'number' ? data.pool.cursor : 0,
      }, data.pool),
      accounts,
    };
  }
  const norm = normalizeSession(data);
  if (!norm) return null;
  return {
    version: 2,
    pool: withPoolDefaults({ mode: 'pool', strategy: 'round-robin', pinnedId: null, cursor: 0 }),
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
  return { version: 2, pool: withPoolDefaults({ mode: 'pool', strategy: 'round-robin', pinnedId: null, cursor: 0 }), accounts: [] };
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
      autoCheckin: r.autoCheckin === undefined ? true : !!r.autoCheckin,
      frozen: !!r.frozen,
      lastUsedAt: r.lastUsedAt,
      useCount: r.useCount,
      createdAt: r.createdAt,
    };
  });
  const poolCfg = store.getAccountPool();
  state = {
    version: 2,
    pool: withPoolDefaults(poolCfg.pool || { mode: 'pool', strategy: 'round-robin', pinnedId: null, cursor: 0 }, poolCfg.pool),
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
    // 服务停机期间进行中的任务视为已结束：清掉超过 TTL×2 的陈旧绑定
    try { pruneSessionBindings(2); } catch (e) { /* ignore */ }
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
        autoCheckin: acct.autoCheckin === undefined ? true : !!acct.autoCheckin,
        frozen: !!acct.frozen,
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
  // 内存态一并清空：账号没了，健康度与额度缓存都不应残留
  unhealthy.clear();
  quotaCache.clear();
  try {
    for (const r of store.listAccountRows()) store.deleteAccountRow(r.id);
    store.setAccountPool(emptyPool());
    store.deleteAllSessionBindings();
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
    if (patch.autoCheckin !== undefined) acct.autoCheckin = !!patch.autoCheckin;
    if (patch.frozen !== undefined) acct.frozen = !!patch.frozen;
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
  if (removed) {
    persistPool();
    try { store.deleteCheckinState(id); } catch (e) { /* ignore */ }
    try { store.deleteCreditSnapshots(id); } catch (e) { /* ignore */ }
    try { store.deleteSessionBindingsByAccount(id); } catch (e) { /* ignore */ }
    try { unhealthy.delete(id); } catch (e) { /* ignore */ }
  }
  return removed;
}

/* ---------------- 池模式 / 选号 ---------------- */

function getPoolConfig() {
  return state ? Object.assign({}, state.pool) : withPoolDefaults({ mode: 'pool', strategy: 'round-robin', pinnedId: null, cursor: 0 });
}

/** 可被 API 写入的池配置字段白名单（含类型与范围校验） */
const POOL_PATCH_RULES = {
  mode: (v) => (v === 'pool' || v === 'pinned' ? v : undefined),
  strategy: (v) => (['round-robin', 'quota-weighted', 'least-used'].includes(v) ? v : undefined),
  pinnedId: (v) => (v ? String(v) : null),
  stickyEnabled: (v) => (typeof v === 'boolean' ? v : undefined),
  stickyTtlMin: (v) => clampNum(v, 1, 1440),
  stickyGranularity: (v) => (['auto', 'fingerprint', 'apikey'].includes(v) ? v : undefined),
  switchEnabled: (v) => (typeof v === 'boolean' ? v : undefined),
  switchIntervalMin: (v) => clampNum(v, 1, 1440),
  switchJitterMin: (v) => clampNum(v, 0, 720),
  quotaRefreshMin: (v) => clampNum(v, 1, 1440),
  failoverEnabled: (v) => (typeof v === 'boolean' ? v : undefined),
};

function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function setPoolConfig(patch) {
  if (!state) state = emptyPool();
  const p = state.pool;
  for (const key of Object.keys(POOL_PATCH_RULES)) {
    if (!patch || patch[key] === undefined) continue;
    const v = POOL_PATCH_RULES[key](patch[key]);
    if (v !== undefined) p[key] = v;
  }
  // pinnedId 指向不存在的账号时清空（避免坏引用）
  if (p.pinnedId && !getAccount(p.pinnedId)) p.pinnedId = null;
  persistPool();
  return getPoolConfig();
}

/**
 * 直接写入内部字段（如 switchLastAt / cursor），不走白名单校验。
 * 供调度器与测试使用；管理页 API 不允许改这些字段。
 */
function setPoolInternal(patch) {
  if (!state) state = emptyPool();
  if (!patch || typeof patch !== 'object') return getPoolConfig();
  for (const k of Object.keys(patch)) {
    if (patch[k] === undefined) continue;
    state.pool[k] = patch[k];
  }
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

/* ---------------- 账号健康度 ---------------- */

/** 标记账号不健康（在 until 之前不参与选号）。reason 用于日志与排查。 */
function markUnhealthy(id, cooldownMs, reason) {
  if (!id) return;
  const until = Date.now() + Math.max(1000, cooldownMs || 0);
  unhealthy.set(String(id), { until, reason: String(reason || '') });
}

/** 清除某账号的不健康标记（请求成功后调用） */
function markHealthy(id) {
  if (!id) return;
  unhealthy.delete(String(id));
}

/** 读取某账号的不健康信息：{ until, reason } 或 null（已过期视为 null） */
function getUnhealthy(id) {
  const v = unhealthy.get(String(id));
  if (!v) return null;
  if (v.until <= Date.now()) { unhealthy.delete(String(id)); return null; }
  return v;
}

/** 当前所有处于不健康冷却期内的账号（管理页展示 / 选号过滤用） */
function listUnhealthy() {
  const now = Date.now();
  const out = [];
  for (const [id, v] of unhealthy.entries()) {
    if (v.until <= now) { unhealthy.delete(id); continue; }
    out.push({ accountId: id, until: v.until, reason: v.reason });
  }
  return out;
}

/* ---------------- 额度缓存（内存，由调度器刷新） ---------------- */

/** 写入某账号的额度缓存（仅供 sessionScheduler 调用） */
function setQuotaCache(accountId, data) {
  if (!accountId || !data) return;
  quotaCache.set(String(accountId), {
    usageLeft: Number(data.usageLeft) || 0,
    usageTotal: Number(data.usageTotal) || 0,
    todayUsed: Number(data.todayUsed) || 0,
    at: Date.now(),
  });
}

function getQuotaCache(accountId) {
  return quotaCache.get(String(accountId)) || null;
}

/** 清空额度缓存（账号变动时） */
function clearQuotaCache() { quotaCache.clear(); }

/** 额度缓存是否可用（至少有一个账号有条目）；用于策略降级判断 */
function hasQuotaData() { return quotaCache.size > 0; }

/* ---------------- 会话指纹 ---------------- */

/**
 * 计算会话指纹。三级回退：
 *   1) 客户端显式传的 X-Session-Id（最准）
 *   2) API 密钥 id（同一客户端实例天然一致，零配置）
 *   3) 对话前缀指纹（system/developer 全部内容 + 首条 user 消息，零配置兜底）
 * 返回 16 位 hex 字符串，或 '' 表示无法识别会话。
 *
 * @param {object} opts { headerSessionId, apiKeyId, payload, granularity }
 */
function computeSessionKey(opts) {
  const o = opts || {};
  const granularity = o.granularity || 'auto';

  // 粒度强制为 apikey 时只用密钥
  if (granularity === 'apikey') {
    return o.apiKeyId ? hashKey('k:' + o.apiKeyId) : '';
  }

  // 客户端显式给出的会话 id 是权威信号：直接用它，不再混入指纹
  // （否则同一会话下对话内容变化会导致指纹变化，粘性失效）
  if (o.headerSessionId) {
    return hashKey('s:' + String(o.headerSessionId).trim());
  }

  const parts = [];
  if (o.apiKeyId) parts.push('k:' + String(o.apiKeyId));

  // auto：前缀指纹优先，取不到再退回密钥
  if (granularity === 'auto' || granularity === 'fingerprint') {
    const fp = messagePrefixFingerprint(o.payload);
    if (fp) parts.push('f:' + fp);
  }

  if (!parts.length) return '';
  return hashKey(parts.join('|'));
}

/**
 * 从 payload.messages 里取「稳定前缀」算指纹：
 * 所有 system/developer 消息 + 第一条 user 消息的文本。
 * agent 多轮 tool loop 中这部分逐字不变，因此同一任务会稳定落到同一个 key。
 */
function messagePrefixFingerprint(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const msgs = Array.isArray(payload.messages) ? payload.messages : null;
  if (!msgs || !msgs.length) {
    // Responses API 的 input 形式：退化为对 instructions + 首个 input 文本取指纹
    const instr = typeof payload.instructions === 'string' ? payload.instructions : '';
    const inputText = firstInputText(payload.input);
    if (!instr && !inputText) return '';
    return hashKey('resp:' + instr + '\u0000' + inputText);
  }
  const chunks = [];
  let firstUserTaken = false;
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    if (role === 'system' || role === 'developer') {
      chunks.push('S:' + contentToText(m.content));
    } else if (role === 'user' && !firstUserTaken) {
      chunks.push('U:' + contentToText(m.content));
      firstUserTaken = true;
    }
  }
  if (!chunks.length) return '';
  return hashKey(chunks.join('\u0000'));
}

/** Responses API 的 input 可能是字符串或数组，取其中第一段文本 */
function firstInputText(input) {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const t = contentToText(item.content);
        if (t) return t;
      }
    }
  }
  return '';
}

/** content 可能是字符串，也可能是 [{type:'text',text}] 数组 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(function (c) {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object' && typeof c.text === 'string') return c.text;
      return '';
    }).join('');
  }
  return '';
}

function hashKey(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);
}

/* ---------------- 会话绑定 ---------------- */

/**
 * 为一个会话挑选/复用账号。
 * 命中且账号仍健康 → 复用；否则按策略选一个新账号并写入绑定。
 * @returns {object|null} 账号对象
 */
function pickAccountForSession(sessionKey) {
  if (!state || !state.accounts.length) return null;
  const p = state.pool;

  if (sessionKey && p.stickyEnabled) {
    const bound = store.getSessionBinding(sessionKey);
    if (bound) {
      const acct = getAccount(bound.accountId);
      if (acct && acct.auth && acct.auth.accessToken && !isAccountBlocked(acct)) {
        store.touchSessionBinding(sessionKey);
        return acct;
      }
      // 绑定的账号已失效/被冻结/不健康/被删 → 丢弃绑定，重新选
      store.deleteSessionBinding(sessionKey);
    }
  }

  const picked = pickAccountStrategy();
  if (picked && sessionKey && p.stickyEnabled) {
    store.setSessionBinding(sessionKey, picked.id);
  }
  return picked;
}

/** 释放会话绑定（任务结束时调用） */
function releaseSession(sessionKey) {
  if (!sessionKey) return 0;
  return store.deleteSessionBinding(sessionKey);
}

/** 强制把某个会话绑定到指定账号（失败转移换号后调用） */
function bindSession(sessionKey, accountId) {
  if (!sessionKey || !accountId) return null;
  return store.setSessionBinding(sessionKey, accountId);
}

/**
 * 清理空闲超过 TTL 的会话绑定。
 * 启动时用 TTL × 2 清一次陈旧项（服务停机期间进行中的任务视为已结束），
 * 运行时由 sessionScheduler 按 TTL 定期清理。
 */
function pruneSessionBindings(ttlMultiplier) {
  const p = getPoolConfig();
  const ttlMs = Math.max(1, p.stickyTtlMin || 30) * 60 * 1000 * (ttlMultiplier || 1);
  try { return store.pruneSessionBindings(ttlMs); } catch (e) { return 0; }
}

/** 选号总入口（含显式指定 / pinned / 会话粘性 / 策略） */
function pickAccount(explicitKey, sessionKey) {
  if (!state || !state.accounts.length) return null;
  const p = state.pool;
  if (explicitKey) {
    const found = findAccountByIdOrName(explicitKey);
    return found || null;   // 显式指定不写绑定，也不受健康度限制
  }
  if (p.mode === 'pinned' && p.pinnedId) {
    const pinned = getAccount(p.pinnedId);
    if (pinned) return pinned;   // pinned 模式完全绕过池与粘性
  }
  return pickAccountForSession(sessionKey);
}

/**
 * 按策略选一个账号（会推进 cursor）。
 * 策略：round-robin（默认）/ quota-weighted / least-used。
 * 后两者依赖额度缓存；缓存为空时自动降级为 round-robin，绝不阻塞。
 */
function pickAccountStrategy() {
  const p = state.pool;
  const candidates = healthyAccounts();
  if (!candidates.length) return state.accounts[0] || null;

  let strategy = p.strategy || 'round-robin';
  // 额度类策略在无缓存数据时降级，避免选到明显不该选的账号
  if ((strategy === 'quota-weighted' || strategy === 'least-used') && !hasQuotaData()) {
    strategy = 'round-robin';
  }

  if (strategy === 'least-used') {
    const picked = pickLeastUsed(candidates);
    if (picked) return picked;
  } else if (strategy === 'quota-weighted') {
    const picked = pickQuotaWeighted(candidates);
    if (picked) return picked;
  }
  return pickRoundRobin(candidates);
}

/**
 * 候选账号：有 accessToken、未被冻结、且不处于冷却期。
 * 冻结是用户的显式意图（持久化），冷却失败转移的临时标记（内存态）；
 * 两者效果一致——都不参与池轮询与失败转移。
 * 若池中全部账号都不可用，则退化为「忽略冻结与冷却」，避免完全不可用。
 */
function healthyAccounts() {
  const valid = state.accounts.filter(function (a) { return a.auth && a.auth.accessToken; });
  const pool = valid.length ? valid : state.accounts.slice();
  const ok = pool.filter(function (a) { return !isAccountBlocked(a); });
  return ok.length ? ok : pool;
}

/** 账号是否被冻结（持久化的显式意图） */
function isFrozen(acct) {
  return !!(acct && acct.frozen);
}

/** 账号是否应排除在池选号之外（冻结或处于冷却期） */
function isAccountBlocked(acct) {
  if (!acct) return true;
  if (isFrozen(acct)) return true;
  return !!getUnhealthy(acct.id);
}

/** 轮询：沿用原有 cursor 语义 */
function pickRoundRobin(candidates) {
  const p = state.pool;
  const cursor = ((p.cursor || 0) % candidates.length + candidates.length) % candidates.length;
  p.cursor = (cursor + 1) % candidates.length;
  persistPool();
  return candidates[cursor];
}

/** 最省优先：今日消耗积分最少者优先；并列时按 cursor 轮询打破平局 */
function pickLeastUsed(candidates) {
  let best = null;
  let bestUsed = Infinity;
  for (const a of candidates) {
    const q = getQuotaCache(a.id);
    if (!q) continue;                      // 无额度数据的账号不参与该策略
    if (q.todayUsed < bestUsed) { bestUsed = q.todayUsed; best = a; }
  }
  if (!best) return null;
  return best;
}

/** 额度加权：按剩余额度占比加权随机（剩余越多越容易被选中） */
function pickQuotaWeighted(candidates) {
  const weighted = [];
  let total = 0;
  for (const a of candidates) {
    const q = getQuotaCache(a.id);
    if (!q) continue;
    // 用「剩余额度」做权重；剩余为 0 时给一个很小的权重，避免完全饿死
    const w = Math.max(1, q.usageLeft);
    weighted.push({ acct: a, w });
    total += w;
  }
  if (!weighted.length || total <= 0) return null;
  let r = Math.random() * total;
  for (const item of weighted) {
    r -= item.w;
    if (r <= 0) return item.acct;
  }
  return weighted[weighted.length - 1].acct;
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
  getPool, setPool, getPoolConfig, setPoolConfig, setPoolInternal,
  listAccounts, getAccount, findAccountByIdOrName,
  addAccount, updateAccount, removeAccount,
  isExpiringAuth, pickAccount, markUsed, getActiveAccount,

  // 会话粘性 / 策略 / 健康度（含冻结）/ 额度缓存
  computeSessionKey, pickAccountForSession, releaseSession, bindSession,
  markUnhealthy, markHealthy, getUnhealthy, listUnhealthy,
  isFrozen, isAccountBlocked, healthyAccounts,
  setQuotaCache, getQuotaCache, clearQuotaCache, hasQuotaData,
  pruneSessionBindings,

  isLoggedIn, getSession, setSession, getSessionSource,
};
