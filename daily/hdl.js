/*
 * 海底捞微信小程序自动签到
 * cron: 30 8 * * *
 *
 * 默认无需静态 hdl：使用 d4 collector 按 AppID 拉起海底捞小程序并完成
 * wx.login code -> openid/unionid -> v2 wechatLogin -> 签到。
 *
 * 必需环境变量：
 *   wx_server_url  collector 地址
 *   wx_auth        collector 鉴权
 * 可选环境变量：
 *   HDL_AUTO_LOGIN=1
 *   HDL_LOGIN_TIMEOUT=120000
 *   HDL_HTTP_TIMEOUT=20000
 *   HDL_MAX_RETRIES=2
 * 兼容旧变量：
 *   hdl=wx#openId#uid 或 app#token，多账号以 & 或换行分隔
 */
'use strict';

const axios = require('axios');
const { Env } = require('../tools/env');

const $ = new Env('海底捞');
const API_BASE = 'https://superapp-public.kiwa-tech.com';
const MINI_APP_ID = 'wx1ddeb67115f30d1a';
const APP_VERSION = '4.93.1';
const DEFAULT_WX_SERVER_URL = 'http://d4.dqf.cc.cd:8787';

class HdlError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HdlError';
    Object.assign(this, details);
  }
}

class AuthError extends HdlError {
  constructor(message = '海底捞登录已失效', details = {}) {
    super(message, details);
    this.name = 'AuthError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const boolEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
};
const intEnv = (name, fallback, min, max) => {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
};
const errorText = (error) => {
  if (!error) return '未知错误';
  const parts = [error.message || String(error)];
  if (error.code) parts.push(error.code);
  if (error.response && error.response.status) parts.push(`HTTP ${error.response.status}`);
  return [...new Set(parts.filter(Boolean))].join(' ');
};

function wxServerConfig() {
  return {
    url: String(process.env.wx_server_url || DEFAULT_WX_SERVER_URL).replace(/\/+$/, ''),
    auth: String(process.env.wx_auth || ''),
  };
}

function commonHeaders(token = '', platformName = 'wechat') {
  return {
    accept: '*/*',
    appId: '15',
    appName: 'HDLMember',
    appVersion: APP_VERSION,
    platformName,
    _HAIDILAO_APP_TOKEN: token,
    'content-type': 'application/json',
    'User-Agent': 'Mozilla/5.0 MicroMessenger/8.0.49 miniProgram',
  };
}

function parseAccounts(raw) {
  return String(raw || '')
    .split(/[&\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x, i) => {
      const parts = x.split('#');
      if (parts[0] === 'wx' && parts[1] && parts[2]) {
        return { mode: 'wx', openId: parts[1], uid: parts[2], remark: parts[3] || `账号${i + 1}` };
      }
      if (parts[0] === 'app' && parts[1]) {
        return { mode: 'app', token: parts[1], remark: parts[2] || `账号${i + 1}` };
      }
      return { mode: 'invalid', remark: `账号${i + 1}` };
    });
}

async function collectorRequest(path, data, options = {}) {
  const http = options.http || axios;
  const config = options.wxServer || wxServerConfig();
  const timeout = options.timeout || intEnv('HDL_LOGIN_TIMEOUT', 120000, 10000, 180000);
  if (!config.auth) throw new HdlError('缺少 wx_auth，无法调用微信 collector');
  const response = await http.request({
    method: 'POST',
    url: `${config.url}${path}`,
    data,
    timeout,
    headers: { auth: config.auth, 'Content-Type': 'application/json' },
  });
  const body = response && response.data;
  if (!body || body.status !== true) {
    throw new HdlError(`collector 调用失败：${(body && body.message) || JSON.stringify(body || {})}`);
  }
  return body;
}

async function fetchWxCode(options = {}) {
  const body = await collectorRequest('/wx/code', { appid: MINI_APP_ID, openid: `hdl-${Date.now()}` }, options);
  const code = body.code || (body.data && body.data.code);
  if (!code) throw new HdlError('collector 未返回海底捞 wx.login code');
  return code;
}

async function fetchPhoneAuthorization(options = {}) {
  const body = await collectorRequest('/wx/getphonenumber', { appid: MINI_APP_ID }, options);
  if (!body.code && !body.encryptedData) throw new HdlError('collector 未返回手机号授权数据');
  return body;
}

async function requestWxIdentity(code, options = {}) {
  const http = options.http || axios;
  const timeout = options.timeout || intEnv('HDL_HTTP_TIMEOUT', 20000, 3000, 60000);
  const form = new URLSearchParams({ code });
  const response = await http.request({
    method: 'POST',
    url: `${API_BASE}/CaterWeixin/ws/external/getId.json`,
    data: form.toString(),
    timeout,
    headers: { ...commonHeaders('', 'wechat'), 'content-type': 'application/x-www-form-urlencoded' },
  });
  const body = response && response.data;
  const value = body && (body.value || body.data);
  const openId = value && (value.openid || value.openId);
  const uid = value && (value.unionid || value.unionId || value.uid);
  if (!body || body.success !== true || !openId || !uid) {
    throw new HdlError(`海底捞微信身份交换失败：${(body && body.msg) || '缺少 openid/unionid'}`);
  }
  return { openId, uid };
}

async function loginWithIdentity(identity, options = {}) {
  const http = options.http || axios;
  const timeout = options.timeout || intEnv('HDL_HTTP_TIMEOUT', 20000, 3000, 60000);
  const response = await http.request({
    method: 'POST',
    url: `${API_BASE}/api/gateway/login/center/login/v2/wechatLogin`,
    timeout,
    headers: commonHeaders('', 'wechat'),
    data: {
      type: 1,
      country: 'CN',
      codeType: 1,
      business: '登录',
      terminal: '会员小程序',
      openId: identity.openId,
      uid: identity.uid,
    },
  });
  const body = response && response.data;
  if (body && body.success === true && body.data && body.data.token) return body.data;
  throw new HdlError((body && body.msg) || '海底捞微信登录失败', {
    apiCode: body && (body.code || body.rc),
  });
}

async function bindPhone(identity, options = {}) {
  const http = options.http || axios;
  const timeout = options.timeout || intEnv('HDL_HTTP_TIMEOUT', 20000, 3000, 60000);
  const phone = await fetchPhoneAuthorization(options);
  const response = await http.request({
    method: 'POST',
    url: `${API_BASE}/login/safeBind`,
    timeout,
    headers: commonHeaders('', 'wechat'),
    data: {
      type: 1,
      country: 'CN',
      codeType: 1,
      regChannel: '',
      regSrc: '',
      regStoreId: '',
      encryptedData: phone.encryptedData || '',
      iv: phone.iv || '',
      wechatCode: phone.code || '',
      openId: identity.openId,
      uid: identity.uid,
      name: '',
      iconurl: '',
    },
  });
  const body = response && response.data;
  const data = body && (body.data || body.value);
  if (body && body.success === true && data && data.token) return data;
  throw new HdlError((body && body.msg) || '海底捞手机号身份恢复失败', {
    apiCode: body && (body.code || body.rc),
  });
}

async function autoLogin(options = {}) {
  const logger = options.logger || console;
  logger.log('通过 collector 获取海底捞 wx.login code...');
  const code = await fetchWxCode(options);
  const identity = await requestWxIdentity(code, options);
  logger.log('海底捞微信身份交换成功');
  try {
    const data = await loginWithIdentity(identity, options);
    logger.log(`海底捞会员登录成功：${data.nickName || data.name || '已登录会员'}`);
    return data;
  } catch (error) {
    if (!/绑定手机号|请绑定手机号/.test(error.message || '')) throw error;
    logger.log('当前微信身份需要恢复手机号绑定，正在自动授权...');
    const data = await bindPhone(identity, options);
    logger.log('海底捞手机号身份恢复成功');
    return data;
  }
}

class Task {
  constructor(account, options = {}) {
    this.index = options.index || 1;
    this.account = account;
    this.http = options.http || axios;
    this.logger = options.logger || console;
    this.wait = options.wait || sleep;
    this.timeout = options.timeout || intEnv('HDL_HTTP_TIMEOUT', 20000, 3000, 60000);
    this.maxRetries = options.maxRetries ?? intEnv('HDL_MAX_RETRIES', 2, 0, 5);
    this.autoLoginEnabled = options.autoLoginEnabled ?? boolEnv('HDL_AUTO_LOGIN', true);
    this.autoLoginProvider = options.autoLoginProvider || (() => autoLogin({ http: this.http, logger: this.logger }));
    this.token = account.token || '';
    this.name = account.remark || `账号${this.index}`;
    this.platformName = account.mode === 'app' ? 'app' : 'wechat';
    this.signinSource = account.mode === 'app' ? 'APP' : 'MiniApp';
    this.failures = [];
  }

  prefix(message) { return `账号[${this.index}]【${this.name}】${message}`; }

  async ensureAccount() {
    if (this.token) return;
    if (this.account.mode === 'wx' && this.account.openId && this.account.uid) {
      try {
        const data = await loginWithIdentity({ openId: this.account.openId, uid: this.account.uid }, { http: this.http });
        this.token = data.token;
        this.name = data.nickName || data.name || this.name;
        return;
      } catch (error) {
        if (!this.autoLoginEnabled) throw error;
        this.logger.warn(this.prefix(`旧微信身份登录失败，切换 collector 自动登录：${errorText(error)}`));
      }
    }
    if (!this.autoLoginEnabled) throw new HdlError('未配置 hdl，且 HDL_AUTO_LOGIN 已关闭');
    const data = await this.autoLoginProvider();
    if (!data || !data.token) throw new HdlError('自动登录未返回 token');
    this.token = data.token;
    this.name = data.nickName || data.name || this.name;
  }

  async request(path, data = {}, meta = {}) {
    const attempts = meta.idempotent ? this.maxRetries + 1 : 1;
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.http.request({
          method: 'POST',
          url: `${API_BASE}${path}`,
          data,
          timeout: this.timeout,
          headers: commonHeaders(this.token, this.platformName),
        });
        const body = response && response.data;
        if (!body || typeof body !== 'object') throw new HdlError('接口返回不是 JSON', { endpoint: path });
        if (response.status === 401 || ['302011', '302012', '302013', '303004'].includes(String(body.code))) {
          throw new AuthError(body.msg || undefined, { endpoint: path, apiCode: body.code });
        }
        if (body.success !== true) {
          const message = body.msg || `接口失败：${body.code || 'unknown'}`;
          if (meta.acceptMessages && meta.acceptMessages.test(message)) {
            return { ...(body.data || body.value || {}), _accepted: true, _message: message };
          }
          throw new HdlError(message, { endpoint: path, apiCode: body.code });
        }
        return body.data || body.value || {};
      } catch (error) {
        last = error;
        const status = error.response && error.response.status;
        const retryable = meta.idempotent && attempt < attempts && (!status || status === 408 || status === 429 || status >= 500);
        if (!retryable) break;
        const delay = Math.min(3000, 400 * 2 ** (attempt - 1));
        this.logger.warn(this.prefix(`只读请求失败，${delay}ms 后重试（${attempt}/${attempts - 1}）：${errorText(error)}`));
        await this.wait(delay);
      }
    }
    throw last instanceof HdlError ? last : new HdlError(`请求失败：${errorText(last)}`, { cause: last, endpoint: path });
  }

  async queryFragment() {
    const data = await this.request('/activity/wxapp/signin/queryFragment', {}, { idempotent: true });
    this.logger.log(this.prefix(`本期碎片【${data.total ?? '未知'}】，有效期至【${data.expireDate || '未知'}】`));
    return data;
  }

  async signIn() {
    const data = await this.request(
      '/activity/wxapp/signin/signin',
      { signinSource: this.signinSource },
      { acceptMessages: /已签到|请勿重复操作/ },
    );
    if (data._accepted) {
      this.logger.log(this.prefix(`签到状态：${data._message}`));
      return data;
    }
    const rows = Array.isArray(data.signinQueryDetailList) ? data.signinQueryDetailList : [];
    const today = rows.find((x) => Number(x.currentOr) === 1) || rows[0] || {};
    const reward = today.fragment ?? data.fragment;
    const activity = today.activityName || data.activityName;
    this.logger.log(this.prefix(`签到成功${reward !== undefined ? `，获得【${reward}】碎片` : ''}${activity ? `（${activity}）` : ''}`));
    return data;
  }

  async memberInfo() {
    const data = await this.request('/activity/wxapp/applet/queryMemberCacheInfo', { type: 1 }, { idempotent: true });
    this.logger.log(this.prefix(`会员【${data.customerName || this.name}】，捞币【${data.coinNum ?? '未知'}】`));
    return data;
  }

  async run() {
    try {
      await this.ensureAccount();
      await this.memberInfo();
      await this.queryFragment();
      await this.signIn();
      await this.queryFragment();
      return { ok: true };
    } catch (error) {
      const message = errorText(error);
      this.failures.push(message);
      this.logger.error(this.prefix(`执行失败：${message}`));
      return { ok: false, failures: this.failures };
    }
  }
}

function createLogger(env) {
  return {
    log: (message) => env.log(message),
    warn: (message) => env.log(`⚠️ ${message}`),
    error: (message) => env.log(`❌ ${message}`),
  };
}

async function main() {
  const logger = createLogger($);
  const staticAccounts = parseAccounts(process.env.hdl || '');
  const autoEnabled = boolEnv('HDL_AUTO_LOGIN', true);
  const accounts = staticAccounts.length ? staticAccounts : (autoEnabled ? [{ mode: 'auto', remark: '自动登录账号' }] : []);
  if (!accounts.length) {
    logger.error('未配置 hdl，且 HDL_AUTO_LOGIN 已关闭');
    console.log('[QLRUN_RESULT] FAILURE accounts=0 failed=1 retryable=0');
    process.exitCode = 1;
    await $.sendMsg();
    return;
  }
  logger.log(`共找到${accounts.length}个账号`);
  let failed = 0;
  for (let i = 0; i < accounts.length; i += 1) {
    if (accounts[i].mode === 'invalid') {
      logger.error(`账号[${i + 1}] 配置格式无效`);
      failed += 1;
      continue;
    }
    const result = await new Task(accounts[i], { index: i + 1, logger }).run();
    if (!result.ok) failed += 1;
  }
  logger.log(`执行汇总：账号=${accounts.length}，失败=${failed}`);
  console.log(failed
    ? `[QLRUN_RESULT] FAILURE accounts=${accounts.length} failed=${failed} retryable=1`
    : `[QLRUN_RESULT] SUCCESS accounts=${accounts.length} failed=0 mode=微信小程序自动登录`);
  await $.sendMsg();
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`海底捞脚本未捕获异常：${errorText(error)}`);
    console.log('[QLRUN_RESULT] FAILURE accounts=0 failed=1 retryable=1');
    process.exitCode = 1;
  });
}

module.exports = {
  API_BASE,
  MINI_APP_ID,
  APP_VERSION,
  HdlError,
  AuthError,
  Task,
  parseAccounts,
  commonHeaders,
  fetchWxCode,
  fetchPhoneAuthorization,
  requestWxIdentity,
  loginWithIdentity,
  bindPhone,
  autoLogin,
  errorText,
};
