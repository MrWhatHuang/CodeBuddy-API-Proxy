'use strict';

/** 服务端装配入口：创建 HTTP 服务、读取登录态、打印启动信息、可选自动打开管理页 */

const http = require('http');
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
    // 1) 优先读 VSCode 插件登录态；2) 其次本地缓存；3) 都没有则提示登录
    const vs = vscode.readVscodeSession();
    if (vs && vs.session) {
      sessionMod.setSession(vs.session, 'vscode');
      sessionMod.saveSession();
    } else if (!sessionMod.loadSession()) {
      logger.log('info', 'auth', '未找到 VSCode 登录态，也未找到本地缓存，等待用户登录');
    }

    const session = sessionMod.getSession();
    const cfg = store.getConfig();

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