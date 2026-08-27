'use strict';

/**
 * 自动每日签到调度器。
 *
 * 对「自动签到」开启的账号，每天在一个随机时间点执行一次签到（默认在 08:00–23:00
 * 之间随机取整分钟），并把「下次签到时间」与「上次签到日期」持久化到 SQLite
 * （checkin_state 表），服务重启后仍能接续，不会重复签到。
 *
 * 随机时间是为了让签到行为看起来像真人操作，避免被上游按固定时间点审计识别。
 */

const crypto = require('crypto');
const logger = require('./logger');
const sessionMod = require('./session');
const store = require('./store');
const checkin = require('./checkin');

/** 调度心跳间隔（毫秒） */
const TICK_MS = 30 * 1000;
/** 每天随机签到时间窗口（本地时间，小时） */
const WINDOW_START_HOUR = 5;
const WINDOW_END_HOUR = 9;
/** 签到失败后的重试间隔（毫秒），避免紧追重试被审计 */
const RETRY_MS = 5 * 60 * 1000;

let timer = null;
let running = false;

/** 本地时区今天日期 key：YYYY-MM-DD */
function todayKey(now) {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/** 随机生成「今天」的一个签到目标时间戳（毫秒），在时间窗口内按分钟取整 */
function randomTargetToday(now) {
  const start = new Date(now);
  start.setHours(WINDOW_START_HOUR, 0, 0, 0);
  const end = new Date(now);
  end.setHours(WINDOW_END_HOUR, 0, 0, 0);
  const rangeMs = end.getTime() - start.getTime();
  // 窗口内随机分钟，再加 0–59 秒抖动，避免总是整点
  const randMin = crypto.randomInt(0, Math.max(1, Math.floor(rangeMs / 60000)));
  const randSec = crypto.randomInt(0, 60);
  return start.getTime() + randMin * 60000 + randSec * 1000;
}

/** 单个账号尝试签到（按调度） */
async function processAccount(acct, now, day) {
  let st = store.getCheckinState(acct.id);

  // 今天已完成，跳过
  if (st && st.lastDate === day) return;

  // 尚未确定今天的目标时间 → 随机生成一个并持久化
  if (!st || !st.nextAt) {
    const nextAt = randomTargetToday(now);
    st = store.setCheckinState(acct.id, { lastDate: st ? st.lastDate : '', nextAt });
  }

  // 还没到时间，等待
  if (now < st.nextAt) return;

  // 到点执行签到
  try {
    const r = await checkin.dailyCheckin(acct.id);
    if (r && r.ok) {
      store.setCheckinState(acct.id, { lastDate: day, nextAt: 0 });
      logger.log('info', 'auth', '自动签到成功: ' + (acct.name || acct.account.nickname || acct.account.uid));
    } else {
      // 失败则稍后重试（重新随机一个较近的时间，避免立即重试被审计）
      store.setCheckinState(acct.id, { lastDate: st.lastDate || '', nextAt: now + RETRY_MS + crypto.randomInt(0, 60 * 1000) });
      logger.log('warn', 'auth', '自动签到失败（稍后重试）: ' + (r && r.error ? r.error : '未知错误'));
    }
  } catch (e) {
    store.setCheckinState(acct.id, { lastDate: st.lastDate || '', nextAt: now + RETRY_MS + crypto.randomInt(0, 60 * 1000) });
    logger.log('warn', 'auth', '自动签到异常（稍后重试）: ' + e.message);
  }
}

/** 一次调度心跳：遍历所有开启自动签到的账号 */
async function tick() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const day = todayKey(now);
    const accounts = sessionMod.listAccounts();
    for (const acct of accounts) {
      if (acct.autoCheckin === false) continue; // 手动关闭自动签到
      if (!acct.auth || !acct.auth.accessToken) continue; // 无有效 token，跳过
      await processAccount(acct, now, day);
    }
  } catch (e) {
    logger.log('error', 'system', '自动签到调度出错: ' + (e.stack || e.message));
  } finally {
    running = false;
  }
}

/** 启动调度器（幂等）。心跳间隔 + 启动后延迟一小段先跑一次。 */
function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  // 启动后稍等几秒执行首轮，避免阻塞启动流程
  const first = setTimeout(tick, 5 * 1000);
  first.unref();
}

/** 停止调度器 */
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick };
