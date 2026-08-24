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
    `);
  return db;
}

function asBool(v, fallback = false) {
  if (v == null || v === '') return fallback;
  return v === 'true' || v === '1';
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

module.exports = {
  // 自定义模型
  addModel, listModels, removeModel, getModel,

  getConfig, setConfig, publicValues, applyPublicPatch,
  getRequestTimeoutMs, getCorsOrigin, loggingDetailsEnabled,
  addLog, queryLogs, clearLogs, stats,
};
