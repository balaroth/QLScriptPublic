/*
爱玛会员俱乐部 - 自动签到脚本
变量名：aima
变量值：账号标识/openid（支持多账号，用 & 或换行分隔）
CODE登录依赖：wx_server_url、wx_auth
*/
const { Env } = require("../tools/env");
const $ = new Env("爱玛会员俱乐部");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ================== 配置区 ==================
const BASE_URL = "https://scrm.aimatech.com";
const WXCLIENT_URL = `${BASE_URL}/aima/wxclient`;
const MINI_APPID = "wx2dcfb409fd5ddfb4";
const APP_ID = "scrm";
const TOKEN_CACHE_FILE = process.env.AIMA_TOKEN_CACHE_FILE || path.join(__dirname, "aima_token_cache.json");
const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 11; Xiaomi Pad 5 Build/RKQ1.200826.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.0.0 Mobile Safari/537.36 XWEB/0 MMWEBSDK/20240404 MicroMessenger/8.0.49.2600(0x28003134) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android";

// ================== 工具函数 ==================
function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

function maskToken(token = "") {
  if (!token) return "";
  if (token.length <= 12) return `${token.slice(0, 3)}***`;
  return `${token.slice(0, 6)}***${token.slice(-6)}`;
}

function isToken(value = "") {
  return /^eyJ/.test(value.trim()) || value.length > 120;
}

function readCache() {
  try {
    if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    $.log(`⚠️ token缓存写入失败: ${e.message}`);
  }
}

function updateCachedToken(account, token) {
  if (!account || !token || isToken(account)) return;
  const cache = readCache();
  cache[account] = {
    token,
    updatedAt: new Date().toISOString(),
  };
  writeCache(cache);
}

function getResponseToken(headers = {}) {
  return (
    headers["set-access-token"] ||
    headers["Set-Access-Token"] ||
    headers["SET-ACCESS-TOKEN"] ||
    ""
  );
}

function buildHeaders(token = "") {
  const timestamp = Date.now().toString();
  const traceLogId = generateUUID();
  const signToken = token ? token.substring(50, 80) : "";
  const signStr = `App-Id${APP_ID}Time-Stamp${timestamp}TraceLog-Id${traceLogId}Access-Token${signToken}AimaScrm321_^`;

  return {
    "App-Id": APP_ID,
    "Time-Stamp": timestamp,
    "TraceLog-Id": traceLogId,
    "Access-Token": token,
    Sign: md5(signStr).toLowerCase(),
    "content-type": "application/json",
    charset: "utf-8",
    Referer: "https://servicewechat.com/wx2dcfb409fd5ddfb4/227/page-frame.html",
    "User-Agent": USER_AGENT,
  };
}

async function request(method, url, token, options = {}) {
  const res = await axios({
    method,
    url,
    headers: buildHeaders(token),
    timeout: 15000,
    validateStatus: () => true,
    ...options,
  });

  const newToken = getResponseToken(res.headers);
  if (newToken && options.account && res.status === 200 && res.data?.code === 200) {
    options.onToken?.(newToken);
    updateCachedToken(options.account, newToken);
  }

  return res;
}

async function getWxCode(account, attempt = 1) {
  const wxServerUrl = process.env.wx_server_url;
  const wxAuth = process.env.wx_auth;
  if (!wxServerUrl || !wxAuth) {
    throw new Error("未配置 wx_server_url 或 wx_auth，无法获取code登录");
  }

  const routes = ["/wx/getuserinfo", "/wx/runtime-code", "/wx/getuserinfo"];
  const route = routes[Math.min(Math.max(attempt - 1, 0), routes.length - 1)];
  const nonce = [account, "aima-code", route.slice(4), process.env.AIMA_TEST_NONCE || Date.now(), attempt, Math.random().toString(36).slice(2, 10)].join("-");
  const res = await axios.post(
    `${wxServerUrl.replace(/\/$/, "")}${route}`,
    {
      appid: MINI_APPID,
      openid: nonce,
    },
    {
      headers: {
        auth: wxAuth,
        "content-type": "application/json",
      },
      timeout: 90000,
      validateStatus: () => true,
    }
  );

  const code = res.data?.code || res.data?.data?.code;
  if (res.status !== 200 || res.data?.status === false || !code) {
    throw new Error(`${route}获取code失败: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }

  return code;
}

async function loginByCode(account) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    $.log(`🔐 正在获取新code并登录${attempt > 1 ? `（第${attempt}次/切换取码策略）` : ""}...`);
    try {
      const code = await getWxCode(account, attempt);
      const res = await request("post", `${WXCLIENT_URL}/user/members:login`, "", {
        data: { code },
      });
      const token = getResponseToken(res.headers);
      if (res.status !== 200 || res.data?.code !== 200 || !token) {
        throw new Error(`登录失败: HTTP ${res.status} ${JSON.stringify(res.data)}`);
      }
      if (!(await validateToken(account, token))) {
        throw new Error("登录响应token未通过会员接口验真");
      }
      updateCachedToken(account, token);
      $.log(`✅ 登录成功且会员接口验真通过，已缓存token: ${maskToken(token)}`);
      return token;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
    }
  }
  throw lastError || new Error("登录失败");
}

async function validateToken(account, token) {
  const res = await request("get", `${WXCLIENT_URL}/member/IndexInfo`, token, {
    account,
  });
  const ok = res.status === 200 && res.data?.code === 200;
  if (!ok) {
    $.log(`⚠️ 缓存token失效: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }
  return ok;
}

async function getAccessToken(account) {
  const value = account.trim();
  if (isToken(value)) {
    $.log(`ℹ️ 检测到旧token变量，将直接使用: ${maskToken(value)}`);
    return value;
  }

  const cache = readCache();
  const cachedToken = cache[value]?.token;
  if (cachedToken) {
    $.log(`🔎 使用缓存token校验: ${maskToken(cachedToken)}`);
    if (await validateToken(value, cachedToken)) {
      $.log("✅ 缓存token有效");
      return cachedToken;
    }
  }

  return loginByCode(value);
}

// ================== 核心逻辑 ==================
async function discoverSignActivity(account, token, onToken) {
  const res = await request(
    "post",
    `${WXCLIENT_URL}/mkt/activities/locations:search`,
    token,
    {
      data: { locations: [0, 1, 2] },
      account,
      onToken,
    }
  );

  if (res.status !== 200 || res.data?.code !== 200) {
    throw new Error(`发现签到活动失败: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }

  const unique = new Map();
  for (const item of Array.isArray(res.data?.content) ? res.data.content : []) {
    if (Number(item?.templateType) !== 3 || !item?.activityId) continue;
    unique.set(String(item.activityId), item);
  }
  const activities = [...unique.values()];
  if (activities.length !== 1) {
    throw new Error(
      `签到活动发现异常: 期望唯一的模板3活动，实际${activities.length}个 ${JSON.stringify(
        activities.map((item) => ({
          activityId: item.activityId,
          activityName: item.activityName || item.name || "",
          status: item.status,
          beginDate: item.beginDate,
          endDate: item.endDate,
        }))
      )}`
    );
  }
  return activities[0];
}

async function signIn(account, index) {
  let token = await getAccessToken(account);
  const setToken = (newToken) => {
    token = newToken;
  };

  const activity = await discoverSignActivity(account, token, setToken);
  const activityId = activity.activityId;
  $.log(
    `🎯 账号【${index}】当前签到活动: ${activity.activityName || activity.name || "未命名"}（${activityId}）`
  );

  $.log(`🚀 账号【${index}】查询签到状态...`);
  const searchRes = await request(
    "post",
    `${WXCLIENT_URL}/mkt/activities/sign:search`,
    token,
    {
      data: { activityId },
      account,
      onToken: setToken,
    }
  );

  if (searchRes.status !== 200 || searchRes.data?.code !== 200) {
    throw new Error(`查询签到状态失败: HTTP ${searchRes.status} ${JSON.stringify(searchRes.data)}`);
  }

  const signStatus = searchRes.data?.content?.signStatus;
  if (signStatus === 1) {
    $.log(`✅ 账号【${index}】今日已签到！`);
    return;
  }

  $.log(`⏳ 账号【${index}】正在签到...`);
  const joinRes = await request(
    "post",
    `${WXCLIENT_URL}/mkt/activities/sign:join`,
    token,
    {
      data: { activityId, activitySceneId: null },
      account,
      onToken: setToken,
    }
  );

  if (joinRes.status === 200 && joinRes.data?.code === 200) {
    const verifyRes = await request(
      "post",
      `${WXCLIENT_URL}/mkt/activities/sign:search`,
      token,
      { data: { activityId }, account, onToken: setToken }
    );
    const verified = verifyRes.status === 200 && verifyRes.data?.code === 200 && verifyRes.data?.content?.signStatus === 1;
    if (!verified) {
      throw new Error(`签到接口返回成功但后验未确认: HTTP ${verifyRes.status} ${JSON.stringify(verifyRes.data)}`);
    }
    const point = joinRes.data.content?.point || joinRes.data.content?.points || 0;
    $.log(`🎉 账号【${index}】签到成功且后验状态为已签到！${point ? `获得 ${point} 积分` : ""}`);
  } else {
    const body = joinRes.data;
    const err = new Error(`签到失败: HTTP ${joinRes.status} ${JSON.stringify(body)}`);
    // 品牌服务端明确活动未开始（910103 / MKT_ACTIVITY_NOT_BEGIN）：账号正常、服务端活动未开放，
    // 重试/重登在当日窗口内不可能改变结果，标记为不可重试终态。
    if (body?.code === 910103 || /MKT_ACTIVITY_NOT_BEGIN|活动未开始/.test(JSON.stringify(body))) {
      err.terminal = "activity-not-begin";
      err.retryable = false;
    }
    throw err;
  }
}

// ================== 主函数 ==================
!(async () => {
  console.log("\n🔔 爱玛会员俱乐部, 开始!");

  let accounts = [];
  if ($.isNode()) {
    const env = process.env.aima;
    if (env) {
      accounts = env.split(/&|\n/).map((t) => t.trim()).filter(Boolean);
    }
  }

  if (accounts.length === 0) {
    $.log("❌ 未找到账号标识，请配置变量 'aima'");
    process.exitCode = 1;
    return;
  }

  console.log(`共找到${accounts.length}个账号`);

  let success = 0;
  let failed = 0;
  let retryable = true;
  for (let i = 0; i < accounts.length; i++) {
    try {
      console.log(`\n🚀 user:【${i + 1}】 start work`);
      await signIn(accounts[i], i + 1);
      success++;
    } catch (e) {
      failed++;
      if (e && e.retryable === false) retryable = false;
      console.log(`❌ 账号【${i + 1}】执行失败: ${e.message}`);
    }
  }

  if (failed === 0 && success === accounts.length) {
    console.log(`[QLRUN_RESULT] SUCCESS core=${success}/${accounts.length}`);
  } else {
    process.exitCode = 1;
    console.log(`[QLRUN_RESULT] FAILURE retryable=${retryable ? 1 : 0} core=${success}/${accounts.length} failed=${failed}`);
  }
  // await $.sendMsg($.logs.join("\n"));
})()
  .catch((e) => {
    process.exitCode = 1;
    console.log(e);
  })
  .finally(() => $.done());
