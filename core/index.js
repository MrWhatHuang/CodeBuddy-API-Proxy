'use strict';

/** 服务端装配入口：创建 HTTP 服务、读取登录态、打印启动信息、可选自动打开管理页 */

const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const config = require('./config');
const store = require('./store');
const logger = require('./logger');
const util = require('./util');
const sessionMod = require('./session');
const vscode = require('./vscode');
const routes = require('./routes');

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') execFileSync('open', [url], { stdio: 'ignore' });
    else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    else execFileSync('xdg-open', [url], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function start() {
  const server = http.createServer((req, res) => {
    routes.route(req, res).catch((e) => {
      logger.log('error', 'system', `路由异常: ${e.stack || e.message}`);
      if (!res.headersSent) util.sendJson(res, 500, { error: { message: e.message } });
    });
  });

  server.listen(config.PORT, config.HOST, () => {
    // 1) 先加载本地账号池（含旧 session.json 一次性迁移）；2) 其次优先同步 VSCode 插件登录态
    sessionMod.loadSession();
    const vs = vscode.readVscodeSession();
    if (vs && vs.session) {
      sessionMod.setSession(vs.session, 'vscode');
      sessionMod.saveSession();
    }
    if (!sessionMod.isLoggedIn()) {
      logger.log('info', 'auth', '未找到 VSCode 登录态，也未找到本地缓存，等待用户登录');
    }

    const session = sessionMod.getSession();
    const cfg = store.getConfig();
    store.ensureDefaultApiKey();

    // 管理页鉴权：首次启动时初始化管理员密码（优先环境变量，否则生成一次性初始密码）
    let adminInitialPassword = '';
    if (!store.adminConfigured()) {
      adminInitialPassword = config.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
      store.setAdminPassword(config.ADMIN_USERNAME, adminInitialPassword, { mustChange: !config.ADMIN_PASSWORD });
      logger.log('info', 'auth', '管理页管理员账号已初始化: ' + config.ADMIN_USERNAME);
    }

    console.log('');
    console.log('  CodeBuddy API Proxy 已启动');
    console.log('  ------------------------------------');
    console.log(`  管理页:     http://${config.HOST}:${config.PORT}/home`);
    console.log(`  OpenAI 基址: http://${config.HOST}:${config.PORT}/v1`);
    console.log(`  后端:       ${config.ENDPOINT}`);
    if (sessionMod.isLoggedIn()) {
      const accounts = sessionMod.listAccounts();
      const pool = sessionMod.getPoolConfig();
      const active = sessionMod.getActiveAccount();
      const sourceText = sessionMod.getSessionSource() === 'vscode' ? 'VSCode 插件' : sessionMod.getSessionSource() === 'oauth' ? '网页登录' : '本地缓存';
      console.log(`  账号池:     ${accounts.length} 个账号, 模式: ${pool.mode === 'pinned' ? '指定账号' : '池模式'}`);
      for (const a of accounts) console.log(`    - ${a.name || a.account.nickname || a.account.uid}${pool.pinnedId === a.id ? ' (当前指定)' : ''}`);
      console.log(`  活跃账号:   ${active ? (active.name || active.account.nickname || active.account.uid) : '-'} (来源: ${sourceText})`);
      if (vs && vs.strategy) console.log(`  解密策略:   ${vs.strategy}`);
    } else {
      console.log(`  登录状态:   未登录（请打开管理页登录）`);
    }
    console.log(`  session:    ${config.SESSION_FILE}`);
    console.log(`  数据库:     ${config.DB_FILE}`);
    const keyEnabled = store.clientKeyVerificationEnabled();
    const keyCount = store.listApiKeys().length;
    console.log(`  API 密钥:   ${keyEnabled ? `校验已启用 (${keyCount} 个密钥)` : '校验已关闭（任何请求都可通过，存在风险）'}`);
    console.log(`  管理页鉴权: ${store.adminAuthEnabled() ? '已开启' : '未开启'}`);
    console.log(`  信任代理:   ${config.TRUST_PROXY ? '是（信任 X-Forwarded-For）' : '否（使用直连 IP）'}`);
    if (store.adminAuthEnabled()) {
      console.log(`  管理员账号: ${config.ADMIN_USERNAME}`);
      console.log(`  登录地址:   http://${config.HOST}:${config.PORT}/admin-login`);
    }
    if (adminInitialPassword) {
      console.log('  ------------------------------------');
      console.log(`  [重要] 管理页初始密码: ${adminInitialPassword}`);
      console.log('  首次登录后请立即修改密码（若通过环境变量注入则可忽略）。');
    }
    console.log('');

    logger.log('info', 'system', `服务已启动 (v${config.VERSION})`, { host: config.HOST, port: config.PORT, endpoint: config.ENDPOINT });

    const wantOpen = !process.env.CODEBUDDY_NO_OPEN && cfg.autoOpen === 'true';
    if (wantOpen) {
      const url = `http://${config.HOST}:${config.PORT}/home`;
      if (openBrowser(url)) console.log(`  已自动打开管理页: ${url}\n`);
      else console.log(`  请手动打开: ${url}\n`);
    }
  });

  return server;
}

module.exports = { start };