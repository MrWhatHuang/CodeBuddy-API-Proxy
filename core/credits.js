'use strict';

/**
 * 积分余额：查询账号的剩余积分 / 总积分。
 *
 * 接口（WorkBuddy 桌面端 authService.getPersonalUsage 逆向得到）：
 *   - POST /v2/billing/meter/get-user-resource
 *
 * 关键点：该接口要求携带客户端身份标识头，缺了会返回 10085「请求不合法」：
 *   - X-Product: WorkBuddy
 *   - X-IDE-Type: WorkBuddy
 *   - User-Agent: WorkBuddy/<version>
 *
 * 返回 data.Response.Data.Accounts 是资源包数组，每个含
 *   CycleCapacityRemainPrecise（剩余）/ CycleCapacitySizePrecise（总量），
 * 求和即 usageLeft / usageTotal（对齐 App 的 getPersonalUsage 输出）。
 */

const config = require('./config');
const logger = require('./logger');
const util = require('./util');
const auth = require('./auth');
const sessionMod = require('./session');

const WORKBUDDY_CLIENT_VERSION = '5.3.14';

/** 根据 accountId 解析账号并生成带鉴权 + 客户端标识的请求头 */
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

/**
 * 查询账号积分余额。
 * @param {string} [accountId] 指定账号 id；缺省用活跃账号
 * @returns {Promise<object>} { ok, usageLeft, usageTotal, usageUsed, resources, account, accountId }
 */
async function getCredits(accountId) {
  const { headers, account } = await pickHeaders(accountId);
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    OnlyValidPeriod: true,
  };
  const r = await util.requestJson(config.ENDPOINT + '/v2/billing/meter/get-user-resource', {
    method: 'POST', headers, body, timeoutMs: 20000,
  });
  const json = r.json || {};
  if (r.status >= 400 || (json.code !== undefined && json.code !== 0)) {
    const msg = json.msg || json.message || ('HTTP ' + r.status);
    logger.log('warn', 'auth', '查询积分余额失败: ' + msg);
    return { ok: false, error: msg, account: account ? (account.name || account.account.uid) : '', accountId: account ? account.id : accountId };
  }
  const accounts = json.data?.Response?.Data?.Accounts || [];
  const resources = accounts.map((a) => {
    const left = Number(a.CycleCapacityRemainPrecise) || 0;
    const total = Number(a.CycleCapacitySizePrecise) || 0;
    return {
      packageCode: a.PackageCode || '',
      packageName: a.PackageName || '',
      left,
      total,
      used: Math.max(0, total - left),
      expireAt: a.DeductionEndTime || a.CycleEndTime || '',
    };
  });
  const usageLeft = resources.reduce((s, x) => s + x.left, 0);
  const usageTotal = resources.reduce((s, x) => s + x.total, 0);
  const usageUsed = resources.reduce((s, x) => s + x.used, 0);
  return {
    ok: true,
    code: json.code,
    msg: json.msg,
    usageLeft,
    usageTotal,
    usageUsed,
    resources,
    account: account ? (account.name || account.account.uid) : '',
    accountId: account ? account.id : accountId,
  };
}

module.exports = { getCredits };
