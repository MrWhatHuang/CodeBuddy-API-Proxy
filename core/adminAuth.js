'use strict';

/**
 * 管理页鉴权：登录 / 会话校验 / 登出 / 改密，以及暴力破解限流。
 *
 * 设计要点：
 *   - 密码用 scrypt（随机盐）哈希存储，常数时间比较。
 *   - 登录成功后签发 256-bit 随机 token，库里只存其 sha256。
 *   - token 通过 HttpOnly + SameSite=Strict + Path=/ 的 Cookie 下发，
 *     前端 JS 无法读取（防 XSS 窃取）；同时支持 Authorization: Bearer <token> 便于脚本调用。
 *   - 会话持久化到 SQLite，服务重启后仍有效；支持滑动续期。
 *   - 登录失败限流持久化到 SQLite（重启不清零），锁定到期时间独立存储。
 *   - 客户端 IP：仅在 TRUST_PROXY 开启时信任 X-Forwarded-For，否则用 socket 远端地址，
 *     防止攻击者伪造 X-Forwarded-For 绕过限流。
 */

const crypto = require('crypto');

const config = require('./config');
const store = require('./store');
const logger = require('./logger');
const util = require('./util');

/* ---------------- 客户端 IP（受信代理感知） ---------------- */

/** 取客户端真实 IP。仅在 config.TRUST_PROXY 为 true 时信任代理注入的头。 */
function clientIp(req) {
  if (config.TRUST_PROXY) {
    const h = req.headers || {};
    const fwd = String(h['x-forwarded-for'] || h['X-Forwarded-For'] || '');
    if (fwd) return fwd.split(',')[0].trim();
    const real = String(h['x-real-ip'] || h['X-Real-Ip'] || '');
    if (real) return real.trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ---------------- 限流（持久化，按 IP + 用户名） ---------------- */

const RATE_WINDOW_MS = 15 * 60 * 1000;   // 窗口：15 分钟
const RATE_MAX_FAILS = 8;                 // 窗口内最多失败次数
const RATE_LOCK_MS = 15 * 60 * 1000;      // 超限后锁定时长

function rateKey(req, username) {
  return 'admin:' + clientIp(req) + '|' + String(username || '').toLowerCase();
}

function rateCheck(req, username) {
  return store.rateLimitCheck(rateKey(req, username), {
    scope: 'admin', maxFails: RATE_MAX_FAILS, windowMs: RATE_WINDOW_MS, lockMs: RATE_LOCK_MS,
  });
}

function rateRecordFailure(req, username) {
  return store.rateLimitRecordFailure(rateKey(req, username), {
    scope: 'admin', maxFails: RATE_MAX_FAILS, windowMs: RATE_WINDOW_MS, lockMs: RATE_LOCK_MS,
  });
}

function rateReset(req, username) {
  store.rateLimitReset(rateKey(req, username));
}

/* ---------------- Cookie 解析 / 写入 ---------------- */

function parseCookies(req) {
  const header = req.headers && (req.headers.cookie || req.headers.Cookie || '');
  if (!header) return {};
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function cookieString(name, value, { expiresAt, httpOnly = true, sameSite = 'Strict', secure = false } = {}) {
  let s = name + '=' + encodeURIComponent(value) + '; Path=/';
  if (httpOnly) s += '; HttpOnly';
  s += '; SameSite=' + sameSite;
  if (secure) s += '; Secure';
  if (expiresAt) s += '; Expires=' + new Date(expiresAt).toUTCString();
  return s;
}

/** 从请求中提取会话 token：优先 Cookie，其次 Authorization: Bearer / X-Admin-Token。 */
function extractToken(req) {
  const cookies = parseCookies(req);
  if (cookies[config.ADMIN_COOKIE]) return cookies[config.ADMIN_COOKIE];
  const h = req.headers || {};
  const authHeader = String(h['authorization'] || h['Authorization'] || '');
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  if (authHeader.startsWith('bearer ')) return authHeader.slice(7).trim();
  const x = String(h['x-admin-token'] || h['X-Admin-Token'] || '').trim();
  if (x) return x;
  return '';
}

/** 校验会话。返回 { ok, username, mustRenew, expiresAt } 或 { ok: false, reason }。 */
function verifySession(req) {
  const token = extractToken(req);
  if (!token) return { ok: false, reason: 'missing' };
  const sess = store.getAdminSession(token);
  if (!sess) return { ok: false, reason: 'invalid' };
  const mustRenew = sess.expiresAt - Date.now() < config.ADMIN_SESSION_RENEW_MS;
  return { ok: true, username: sess.username, expiresAt: sess.expiresAt, mustRenew, token };
}

/* ---------------- 是否需要鉴权的路径判断 ---------------- */

// AI 对话接口：只走 API key 校验，不要求登录（保持与登录态解耦）
const PUBLIC_PROXY_PATHS = [
  '/v1/chat/completions', '/chat/completions',
  '/v1/completions', '/completions',
  '/v1/embeddings', '/embeddings',
  '/v1/responses', '/responses',
];

// 始终放行：健康检查 + 登录相关接口（登录页/登录接口本身必须公开，否则无法登录）
const ALWAYS_PUBLIC = new Set([
  '/health',
  '/api/admin/login',
  '/api/admin/status',
  '/admin-login',
]);

/** 判断路径是否属于「管理接口」，需要鉴权。SPA 页面与静态资源必须公开。 */
function isProtectedPath(pathname, method) {
  if (!pathname) return false;
  if (ALWAYS_PUBLIC.has(pathname)) return false;
  // AI 对话代理接口放行（POST）
  if (method === 'POST' && PUBLIC_PROXY_PATHS.includes(pathname)) return false;
  // /v1/models 与 /models 仍按 API key 校验（属于代理 API，不强制登录）
  if (pathname === '/v1/models' || pathname === '/models') return false;

  // 管理 API、OAuth 登录流程、session 等后端接口需要登录
  if (pathname.startsWith('/api/')) return true;
  if (pathname === '/session' || pathname.startsWith('/session/')) return true;
  if (pathname === '/logout') return true;
  if (pathname.startsWith('/login/')) return true; // /login/state、/login/status

  // SPA 路由（/home、/settings、/admin-login…）和静态资源（/assets/*、favicon）必须公开，
  // 否则浏览器拿不到登录页 HTML/JS，只会看到 JSON 401。
  return false;
}

/* ---------------- 中间件 ---------------- */

/**
 * 鉴权中间件：在 routes.route() 开头调用。
 * 未开启鉴权时直接放行；开启后对受保护路径校验会话。
 * 返回 null 表示放行；返回 { status, body } 表示应直接响应该错误。
 */
function guard(req, pathname, method) {
  if (!store.adminAuthEnabled()) return null;
  if (!isProtectedPath(pathname, method)) return null;

  const v = verifySession(req);
  if (!v.ok) {
    return {
      status: 401,
      body: { error: { message: '未登录或会话已失效', type: 'admin_auth_required' } },
    };
  }

  // 滑动续期：剩余时间不足时刷新过期时间，并写回 Cookie
  if (v.mustRenew && v.token && pathname !== '/api/admin/logout') {
    const renewed = store.renewAdminSession(v.token);
    if (renewed) {
      return { __renew: { token: v.token, expiresAt: renewed.expiresAt } };
    }
  }
  return null;
}

module.exports = {
  guard,
  isProtectedPath,
  parseCookies,
  cookieString,
  extractToken,
  verifySession,
  clientIp,
  rateCheck,
  rateRecordFailure,
  rateReset,
};
