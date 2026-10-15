'use strict';

/*
 * 叮当快药签到
 * cron: 9 9 * * *
 *
 * 兼容变量：
 *   ddky=loginToken#userId#uDate，多账号用换行或 & 分隔。
 *   旧说明里的 loginToken&userId&uDate 也会自动识别为单账号。
 *
 * collector 取码（可选诊断/后续自动登录入口）：
 *   DDKY_APPID=<叮当快药主小程序 AppID>
 *   wx_server_url=http://d4.dqf.cc.cd:8787
 *   wx_auth=<collector auth>
 *
 * 注意：wx.login code 只是一次性凭证，仍需叮当登录接口兑换 loginToken/userId/uDate。
 * 当前公开资料和现有仓库未提供可验证的兑换接口，因此脚本不会把“取到 code”误报成业务登录成功。
 */

const axios = require('axios');
const crypto = require('crypto');
const { Env } = require('../tools/env');

const $ = new Env('叮当快药');
const CK_NAME = 'ddky';
const API_URL = 'https://hapi.ddky.com/mcp/weixin/rest.htm';
const SIGN_SECRET = '6C57AB91A1308E26B797F4CD382AC79D';
const VERSION_NAME = '4.9.0';
const WX_SERVER_URL = String(process.env.wx_server_url || 'http://d4.dqf.cc.cd:8787').replace(/\/+$/, '');
const WX_AUTH = String(process.env.wx_auth || '');
const DDKY_APPID = String(process.env.DDKY_APPID || '').trim();
const HTTP_TIMEOUT = Math.min(60000, Math.max(3000, Number(process.env.DDKY_HTTP_TIMEOUT || 20000)));

class DdkyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DdkyError';
    Object.assign(this, details);
  }
}

function formatTime(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`;
}

function formatDay(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function md5Upper(value) {
  return crypto.createHash('md5').update(value).digest('hex').toUpperCase();
}

function parseJsonp(raw, callback) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  const escaped = String(callback || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^${escaped}\\((.*)\\);?$`, 's'));
  if (!match) throw new DdkyError(`接口返回不是预期 JSONP：${text.slice(0, 160)}`);
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new DdkyError(`接口 JSON 解析失败：${error.message}`);
  }
}

function messageOf(body) {
  return String(body?.msg || body?.message || body?.errorMsg || body?.error || '').trim();
}

function isApiSuccess(body) {
  return body && (Number(body.code) === 0 || String(body.code) === '0');
}

function signedFlag(signDayVo = {}) {
  return signDayVo.isSingn === true || signDayVo.singn === true || signDayVo.isSign === true || signDayVo.signed === true;
}

function normalizeAccounts(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const records = [];
  for (const line of text.split(/\n+/).map((item) => item.trim()).filter(Boolean)) {
    if (line.includes('#')) {
      records.push(...line.split('&').map((item) => item.trim()).filter(Boolean));
      continue;
    }
    const amp = line.split('&').map((item) => item.trim()).filter(Boolean);
    if (amp.length >= 3 && amp.length % 3 === 0) {
      for (let index = 0; index < amp.length; index += 3) records.push(amp.slice(index, index + 3).join('#'));
    } else {
      records.push(line);
    }
  }
  return records;
}

function parseAccount(raw, index = 1) {
  const parts = String(raw || '').split('#').map((item) => item.trim());
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new DdkyError(`账号[${index}] 变量格式错误，应为 loginToken#userId#uDate`);
  }
  return { token: parts[0], userId: parts[1], uDate: parts[2], remark: parts.slice(3).join('#') };
}

async function fetchWxCode(options = {}) {
  const appid = String(options.appid || DDKY_APPID).trim();
  const url = String(options.url || WX_SERVER_URL).replace(/\/+$/, '');
  const auth = options.auth === undefined ? WX_AUTH : String(options.auth || '');
  const http = options.http || axios;
  if (!appid) throw new DdkyError('未配置 DDKY_APPID，无法让 collector 拉起叮当快药主小程序');
  if (!auth) throw new DdkyError('未配置 wx_auth，无法调用 collector');
  const response = await http.request({
    method: 'POST',
    url: `${url}/wx/runtime-code`,
    data: { appid },
    headers: { auth, 'Content-Type': 'application/json' },
    timeout: Number(options.timeout || 60000),
    validateStatus: () => true,
  });
  const body = response?.data || {};
  const code = body.code || body?.data?.code;
  if (response?.status !== 200 || body.status !== true || !code) {
    throw new DdkyError(`collector 取码失败：${body.message || `HTTP ${response?.status || 'unknown'}`}`);
  }
  return { code, via: body.via || '', appid };
}

class Task {
  constructor(raw, options = {}) {
    this.index = options.index || $.userIdx++;
    this.account = parseAccount(raw, this.index);
    this.http = options.http || axios;
    this.now = options.now || (() => new Date());
    this.logger = options.logger || ((message) => $.log(message));
  }

  log(message) {
    this.logger(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ''} ${message}`);
  }

  buildParams(method, extra = {}) {
    const date = this.now();
    const params = {
      loginToken: this.account.token,
      method,
      plat: 'H5',
      platform: 'H5',
      t: formatTime(date),
      uDate: this.account.uDate,
      userId: this.account.userId,
      v: '1.0',
      versionName: VERSION_NAME,
      ...extra,
    };
    const ordered = Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('');
    params.sign = md5Upper(`${method}${ordered}${SIGN_SECRET}`);
    return params;
  }

  async call(method, extra = {}) {
    const callback = `ddky_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const params = this.buildParams(method, extra);
    const response = await this.http.request({
      method: 'GET',
      url: API_URL,
      params: { sign: params.sign, ...Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'sign')), callback },
      timeout: HTTP_TIMEOUT,
      validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0 MicroMessenger/8.0.49 miniProgram' },
    });
    if (!response || response.status !== 200) throw new DdkyError(`${method} HTTP ${response?.status || 'unknown'}`);
    const body = parseJsonp(response.data, callback);
    if (!isApiSuccess(body)) throw new DdkyError(`${method} 失败：${messageOf(body) || `code=${body?.code}`}`, { apiBody: body });
    return body.result || {};
  }

  async pageInfo() {
    return this.call('ddky.promotion.signin.pageinfo', { signDay: formatDay(this.now()) });
  }

  async sign(signinId) {
    if (!signinId) throw new DdkyError('签到页未返回 signinId');
    return this.call('ddky.promotion.signin.sign', { channel: 'H5', laterSignType: 1, signinId });
  }

  async run() {
    try {
      const before = await this.pageInfo();
      const beforeVo = before.signDayVo || {};
      if (signedFlag(beforeVo)) {
        this.log(`✅ 今日已签到（服务端状态确认）${beforeVo.rewardsInfo ? `，奖励：${beforeVo.rewardsInfo}` : ''}`);
        return { ok: true, already: true, state: before };
      }

      await this.sign(beforeVo.signinId);
      const after = await this.pageInfo();
      const afterVo = after.signDayVo || {};
      if (!signedFlag(afterVo)) {
        throw new DdkyError(`签到接口已返回，但回查仍是未签到；服务端消息：${afterVo.signTips || '无'}`);
      }
      this.log(`✅ 签到成功（已回查确认）${afterVo.rewardsInfo ? `，奖励：${afterVo.rewardsInfo}` : ''}`);
      return { ok: true, already: false, state: after };
    } catch (error) {
      this.log(`❌ 执行失败：${error.message || error}`);
      return { ok: false, error };
    }
  }
}

async function main() {
  const raw = process.env[CK_NAME] || '';
  const accounts = normalizeAccounts(raw);
  if (!accounts.length) {
    $.log(`未找到变量 ${CK_NAME}`);
    if (DDKY_APPID) {
      try {
        const got = await fetchWxCode();
        $.log(`collector 已为 ${got.appid} 取得 wx.login code（${got.via || 'unknown'}），但缺少 ddky 业务会话兑换配置，未执行签到`);
      } catch (error) {
        $.log(`collector 取码失败：${error.message || error}`);
      }
    }
    return [];
  }

  $.log(`共找到 ${accounts.length} 个账号`);
  const results = [];
  for (let index = 0; index < accounts.length; index += 1) {
    const task = new Task(accounts[index], { index: index + 1 });
    results.push(await task.run());
    if (index < accounts.length - 1) await $.wait(1000, 2000);
  }
  return results;
}

if (require.main === module) {
  main()
    .catch((error) => $.log(`❌ 主流程异常：${error.message || error}`))
    .finally(() => $.done());
}

module.exports = {
  DdkyError,
  Task,
  fetchWxCode,
  formatDay,
  formatTime,
  isApiSuccess,
  main,
  md5Upper,
  normalizeAccounts,
  parseAccount,
  parseJsonp,
  signedFlag,
};
