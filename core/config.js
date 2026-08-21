'use strict';

/**
 * 静态配置：环境变量 + 默认值。
 * 运行时可动态修改的配置（日志开关、默认模型等）见 store.js。
 */

const os = require('os');
const path = require('path');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || process.env.CODEBUDDY_PROXY_PORT || '3800', 10);
const HOST = process.env.HOST || process.env.CODEBUDDY_PROXY_HOST || '127.0.0.1';

const ENDPOINT = (process.env.CODEBUDDY_ENDPOINT || 'https://copilot.tencent.com').replace(/\/+$/, '');
const PREFIX_PATH = process.env.CODEBUDDY_PREFIX_PATH || '/plugin';
const PLATFORM = process.env.CODEBUDDY_PLATFORM || 'VSCode';

const DATA_DIR = process.env.CODEBUDDY_DATA_DIR || path.join(os.homedir(), '.codebuddy-proxy');
const SESSION_FILE = process.env.CODEBUDDY_SESSION_FILE || path.join(DATA_DIR, 'session.json');
const DB_FILE = process.env.CODEBUDDY_DB_FILE || path.join(DATA_DIR, 'proxy.db');

const DIST_DIR = path.join(__dirname, '..', 'dist');

const ENDPOINT_HOST = (() => { try { return new URL(ENDPOINT).host; } catch { return 'copilot.tencent.com'; } })();

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_INTERVAL_MS = 1000;
const REFRESH_AHEAD_MS = 60 * 1000;

const VERSION = (() => {
  try { return require('../package.json').version || '1.0.0'; } catch { return '1.0.0'; }
})();

/**
 * 系统配置默认值（可被 DB 中的 config 表覆盖）。
 * 值统一存成字符串，读取处再做类型转换。
 */
const DEFAULT_CONFIG = {
  'logging.enabled': 'true',
  'logging.details': 'true',          // 是否记录请求摘要 / tokens / 耗时等详情
  'logging.level': 'info',            // debug | info | warn | error
  'logging.retentionDays': '7',       // 日志保留天数，0 = 永久
  'logging.maxRows': '10000',         // 日志条数上限，超出后删除最旧，0 = 不限制
  'autoOpen': process.env.CODEBUDDY_NO_OPEN ? 'false' : 'true',
  'defaultModel': process.env.CODEBUDDY_DEFAULT_MODEL || 'default',
  'forceModel': process.env.CODEBUDDY_FORCE_MODEL || '',
  'requestTimeoutMs': '300000',       // 上游请求超时
  'cors.origin': '*',                 // CORS Allow-Origin
};

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const LOG_CATEGORIES = ['system', 'auth', 'proxy', 'responses', 'config'];

module.exports = {
  PORT, HOST, ENDPOINT, PREFIX_PATH, PLATFORM,
  DATA_DIR, SESSION_FILE, DB_FILE, DIST_DIR, ENDPOINT_HOST,
  LOGIN_TIMEOUT_MS, LOGIN_POLL_INTERVAL_MS, REFRESH_AHEAD_MS,
  VERSION, DEFAULT_CONFIG, LOG_LEVELS, LOG_CATEGORIES,
};
