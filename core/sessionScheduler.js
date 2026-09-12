'use strict';

/**
 * 账号池调度器：定时切换 + 额度缓存刷新 + 会话绑定清理。
 *
 * 三件事，都围绕「让一天的额度消耗更均匀，但不打断正在进行的任务」：
 *
 * 1. **定时切换**：每到 switchIntervalMin（叠加 ±switchJitterMin 随机抖动）就把选号指针
 *    推进一个位置。它**只影响之后新建的会话**——已经绑定到某账号的会话继续用原账号，
 *    直到任务结束（请求 finish_reason 不再是 tool_calls）或绑定超过 TTL 空闲。
 *    这样既均匀了消耗，又不会让一个跑了一半的任务换号、丢掉上游 prompt cache。
 *
 * 2. **额度缓存刷新**：每 quotaRefreshMin 分钟对每个账号查一次积分余额，写进内存缓存。
 *    选号策略（quota-weighted / least-used）只读缓存，绝不在请求热路径里发网络请求。
 *
 * 3. **清理**：删除空闲超过 TTL 的会话绑定；清理过期的账号不健康标记与额度缓存。
 *
 * 与 checkinScheduler / creditScheduler 一样：setInterval + unref()，导出 tick() 便于测试。
 */

const logger = require('./logger');
const store = require('./store');
const sessionMod = require('./session');
const credits = require('./credits');

/** 调度心跳间隔（毫秒）：每分钟检查一次 */
const TICK_MS = 60 * 1000;

let timer = null;
let running = false;

/**
 * 依据上次切换时间判断「现在是否该切换账号」。
 * 到期条件：now >= switchLastAt + (switchIntervalMin ± 抖动) 分钟。
 * 抖动值在每次切换后重新抽取，保证间隔不会固定不变（避免整点特征）。
 */
function shouldSwitch(pool, now) {
  if (!pool.switchEnabled) return false;
  const intervalMs = Math.max(1, pool.switchIntervalMin || 60) * 60 * 1000;
  const jitterMs = Math.max(0, pool.switchJitterMin || 0) * 60 * 1000;
  // 抖动值由 (上次切换时间 + 账号数) 派生，无需额外持久化字段，且每次切换后自然变化
  const jitter = jitterMs > 0 ? (Math.abs(Math.sin((pool.switchLastAt || 0) / 60000)) * 2 - 1) * jitterMs : 0;
  const due = (pool.switchLastAt || 0) + intervalMs + jitter;
  return now >= due;
}

/**
 * 执行一次「切换」：把选号指针推进到下一个健康账号。
 * 注意这里**不动任何会话绑定**——已有会话继续用原账号。
 * @returns {string} 切换到的账号名（无账号时为空串）
 */
function doSwitch() {
  const accounts = sessionMod.listAccounts().filter(function (a) { return a.auth && a.auth.accessToken; });
  if (accounts.length < 2) return '';
  const pool = sessionMod.getPoolConfig();
  const nextCursor = ((pool.cursor || 0) + 1) % accounts.length;
  sessionMod.setPoolInternal({ cursor: nextCursor, switchLastAt: Date.now() });
  const target = accounts[nextCursor];
  return target ? (target.name || (target.account && target.account.uid) || target.id) : '';
}

/** 刷新所有账号的额度缓存（失败静默跳过，不影响其他账号） */
async function refreshQuotaCache() {
  const accounts = sessionMod.listAccounts();
  if (!accounts.length) return 0;
  let ok = 0;
  for (const acct of accounts) {
    if (!acct.auth || !acct.auth.accessToken) continue;
    try {
      const r = await credits.getCredits(acct.id);
      if (r && r.ok) {
        sessionMod.setQuotaCache(acct.id, {
          usageLeft: r.usageLeft,
          usageTotal: r.usageTotal,
          todayUsed: r.todayUsed,
        });
        ok++;
      }
    } catch (e) {
      logger.log('debug', 'auth', '额度缓存刷新失败（跳过）: ' + (acct.name || acct.id) + ' - ' + e.message);
    }
  }
  return ok;
}

/** 一次性调度心跳 */
async function tick() {
  if (running) return;
  running = true;
  try {
    const pool = sessionMod.getPoolConfig();
    const now = Date.now();

    // 1) 定时切换：只推进指针，不影响进行中的会话
    if (shouldSwitch(pool, now)) {
      const name = doSwitch();
      if (name) logger.log('info', 'auth', '已按计划切换账号池指针，下一个新会话将使用: ' + name);
    }

    // 2) 额度缓存刷新（按 quotaRefreshMin 节流；用 config 里的私有键记上次刷新时间）
    const refreshMs = Math.max(1, pool.quotaRefreshMin || 10) * 60 * 1000;
    const cfg = store.getConfig();
    const lastAt = Number(cfg.quotaCacheAt) || 0;
    if (now - lastAt >= refreshMs) {
      const n = await refreshQuotaCache();
      store.setConfig({ quotaCacheAt: String(Date.now()) });
      if (n) logger.log('debug', 'auth', `额度缓存已刷新 (${n} 个账号)`);
    }

    // 3) 清理过期的会话绑定
    const pruned = sessionMod.pruneSessionBindings(1);
    if (pruned) logger.log('debug', 'auth', `已清理 ${pruned} 条过期会话绑定`);
  } catch (e) {
    logger.log('error', 'system', '账号池调度出错: ' + (e.stack || e.message));
  } finally {
    running = false;
  }
}

/** 启动调度器（幂等）。启动后延迟一小段先跑一次（只刷新额度，不立即切换）。 */
function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  const first = setTimeout(function () {
    // 启动时刷新一次额度缓存，让策略立刻有数据可用；不触发切换（避免刚启动就换号）
    refreshQuotaCache()
      .then(function (n) {
        if (n) store.setConfig({ quotaCacheAt: String(Date.now()) });
      })
      .catch(function () { /* ignore */ });
  }, 15 * 1000);
  first.unref();
}

/** 停止调度器 */
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick, shouldSwitch, doSwitch, refreshQuotaCache };
