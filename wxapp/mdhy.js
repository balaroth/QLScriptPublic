#!/usr/bin/env node
/**
 * cron 27 19 * * * mdhy.js
 * Show:每天运行一次
 * 美的会员（当前主端）自动登录、会员状态校验、积分流水同步、可领取积分任务领取
 *
 * 旧版 wx_midea=uid=...;sukey=...;#ucAccessToken 已废弃：
 * - 旧线下会员签到接口 create_daily_score 已退役；
 * - 旧营销签到活动已退役；
 * - 当前正式主端使用 wx49a622805968d156 + 手机号授权 + ucAccessToken。
 *
 * 依赖青龙环境：wx_server_url、wx_auth（由统一执行器注入）
 * scriptVersionNow = "1.0.0";
 */

'use strict';

const axios = require('axios');
const notify = require('../sendNotify');

const NAME = '美的会员签到';
const APPID = 'wx49a622805968d156';
const PLATFORM = 'WX_MEIDIDAOJIA_MINI';
const CHANNEL = '1.1.1.6.2.78.1.1';
const WCP_TAG = 'a3d1d55ebdd44ab1b8d46eba7b68472e';
const SOURCE_CLIENT = 'MIDEA_WEAPPLET';
const API = 'https://mcsp.midea.com';
const WX_SERVER = (process.env.wx_server_url || 'http://d4.dqf.cc.cd:8787').replace(/\/+$/, '');
const WX_AUTH = process.env.wx_auth || '';
const REQUEST_TIMEOUT = Number(process.env.MIDEA_REQUEST_TIMEOUT || 40000);
const COLLECTOR_TIMEOUT = Number(process.env.MIDEA_COLLECTOR_TIMEOUT || 140000);

let failed = false;
let retryable = false;
let notification = [];

function safeText(value, max = 160) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, max);
}

function businessMessage(body) {
  return safeText(body?.msg || body?.message || body?.errmsg || body?.error || body?.code || 'unknown');
}

function isSuccess(body) {
  return body && ['0', '000000'].includes(String(body.code ?? body.errcode ?? body.errCode));
}

function requestEnvelope(restParams, token, userCode = '', pagination = {}) {
  const timestamp = String(Date.now());
  const transactionId = `${timestamp}${Math.random().toString().slice(2)}`.slice(-13);
  return {
    headParams: {
      language: 'CN',
      originSystem: 'cms-app-mini',
      timeZone: '8',
      userType: 'C',
      userCode,
      tenantCode: '',
      userKey: token,
      sign: `e02ac436de344f729498263395de1dba${timestamp}0de1177c77524a7f965a36cf09d21345`,
      timestamp,
      miniAppVersion: 'release',
      transactionId,
    },
    restParams,
    pagination,
  };
}

async function collectorPost(route, tag) {
  if (!WX_AUTH) throw new Error('缺少 wx_auth，无法调用微信授权采集器');
  const nonce = `midea-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await axios.post(
    `${WX_SERVER}${route}`,
    { appid: APPID, openid: nonce },
    {
      headers: { auth: WX_AUTH, 'content-type': 'application/json' },
      timeout: COLLECTOR_TIMEOUT,
      validateStatus: () => true,
    },
  );
  const data = response.data || {};
  if (response.status !== 200 || !(data.status || data.ok)) {
    throw new Error(`${route}失败: ${businessMessage(data) || `HTTP ${response.status}`}`);
  }
  return data;
}

async function mideaPost(path, data, headers = {}, originalInput = true) {
  const response = await axios.post(`${API}/${path.replace(/^\/+/, '')}`, data, {
    headers: {
      'content-type': 'application/json',
      'miniAppVersion': 'release',
      wcpTag: WCP_TAG,
      ...headers,
    },
    timeout: REQUEST_TIMEOUT,
    validateStatus: () => true,
  });
  if (response.status !== 200) {
    const error = new Error(`${path} HTTP ${response.status}: ${businessMessage(response.data)}`);
    error.retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    throw error;
  }
  const body = response.data || {};
  if (!originalInput && !isSuccess(body)) {
    const error = new Error(`${path}业务失败: ${businessMessage(body)}`);
    error.retryable = /系统繁忙|超时|稍后再试|timeout/i.test(JSON.stringify(body));
    throw error;
  }
  return body;
}

function extractPhoneAuth(data) {
  const raw = data?.raw || data?.data?.raw || {};
  return {
    encryptedData: data?.encryptedData || raw.encryptedData || '',
    iv: data?.iv || raw.iv || '',
  };
}

function extractCode(data) {
  return data?.data?.code || data?.code || '';
}

async function login() {
  console.log('正在获取当前美的主端手机号授权...');
  const phone = extractPhoneAuth(await collectorPost('/wx/getphonenumber', 'phone'));
  if (!phone.encryptedData || !phone.iv) throw new Error('手机号授权结果缺少 encryptedData/iv');

  const jsCode = extractCode(await collectorPost('/wx/code', 'code'));
  if (!jsCode) throw new Error('微信授权采集器未返回登录 code');

  const body = await mideaPost(
    'api/cms_bff/mcsp-uc-mvip-bff/app/login/wx/mini/getLoginInfo.do',
    {
      jsCode,
      channelCode: CHANNEL,
      encryptedData: phone.encryptedData,
      ivStr: phone.iv,
      loginMode: 2,
      platformType: PLATFORM,
    },
    {},
    false,
  );
  const session = body.data || {};
  if (!session.ucAccessToken || !session.c4aUid || !session.openId) {
    throw new Error('美的登录成功但缺少 ucAccessToken/c4aUid/openId');
  }
  console.log('美的主端手机号授权登录成功');
  return session;
}

function authHeaders(session) {
  return {
    ucAccessToken: session.ucAccessToken,
    userKey: session.ucAccessToken,
    'login-mode-type': '2',
    'source-client': SOURCE_CLIENT,
  };
}

async function getProfile(session) {
  const body = await mideaPost(
    'api/cms_bff/mcsp-uc-mvip-bff/member/getMemberInfo.do',
    {
      pagination: {},
      restParams: { brand: 1, sourceSys: 'MIDEA', c4aUid: session.c4aUid },
      openid: session.openId,
    },
    authHeaders(session),
    false,
  );
  const profile = body.data || {};
  if (!profile.uid || Number(profile.userState) !== 1) {
    throw new Error(`会员状态异常: uid=${profile.uid ? 'present' : 'missing'} userState=${safeText(profile.userState)}`);
  }
  const point = profile.vipPoint ?? profile.vipPointPool ?? '未知';
  const growth = profile.vipGrow ?? '未知';
  const level = profile.levelName || profile.mfansLevelName || '普通会员';
  console.log(`会员身份有效：${level}，积分 ${point}，成长值 ${growth}`);
  notification.push(`会员身份有效：${level}，积分 ${point}，成长值 ${growth}`);
  return profile;
}

async function getScoreDetail(session, profile) {
  const body = await mideaPost(
    'api/cms_bff/mcsp-uc-mvip-bff/integral/getScoreDetail.do',
    requestEnvelope({}, session.ucAccessToken, session.c4aUid, { pageNo: 1, pageSize: 20, countFlag: true }),
    authHeaders(session),
    false,
  );
  const rows = Array.isArray(body.data) ? body.data : [];
  console.log(`积分流水同步成功：返回 ${rows.length} 条`);
  return rows;
}

async function getPointTasks(session) {
  const body = await mideaPost(
    'api/cms_bff/mcsp-uc-mvip-bff/pointTask/list.do',
    requestEnvelope({ platform: '19' }, session.ucAccessToken, session.c4aUid, {}),
    authHeaders(session),
    false,
  );
  const tasks = Array.isArray(body.data) ? body.data : [];
  if (!tasks.length) {
    console.log('当前官方积分任务列表为空');
    return [];
  }
  console.log(`当前官方积分任务：${tasks.map((t) => `${t.taskName || t.taskCode}[${t.taskStatus}]`).join('，')}`);
  return tasks;
}

async function receiveReadyTasks(session, tasks) {
  const ready = tasks.filter((task) => Number(task.taskStatus) === 1 && task.taskCode);
  if (!ready.length) {
    console.log('当前无已完成待领取的积分任务');
    notification.push('当前无已完成待领取的积分任务');
    return 0;
  }
  let received = 0;
  for (const task of ready) {
    const body = await mideaPost(
      'api/cms_bff/mcsp-uc-mvip-bff/pointTask/receive.do',
      requestEnvelope({ taskCode: task.taskCode }, session.ucAccessToken, session.c4aUid, {}),
      authHeaders(session),
      false,
    );
    console.log(`积分任务领取成功：${task.taskName || task.taskCode} +${task.pointValue ?? '?'}积分`);
    received += 1;
    if (body.data) console.log(`领取结果：${safeText(JSON.stringify(body.data), 240)}`);
  }
  notification.push(`已领取 ${received} 个积分任务`);
  return received;
}

async function main() {
  console.log(`\n🔔${NAME},开始!`);
  console.log('协议：当前美的主端手机号授权登录 + 统一会员/积分接口');
  console.log('说明：旧版每日签到和营销签到活动均已退役，不再调用');
  const session = await login();
  const profile = await getProfile(session);
  await getScoreDetail(session, profile);
  const tasks = await getPointTasks(session);
  await receiveReadyTasks(session, tasks);
  console.log('[QLRUN_RESULT] SUCCESS reason=midea_member_sync_ok');
}

(async () => {
  try {
    await main();
  } catch (error) {
    failed = true;
    retryable = Boolean(error?.retryable) || /timeout|ECONN|ENOTFOUND|EAI_AGAIN|系统繁忙|稍后再试|超时/i.test(String(error?.message || error));
    const reason = safeText(error?.message || error, 360);
    console.error(`美的会员执行失败: ${reason}`);
    console.log(`[QLRUN_RESULT] FAILURE reason=midea_member_flow_failed retryable=${retryable ? 1 : 0}`);
    notification.push(`执行失败：${reason}`);
  } finally {
    if (process.env.QL_SUPPRESS_NOTIFY !== '1' && notification.length) {
      try { await notify.sendNotify(NAME, notification.join('\n')); } catch (error) { console.error(`通知失败: ${safeText(error?.message || error)}`); }
    }
    console.log(`🔔${NAME},结束!`);
    if (failed) process.exitCode = 1;
  }
})();
