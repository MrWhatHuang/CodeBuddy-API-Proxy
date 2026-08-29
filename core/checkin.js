'use strict';

/**
 * 每日签到：查询签到状态 + 执行签到。
 *
 * 复用 CodeBuddy 登录态（账号池里的 accessToken / uid / domain），
 * 调用腾讯后端 /v2/billing/meter/* 系列接口。
 *
 * 支持按账号 id 指定签到目标；不指定时用「活跃账号」（pinned 或第一个）。
 *
 * 接口来源（WorkBuddy 桌面端逆向得到，authService 实际实现）：
 *   - POST /v2/billing/meter/checkin-activity-status  查询签到活动状态
 *   - POST /v2/billing/meter/daily-checkin            执行每日签到
 *
 * 注意：不要用 /billing/meter/checkin-status（无 /v2、无 -activity），
 * 那是废弃的旧接口，永远返回 active:false。
 */

const config = require('./config');
const logger = require('./logger');
const util = require('./util');
const auth = require('./auth');
const sessionMod = require('./session');

/**
 * 签到接口的基础路径。
 * 注意：App 实际走的是 /v2/billing/meter/*（带 /v2 前缀），
 * 而不是 /billing/meter/*（那是废弃的旧接口，永远返回 active:false）。
 */
const WORKBUDDY_CLIENT_VERSION = '5.3.14';

function checkinUrl(sub) {
  return config.ENDPOINT + '/v2/billing/meter/' + sub;
}

function truthyFlag(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** 兼容上游 snake_case / camelCase 的「今日已签」字段 */
function todayCheckedIn(data) {
  if (!data || typeof data !== 'object') return false;
  return truthyFlag(data.today_checked_in) || truthyFlag(data.todayCheckedIn)
    || truthyFlag(data.already_checked_in) || truthyFlag(data.alreadyCheckedIn)
    || truthyFlag(data.checked_in) || truthyFlag(data.checkedIn)
    || truthyFlag(data.has_checked_in) || truthyFlag(data.hasCheckedIn)
    || truthyFlag(data.is_checkin) || truthyFlag(data.isCheckin);
}

function normalizeStatusData(data) {
  const src = data && typeof data === 'object' ? data : {};
  return Object.assign({}, src, {
    today_checked_in: todayCheckedIn(src),
    active: src.active !== false,
  });
}

/** 根据 accountId 解析账号并生成带鉴权的请求头 */
async function pickHeaders(accountId) {
  let acct = null;
  if (accountId) {
    acct = sessionMod.getAccount(accountId);
    if (!acct) {
      const e = new Error('未找到账号: ' + accountId);
      e.status = 404;
      throw e;
    }
    acct = await auth.getValidAccount(acct);
  } else {
    acct = await auth.getValidSession();
  }
  const headers = Object.assign({}, auth.buildAuthHeaders(acct), {
    Accept: 'application/json',
    'X-Product': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': WORKBUDDY_CLIENT_VERSION,
    'User-Agent': 'WorkBuddy/' + WORKBUDDY_CLIENT_VERSION,
  });
  return { headers, account: acct };
}

function accountLabel(acct) {
  return acct ? (acct.name || acct.account.uid) : '';
}

/**
 * 查询当日签到状态。
 * @param {string} [accountId] 指定账号 id；缺省用活跃账号
 * @returns {Promise<object>} { ok, code, msg, data, account, accountId }
 */
async function checkinStatus(accountId) {
  const { headers, account } = await pickHeaders(accountId);
  const r = await util.requestJson(checkinUrl('checkin-activity-status'), {
    method: 'POST', headers, body: {}, timeoutMs: 20000,
  });
  const json = r.json || {};
  if (r.status >= 400 || (json.code !== undefined && json.code !== 0)) {
    const msg = json.msg || json.message || ('HTTP ' + r.status);
    logger.log('warn', 'auth', '查询签到状态失败: ' + msg);
    return { ok: false, error: msg, account: accountLabel(account), accountId: account ? account.id : accountId };
  }
  return { ok: true, code: json.code, msg: json.msg, data: normalizeStatusData(json.data || {}), account: accountLabel(account), accountId: account ? account.id : accountId };
}

/**
 * 执行每日签到。
 * @param {string} [accountId] 指定账号 id；缺省用活跃账号
 * @returns {Promise<object>} { ok, code, msg, data, alreadyCheckedIn, account, accountId }
 */
async function dailyCheckin(accountId) {
  const { headers, account } = await pickHeaders(accountId);
  const r = await util.requestJson(checkinUrl('daily-checkin'), {
    method: 'POST', headers, body: {}, timeoutMs: 20000,
  });
  const json = r.json || {};
  const msg = json.msg || json.message || ('HTTP ' + r.status);
  // 「今天已签到」是业务正常态（code 10001），不算失败
  const alreadyCheckedInByCode = json.code === 10001 || /已签到|already checked/i.test(msg || '');
  if (alreadyCheckedInByCode) {
    logger.log('info', 'auth', '每日签到：今日已签到' + (account ? ' - ' + accountLabel(account) : ''));
    return { ok: true, code: json.code, msg, data: json.data || {}, alreadyCheckedIn: true, account: accountLabel(account), accountId: account ? account.id : accountId };
  }
  if (r.status >= 400 || (json.code !== undefined && json.code !== 0)) {
    logger.log('warn', 'auth', '执行签到失败: ' + msg);
    return { ok: false, error: msg, account: accountLabel(account), accountId: account ? account.id : accountId };
  }
  const data = json.data || {};
  const alreadyCheckedIn = todayCheckedIn(data);
  logger.log('info', 'auth', '每日签到成功' + (alreadyCheckedIn ? '（已签到）' : '') + (account ? ' - ' + accountLabel(account) : ''));
  return {
    ok: true, code: json.code, msg: json.msg, data,
    alreadyCheckedIn,
    account: accountLabel(account),
    accountId: account ? account.id : accountId,
  };
}

module.exports = { checkinStatus, dailyCheckin, todayCheckedIn };
