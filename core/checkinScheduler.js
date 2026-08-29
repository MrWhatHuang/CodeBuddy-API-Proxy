'use strict';

/**
 * 自动每日签到调度器。
 *
 * 全局开关开启时，对账号池里所有有效账号，按「国内自然日」（默认 Asia/Shanghai）
 * 在每天的随机时间点执行一次签到（05:00–09:00，带秒级抖动）。
 * 「下次签到时间」与「上次签到日期」持久化到 SQLite（checkin_state 表），
 * 服务重启后仍能接续：窗口内等到点再签，窗口过后立即补签，不会漏签也不会重复签。
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
/** 每天随机签到时间窗口（签到时区，小时） */
const WINDOW_START_HOUR = 5;
const WINDOW_END_HOUR = 9;
/** 签到失败后的重试间隔（毫秒），避免紧追重试被审计 */
const RETRY_MS = 5 * 60 * 1000;
/** 签到日历时区：腾讯侧按国内自然日结算，不跟服务器本地时区走 */
const TIME_ZONE = process.env.CODEBUDDY_TZ || 'Asia/Shanghai';

let timer = null;
let running = false;

function zonedParts(now, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const out = { year: '1970', month: '01', day: '01', hour: '00', minute: '00', second: '00' };
  for (const p of fmt.formatToParts(new Date(now))) {
    if (p.type in out) out[p.type] = p.value;
  }
  if (out.hour === '24') out.hour = '00';
  return out;
}

/** 签到时区今天日期 key：YYYY-MM-DD */
function todayKey(now) {
  const p = zonedParts(now, TIME_ZONE);
  return p.year + '-' + p.month + '-' + p.day;
}

/** 把目标时区的墙钟时间转成 UTC 毫秒时间戳 */
function zonedWallToUtc(year, month, day, hour, minute, second) {
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = desired;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(utc, TIME_ZONE);
    const got = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    utc += desired - got;
  }
  return utc;
}

function windowBounds(now) {
  const p = zonedParts(now, TIME_ZONE);
  const y = +p.year;
  const m = +p.month;
  const d = +p.day;
  return {
    start: zonedWallToUtc(y, m, d, WINDOW_START_HOUR, 0, 0),
    end: zonedWallToUtc(y, m, d, WINDOW_END_HOUR, 0, 0),
  };
}

function randomBetween(fromMs, toMs) {
  const rangeMs = Math.max(0, toMs - fromMs);
  const randMin = crypto.randomInt(0, Math.max(1, Math.floor(rangeMs / 60000)));
  const randSec = crypto.randomInt(0, 60);
  return fromMs + randMin * 60000 + randSec * 1000;
}

function formatZoned(ts) {
  const p = zonedParts(ts, TIME_ZONE);
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
}

function accountLabel(acct) {
  return acct.name || (acct.account && (acct.account.nickname || acct.account.uid)) || acct.id;
}

/**
 * 决定今天的目标签到时间。
 * - 今日窗口内已有合法目标：沿用
 * - 窗口已过：立即补签
 * - 旧版宽窗口留下的「今天很晚」目标：作废重抽（近期失败重试除外）
 */
function pickTarget(now, existingNextAt) {
  const { start, end } = windowBounds(now);
  const maxRetryAt = now + RETRY_MS + 60 * 1000;
  let nextAt = Number(existingNextAt) || 0;

  if (nextAt && nextAt < start) nextAt = 0;
  if (nextAt && nextAt > end && nextAt > maxRetryAt) nextAt = 0;
  if (nextAt) return nextAt;

  if (now >= end) return now;
  return randomBetween(Math.max(now, start), end);
}

async function confirmCheckedIn(accountId, dailyResult) {
  if (dailyResult && dailyResult.alreadyCheckedIn) return true;
  if (!dailyResult || !dailyResult.ok) return false;
  try {
    const s = await checkin.checkinStatus(accountId);
    if (s && s.ok) return checkin.todayCheckedIn(s.data);
  } catch (e) {
    // 查询失败时信任签到接口的成功返回，避免因状态字段差异而空转重试
  }
  return true;
}

/** 单个账号尝试签到（按调度） */
async function processAccount(acct, now, day) {
  let st = store.getCheckinState(acct.id);

  if (st && st.lastDate === day) return;

  const nextAt = pickTarget(now, st && st.nextAt);
  if (!st || st.nextAt !== nextAt) {
    st = store.setCheckinState(acct.id, { lastDate: st ? st.lastDate : '', nextAt });
    if (nextAt > now) {
      logger.log('info', 'auth', '已安排自动签到: ' + accountLabel(acct) + ' @ ' + formatZoned(nextAt) + ' (' + TIME_ZONE + ')');
    }
  }

  if (now < nextAt) return;

  try {
    const r = await checkin.dailyCheckin(acct.id);
    if (r && r.ok && await confirmCheckedIn(acct.id, r)) {
      store.setCheckinState(acct.id, { lastDate: day, nextAt: 0 });
      logger.log('info', 'auth', '自动签到成功: ' + accountLabel(acct));
    } else {
      store.setCheckinState(acct.id, { lastDate: st.lastDate || '', nextAt: now + RETRY_MS + crypto.randomInt(0, 60 * 1000) });
      logger.log('warn', 'auth', '自动签到失败（稍后重试）: ' + (r && r.error ? r.error : '未知错误'));
    }
  } catch (e) {
    store.setCheckinState(acct.id, { lastDate: st.lastDate || '', nextAt: now + RETRY_MS + crypto.randomInt(0, 60 * 1000) });
    logger.log('warn', 'auth', '自动签到异常（稍后重试）: ' + e.message);
  }
}

/** 一次调度心跳：全局开关开启时遍历所有账号 */
async function tick() {
  if (running) return;
  running = true;
  try {
    if (!store.autoCheckinEnabled()) return;
    const now = Date.now();
    const day = todayKey(now);
    const accounts = sessionMod.listAccounts();
    for (const acct of accounts) {
      if (!acct.auth || !acct.auth.accessToken) continue;
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
  logger.log('info', 'auth', '自动签到调度已启动（窗口 ' + String(WINDOW_START_HOUR).padStart(2, '0') + ':00–' + String(WINDOW_END_HOUR).padStart(2, '0') + ':00 ' + TIME_ZONE + '）');
  const first = setTimeout(tick, 5 * 1000);
  first.unref();
}

/** 停止调度器 */
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick, todayKey, pickTarget, TIME_ZONE };
