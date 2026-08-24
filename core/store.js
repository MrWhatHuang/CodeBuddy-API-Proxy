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
    `);

  // 兼容旧库：若 usage 表缺少 cached_tokens 列则补充
  try {
    const cols = db.prepare("PRAGMA table_info(usage)").all().map((c) => c.name);
    if (!cols.includes('cached_tokens')) {
      db.exec('ALTER TABLE usage ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0');
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

/** 新增密钥。name 必填（可为默认）。返回完整密钥对象（含 fullKey，仅创建时）。 */
function addApiKey({ name, key } = {}) {
  const d = getDb();
  const nm = (name && String(name).trim()) || 'default';
  const k = (key && String(key).trim()) || generateApiKey();
  if (!/^[A-Za-z0-9_-]{6,}$/.test(k)) return { error: '密钥格式无效（仅允许字母、数字及 _ -，至少 6 位）' };
  const exists = d.prepare('SELECT id FROM api_keys WHERE key = ?').get(k);
  if (exists) return { error: '密钥已存在' };
  const id = genId();
  const createdAt = Date.now();
  d.prepare('INSERT INTO api_keys(id, name, key, created_at) VALUES(?, ?, ?, ?)')
    .run(id, nm, k, createdAt);
  return { key: { id, name: nm, key: maskKey(k), fullKey: k, createdAt, lastUsedAt: 0, useCount: 0 } };
}

/** 重新生成指定密钥的明文值。返回 { key: {..含 fullKey} }。 */
function regenerateApiKey(id) {
  const r = getApiKey(id);
  if (!r) return { error: '未找到该密钥' };
  const k = generateApiKey();
  getDb().prepare('UPDATE api_keys SET key = ? WHERE id = ?').run(k, id);
  return { key: { id: r.id, name: r.name || '', key: maskKey(k), fullKey: k, createdAt: r.created_at, lastUsedAt: r.last_used_at, useCount: r.use_count } };
}

function removeApiKey(id) {
  const r = getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  if (r.changes === 0) return { error: '未找到该密钥' };
  return { ok: true, id };
}

/** 校验提供的明文密钥是否命中任一存储密钥（常数时间比较）。命中则更新最近使用。 */
function apiKeyValid(provided) {
  return !!resolveApiKey(provided);
}

/** 返回命中的密钥信息 { id, name }，未命中返回 null。会更新最近使用。 */
function resolveApiKey(provided) {
  const d = getDb();
  const rows = d.prepare('SELECT id, name, key FROM api_keys').all();
  const b = Buffer.from(String(provided));
  for (const r of rows) {
    const a = Buffer.from(r.key);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      d.prepare('UPDATE api_keys SET last_used_at = ?, use_count = use_count + 1 WHERE key = ?').run(Date.now(), r.key);
      return { id: r.id, name: r.name || '' };
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

module.exports = {
  // 自定义模型
  addModel, listModels, removeModel, getModel,

  getConfig, setConfig, publicValues, applyPublicPatch,
  getRequestTimeoutMs, getCorsOrigin, loggingDetailsEnabled,
  addLog, queryLogs, clearLogs, stats,

  // API 密钥
  ensureDefaultApiKey, listApiKeys, listApiKeysPublic, addApiKey,
  regenerateApiKey, removeApiKey, apiKeyValid, resolveApiKey, clientKeyVerificationEnabled,

  // 用量记录
  recordUsage, queryUsage, usageStatsByDay, usageTotals,
};
