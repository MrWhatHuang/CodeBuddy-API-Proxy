'use strict';

/**
 * 每日积分快照调度器。
 *
 * 对账号池里每个有效账号，在每天 0 时（实际按本地日期首次 tick）把当前积分
 * 快照记录到 credit_snapshots 表（usageUsed / usageLeft / usageTotal）。
 *
 * 用途：前端据此计算「今日消耗」= 当前 usageUsed - 今日 0 时快照 usageUsed。
 *
 * 快照日期用 config 表里的私有键 creditSnapshotDate 持久化，服务重启后不会在同一天重复快照；
 * 若服务在 0 点后某一刻才启动/恢复，也会在首次 tick 立即补上当日快照。
 */

const logger = require('./logger');
const store = require('./store');
const sessionMod = require('./session');
const credits = require('./credits');

/** 调度心跳间隔（毫秒）：每分钟检查一次是否跨天 */
const TICK_MS = 60 * 1000;

let timer = null;
let running = false;

/** 本地时区日期 key：YYYY-MM-DD */
function todayKey(now) {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/** 对单个账号执行一次积分快照 */
async function snapshotAccount(acct, dateKey) {
  if (!acct.auth || !acct.auth.accessToken) return;
  try {
    const r = await credits.getCredits(acct.id);
    if (r && r.ok) {
      store.setCreditSnapshot(acct.id, dateKey, {
        usageUsed: r.usageUsed,
        usageLeft: r.usageLeft,
        usageTotal: r.usageTotal,
      });
      logger.log('debug', 'auth', '积分快照已记录: ' + (acct.name || acct.account.nickname || acct.account.uid) + ' @ ' + dateKey);
    } else {
      logger.log('warn', 'auth', '积分快照获取失败（跳过）: ' + (r && r.error ? r.error : '未知错误'));
    }
  } catch (e) {
    logger.log('warn', 'auth', '积分快照异常（跳过）: ' + e.message);
  }
}

/** 一次调度心跳：若本地日期已变化且尚未快照，则对所有账号快照 */
async function tick() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const dateKey = todayKey(now);
    const cfg = store.getConfig();
    if (cfg.creditSnapshotDate === dateKey) return; // 当天已快照过
    const accounts = sessionMod.listAccounts();
    if (!accounts.length) {
      // 无账号也记录日期，避免每次 tick 都尝试空跑
      store.setConfig({ creditSnapshotDate: dateKey });
      return;
    }
    logger.log('info', 'auth', '开始每日积分快照 @ ' + dateKey);
    for (const acct of accounts) {
      await snapshotAccount(acct, dateKey);
    }
    store.setConfig({ creditSnapshotDate: dateKey });
    logger.log('info', 'auth', '每日积分快照完成 @ ' + dateKey);
  } catch (e) {
    logger.log('error', 'system', '积分快照调度出错: ' + (e.stack || e.message));
  } finally {
    running = false;
  }
}

/** 启动调度器（幂等）。启动后延迟一小段先跑一次。 */
function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  const first = setTimeout(tick, 10 * 1000);
  first.unref();
}

/** 停止调度器 */
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick, todayKey };
