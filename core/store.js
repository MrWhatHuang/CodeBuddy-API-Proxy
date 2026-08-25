'use strict';

/**
 * SQLite 存储（node:sqlite 内置模块，无需 npm 依赖）。
 *   - logs 表：结构化日志 + 查询 / 清理 / 滚动删除
 *   - config 表：运行时可修改的系统配置
 */

{
  const orig = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    if (typeof warning === 'string' && warning.includes('SQLite')) return;
    return orig.apply(process, [warning, ...args]);
  };
}

const fs = require('fs');
const path = require('path');
const config = require('./config');

let db = null;
let cachedConfig = null;
let insertCount = 0;

function getDb() {
  if (db) return db;
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(config.DB_FILE), { recursive: true });
  db = new DatabaseSync(config.DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       INTEGER NOT NULL,
      level    TEXT    NOT NULL,
      category TEXT    NOT NULL,
      message  TEXT    NOT NULL,
      meta     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
    CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
    CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      max_input_tokens  INTEGER NOT NULL DEFAULT 0,
      max_output_tokens INTEGER NOT NULL DEFAULT 0,
      tools            INTEGER NOT NULL DEFAULT 0,
      vision           INTEGER NOT NULL DEFAULT 0,
      reasoning        INTEGER NOT NULL DEFAULT 0,
      region           TEXT NOT NULL DEFAULT 'cn',
      created_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL DEFAULT '',
      key          TEXT NOT NULL,
      account_id   TEXT NOT NULL DEFAULT '',  -- 绑定的账号 id；空 = 走账号池
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL DEFAULT 0,
      use_count    INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);

    CREATE TABLE IF NOT EXISTS usage (
      id              TEXT PRIMARY KEY,
      ts              INTEGER NOT NULL,
      source          TEXT NOT NULL DEFAULT '',   -- 请求入口，如 /v1/chat/completions /v1/responses
      model           TEXT NOT NULL DEFAULT '',
      stream          INTEGER NOT NULL DEFAULT 0,
      account_id      TEXT NOT NULL DEFAULT '',
      account_name    TEXT NOT NULL DEFAULT '',
      api_key_id      TEXT NOT NULL DEFAULT '',
      api_key_name    TEXT NOT NULL DEFAULT '',    -- 空 = 未走密钥
      prompt_tokens   INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens    INTEGER NOT NULL DEFAULT 0,
      cached_tokens   INTEGER NOT NULL DEFAULT 0,  -- 缓存命中（prompt cache hit）token 数
      duration_ms     INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'ok'   -- ok | error
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_account ON usage(account_id);
    CREATE INDEX IF NOT EXISTS idx_usage_key ON usage(api_key_id);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model);

    -- 账号池：登录态（含 accessToken/refreshToken 等敏感凭证）与账号信息
    CREATE TABLE IF NOT EXISTS accounts (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL DEFAULT '',
      source        TEXT NOT NULL DEFAULT 'file',  -- vscode | oauth | manual | file（旧数据迁移）
      added_by      TEXT NOT NULL DEFAULT 'file',  -- 添加方式：vscode(解析导入) | oauth(网页登录) | manual(手工导入) | migrate(旧 session 迁移)
      account       TEXT NOT NULL DEFAULT '{}',    -- JSON：{ uid, nickname, type, enterpriseId, ... }
      auth          TEXT NOT NULL DEFAULT '{}',    -- JSON：{ accessToken, refreshToken, domain, expiresAt, ... }
      accounts      TEXT NOT NULL DEFAULT '[]',    -- JSON：该账号可切换的子账号列表
      last_used_at  INTEGER NOT NULL DEFAULT 0,
      use_count     INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_source ON accounts(source);

    -- 账号池配置（单行：version=2 固定），mode/strategy/pinnedId/cursor 存为 JSON
    CREATE TABLE IF NOT EXISTS account_pool (
      id      INTEGER PRIMARY KEY CHECK (id = 1),
      config  TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    -- 管理页管理员账号（单账号：username 主键）。password_hash 为 scrypt 派生结果（含盐）。
    CREATE TABLE IF NOT EXISTS admin_users (
      username        TEXT PRIMARY KEY,
      password_hash   TEXT NOT NULL,          -- 格式：scrypt$N$r$p$salt$hash(hex)
      must_change     INTEGER NOT NULL DEFAULT 0,  -- 1 = 下次登录需改密
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL DEFAULT 0
    );

    -- 管理页登录会话（持久化，服务重启后仍有效）
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash      TEXT PRIMARY KEY,        -- 会话 token 的 sha256（不存明文）
      username        TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      last_seen_at    INTEGER NOT NULL DEFAULT 0,
      user_agent      TEXT NOT NULL DEFAULT '',
      ip              TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);

    -- 通用失败限流（持久化，服务重启后仍生效）。key 唯一（如 admin:ip|user、apikey:ip）
    CREATE TABLE IF NOT EXISTS rate_limits (
      key            TEXT PRIMARY KEY,
      scope          TEXT NOT NULL DEFAULT '',   -- admin | apikey
      fails          INTEGER NOT NULL DEFAULT 0,
      window_start   INTEGER NOT NULL,
      locked_until   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limits_scope ON rate_limits(scope);
    `);

  // 兼容旧库：若 usage 表缺少 cached_tokens 列则补充
  try {
    const cols = db.prepare("PRAGMA table_info(usage)").all().map((c) => c.name);
    if (!cols.includes('cached_tokens')) {
      db.exec('ALTER TABLE usage ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0');
    }
  } catch { /* 表不存在或已就绪则忽略 */ }
  // 兼容旧库：若 api_keys 表缺少 account_id 列则补充
  try {
    const cols = db.prepare("PRAGMA table_info(api_keys)").all().map((c) => c.name);
    if (!cols.includes('account_id')) {
      db.exec("ALTER TABLE api_keys ADD COLUMN account_id TEXT NOT NULL DEFAULT ''");
    }
  } catch { /* 表不存在或已就绪则忽略 */ }
  return db;
}

function asBool(v, fallback = false) {
  if (v == null || v === '') return fallback;
  return v === 'true' || v === '1';
}

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '***';
  return k.slice(0, 6) + '…' + k.slice(-4);
}

function asInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function getConfig() {
  if (cachedConfig) return cachedConfig;
  const d = getDb();
  const out = { ...config.DEFAULT_CONFIG };
  const rows = d.prepare('SELECT key, value FROM config').all();
  for (const r of rows) out[r.key] = r.value;
  cachedConfig = out;
  return out;
}

function setConfig(patch) {
  if (!patch || typeof patch !== 'object') return getConfig();
  const d = getDb();
  const stmt = d.prepare(
    'INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(patch)) {
    stmt.run(String(k), String(v));
  }
  cachedConfig = null;
  return getConfig();
}

function publicValues(cfg) {
  const c = cfg || getConfig();
  return {
    logging: {
      enabled: asBool(c['logging.enabled'], true),
      details: asBool(c['logging.details'], true),
      level: config.LOG_LEVELS.includes(c['logging.level']) ? c['logging.level'] : 'info',
      retentionDays: asInt(c['logging.retentionDays'], 7),
      maxRows: asInt(c['logging.maxRows'], 10000),
    },
    autoOpen: asBool(c.autoOpen, true),
    defaultModel: c.defaultModel || 'default',
    forceModel: c.forceModel || '',
    requestTimeoutMs: asInt(c.requestTimeoutMs, 300000),
    corsOrigin: c['cors.origin'] || '*',
    apiKeyEnabled: asBool(c.apiKeyEnabled, true),
    apiKeyCount: listApiKeys().length,
    adminAuthEnabled: asBool(c.adminAuthEnabled, false),
    adminConfigured: adminConfigured(),
    adminUsername: config.ADMIN_USERNAME,
  };
}

function applyPublicPatch(body) {
  const patch = {};
  if (!body || typeof body !== 'object') return patch;

  const lg = body.logging;
  if (lg && typeof lg === 'object') {
    if (typeof lg.enabled === 'boolean') patch['logging.enabled'] = String(lg.enabled);
    if (typeof lg.details === 'boolean') patch['logging.details'] = String(lg.details);
    if (config.LOG_LEVELS.includes(lg.level)) patch['logging.level'] = lg.level;
    if (typeof lg.retentionDays === 'number') patch['logging.retentionDays'] = String(clampInt(lg.retentionDays, 0, 3650));
    if (typeof lg.maxRows === 'number') patch['logging.maxRows'] = String(clampInt(lg.maxRows, 0, 1000000));
  }
  if (typeof body.autoOpen === 'boolean') patch.autoOpen = String(body.autoOpen);
  if (typeof body.defaultModel === 'string' && body.defaultModel.trim()) patch.defaultModel = body.defaultModel.trim();
  if (typeof body.forceModel === 'string') patch.forceModel = body.forceModel.trim();
  // 是否校验 API 密钥
  if (typeof body.apiKeyEnabled === 'boolean') patch.apiKeyEnabled = String(body.apiKeyEnabled);
  // 是否开启管理页鉴权
  if (typeof body.adminAuthEnabled === 'boolean') patch.adminAuthEnabled = String(body.adminAuthEnabled);
  // 联动约束：开启管理页鉴权后，强制开启 API 密钥校验（避免「管理页锁了但 AI 接口裸奔」）。
  // 以 patch 覆盖后的最终值为准，所以即使本次请求同时传了 adminAuthEnabled:true + apiKeyEnabled:false 也会被纠正。
  const cur = getConfig();
  const effAdmin = asBool('adminAuthEnabled' in patch ? patch.adminAuthEnabled : cur.adminAuthEnabled, false);
  if (effAdmin) patch.apiKeyEnabled = 'true';
  // 兼容旧版：单个 API 密钥（空字符串表示不更新；非空则作为新密钥加入 keys 表）
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    addApiKey({ name: 'legacy', key: body.apiKey.trim() });
  }
  if (typeof body.requestTimeoutMs === 'number') patch.requestTimeoutMs = String(clampInt(body.requestTimeoutMs, 1000, 30 * 60 * 1000));
  if (typeof body.corsOrigin === 'string') {
    const origin = body.corsOrigin.trim() || '*';
    if (origin === '*' || /^https?:\/\/[^\s]+$/i.test(origin)) patch['cors.origin'] = origin;
  }
  return patch;
}

function getRequestTimeoutMs() {
  return Math.max(1000, asInt(getConfig().requestTimeoutMs, 300000));
}

function getCorsOrigin() {
  return getConfig()['cors.origin'] || '*';
}

function loggingDetailsEnabled() {
  return asBool(getConfig()['logging.details'], true);
}

function addLog(level, category, message, meta) {
  const cfg = getConfig();
  if (!asBool(cfg['logging.enabled'], true)) return;
  const levels = config.LOG_LEVELS;
  const minIdx = levels.indexOf(cfg['logging.level'] || 'info');
  if (levels.indexOf(level) < minIdx) return;
  try {
    const d = getDb();
    const details = asBool(cfg['logging.details'], true);
    d.prepare('INSERT INTO logs(ts, level, category, message, meta) VALUES(?, ?, ?, ?, ?)')
      .run(Date.now(), level, category, message, (details && meta != null) ? JSON.stringify(meta) : null);
    insertCount += 1;
    if (insertCount === 1 || insertCount % 50 === 0) prune(cfg);
  } catch { /* 日志写入失败不应影响主流程 */ }
}

function prune(cfg) {
  try {
    const d = getDb();
    const retentionDays = asInt(cfg['logging.retentionDays'], 0);
    if (retentionDays > 0) {
      d.prepare('DELETE FROM logs WHERE ts < ?').run(Date.now() - retentionDays * 24 * 3600 * 1000);
    }
    const maxRows = asInt(cfg['logging.maxRows'], 0);
    if (maxRows > 0) {
      const row = d.prepare('SELECT COUNT(*) AS n FROM logs').get();
      const n = row ? row.n : 0;
      if (n > maxRows) {
        d.prepare('DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id ASC LIMIT ?)').run(n - maxRows);
      }
    }
  } catch { /* ignore */ }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function queryLogs({ level, category, q, from, to, limit, offset } = {}) {
  const d = getDb();
  const conds = [];
  const params = [];
  if (level) { conds.push('level = ?'); params.push(level); }
  if (category) { conds.push('category = ?'); params.push(category); }
  if (q) { conds.push('(message LIKE ? OR IFNULL(meta, \'\') LIKE ?)'); params.push('%' + q + '%', '%' + q + '%'); }
  if (from) { conds.push('ts >= ?'); params.push(Number(from)); }
  if (to) { conds.push('ts <= ?'); params.push(Number(to)); }
  const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';

  const limitN = Math.min(Math.max(asInt(limit, 100), 1), 1000);
  const offsetN = Math.max(asInt(offset, 0), 0);

  const total = d.prepare('SELECT COUNT(*) AS n FROM logs' + where).get(...params).n;
  const rows = d.prepare(
    'SELECT id, ts, level, category, message, meta FROM logs' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(...params, limitN, offsetN);

  return {
    total,
    limit: limitN,
    offset: offsetN,
    items: rows.map((r) => ({
      id: r.id, ts: r.ts, level: r.level, category: r.category,
      message: r.message, meta: r.meta ? safeParse(r.meta) : null,
    })),
  };
}

function clearLogs() {
  getDb().prepare('DELETE FROM logs').run();
}

function stats() {
  const d = getDb();
  const total = d.prepare('SELECT COUNT(*) AS n FROM logs').get().n;
  const last24h = d.prepare('SELECT COUNT(*) AS n FROM logs WHERE ts >= ?').get(Date.now() - 24 * 3600 * 1000).n;
  const errors24h = d.prepare("SELECT COUNT(*) AS n FROM logs WHERE level = 'error' AND ts >= ?").get(Date.now() - 24 * 3600 * 1000).n;
  const byLevel = d.prepare('SELECT level, COUNT(*) AS n FROM logs GROUP BY level ORDER BY n DESC').all();
  const byCategory = d.prepare('SELECT category, COUNT(*) AS n FROM logs GROUP BY category ORDER BY n DESC').all();
  return { total, last24h, errors24h, byLevel, byCategory };
}


/* ============================ 自定义模型 ============================ */

function validateModelInput(body) {
  if (!body || typeof body !== 'object') return { error: 'invalid body' };
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!id) return { error: 'model id 不能为空' };
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) return { error: 'model id 仅允许字母、数字及 . _ : - 字符' };
  if (!name) return { error: 'model name 不能为空' };
  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : 0; };
  const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';
  return {
    model: {
      id,
      name,
      maxInputTokens: num(body.maxInputTokens),
      maxOutputTokens: num(body.maxOutputTokens),
      tools: bool(body.tools),
      vision: bool(body.vision),
      reasoning: bool(body.reasoning),
      region: body.region === 'intl' ? 'intl' : 'cn',
      createdAt: Date.now(),
    },
  };
}

function addModel(body) {
  const { error, model } = validateModelInput(body);
  if (error) return { error };
  const d = getDb();
  d.prepare(
    'INSERT INTO models(id, name, max_input_tokens, max_output_tokens, tools, vision, reasoning, region, created_at) ' +
    'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET name=excluded.name, max_input_tokens=excluded.max_input_tokens, ' +
    'max_output_tokens=excluded.max_output_tokens, tools=excluded.tools, vision=excluded.vision, ' +
    'reasoning=excluded.reasoning, region=excluded.region'
  ).run(model.id, model.name, model.maxInputTokens, model.maxOutputTokens,
        model.tools ? 1 : 0, model.vision ? 1 : 0, model.reasoning ? 1 : 0, model.region, model.createdAt);
  return { model };
}

function listModels() {
  const rows = getDb().prepare('SELECT * FROM models ORDER BY created_at ASC, id ASC').all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    maxInputTokens: r.max_input_tokens,
    maxOutputTokens: r.max_output_tokens,
    tools: !!r.tools,
    vision: !!r.vision,
    reasoning: !!r.reasoning,
    region: r.region,
    createdAt: r.created_at,
  }));
}

function removeModel(id) {
  if (!id) return { error: 'model id 不能为空' };
  const d = getDb();
  const r = d.prepare('DELETE FROM models WHERE id = ?').run(id);
  return { deleted: r.changes > 0 };
}

function getModel(id) {
  const r = getDb().prepare('SELECT * FROM models WHERE id = ?').get(id);
  if (!r) return null;
  return {
    id: r.id, name: r.name,
    maxInputTokens: r.max_input_tokens, maxOutputTokens: r.max_output_tokens,
    tools: !!r.tools, vision: !!r.vision, reasoning: !!r.reasoning, region: r.region,
  };
}

/* ============================ API 密钥 ============================ */

const crypto = require('crypto');

function generateApiKey() {
  return 'cb-' + crypto.randomBytes(24).toString('hex');
}

/** 首次启动时若无任何密钥，则自动生成一个默认密钥（含从 env 迁移的旧版密钥）。 */
function ensureDefaultApiKey() {
  const d = getDb();
  const envKey = String(config.DEFAULT_CONFIG.apiKey || '').trim();
  if (envKey) {
    const exists = d.prepare('SELECT id FROM api_keys WHERE key = ?').get(envKey);
    if (!exists) {
      d.prepare('INSERT OR IGNORE INTO api_keys(id, name, key, created_at) VALUES(?, ?, ?, ?)')
        .run(genId(), 'legacy', envKey, Date.now());
    }
  }
  const n = d.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n;
  if (n === 0) {
    d.prepare('INSERT INTO api_keys(id, name, key, created_at) VALUES(?, ?, ?, ?)')
      .run(genId(), 'default', generateApiKey(), Date.now());
  }
}

function genId() {
  return crypto.randomUUID();
}

function listApiKeys() {
  const rows = getDb().prepare('SELECT * FROM api_keys ORDER BY created_at ASC, id ASC').all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name || '',
    key: maskKey(r.key),
    fullKey: r.key,
    accountId: r.account_id || '',
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
  }));
}

/** 公开给管理页：不返回完整密钥 */
function listApiKeysPublic() {
  return listApiKeys().map((k) => ({ ...k, fullKey: undefined, key: k.key }));
}

function getApiKey(id) {
  const r = getDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  return r || null;
}

/** 新增密钥。name 必填（可为默认），accountId 可选（空 = 走账号池）。返回完整密钥对象（含 fullKey，仅创建时）。 */
function addApiKey({ name, key, accountId } = {}) {
  const d = getDb();
  const nm = (name && String(name).trim()) || 'default';
  const k = (key && String(key).trim()) || generateApiKey();
  const aid = (accountId && String(accountId).trim()) || '';
  if (!/^[A-Za-z0-9_-]{16,}$/.test(k)) return { error: '密钥格式无效（仅允许字母、数字及 _ -，至少 16 位）' };
  const exists = d.prepare('SELECT id FROM api_keys WHERE key = ?').get(k);
  if (exists) return { error: '密钥已存在' };
  const id = genId();
  const createdAt = Date.now();
  d.prepare('INSERT INTO api_keys(id, name, key, account_id, created_at) VALUES(?, ?, ?, ?, ?)')
    .run(id, nm, k, aid, createdAt);
  return { key: { id, name: nm, key: maskKey(k), fullKey: k, accountId: aid, createdAt, lastUsedAt: 0, useCount: 0 } };
}

/** 重新生成指定密钥的明文值。返回 { key: {..含 fullKey} }。 */
function regenerateApiKey(id) {
  const r = getApiKey(id);
  if (!r) return { error: '未找到该密钥' };
  const k = generateApiKey();
  getDb().prepare('UPDATE api_keys SET key = ? WHERE id = ?').run(k, id);
  return { key: { id: r.id, name: r.name || '', key: maskKey(k), fullKey: k, accountId: r.account_id || '', createdAt: r.created_at, lastUsedAt: r.last_used_at, useCount: r.use_count } };
}

function removeApiKey(id) {
  const r = getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  if (r.changes === 0) return { error: '未找到该密钥' };
  return { ok: true, id };
}

/** 更新指定密钥绑定的账号（accountId 空 = 走账号池）。返回更新后的公开密钥对象。 */
function setApiKeyAccount(id, accountId) {
  const existing = getApiKey(id);
  if (!existing) return { error: '未找到该密钥' };
  const aid = (accountId && String(accountId).trim()) || '';
  getDb().prepare('UPDATE api_keys SET account_id = ? WHERE id = ?').run(aid, id);
  const updated = getApiKey(id);
  return { key: { id: updated.id, name: updated.name || '', key: maskKey(updated.key), accountId: updated.account_id || '', createdAt: updated.created_at, lastUsedAt: updated.last_used_at, useCount: updated.use_count } };
}

/** 校验提供的明文密钥是否命中任一存储密钥（常数时间比较）。命中则更新最近使用。 */
function apiKeyValid(provided) {
  return !!resolveApiKey(provided);
}

/** 返回命中的密钥信息 { id, name, accountId }，未命中返回 null。会更新最近使用。 */
function resolveApiKey(provided) {
  const d = getDb();
  const rows = d.prepare('SELECT id, name, key, account_id FROM api_keys').all();
  const b = Buffer.from(String(provided));
  for (const r of rows) {
    const a = Buffer.from(r.key);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      d.prepare('UPDATE api_keys SET last_used_at = ?, use_count = use_count + 1 WHERE key = ?').run(Date.now(), r.key);
      return { id: r.id, name: r.name || '', accountId: r.account_id || '' };
    }
  }
  return null;
}

/** 客户端密钥校验是否启用 */
function clientKeyVerificationEnabled() {
  return asBool(getConfig().apiKeyEnabled, true);
}

/* ============================ 用量记录 ============================ */

function genUsageId() {
  return 'u_' + crypto.randomBytes(10).toString('hex');
}

/** 记录一次 LLM 请求的用量。account 与 key 均可为空（未走密钥 = 空密钥维度）。 */
function recordUsage({
  source = '', model = '', stream = false,
  accountId = '', accountName = '',
  apiKeyId = '', apiKeyName = '',
  promptTokens = 0, completionTokens = 0, totalTokens = 0,
  cachedTokens = 0, durationMs = 0, status = 'ok',
} = {}) {
  try {
    getDb().prepare(
      'INSERT INTO usage(id, ts, source, model, stream, account_id, account_name, api_key_id, api_key_name, ' +
      'prompt_tokens, completion_tokens, total_tokens, cached_tokens, duration_ms, status) ' +
      'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      genUsageId(), Date.now(), String(source || ''), String(model || ''),
      stream ? 1 : 0, String(accountId || ''), String(accountName || ''),
      String(apiKeyId || ''), String(apiKeyName || ''),
      asInt(promptTokens), asInt(completionTokens), asInt(totalTokens),
      asInt(cachedTokens), asInt(durationMs), status === 'error' ? 'error' : 'ok'
    );
  } catch { /* 用量写入失败不应影响请求 */ }
}

function mapUsageRow(r) {
  return {
    id: r.id,
    ts: r.ts,
    source: r.source,
    model: r.model,
    stream: !!r.stream,
    accountId: r.account_id,
    accountName: r.account_name,
    apiKeyId: r.api_key_id,
    apiKeyName: r.api_key_name,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens,
    cachedTokens: r.cached_tokens || 0,
    cacheHitRate: cacheHitRate(r.cached_tokens || 0, r.prompt_tokens),
    durationMs: r.duration_ms,
    status: r.status,
  };
}

/** 缓存命中率（%）：命中 token 占输入 token 的比例，0–100；无输入 token 时为 0。 */
function cacheHitRate(cached, prompt) {
  if (!prompt) return 0;
  const rate = (asInt(cached) / asInt(prompt)) * 100;
  if (!Number.isFinite(rate) || rate < 0) return 0;
  return Math.min(100, rate);
}

/** 查询用量记录。支持时间、账号、密钥、模型过滤与分页。 */
function queryUsage({ from, to, accountId, apiKeyId, model, status, limit = 50, offset = 0 } = {}) {
  const conds = [];
  const params = [];
  if (from) { conds.push('ts >= ?'); params.push(Number(from)); }
  if (to) { conds.push('ts <= ?'); params.push(Number(to)); }
  if (accountId) { conds.push('account_id = ?'); params.push(accountId); }
  if (apiKeyId) { conds.push('api_key_id = ?'); params.push(apiKeyId); }
  if (model) { conds.push('model = ?'); params.push(model); }
  if (status === 'error' || status === 'ok') { conds.push('status = ?'); params.push(status); }
  const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';

  const limitN = Math.min(Math.max(asInt(limit, 50), 1), 500);
  const offsetN = Math.max(asInt(offset, 0), 0);
  const d = getDb();
  const total = d.prepare('SELECT COUNT(*) AS n FROM usage' + where).get(...params).n;
  const rows = d.prepare(
    'SELECT * FROM usage' + where + ' ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?'
  ).all(...params, limitN, offsetN);
  const agg = d.prepare(
    'SELECT COUNT(*) AS calls, IFNULL(SUM(prompt_tokens),0) AS prompt, IFNULL(SUM(completion_tokens),0) AS completion, ' +
    'IFNULL(SUM(total_tokens),0) AS total, IFNULL(SUM(cached_tokens),0) AS cached FROM usage' + where
  ).get(...params);
  return {
    total,
    limit: limitN,
    offset: offsetN,
    calls: agg ? agg.calls : 0,
    promptTokens: agg ? agg.prompt : 0,
    completionTokens: agg ? agg.completion : 0,
    totalTokens: agg ? agg.total : 0,
    cachedTokens: agg ? agg.cached : 0,
    cacheHitRate: cacheHitRate(agg ? agg.cached : 0, agg ? agg.prompt : 0),
    items: rows.map(mapUsageRow),
  };
}

/**
 * 按天聚合 token 用量，供首页图表使用。
 * dimension: 'account' | 'apiKey' —— 决定按哪个维度分组。
 * 返回 { days: [...], series: [{ id, name, points: { [day]: totalTokens } }] }，
 * day 为 'YYYY-MM-DD'（本地时区）。
 */
function usageStatsByDay({ dimension = 'account', from, to } = {}) {
  const days = [];
  const now = new Date();
  const start = from ? new Date(Number(from)) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13);
  const end = to ? new Date(Number(to)) : new Date(now);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
    days.push(toDayKey(dt));
  }
  if (!days.length) return { days: [], series: [] };

  const startTs = start.getTime();
  const endTs = end.getTime();
  const d = getDb();
  const col = dimension === 'apiKey' ? 'api_key_id' : 'account_id';
  const nameCol = dimension === 'apiKey' ? 'api_key_name' : 'account_name';
  const rows = d.prepare(
    'SELECT ' + col + ' AS gid, ' + nameCol + ' AS gname, ts, total_tokens, cached_tokens FROM usage ' +
    'WHERE ts >= ? AND ts <= ?'
  ).all(startTs, endTs);

  const seriesMap = new Map();
  const makeSeries = (gid, gname) => {
    if (seriesMap.has(gid)) return seriesMap.get(gid);
    const points = {};
    const cached = {};
    for (const day of days) { points[day] = 0; cached[day] = 0; }
    const s = { id: gid, name: gname || (dimension === 'apiKey' ? '(未走密钥)' : '(空账号)'), points, cached };
    seriesMap.set(gid, s);
    return s;
  };

  // 未走密钥/无账号：统一归到空密钥/空账号维度
  for (const r of rows) {
    const gid = r.gid || '';
    const s = makeSeries(gid, r.gname);
    const day = toDayKey(new Date(r.ts));
    if (s.points[day] != null) s.points[day] += asInt(r.total_tokens);
    if (s.cached[day] != null) s.cached[day] += asInt(r.cached_tokens);
  }

  const series = Array.from(seriesMap.values());
  // 按总用量降序，最多展示若干条
  series.sort((a, b) => totalOf(a.points) - totalOf(b.points));
  return { days, series: series.slice(0, 12) };
}

function toDayKey(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function totalOf(points) {
  let s = 0;
  for (const k in points) s += points[k];
  return s;
}

/** 汇总统计：总 token、请求次数、错误次数，供首页 StatCard 使用 */
function usageTotals() {
  const d = getDb();
  const r = d.prepare(
    'SELECT COUNT(*) AS calls, IFNULL(SUM(total_tokens),0) AS total, ' +
    'IFNULL(SUM(prompt_tokens),0) AS prompt, IFNULL(SUM(completion_tokens),0) AS completion, ' +
    'IFNULL(SUM(cached_tokens),0) AS cached ' +
    'FROM usage'
  ).get();
  const err = d.prepare("SELECT COUNT(*) AS n FROM usage WHERE status = 'error'").get().n;
  const last24h = d.prepare('SELECT COUNT(*) AS n, IFNULL(SUM(prompt_tokens),0) AS prompt, IFNULL(SUM(total_tokens),0) AS total, IFNULL(SUM(cached_tokens),0) AS cached FROM usage WHERE ts >= ?')
    .get(Date.now() - 24 * 3600 * 1000);
  return {
    calls: r ? r.calls : 0,
    promptTokens: r ? r.prompt : 0,
    completionTokens: r ? r.completion : 0,
    totalTokens: r ? r.total : 0,
    cachedTokens: r ? r.cached : 0,
    cacheHitRate: cacheHitRate(r ? r.cached : 0, r ? r.prompt : 0),
    errors: err,
    calls24h: last24h ? last24h.n : 0,
    tokens24h: last24h ? last24h.total : 0,
    cachedTokens24h: last24h ? last24h.cached : 0,
    cacheHitRate24h: cacheHitRate(last24h ? last24h.cached : 0, last24h ? last24h.prompt : 0),
  };
}

/* ============================ 账号池（登录态迁移到 SQLite） ============================ */

function safeParseJson(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

function accountRowToObject(r) {
  return {
    id: r.id,
    name: r.name || '',
    source: r.source || 'file',
    addedBy: r.added_by || 'file',
    account: safeParseJson(r.account, {}),
    auth: safeParseJson(r.auth, {}),
    accounts: safeParseJson(r.accounts, []),
    lastUsedAt: r.last_used_at || 0,
    useCount: r.use_count || 0,
    createdAt: r.created_at || 0,
    updatedAt: r.updated_at || 0,
  };
}

/** 列出账号池全部账号（按创建时间升序，保持旧 session 数组顺序语义） */
function listAccountRows() {
  const rows = getDb().prepare('SELECT * FROM accounts ORDER BY created_at ASC, id ASC').all();
  return rows.map(accountRowToObject);
}

function getAccountRow(id) {
  if (!id) return null;
  const r = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  return r ? accountRowToObject(r) : null;
}

/**
 * 新增账号（持久化到 accounts 表）。
 * acct: { id?, name?, source?, addedBy?, account?, auth?, accounts?, lastUsedAt?, useCount?, createdAt? }
 */
function insertAccount(acct) {
  if (!acct || typeof acct !== 'object') return null;
  const id = acct.id || ('acct_' + crypto.randomBytes(12).toString('hex'));
  const name = String(acct.name || '');
  const source = String(acct.source || 'file');
  const addedBy = String(acct.addedBy || source || 'file');
  const account = acct.account || {};
  const auth = acct.auth || {};
  const accounts = Array.isArray(acct.accounts) ? acct.accounts : [];
  const createdAt = Number(acct.createdAt) || Date.now();
  const now = Date.now();
  getDb().prepare(
    'INSERT INTO accounts(id, name, source, added_by, account, auth, accounts, last_used_at, use_count, created_at, updated_at) ' +
    'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET ' +
    'name=excluded.name, source=excluded.source, added_by=excluded.added_by, ' +
    'account=excluded.account, auth=excluded.auth, accounts=excluded.accounts, ' +
    'last_used_at=excluded.last_used_at, use_count=excluded.use_count, updated_at=excluded.updated_at'
  ).run(
    id, name, source, addedBy,
    JSON.stringify(account), JSON.stringify(auth), JSON.stringify(accounts),
    Number(acct.lastUsedAt) || 0, Number(acct.useCount) || 0, createdAt, now
  );
  return getAccountRow(id);
}

/** 更新账号（按 id），patch 支持 name / auth / account / source / addedBy / lastUsedAt / useCount */
function updateAccountRow(id, patch) {
  if (!id || !patch || typeof patch !== 'object') return getAccountRow(id);
  const existing = getAccountRow(id);
  if (!existing) return null;
  const next = Object.assign({}, existing, patch);
  getDb().prepare(
    'UPDATE accounts SET name=?, source=?, added_by=?, account=?, auth=?, accounts=?, last_used_at=?, use_count=?, updated_at=? WHERE id=?'
  ).run(
    String(next.name || ''),
    String(next.source || 'file'),
    String(next.addedBy || next.source || 'file'),
    JSON.stringify(next.account || {}),
    JSON.stringify(next.auth || {}),
    JSON.stringify(Array.isArray(next.accounts) ? next.accounts : []),
    Number(next.lastUsedAt) || 0,
    Number(next.useCount) || 0,
    Date.now(),
    id
  );
  return getAccountRow(id);
}

function deleteAccountRow(id) {
  const r = getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
  return r.changes > 0;
}

function accountCount() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
}

/* ---- 账号池配置（单行存储，version=2 固定） ---- */

function defaultPoolConfig() {
  return { version: 2, pool: { mode: 'pool', strategy: 'round-robin', pinnedId: null, cursor: 0 } };
}

function getAccountPool() {
  const r = getDb().prepare("SELECT config FROM account_pool WHERE id = 1").get();
  if (!r) return defaultPoolConfig();
  const cfg = safeParseJson(r.config, null);
  if (!cfg || typeof cfg !== 'object') return defaultPoolConfig();
  return Object.assign(defaultPoolConfig(), cfg);
}

function setAccountPool(config) {
  const cfg = config && typeof config === 'object' ? config : defaultPoolConfig();
  const now = Date.now();
  getDb().prepare(
    'INSERT INTO account_pool(id, config, updated_at) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET config=excluded.config, updated_at=excluded.updated_at'
  ).run(JSON.stringify(cfg), now);
  return getAccountPool();
}

/* ============================ 管理页鉴权 ============================ */

/** scrypt 派生密码哈希，返回 `scrypt$N$r$p$salt$hash`（salt/hash 均为 hex） */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keyLen } = config.ADMIN_SCRYPT;
  const hash = crypto.scryptSync(String(password), salt, keyLen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** 常数时间校验密码。返回 true/false */
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !salt.length || !expected.length) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
  } catch { return false; }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/** 管理员账号是否已设置密码 */
function adminConfigured() {
  const r = getDb().prepare('SELECT password_hash FROM admin_users WHERE username = ?').get(config.ADMIN_USERNAME);
  return !!(r && r.password_hash);
}

/** 是否开启管理页鉴权（配置开关） */
function adminAuthEnabled() {
  return asBool(getConfig().adminAuthEnabled, false);
}

/** 获取管理员账号记录（不含敏感信息外泄，仅内部使用） */
function getAdminUser(username) {
  return getDb().prepare('SELECT * FROM admin_users WHERE username = ?').get(username || config.ADMIN_USERNAME) || null;
}

/** 设置/更新管理员密码。mustChange 为 true 表示下次登录强制改密 */
function setAdminPassword(username, password, { mustChange = false } = {}) {
  const u = username || config.ADMIN_USERNAME;
  const hash = hashPassword(password);
  const now = Date.now();
  getDb().prepare(
    'INSERT INTO admin_users(username, password_hash, must_change, created_at, updated_at) VALUES(?, ?, ?, ?, ?) ' +
    'ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, must_change=excluded.must_change, updated_at=excluded.updated_at'
  ).run(u, hash, mustChange ? 1 : 0, now, now);
  return true;
}

/** 校验管理员密码。返回 { ok, mustChange } */
function verifyAdminPassword(username, password) {
  const r = getAdminUser(username);
  if (!r || !r.password_hash) return { ok: false, mustChange: false };
  const ok = verifyPassword(password, r.password_hash);
  return { ok, mustChange: !!r.must_change };
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/** 创建持久化会话。token 明文仅返回一次，库中只存其哈希。返回 { token, expiresAt } */
function createAdminSession(username, { userAgent = '', ip = '', ttlMs = config.ADMIN_SESSION_TTL_MS } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + ttlMs;
  getDb().prepare(
    'INSERT INTO admin_sessions(token_hash, username, created_at, expires_at, last_seen_at, user_agent, ip) ' +
    'VALUES(?, ?, ?, ?, ?, ?, ?)'
  ).run(tokenHash, username || config.ADMIN_USERNAME, now, expiresAt, now, userAgent || '', ip || '');
  pruneAdminSessions();
  return { token, expiresAt };
}

/** 根据 token 校验会话。返回 { username, expiresAt } 或 null。有效时刷新 last_seen。 */
function getAdminSession(token) {
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  const now = Date.now();
  const r = getDb().prepare('SELECT * FROM admin_sessions WHERE token_hash = ?').get(tokenHash);
  if (!r) return null;
  if (r.expires_at <= now) { deleteAdminSessionByHash(tokenHash); return null; }
  getDb().prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, tokenHash);
  return { username: r.username, expiresAt: r.expires_at, createdAt: r.created_at };
}

/** 续期会话（滑动续期）：把过期时间推迟一个 TTL。 */
function renewAdminSession(token, ttlMs = config.ADMIN_SESSION_TTL_MS) {
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  const now = Date.now();
  const r = getDb().prepare('SELECT * FROM admin_sessions WHERE token_hash = ?').get(tokenHash);
  if (!r) return null;
  const expiresAt = now + ttlMs;
  getDb().prepare('UPDATE admin_sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?').run(expiresAt, now, tokenHash);
  return { username: r.username, expiresAt };
}

function deleteAdminSessionByHash(tokenHash) {
  getDb().prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(tokenHash);
}

/** 注销单个会话（按 token 明文） */
function revokeAdminSession(token) {
  if (!token) return;
  deleteAdminSessionByHash(sha256Hex(token));
}

/** 注销某用户名下所有会话 */
function revokeAllAdminSessions(username) {
  getDb().prepare('DELETE FROM admin_sessions WHERE username = ?').run(username || config.ADMIN_USERNAME);
}

/** 清理过期会话 */
function pruneAdminSessions() {
  getDb().prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now());
}

/* ============================ 失败限流（持久化） ============================ */

/**
 * 持久化限流检查。key 唯一标识限流维度（如 `admin:<ip>|<user>`、`apikey:<ip>`）。
 * 失败计数有独立窗口；锁定到期时间独立存储，不会因计数窗口滑动被清掉。
 * 返回 { allowed, retryAfterSec }。
 */
function rateLimitCheck(key, { scope = 'admin', maxFails = 8, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000 } = {}) {
  const now = Date.now();
  const d = getDb();
  let r = d.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key);
  // 锁定未到期 → 拒绝
  if (r && r.locked_until > now) {
    return { allowed: false, retryAfterSec: Math.ceil((r.locked_until - now) / 1000) };
  }
  // 计数窗口过期 → 重置计数（但保留锁定判断已在上面处理）
  if (r && now - r.window_start > windowMs) {
    d.prepare('UPDATE rate_limits SET fails = 0, window_start = ?, locked_until = 0 WHERE key = ?').run(now, key);
    r = { key, scope, fails: 0, window_start: now, locked_until: 0 };
  }
  if (!r) {
    d.prepare('INSERT INTO rate_limits(key, scope, fails, window_start, locked_until) VALUES(?, ?, 0, ?, 0)')
      .run(key, scope, now);
  }
  return { allowed: true, retryAfterSec: 0 };
}

/** 记录一次失败。返回是否触发锁定。 */
function rateLimitRecordFailure(key, { scope = 'admin', maxFails = 8, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000 } = {}) {
  const now = Date.now();
  const d = getDb();
  let r = d.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key);
  if (!r || now - r.window_start > windowMs) {
    d.prepare(
      'INSERT INTO rate_limits(key, scope, fails, window_start, locked_until) VALUES(?, ?, 1, ?, 0) ' +
      'ON CONFLICT(key) DO UPDATE SET fails = 1, window_start = excluded.window_start, locked_until = 0'
    ).run(key, scope, now);
    r = d.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key);
  } else {
    d.prepare('UPDATE rate_limits SET fails = fails + 1 WHERE key = ?').run(key);
    r = d.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key);
  }
  if (r.fails >= maxFails) {
    const lockedUntil = now + lockMs;
    d.prepare('UPDATE rate_limits SET locked_until = ? WHERE key = ?').run(lockedUntil, key);
    return { locked: true, lockedUntil };
  }
  return { locked: false };
}

/** 成功后清空该 key 的失败计数与锁定 */
function rateLimitReset(key) {
  getDb().prepare('DELETE FROM rate_limits WHERE key = ?').run(key);
}

/** 清理已过期且已解锁的限流记录（避免表无限增长） */
function pruneRateLimits() {
  const now = Date.now();
  getDb().prepare('DELETE FROM rate_limits WHERE locked_until <= ? AND window_start < ?')
    .run(now, now - 24 * 3600 * 1000);
}

module.exports = {
  // 账号池（登录态已迁移到 SQLite）
  listAccountRows, getAccountRow, insertAccount, updateAccountRow, deleteAccountRow, accountCount,
  getAccountPool, setAccountPool, defaultPoolConfig,

  // 自定义模型
  addModel, listModels, removeModel, getModel,

  getConfig, setConfig, publicValues, applyPublicPatch,
  getRequestTimeoutMs, getCorsOrigin, loggingDetailsEnabled,
  addLog, queryLogs, clearLogs, stats,

  // API 密钥
  ensureDefaultApiKey, listApiKeys, listApiKeysPublic, addApiKey,
  regenerateApiKey, removeApiKey, setApiKeyAccount, apiKeyValid, resolveApiKey, clientKeyVerificationEnabled,

  // 用量记录
  recordUsage, queryUsage, usageStatsByDay, usageTotals,

  // 管理页鉴权
  adminAuthEnabled, adminConfigured, getAdminUser, setAdminPassword, verifyAdminPassword,
  hashPassword, verifyPassword,
  createAdminSession, getAdminSession, renewAdminSession, revokeAdminSession,
  revokeAllAdminSessions, pruneAdminSessions,

  // 失败限流（持久化）
  rateLimitCheck, rateLimitRecordFailure, rateLimitReset, pruneRateLimits,
};
