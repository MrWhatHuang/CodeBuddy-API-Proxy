'use strict';

/**
 * 从 VSCode 系编辑器的 SecretStorage 里解密出 CodeBuddy 登录态（macOS）。
 * 逆向自 tencent-cloud.coding-copilot 插件：
 *   - token 存于 state.vscdb 的 ItemTable 表，key 为 SECRET_KEY
 *   - 值用 Electron safeStorage 加密：PBKDF2-SHA1(钥匙串密码, "saltysalt", 1003, 16)
 *     派生 AES-128-CBC 密钥，密文前缀 v10，IV 为 16 个空格
 *   - 钥匙串服务名如 "Code Safe Storage"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const sessionMod = require('./session');

// 抑制 node:sqlite 实验性警告
{
  const orig = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    if (typeof warning === 'string' && warning.includes('SQLite')) return;
    return orig.apply(process, [warning, ...args]);
  };
}

const SECRET_KEY = 'secret://{"extensionId":"tencent-cloud.coding-copilot","key":"Tencent-Cloud.coding-copilot.new.accessToken"}';

const VSCODE_CANDIDATES = [
  { dir: 'Code', keychain: 'Code Safe Storage' },
  { dir: 'Code - Insiders', keychain: 'Code - Insiders Safe Storage' },
  { dir: 'Cursor', keychain: 'Cursor Safe Storage' },
  { dir: 'VSCodium', keychain: 'VSCodium Safe Storage' },
  { dir: 'Windsurf', keychain: 'Windsurf Safe Storage' },
  { dir: 'Trae CN', keychain: 'Trae CN Safe Storage' },
  { dir: 'Trae', keychain: 'Trae Safe Storage' },
];

function getKeychainPassword(service) {
  try {
    return execSync(`security find-generic-password -s '${service.replace(/'/g, "'\\''")}' -w`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function decryptSafeStorage(cipherBuf, keychainPassword) {
  const aesKey = crypto.pbkdf2Sync(keychainPassword, 'saltysalt', 1003, 16, 'sha1');
  const prefix = cipherBuf.slice(0, 3).toString('ascii');
  const strategies = [];
  if (prefix === 'v10' || prefix === 'v11') {
    strategies.push({ name: 'v10+randomIV', iv: cipherBuf.slice(3, 19), data: cipherBuf.slice(19) });
    strategies.push({ name: 'v10+fixedIV(spaces)', iv: Buffer.alloc(16, 0x20), data: cipherBuf.slice(3) });
    strategies.push({ name: 'v10+fixedIV(nul)', iv: Buffer.alloc(16, 0x00), data: cipherBuf.slice(3) });
    strategies.push({ name: 'v10+fixedIV(0123)', iv: Buffer.from('0123456789012345'), data: cipherBuf.slice(3) });
  }
  for (const s of strategies) {
    try {
      const d = crypto.createDecipheriv('aes-128-cbc', aesKey, s.iv);
      d.setAutoPadding(true);
      const clear = Buffer.concat([d.update(s.data), d.final()]);
      const text = clear.toString('utf8');
      try { JSON.parse(text); return { strategy: s.name, text }; } catch { /* try next */ }
    } catch { /* try next */ }
  }
  return null;
}

function readSecretFromDb(dbPath, keychainService) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return null; }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(SECRET_KEY);
    if (!row) return null;
    const cipher = Buffer.from(JSON.parse(row.value).data);
    db.close();
    const pwd = getKeychainPassword(keychainService);
    if (!pwd) return null;
    const r = decryptSafeStorage(cipher, pwd);
    if (!r) return null;
    const parsed = JSON.parse(r.text);
    const norm = sessionMod.normalizeSession(parsed);
    return norm ? { session: norm, strategy: r.strategy } : null;
  } catch (e) {
    try { if (db && db.close) db.close(); } catch { /* ignore */ }
    return null;
  }
}

function readVscodeSession() {
  if (process.platform !== 'darwin') return null;
  const dataRoot = path.join(os.homedir(), 'Library', 'Application Support');
  for (const c of VSCODE_CANDIDATES) {
    const dbPath = path.join(dataRoot, c.dir, 'User', 'globalStorage', 'state.vscdb');
    if (!fs.existsSync(dbPath)) continue;
    try {
      const r = readSecretFromDb(dbPath, c.keychain);
      if (r && r.session) return { ...r, source: c.dir };
    } catch { /* try next editor */ }
  }
  return null;
}

module.exports = { readVscodeSession };
