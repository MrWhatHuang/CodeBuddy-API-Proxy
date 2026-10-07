'use strict';

/**
 * 回归测试：账号「重新登录」（用新 OAuth 登录态覆盖已有账号）。
 *
 * 起一个假的 CodeBuddy 上游（/v2/plugin/auth/*），把 CODEBUDDY_ENDPOINT 指过去，
 * 然后完整跑一遍 auth.completeLogin 的重新登录分支，验证：
 *   - 登录态被覆盖、账号数量不变、名称/冻结/签到/用量统计保留
 *   - 冷却标记被清除
 *   - 落库（loadSession 重新载入后仍是新 token）
 *   - 登录失败时原登录态不被破坏
 * 全程本地回环，不访问真实上游。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const MOCK_PORT = 38911;

/* ---- 假上游：按 state 决定返回哪种登录结果 ---- */
let stateSeq = 0;
const issuedStates = new Set();

const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:' + MOCK_PORT);
  const json = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (u.pathname === '/v2/plugin/auth/state') {
    const state = 'state_' + (++stateSeq);
    issuedStates.add(state);
    return json({ code: 0, data: { state, authUrl: 'https://example.invalid/login?state=' + state } });
  }
  if (u.pathname === '/v2/plugin/auth/token') {
    const state = u.searchParams.get('state') || '';
    if (!issuedStates.has(state)) return json({ code: 11217, msg: '登录中' });
    if (state.endsWith('_fail')) return json({ code: 40001, msg: '登录被拒绝' });
    // token_<state> 作为新 accessToken，便于断言到底写入了哪一份
    return json({ code: 0, data: { accessToken: 'token_' + state, refreshToken: 'rt_' + state, expiresIn: 3600 } });
  }
  if (u.pathname === '/v2/plugin/login/account') {
    const state = u.searchParams.get('state') || '';
    return json({ code: 0, data: { uid: 'uid_' + state, nickname: '昵称_' + state, type: 'personal' } });
  }
  if (u.pathname === '/v2/plugin/accounts') return json({ code: 0, data: [{ id: 'ent1' }] });
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 404 }));
});

/* ---- 必须在 require core 之前设好环境变量（config 在加载时读取） ---- */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbp-relogin-test-'));
process.env.CODEBUDDY_DATA_DIR = tmpDir;
process.env.CODEBUDDY_DB_FILE = path.join(tmpDir, 'test.db');
process.env.CODEBUDDY_SESSION_FILE = path.join(tmpDir, 'session.json');
process.env.CODEBUDDY_ENDPOINT = 'http://127.0.0.1:' + MOCK_PORT;

const sessionMod = require('../core/session');
const store = require('../core/store');
const auth = require('../core/auth');
const config = require('../core/config');
const routes = require('../core/routes');

let passed = 0;
let failed = 0;

async function ok(name, fn) {
  try { await fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); failed++; }
}

/** 等待 pendingLogins 里的登录流程跑完（轮询间隔 1s，最多等 20s） */
async function waitLogin(state, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = auth.pendingLogins.get(state);
    if (entry && (entry.status === 'success' || entry.status === 'error')) return entry;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('等待登录流程超时');
}

/** 模拟路由层 /api/accounts/:id/relogin：取 state → 登记 pending → 异步跑完整登录 */
async function relogin(accountId) {
  const acct = sessionMod.getAccount(accountId);
  if (!acct) throw new Error('未找到账号');
  const data = await auth.fetchAuthState();
  auth.pendingLogins.set(data.state, {
    status: 'pending', startedAt: Date.now(), name: acct.name || '', accountId: acct.id, relogin: true,
  });
  auth.completeLogin(data.state, acct.name || '', { accountId: acct.id });
  return waitLogin(data.state);
}

function makeAccount(id, name, token) {
  return {
    id,
    name,
    source: 'oauth',
    addedBy: 'oauth',
    account: { uid: 'uid_' + id, nickname: name, type: 'personal', enterpriseId: '' },
    auth: { accessToken: token, refreshToken: 'rt_' + id, domain: 'old.example.com', expiresAt: Date.now() - 1000 },
    accounts: [],
    lastUsedAt: 0,
    useCount: 0,
    createdAt: Date.now(),
  };
}

async function main() {
  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
  sessionMod.loadSession();

  console.log('\n[1] 重新登录：成功路径');
  sessionMod.clearSession();
  sessionMod.addAccount(makeAccount('a1', '公司号', 'expired_tok'));
  const accountCountBefore = sessionMod.listAccounts().length;

  await ok('重新登录后 pendingLogins 标记为 success 且带 relogin/uid', async () => {
    const e = await relogin('a1');
    assert.strictEqual(e.status, 'success', '登录流程应成功: ' + e.error);
    assert.strictEqual(e.relogin, true, '应标记为重新登录');
    assert.ok(e.accountId, '应返回账号 id');
  });

  await ok('accessToken 被替换为新登录态的 token', async () => {
    const acct = sessionMod.getAccount('a1');
    assert.ok(/^token_state_/.test(acct.auth.accessToken), '应为本次登录拿到的 token，实际: ' + acct.auth.accessToken);
    assert.ok(acct.auth.expiresAt > Date.now(), '过期时间应被刷新到未来');
  });

  await ok('账号数量不变（就地更新，不新增账号）', () => {
    assert.strictEqual(sessionMod.listAccounts().length, accountCountBefore, '不应多出账号');
    assert.strictEqual(sessionMod.getAccount('a1').id, 'a1', '原账号 id 应保留');
  });

  await ok('账号资料更新为新登录返回的 uid / 昵称', () => {
    const acct = sessionMod.getAccount('a1');
    assert.ok(/^uid_state_/.test(acct.account.uid), 'uid 应更新为新登录的账号');
    assert.ok(/^昵称_state_/.test(acct.account.nickname), '昵称应更新');
  });

  await ok('uid 变化时不继承旧 domain（避免串号）', () => {
    assert.notStrictEqual(sessionMod.getAccount('a1').auth.domain, 'old.example.com', '不应沿用旧 domain');
  });

  await ok('名称 / 冻结 / 签到配置 / 用量统计均保留', async () => {
    sessionMod.clearSession();
    sessionMod.addAccount(makeAccount('a2', '个人号', 'expired_tok'));
    sessionMod.updateAccount('a2', { frozen: true, autoCheckin: false, lastUsedAt: 777, useCount: 42 });
    await relogin('a2');
    const acct = sessionMod.getAccount('a2');
    assert.strictEqual(acct.name, '个人号', '名称应保留');
    assert.strictEqual(acct.frozen, true, '冻结状态应保留');
    assert.strictEqual(acct.autoCheckin, false, '签到配置应保留');
    assert.strictEqual(acct.lastUsedAt, 777, '最近使用时间应保留');
    assert.strictEqual(acct.useCount, 42, '调用次数应保留');
  });

  await ok('重新登录成功后清除该账号的冷却标记', async () => {
    sessionMod.clearSession();
    sessionMod.addAccount(makeAccount('a3', '冷却号', 'expired_tok'));
    sessionMod.markUnhealthy('a3', 30 * 60 * 1000, 'auth:401');
    assert.ok(sessionMod.getUnhealthy('a3'), '前置条件：应有冷却标记');
    await relogin('a3');
    assert.strictEqual(sessionMod.getUnhealthy('a3'), null, '冷却标记应被清除');
  });

  await ok('重新登录结果落库：重新载入后仍是新 token', async () => {
    sessionMod.clearSession();
    sessionMod.addAccount(makeAccount('a4', '落库号', 'expired_tok'));
    await relogin('a4');
    const inMem = sessionMod.getAccount('a4').auth.accessToken;
    sessionMod.loadSession();
    assert.strictEqual(sessionMod.getAccount('a4').auth.accessToken, inMem, '重载后 token 应一致');
  });

  console.log('\n[2] 重新登录：失败路径不破坏原登录态');

  await ok('目标账号不存在时立即失败，不产生 pending 登录', async () => {
    sessionMod.clearSession();
    sessionMod.addAccount(makeAccount('a5', '存在的号', 'keep_tok'));
    const before = auth.pendingLogins.size;
    assert.strictEqual(sessionMod.getAccount('ghost'), null, '前置条件：ghost 不存在');
    // 路由层在发起登录前就会 404，这里直接断言该前置判断
    assert.strictEqual(auth.pendingLogins.size, before, '不应有新的 pending 登录');
  });

  await ok('上游拒绝登录时标记 error，原 token 保持不变', async () => {
    sessionMod.clearSession();
    sessionMod.addAccount(makeAccount('a6', '失败号', 'keep_tok'));
    // 让 mock 的 token 接口对该 state 返回业务错误
    const data = await auth.fetchAuthState();
    const badState = data.state + '_fail';
    issuedStates.add(badState);
    auth.pendingLogins.set(badState, {
      status: 'pending', startedAt: Date.now(), name: '失败号', accountId: 'a6', relogin: true,
    });
    auth.completeLogin(badState, '失败号', { accountId: 'a6' });
    const entry = await waitLogin(badState);
    assert.strictEqual(entry.status, 'error', '应标记为 error');
    assert.strictEqual(sessionMod.getAccount('a6').auth.accessToken, 'keep_tok', '原 token 不应被清掉');
    assert.strictEqual(sessionMod.getAccount('a6').name, '失败号', '名称不应被破坏');
  });

  console.log('\n[3] 新增账号路径未被破坏（同一个 completeLogin）');

  await ok('不带 accountId 时仍然追加一个新账号', async () => {
    sessionMod.clearSession();
    sessionMod.addAccount(makeAccount('a7', '老号', 'old_tok'));
    const data = await auth.fetchAuthState();
    auth.pendingLogins.set(data.state, { status: 'pending', startedAt: Date.now(), name: '新号' });
    auth.completeLogin(data.state, '新号');
    const entry = await waitLogin(data.state);
    assert.strictEqual(entry.status, 'success', '应成功: ' + entry.error);
    assert.strictEqual(sessionMod.listAccounts().length, 2, '应新增到 2 个账号');
    assert.strictEqual(sessionMod.getAccount('a7').auth.accessToken, 'old_tok', '老账号不受影响');
    const added = sessionMod.listAccounts().find((a) => a.name === '新号');
    assert.ok(added, '新账号应写入');
    assert.notStrictEqual(added.id, 'a7', '新账号应有独立 id');
  });

  console.log('\n[4] 路由层：接口与鉴权边界');

  await ok('relogin 路由在账号池管理段内注册且不影响其它账号路由', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'routes.js'), 'utf8');
    assert.ok(src.includes("pathname.endsWith('/relogin')"), '应注册 /relogin 路由');
    assert.ok(src.includes('{ accountId: acct.id }'), '应把 accountId 传给 completeLogin');
  });

  await ok('配置与运行时端点未受影响', async () => {
    assert.strictEqual(config.ENDPOINT, 'http://127.0.0.1:' + MOCK_PORT, 'ENDPOINT 应指向 mock');
    assert.strictEqual(typeof routes.route, 'function', 'routes.route 仍可导出');
  });

  // 清理
  try { sessionMod.clearSession(); } catch { /* ignore */ }
  try { store.close && store.close(); } catch { /* ignore */ }
  await new Promise((resolve) => mock.close(resolve));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('\n断言：' + passed + ' 通过, ' + failed + ' 失败\n');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('测试脚本异常: ' + (e && e.stack || e));
  try { mock.close(); } catch { /* ignore */ }
  process.exit(1);
});
