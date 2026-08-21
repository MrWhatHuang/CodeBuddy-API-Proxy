'use strict';

/** 会话状态：登录态的归一化、读写本地缓存、退出清理 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

let session = null;          // { account, auth, accounts }
let sessionSource = '';      // 'vscode' | 'oauth' | 'file'

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

function loadSession() {
  try {
    if (fs.existsSync(config.SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(config.SESSION_FILE, 'utf8'));
      const norm = normalizeSession(data);
      if (norm) { session = norm; sessionSource = 'file'; return true; }
    }
  } catch (e) { logger.log('warn', 'system', `加载本地 session 失败: ${e.message}`); }
  return false;
}

function saveSession() {
  try {
    fs.mkdirSync(path.dirname(config.SESSION_FILE), { recursive: true });
    fs.writeFileSync(config.SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  } catch (e) { logger.log('error', 'system', `保存 session 失败: ${e.message}`); }
}

function clearSession() {
  session = null; sessionSource = '';
  try { if (fs.existsSync(config.SESSION_FILE)) fs.unlinkSync(config.SESSION_FILE); } catch { /* ignore */ }
}

function isLoggedIn() { return !!(session && session.auth && session.auth.accessToken); }

function getSession() { return session; }
function setSession(s, source) { session = s; sessionSource = source; }
function getSessionSource() { return sessionSource; }

module.exports = {
  normalizeSession, loadSession, saveSession, clearSession,
  isLoggedIn, getSession, setSession, getSessionSource,
};
