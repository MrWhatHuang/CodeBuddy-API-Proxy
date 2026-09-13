'use strict';

/**
 * 回归测试：账号池策略（会话粘性 / 定时切换 / 健康度 / 失败转移判据 / 策略选号）。
 *
 * 用独立临时数据目录，避免污染真实 ~/.codebuddy-proxy。
 * 只测纯逻辑与 SQLite 读写，不发任何网络请求。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require core 之前设好数据目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbp-pool-test-'));
process.env.CODEBUDDY_DATA_DIR = tmpDir;
process.env.CODEBUDDY_DB_FILE = path.join(tmpDir, 'test.db');
process.env.CODEBUDDY_SESSION_FILE = path.join(tmpDir, 'session.json');

const sessionMod = require('../core/session');
const store = require('../core/store');
const auth = require('../core/auth');
const sessionScheduler = require('../core/sessionScheduler');

let passed = 0;
let failed = 0;

function ok(name, fn) {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); failed++; }
}

function makeAccount(id, name) {
  return {
    id,
    name,
    source: 'oauth',
    addedBy: 'oauth',
    account: { uid: 'uid_' + id, nickname: name, type: 'personal', enterpriseId: '' },
    auth: { accessToken: 'tok_' + id, refreshToken: 'rt_' + id, domain: 'copilot.tencent.com', expiresAt: Date.now() + 3600e3 },
    accounts: [],
    lastUsedAt: 0,
    useCount: 0,
    createdAt: Date.now(),
  };
}

/**
 * 设置池配置：公开字段走 setPoolConfig（带白名单校验），
 * 内部字段（switchLastAt / cursor）走 setPoolInternal。
 */
function setPool(patch) {
  const internal = {};
  const pub = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'switchLastAt' || k === 'cursor') internal[k] = v;
    else pub[k] = v;
  }
  if (Object.keys(pub).length) sessionMod.setPoolConfig(pub);
  if (Object.keys(internal).length) sessionMod.setPoolInternal(internal);
  return sessionMod.getPoolConfig();
}

function resetPool(accounts) {
  sessionMod.clearSession();          // 同时清空账号、健康度、额度缓存与会话绑定
  const list = accounts || [makeAccount('a1', '账号1'), makeAccount('a2', '账号2'), makeAccount('a3', '账号3')];
  for (const a of list) sessionMod.addAccount(a);
  // switchLastAt 必须显式归零，否则会继承上一个用例的过期时间
  setPool({
    mode: 'pool', pinnedId: null, stickyEnabled: true, switchEnabled: false,
    failoverEnabled: true, strategy: 'round-robin',
    switchIntervalMin: 60, switchJitterMin: 0, stickyTtlMin: 30,
  });
  setPool({ switchLastAt: 0 });
  return list;
}

// 准备表格（loadSession 会建表）
sessionMod.loadSession();

console.log('\n[1] 会话指纹：稳定性与区分度');

ok('同一会话（system + 首条 user 相同）指纹稳定', () => {
  const p1 = { messages: [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '任务A' },
    { role: 'assistant', content: '好的' },
  ] };
  // 多轮之后对话增长，但前缀不变 → 指纹必须一致
  const p2 = { messages: [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '任务A' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '在做了' },
  ] };
  const k1 = sessionMod.computeSessionKey({ payload: p1, granularity: 'auto' });
  const k2 = sessionMod.computeSessionKey({ payload: p2, granularity: 'auto' });
  assert.ok(k1, '指纹不应为空');
  assert.strictEqual(k1, k2, '多轮增长后指纹应保持不变');
});

ok('不同任务（首条 user 不同）指纹不同', () => {
  const a = sessionMod.computeSessionKey({ payload: { messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: '任务A' }] }, granularity: 'auto' });
  const b = sessionMod.computeSessionKey({ payload: { messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: '任务B' }] }, granularity: 'auto' });
  assert.notStrictEqual(a, b);
});

ok('X-Session-Id 头是权威信号（同头部不同对话 → 同指纹）', () => {
  const k1 = sessionMod.computeSessionKey({ headerSessionId: 'sess-1', payload: { messages: [{ role: 'user', content: 'A' }] } });
  const k2 = sessionMod.computeSessionKey({ headerSessionId: 'sess-1', payload: { messages: [{ role: 'user', content: 'B' }] } });
  const k3 = sessionMod.computeSessionKey({ headerSessionId: 'sess-2', payload: { messages: [{ role: 'user', content: 'A' }] } });
  assert.strictEqual(k1, k2, '显式 session id 应让同会话稳定');
  assert.notStrictEqual(k1, k3, '不同 session id 应区分开');
});

ok('granularity=apikey 时只按密钥区分', () => {
  const k1 = sessionMod.computeSessionKey({ apiKeyId: 'key1', payload: { messages: [{ role: 'user', content: 'A' }] }, granularity: 'apikey' });
  const k2 = sessionMod.computeSessionKey({ apiKeyId: 'key1', payload: { messages: [{ role: 'user', content: 'B' }] }, granularity: 'apikey' });
  const k3 = sessionMod.computeSessionKey({ apiKeyId: 'key2', payload: { messages: [{ role: 'user', content: 'A' }] }, granularity: 'apikey' });
  assert.strictEqual(k1, k2);
  assert.notStrictEqual(k1, k3);
});

ok('无任何可用信号时返回空字符串（不做粘性）', () => {
  const k = sessionMod.computeSessionKey({ payload: {}, granularity: 'auto' });
  assert.strictEqual(k, '');
});

ok('Responses API 的 instructions + input 也能算出指纹', () => {
  const k = sessionMod.computeSessionKey({
    payload: { instructions: '你是编码助手', input: [{ role: 'user', content: [{ type: 'input_text', text: '修个 bug' }] }] },
    granularity: 'auto',
  });
  assert.ok(k, 'Responses 结构应能算指纹');
});

console.log('\n[2] 会话粘性：同一会话固定同一账号');

ok('同一会话的多次请求落在同一账号上', () => {
  resetPool();
  const payload = { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '跑个长任务' }] };
  const key = sessionMod.computeSessionKey({ payload });
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const a = sessionMod.pickAccount(null, key);
    ids.push(a.id);
  }
  assert.strictEqual(new Set(ids).size, 1, '同一会话应始终用同一账号，实际: ' + ids.join(','));
});

ok('不同会话会被分散到不同账号（轮询）', () => {
  resetPool();
  const picked = [];
  for (let i = 0; i < 3; i++) {
    const key = sessionMod.computeSessionKey({ payload: { messages: [{ role: 'user', content: '任务' + i }] } });
    picked.push(sessionMod.pickAccount(null, key).id);
  }
  assert.strictEqual(new Set(picked).size, 3, '3 个不同会话应分到 3 个不同账号，实际: ' + picked.join(','));
});

ok('粘性关闭时不再固定账号', () => {
  resetPool();
  setPool({ stickyEnabled: false });
  const key = 'fixedkey00000000';
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(sessionMod.pickAccount(null, key).id);
  assert.ok(new Set(ids).size > 1, '关闭粘性后应轮询换号');
});

ok('会话绑定在任务结束时被释放，下个任务可换号', () => {
  resetPool();
  const key = sessionMod.computeSessionKey({ payload: { messages: [{ role: 'user', content: '一次性任务' }] } });
  const first = sessionMod.pickAccount(null, key).id;
  assert.ok(store.getSessionBinding(key), '应有绑定记录');
  sessionMod.releaseSession(key);
  assert.strictEqual(store.getSessionBinding(key), null, '释放后绑定应消失');
  const second = sessionMod.pickAccount(null, key).id;
  assert.notStrictEqual(first, second, '释放后应能分到别的账号');
});

ok('显式指定账号优先级最高，且不写绑定', () => {
  const list = resetPool();
  const key = sessionMod.computeSessionKey({ payload: { messages: [{ role: 'user', content: 'x' }] } });
  const a = sessionMod.pickAccount('a2', key);
  assert.strictEqual(a.id, 'a2');
  assert.strictEqual(store.getSessionBinding(key), null, '显式指定不应产生粘性绑定');
  assert.strictEqual(list.length, 3);
});

ok('pinned 模式完全绕过粘性与策略', () => {
  resetPool();
  setPool({ mode: 'pinned', pinnedId: 'a3' });
  const key = sessionMod.computeSessionKey({ payload: { messages: [{ role: 'user', content: 'y' }] } });
  const a = sessionMod.pickAccount(null, key);
  assert.strictEqual(a.id, 'a3');
  assert.strictEqual(store.getSessionBinding(key), null);
  setPool({ mode: 'pool', pinnedId: null });
});

ok('绑定的账号被删除后，会话自动改绑其他账号', () => {
  resetPool();
  const key = sessionMod.computeSessionKey({ payload: { messages: [{ role: 'user', content: 'z' }] } });
  const first = sessionMod.pickAccount(null, key).id;
  sessionMod.removeAccount(first);
  const after = sessionMod.pickAccount(null, key);
  assert.ok(after, '应能选到其他账号');
  assert.notStrictEqual(after.id, first, '不应再选到已删除账号');
});

console.log('\n[3] 账号健康度与失败转移判据');

ok('额度类错误 → 标记不健康 30 分钟，且不再被选中', () => {
  resetPool();
  const marked = auth.recordUpstreamFailure('a1', 200, '{"code":1,"msg":"insufficient quota 额度不足"}');
  assert.strictEqual(marked, true, '额度错误应触发标记');
  const u = sessionMod.getUnhealthy('a1');
  assert.ok(u && u.reason.indexOf('quota') === 0, '原因应为 quota');
  assert.ok(u.until - Date.now() > 25 * 60 * 1000, '冷却应接近 30 分钟');
  // 该账号应被选号排除
  const picked = new Set();
  for (let i = 0; i < 10; i++) picked.add(sessionMod.pickAccount(null, '').id);
  assert.ok(!picked.has('a1'), '冷却中的账号不应被选中');
});

ok('401 鉴权失败 → 标记不健康 5 分钟', () => {
  resetPool();
  assert.strictEqual(auth.recordUpstreamFailure('a2', 401, 'unauthorized'), true);
  const u = sessionMod.getUnhealthy('a2');
  assert.ok(u && u.reason === 'auth:401');
});

ok('429 限流 → 标记不健康 1 分钟', () => {
  resetPool();
  assert.strictEqual(auth.recordUpstreamFailure('a3', 429, 'too many requests'), true);
  const u = sessionMod.getUnhealthy('a3');
  assert.ok(u && u.reason === 'rate-limit');
});

ok('普通 500 错误不触发标记（不误伤账号）', () => {
  resetPool();
  assert.strictEqual(auth.recordUpstreamFailure('a1', 500, 'internal error'), false);
  assert.strictEqual(sessionMod.getUnhealthy('a1'), null);
});

ok('请求成功后清除不健康标记', () => {
  resetPool();
  auth.recordUpstreamFailure('a1', 401, 'x');
  assert.ok(sessionMod.getUnhealthy('a1'));
  auth.recordUpstreamSuccess('a1');
  assert.strictEqual(sessionMod.getUnhealthy('a1'), null);
});

ok('全部账号都不健康时退化选号（不至于完全不可用）', () => {
  resetPool();
  auth.recordUpstreamFailure('a1', 401, 'x');
  auth.recordUpstreamFailure('a2', 401, 'x');
  auth.recordUpstreamFailure('a3', 401, 'x');
  const a = sessionMod.pickAccount(null, '');
  assert.ok(a, '应仍能返回一个账号作为兜底');
});

console.log('\n[4] 选号策略');

ok('least-used：优先选今日消耗最少的账号', () => {
  resetPool();
  setPool({ strategy: 'least-used' });
  sessionMod.setQuotaCache('a1', { usageLeft: 100, usageTotal: 500, todayUsed: 90 });
  sessionMod.setQuotaCache('a2', { usageLeft: 100, usageTotal: 500, todayUsed: 5 });
  sessionMod.setQuotaCache('a3', { usageLeft: 100, usageTotal: 500, todayUsed: 50 });
  const picked = sessionMod.pickAccount(null, '');
  assert.strictEqual(picked.id, 'a2', '应选今日消耗最少的 a2');
});

ok('quota-weighted：剩余额度为 0 的账号几乎不会被选中', () => {
  resetPool();
  setPool({ strategy: 'quota-weighted' });
  sessionMod.setQuotaCache('a1', { usageLeft: 100000, usageTotal: 100000, todayUsed: 0 });
  sessionMod.setQuotaCache('a2', { usageLeft: 0, usageTotal: 100000, todayUsed: 0 });
  sessionMod.setQuotaCache('a3', { usageLeft: 100000, usageTotal: 100000, todayUsed: 0 });
  let a2Count = 0;
  for (let i = 0; i < 200; i++) {
    if (sessionMod.pickAccount(null, '').id === 'a2') a2Count++;
  }
  assert.ok(a2Count < 20, '额度耗尽的账号被选次数应极少，实际 ' + a2Count + '/200');
});

ok('无额度缓存时，额度类策略自动降级为轮询', () => {
  sessionMod.clearQuotaCache();
  resetPool();
  setPool({ strategy: 'least-used' });
  const ids = new Set();
  for (let i = 0; i < 3; i++) ids.add(sessionMod.pickAccount(null, '').id);
  assert.strictEqual(ids.size, 3, '降级后应按轮询分散到 3 个账号');
});

console.log('\n[5] 定时切换');

ok('switchEnabled 关闭时不应切换', () => {
  resetPool();
  setPool({ switchEnabled: false, switchIntervalMin: 1, switchJitterMin: 0 });
  setPool({ switchLastAt: Date.now() - 3600e3 });
  assert.strictEqual(sessionScheduler.shouldSwitch(sessionMod.getPoolConfig(), Date.now()), false);
});

ok('达到间隔后应触发切换', () => {
  resetPool();
  setPool({ switchEnabled: true, switchIntervalMin: 60, switchJitterMin: 0 });
  setPool({ switchLastAt: Date.now() - 61 * 60 * 1000 });
  assert.strictEqual(sessionScheduler.shouldSwitch(sessionMod.getPoolConfig(), Date.now()), true);
});

ok('未到间隔时不切换', () => {
  resetPool();
  setPool({ switchEnabled: true, switchIntervalMin: 60, switchJitterMin: 0 });
  setPool({ switchLastAt: Date.now() - 10 * 60 * 1000 });
  assert.strictEqual(sessionScheduler.shouldSwitch(sessionMod.getPoolConfig(), Date.now()), false);
});

ok('doSwitch 推进指针，且不打断已有会话绑定', () => {
  resetPool();
  setPool({ switchEnabled: true, switchIntervalMin: 1, switchJitterMin: 0 });
  setPool({ switchLastAt: 0 });
  // 先建立一个会话绑定
  const key = sessionMod.computeSessionKey({ payload: { messages: [{ role: 'user', content: '进行中的任务' }] } });
  const boundAccount = sessionMod.pickAccount(null, key).id;

  const cursorBefore = sessionMod.getPoolConfig().cursor;
  const name = sessionScheduler.doSwitch();
  assert.ok(name, '应返回切换到的账号名');
  // doSwitch 明确设置 cursor = (旧值 + 1) % 账号数
  const expected = (cursorBefore + 1) % 3;
  assert.strictEqual(sessionMod.getPoolConfig().cursor, expected, 'cursor 应被推进一格');

  // 关键断言：原会话仍绑定原账号
  const again = sessionMod.pickAccount(null, key);
  assert.strictEqual(again.id, boundAccount, '切换不应影响正在进行的会话');
  // 且切换时间被记录
  assert.ok(sessionMod.getPoolConfig().switchLastAt > 0, 'switchLastAt 应被写入');
});

ok('定时切换后，新会话使用新账号', () => {
  resetPool();
  setPool({ switchEnabled: true, switchIntervalMin: 1, switchJitterMin: 0, stickyEnabled: true });
  setPool({ switchLastAt: 0 });
  const k1 = sessionMod.computeSessionKey({ payload: { messages: [{ role: 'user', content: '任务甲' }] } });
  const before = sessionMod.pickAccount(null, k1).id;
  sessionScheduler.doSwitch();      // 推进指针
  const k2 = sessionMod.computeSessionKey({ payload: { messages: [{ role: 'user', content: '任务乙' }] } });
  const after = sessionMod.pickAccount(null, k2).id;
  assert.notStrictEqual(before, after, '切换后新会话应使用不同账号');
});

ok('账号少于 2 个时不切换（避免无意义抖动）', () => {
  resetPool([makeAccount('only1', '唯一账号')]);
  setPool({ switchEnabled: true, switchIntervalMin: 1, switchJitterMin: 0 });
  setPool({ switchLastAt: 0 });
  const name = sessionScheduler.doSwitch();
  assert.strictEqual(name, '', '只有一个账号时不应切换');
});

console.log('\n[6] 会话绑定持久化与清理');

ok('绑定写入 SQLite，可被重新读取', () => {
  resetPool();
  store.setSessionBinding('persistkey000001', 'a2');
  const b = store.getSessionBinding('persistkey000001');
  assert.ok(b, '应读到绑定');
  assert.strictEqual(b.accountId, 'a2');
  assert.strictEqual(b.reqCount, 1);
});

ok('touchSessionBinding 递增请求计数并刷新时间', () => {
  resetPool();
  store.setSessionBinding('touchkey000000001', 'a1');
  store.touchSessionBinding('touchkey000000001');
  store.touchSessionBinding('touchkey000000001');
  const b = store.getSessionBinding('touchkey000000001');
  assert.strictEqual(b.reqCount, 3, '请求计数应为 3');
});

ok('pruneSessionBindings 清理空闲超时的绑定', () => {
  resetPool();
  const oldTs = Date.now() - 10 * 60 * 1000;
  store.setSessionBinding('oldkey00000000001', 'a1', oldTs);
  store.setSessionBinding('newkey00000000001', 'a2');
  // 5 分钟前的绑定在 30 分钟 TTL 下不该被清
  store.pruneSessionBindings(30 * 60 * 1000);
  assert.ok(store.getSessionBinding('oldkey00000000001'), 'TTL 未到时老绑定应保留');
  assert.ok(store.getSessionBinding('newkey00000000001'), '新绑定应保留');
  // 用 1 分钟 TTL 再清一次，老绑定应被删除
  store.pruneSessionBindings(60 * 1000);
  assert.strictEqual(store.getSessionBinding('oldkey00000000001'), null, '超时绑定应被清理');
  assert.ok(store.getSessionBinding('newkey00000000001'), '新绑定仍应保留');
});

ok('删除账号时其会话绑定一并清除', () => {
  resetPool();
  store.setSessionBinding('delkey00000000001', 'a3');
  assert.ok(store.getSessionBinding('delkey00000000001'));
  sessionMod.removeAccount('a3');
  assert.strictEqual(store.getSessionBinding('delkey00000000001'), null, '账号删除后绑定应清除');
});

ok('listSessionBindings 返回全部绑定（排查用）', () => {
  resetPool();
  store.setSessionBinding('listkey0000000001', 'a1');
  store.setSessionBinding('listkey0000000002', 'a2');
  const all = store.listSessionBindings();
  assert.ok(all.length >= 2, '应至少列出 2 条绑定');
});

console.log('\n[7] 配置向后兼容与健壮性');

ok('老库缺失的新字段自动补默认值', () => {
  store.setAccountPool({ version: 2, pool: { mode: 'pool', strategy: 'round-robin', pinnedId: null, cursor: 0 } });
  sessionMod.loadSession();
  const p = sessionMod.getPoolConfig();
  assert.strictEqual(p.stickyEnabled, true, 'stickyEnabled 默认应为 true');
  assert.strictEqual(p.switchEnabled, false, 'switchEnabled 默认应为 false');
  assert.strictEqual(p.stickyTtlMin, 30);
  assert.strictEqual(p.failoverEnabled, true);
  assert.strictEqual(p.stickyGranularity, 'auto');
});

ok('非法配置值被拒绝（保持原值）', () => {
  resetPool();
  setPool({ strategy: 'round-robin' });
  sessionMod.setPoolConfig({ strategy: '不存在的策略' });
  assert.strictEqual(sessionMod.getPoolConfig().strategy, 'round-robin', '非法策略应被忽略');
  sessionMod.setPoolConfig({ stickyTtlMin: 99999 });
  assert.ok(sessionMod.getPoolConfig().stickyTtlMin <= 1440, '超范围数值应被夹取');
  sessionMod.setPoolConfig({ stickyGranularity: 'bogus' });
  assert.strictEqual(sessionMod.getPoolConfig().stickyGranularity, 'auto', '非法粒度应被忽略');
});

ok('pinnedId 指向不存在的账号时被清空', () => {
  resetPool();
  setPool({ mode: 'pinned', pinnedId: 'ghost_account' });
  assert.strictEqual(sessionMod.getPoolConfig().pinnedId, null, '坏引用应被清空');
});

ok('clearSession 同时清空健康度与额度缓存', () => {
  resetPool();
  auth.recordUpstreamFailure('a1', 401, 'x');
  sessionMod.setQuotaCache('a1', { usageLeft: 1, usageTotal: 2, todayUsed: 3 });
  assert.ok(sessionMod.getUnhealthy('a1'));
  assert.ok(sessionMod.getQuotaCache('a1'));
  sessionMod.clearSession();
  assert.strictEqual(sessionMod.getUnhealthy('a1'), null, '健康度应被清空');
  assert.strictEqual(sessionMod.getQuotaCache('a1'), null, '额度缓存应被清空');
});

console.log('\n[8] 账号冻结（不参与池轮询与失败转移）');

ok('冻结的账号不出现在池轮询候选中', () => {
  resetPool();
  sessionMod.updateAccount('a2', { frozen: true });
  const a2 = sessionMod.getAccount('a2');
  assert.strictEqual(a2.frozen, true, 'frozen 应写入内存态');
  const candidates = sessionMod.healthyAccounts();
  assert.ok(!candidates.some((a) => a.id === 'a2'), '冻结账号不应进入候选');
  assert.strictEqual(candidates.length, 2, '其余两个账号应仍可参与轮询');
});

ok('冻结后连续选号永远不会选中该账号', () => {
  resetPool();
  sessionMod.updateAccount('a2', { frozen: true });
  const seen = new Set();
  for (let i = 0; i < 12; i++) seen.add(sessionMod.pickAccount(null, '').id);
  assert.ok(!seen.has('a2'), '轮询 12 次都不应选中冻结账号');
  assert.deepStrictEqual([...seen].sort(), ['a1', 'a3'], '应只在未冻结账号间轮询');
});

ok('全部账号被冻结时退化为忽略冻结（避免完全不可用）', () => {
  const list = resetPool();
  for (const a of list) sessionMod.updateAccount(a.id, { frozen: true });
  const picked = sessionMod.pickAccount(null, '');
  assert.ok(picked, '全部冻结时仍应返回一个账号而不是 null');
});

ok('冻结持久化到数据库，重新载入后仍生效', () => {
  resetPool();
  sessionMod.updateAccount('a2', { frozen: true });
  sessionMod.loadSession();   // 从 SQLite 重新载入
  assert.strictEqual(sessionMod.getAccount('a2').frozen, true, '重启/重载后冻结状态应保留');
  assert.strictEqual(sessionMod.getAccount('a1').frozen, false, '未冻结账号不受影响');
});

ok('冻结与冷却合并：isAccountBlocked 对两者都返回 true', () => {
  resetPool();
  sessionMod.updateAccount('a2', { frozen: true });
  auth.recordUpstreamFailure('a3', 401, 'unauthorized');   // a3 进入冷却
  assert.strictEqual(sessionMod.isAccountBlocked(sessionMod.getAccount('a2')), true, '冻结账号应被阻塞');
  assert.strictEqual(sessionMod.isAccountBlocked(sessionMod.getAccount('a3')), true, '冷却账号应被阻塞');
  assert.strictEqual(sessionMod.isAccountBlocked(sessionMod.getAccount('a1')), false, '正常账号不应被阻塞');
  const candidates = sessionMod.healthyAccounts();
  assert.deepStrictEqual(candidates.map((a) => a.id), ['a1'], '只剩未冻结未冷却的 a1');
});

ok('冻结的账号不会被会话粘性复用，绑定被丢弃', () => {
  resetPool();
  setPool({ stickyEnabled: true });
  const first = sessionMod.pickAccountForSession('freezekey000001');
  assert.ok(first, '应能选出账号');
  sessionMod.updateAccount(first.id, { frozen: true });
  const next = sessionMod.pickAccountForSession('freezekey000001');
  assert.ok(next, '应重新选出可用账号');
  assert.notStrictEqual(next.id, first.id, '不应复用已冻结的绑定账号');
});

ok('解冻后账号重新参与轮询', () => {
  resetPool();
  sessionMod.updateAccount('a2', { frozen: true });
  sessionMod.updateAccount('a2', { frozen: false });
  const seen = new Set();
  for (let i = 0; i < 9; i++) seen.add(sessionMod.pickAccount(null, '').id);
  assert.ok(seen.has('a2'), '解冻后应能重新被选中');
});

ok('冻结时写入冷却标记，解冻时清除（与失败转移状态合并）', () => {
  resetPool();
  // 模拟路由层逻辑：冻结 → 无限期冷却；解冻 → 清除冷却
  sessionMod.updateAccount('a2', { frozen: true });
  sessionMod.markUnhealthy('a2', 365 * 24 * 60 * 60 * 1000, 'frozen:manual');
  assert.ok(sessionMod.getUnhealthy('a2'), '冻结应带有冷却标记');
  assert.strictEqual(sessionMod.getUnhealthy('a2').reason, 'frozen:manual');
  sessionMod.updateAccount('a2', { frozen: false });
  sessionMod.markHealthy('a2');
  assert.strictEqual(sessionMod.getUnhealthy('a2'), null, '解冻应清除冷却标记');
});

ok('显式指定账号仍可使用被冻结的账号', () => {
  resetPool();
  sessionMod.updateAccount('a2', { frozen: true });
  const found = sessionMod.findAccountByIdOrName('a2');
  assert.ok(found, '显式指定应能找到冻结账号（池选号才排除）');
  assert.strictEqual(found.id, 'a2');
});

// 清理
try { sessionMod.clearSession(); } catch { /* ignore */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('\n断言：' + passed + ' 通过, ' + failed + ' 失败\n');
process.exit(failed ? 1 : 0);
