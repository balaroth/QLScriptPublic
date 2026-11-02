/*
爱玛会员俱乐部 - 自动签到脚本（防重放安全骨架候选，2026-11-02）
变量名：aima
变量值：账号标识/openid（支持多账号，用 & 或换行分隔）
CODE登录依赖：wx_server_url、wx_auth
只读模式：AIMA_READ_ONLY=1 时只做发现+权威查，绝不发 sign:join
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
const WRITE_STATE_FILE = process.env.AIMA_WRITE_STATE_FILE || path.join(__dirname, "aima_write_state.json");
const READ_ONLY = process.env.AIMA_READ_ONLY === "1";
const MAX_RECOVERY_WRITES = 1;       // 当日除首次外，最多一次恢复写
const HARD_TOTAL_WRITES = 2;         // 当日总写硬上限（首次+恢复）
const COOLDOWN_MS = Number(process.env.AIMA_RECOVERY_COOLDOWN_MS || 30 * 60 * 1000);
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
function md5(str) { return crypto.createHash("md5").update(str).digest("hex"); }
function maskToken(token = "") {
  if (!token) return "";
  if (token.length <= 12) return `${token.slice(0, 3)}***`;
  return `${token.slice(0, 6)}***${token.slice(-6)}`;
}
function isToken(value = "") { return /^eyJ/.test(value.trim()) || value.length > 120; }
function chinaToday() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function short(v, n = 240) {
  try { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + "…" : s; }
  catch (_) { return String(v).slice(0, n); }
}

// 业务异常分类：retryable=false 即终态，外层不得重放
class BizError extends Error {
  constructor(msg, opts = {}) { super(msg); this.retryable = !!opts.retryable; this.terminal = !!opts.terminal; this.kind = opts.kind || "biz"; }
}
// 写结果未知：retryable=0，只读收敛，绝不重发
class WriteUnknownError extends Error { constructor(msg) { super(msg); this.retryable = 0; this.kind = "unknown"; } }

// ================== 共享文件锁（cache/state 跨账号互斥） ==================
// openSync(wx) 独占创建；EEXIST → null（fail-closed）；fd finally 关；绝不删外来锁。
function sharedLock(name) {
  const f = path.join(path.dirname(WRITE_STATE_FILE), name);
  let fd = null;
  try {
    fd = fs.openSync(f, "wx");
    fs.writeSync(fd, `pid=${process.pid}\n`);
    const rel = () => { try { if (fd !== null) fs.closeSync(fd); } catch (_) {} try { fs.unlinkSync(f); } catch (_) {} };
    return rel;
  } catch (e) {
    try { if (fd !== null) fs.closeSync(fd); } catch (_) {}
    return null; // EEXIST 或锁异常 → 竞争/不可用，fail-closed
  }
}

// ================== 原子 JSON 落盘 + 回读 ==================
function atomicWriteJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

// ================== token cache（共享锁 + 原子 + schema fail-closed） ==================
function readCacheRaw() {
  try {
    if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
    const v = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("corrupt");
    return v;
  } catch (e) { return {}; }
}
function updateCachedToken(account, token) {
  if (!account || !token || isToken(account)) return;
  const rel = sharedLock("aima_shared_cache.lock");
  if (!rel) { $.log("⚠️ 缓存锁竞争，跳过本次缓存写（保留他人锁）"); return; }
  try {
    let cur;
    try {
      cur = fs.existsSync(TOKEN_CACHE_FILE) ? JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) : {};
      if (!cur || typeof cur !== "object" || Array.isArray(cur)) throw new Error("corrupt");
    } catch (e) { throw new BizError("CACHE_CORRUPT:token缓存结构非法，已阻写", { retryable: false }); }
    const merged = Object.assign({}, cur, { [account]: { token, updatedAt: new Date().toISOString() } });
    if (!atomicWriteJson(TOKEN_CACHE_FILE, merged)) throw new BizError("CACHE_WRITE_FAIL:token缓存原子写失败，已阻写", { retryable: false });
  } finally { rel(); }
}

// ================== 防重写状态机（按 openid + activityId + 日期隔离） ==================
function stateKey(account, activityId) { return `${String(account)}::${String(activityId || "unknown")}`; }
function readStateAll() {
  if (!fs.existsSync(WRITE_STATE_FILE)) return {};
  let v;
  try {
    v = JSON.parse(fs.readFileSync(WRITE_STATE_FILE, "utf8"));
  } catch (e) {
    throw new BizError("WRITE_STATE_PARSE:防重放状态文件JSON语法损坏，已阻写", { retryable: false });
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BizError("WRITE_STATE_SCHEMA:防重放状态根结构非法（非对象），已阻写", { retryable: false });
  return v;
}
// 持共享锁全程：读盘→merge→rename→回读
function recordState(account, activityId, entry) {
  const k = stateKey(account, activityId);
  const rel = sharedLock("aima_shared_state.lock");
  if (!rel) throw new WriteUnknownError("共享状态锁竞争，已阻写（保留他人锁）");
  try {
    const fresh = readStateAll();
    fresh[k] = Object.assign({}, fresh[k] || {}, entry, { date: chinaToday(), activityId });
    if (!atomicWriteJson(WRITE_STATE_FILE, fresh)) throw new WriteUnknownError("防重放状态落盘失败，已阻写");
    const back = (JSON.parse(fs.readFileSync(WRITE_STATE_FILE, "utf8")) || {})[k];
    if (!back || back.date !== fresh[k].date || back.outcome !== fresh[k].outcome) throw new WriteUnknownError("防重放状态回读校验失败");
    return back;
  } finally { rel(); }
}
function stateFor(account, activityId) {
  try {
    const all = readStateAll();
    const st = all[stateKey(account, activityId)];
    if (!st || st.date !== chinaToday()) return null;
    return st;
  } catch (e) { throw e; }
}

function getResponseToken(headers = {}) {
  return headers["set-access-token"] || headers["Set-Access-Token"] || headers["SET-ACCESS-TOKEN"] || "";
}
function buildHeaders(token = "") {
  const timestamp = Date.now().toString();
  const traceLogId = generateUUID();
  const signToken = token ? token.substring(50, 80) : "";
  const signStr = `App-Id${APP_ID}Time-Stamp${timestamp}TraceLog-Id${traceLogId}Access-Token${signToken}AimaScrm321_^`;
  return {
    "App-Id": APP_ID, "Time-Stamp": timestamp, "TraceLog-Id": traceLogId,
    "Access-Token": token, Sign: md5(signStr).toLowerCase(),
    "content-type": "application/json", charset: "utf-8",
    Referer: "https://servicewechat.com/wx2dcfb409fd5ddfb4/227/page-frame.html",
    "User-Agent": USER_AGENT,
  };
}

async function request(method, url, token, options = {}) {
  const res = await axios({ method, url, headers: buildHeaders(token), timeout: 15000, validateStatus: () => true, ...options });
  const newToken = getResponseToken(res.headers);
  if (newToken && options.account && res.status === 200 && res.data?.code === 200) {
    options.onToken?.(newToken);
    try { updateCachedToken(options.account, newToken); } catch (e) { /* cache 写失败不阻断读路径 */ }
  }
  return res;
}

async function getWxCode(account, attempt = 1) {
  const wxServerUrl = process.env.wx_server_url;
  const wxAuth = process.env.wx_auth;
  if (!wxServerUrl || !wxAuth) throw new Error("未配置 wx_server_url 或 wx_auth，无法获取code登录");
  const routes = ["/wx/getuserinfo", "/wx/runtime-code", "/wx/getuserinfo"];
  const route = routes[Math.min(Math.max(attempt - 1, 0), routes.length - 1)];
  const nonce = [account, "aima-code", route.slice(4), process.env.AIMA_TEST_NONCE || Date.now(), attempt, Math.random().toString(36).slice(2, 10)].join("-");
  const res = await axios.post(`${wxServerUrl.replace(/\/$/, "")}${route}`, { appid: MINI_APPID, openid: nonce },
    { headers: { auth: wxAuth, "content-type": "application/json" }, timeout: 90000, validateStatus: () => true });
  const code = res.data?.code || res.data?.data?.code;
  if (res.status !== 200 || res.data?.status === false || !code) throw new Error(`${route}获取code失败: HTTP ${res.status} ${short(res.data)}`);
  return code;
}

async function loginByCode(account) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    $.log(`🔐 正在获取新code并登录${attempt > 1 ? `（第${attempt}次/切换取码策略）` : ""}...`);
    try {
      const code = await getWxCode(account, attempt);
      const res = await request("post", `${WXCLIENT_URL}/user/members:login`, "", { data: { code } });
      const token = getResponseToken(res.headers);
      if (res.status !== 200 || res.data?.code !== 200 || !token) throw new Error(`登录失败: HTTP ${res.status} ${short(res.data)}`);
      if (!(await validateToken(account, token))) throw new Error("登录响应token未通过会员接口验真");
      updateCachedToken(account, token);
      $.log(`✅ 登录成功且会员接口验真通过，已缓存token: ${maskToken(token)}`);
      return token;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  throw lastError || new Error("登录失败");
}

async function validateToken(account, token) {
  const res = await request("get", `${WXCLIENT_URL}/member/IndexInfo`, token, { account });
  const ok = res.status === 200 && res.data?.code === 200;
  if (!ok) $.log(`⚠️ 缓存token失效: HTTP ${res.status} ${short(res.data)}`);
  return ok;
}

async function getAccessToken(account) {
  const value = account.trim();
  if (isToken(value)) { $.log(`ℹ️ 检测到旧token变量，将直接使用: ${maskToken(value)}`); return value; }
  const cache = readCacheRaw();
  const cachedToken = cache[value]?.token;
  if (cachedToken) {
    $.log(`🔎 使用缓存token校验: ${maskToken(cachedToken)}`);
    if (await validateToken(value, cachedToken)) { $.log("✅ 缓存token有效"); return cachedToken; }
  }
  return loginByCode(value);
}

// ================== 业务发现/权威查（只读） ==================
// 返回：
//   { skip: true }                          — content=[] 合法空数组，视为活动不可用，成功跳过
//   { activity, signed }                    — 找到唯一 template=3 活动
// 抛 BizError：瞬态 retryable=1（5xx/HTML/坏 JSON/登录异常）；结构/语义 retryable=0（content 缺/错型/code≠200/非空无 template3）
async function discoverAndAuthoritative(account, token, onToken) {
  const res = await request("post", `${WXCLIENT_URL}/mkt/activities/locations:search`, token,
    { data: { locations: [0, 1, 2] }, account, onToken });
  if (typeof res.data === "string" || res.status === 0) {
    throw new BizError(`发现签到活动瞬态(HTML/网关): HTTP ${res.status}`, { retryable: true });
  }
  if (res.status !== 200 || !res.data || typeof res.data !== "object") {
    throw new BizError(`发现签到活动瞬态: HTTP ${res.status} ${short(res.data)}`, { retryable: true });
  }
  if (res.data?.code !== 200) {
    throw new BizError(`发现签到业务码异常: code=${res.data?.code} ${short(res.data)}`, { retryable: false });
  }
  if (!Array.isArray(res.data?.content)) {
    throw new BizError(`发现签到 content 结构异常(非数组): ${short(res.data)}`, { retryable: false });
  }
  const items = res.data.content;
  if (items.length === 0) {
    // 合法空数组 → 活动不可用，成功跳过（零写，不动 state）
    return { skip: true };
  }
  const unique = new Map();
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    if (Number(it?.templateType) !== 3 || !it?.activityId) continue;
    unique.set(String(it.activityId), it);
  }
  const activities = [...unique.values()];
  if (activities.length !== 1) {
    // 非空但无唯一 template=3：保守失败，不扩大成功
    throw new BizError(`非权威:模板3活动不唯一(实际${activities.length})，保守失败`, { retryable: false });
  }
  const activity = activities[0];
  const searchRes = await request("post", `${WXCLIENT_URL}/mkt/activities/sign:search`, token,
    { data: { activityId: activity.activityId }, account, onToken });
  if (typeof searchRes.data === "string" || searchRes.status === 0) {
    throw new BizError(`权威查瞬态(HTML): HTTP ${searchRes.status}`, { retryable: true });
  }
  if (searchRes.status !== 200 || !searchRes.data || typeof searchRes.data !== "object" || searchRes.data?.code !== 200) {
    throw new BizError(`权威查失败: HTTP ${searchRes.status} code=${searchRes.data?.code}`, { retryable: false });
  }
  const ss = searchRes.data?.content?.signStatus;
  if (ss !== 0 && ss !== 1) {
    throw new BizError(`权威查 signStatus 非法: ${short(searchRes.data?.content)}`, { retryable: false });
  }
  return { activity, signed: ss === 1 };
}

// ================== 主签到（带防重放状态机 + 同账号动作独占锁） ==================
// 同账号动作锁：openSync(wx) 独占创建；EEXIST → 他进程在跑本账号，零写不删锁。
function acctLock(account) {
  const h = crypto.createHash("sha1").update(String(account)).digest("hex").slice(0, 12);
  const f = path.join(path.dirname(WRITE_STATE_FILE), `aima_sign_${h}.lock`);
  let fd = null;
  try {
    fd = fs.openSync(f, "wx");
    fs.writeSync(fd, `pid=${process.pid}\n`);
    const rel = () => { try { if (fd !== null) fs.closeSync(fd); } catch (_) {} try { fs.unlinkSync(f); } catch (_) {} };
    return rel;
  } catch (e) {
    try { if (fd !== null) fs.closeSync(fd); } catch (_) {}
    return null; // EEXIST 或锁异常 → 他进程在跑，fail-closed 零写
  }
}

async function signIn(account, index) {
  const rel = acctLock(account);
  if (!rel) { $.log(`⚠️ 账号【${index}】他进程持同账号锁，本次零写不删`); throw new WriteUnknownError("他进程持锁，本进程零写收敛"); }
  try {
    return await signInLocked(account, index);
  } finally { rel(); }
}

async function signInLocked(account, index) {
  let freshLogin = false;
  let token;
  {
    const v = account.trim();
    if (isToken(v)) { token = v; }
    else {
      const cache = readCacheRaw();
      const cachedToken = cache[v]?.token;
      if (cachedToken && await validateToken(v, cachedToken)) { token = cachedToken; }
      else { token = await loginByCode(v); freshLogin = true; }
    }
  }
  const setToken = (t) => { token = t; };

  let discovery;
  try {
    discovery = await discoverAndAuthoritative(account, token, setToken);
  } catch (e) {
    // 结构/语义失败：不写 state（无 activityId 无法定位键）
    throw e;
  }
  if (discovery.skip) {
    // 合法空 content：成功跳过，零写，不动 state
    $.log(`⏭️ 账号【${index}】当前无可签到活动，本次成功跳过（未签到）`);
    return { skipped: true };
  }
  const activity = discovery.activity;
  const signed = discovery.signed;
  const activityId = activity.activityId;
  $.log(`🎯 账号【${index}】活动: ${activity.activityName || activity.name || "未命名"}（${activityId}）`);

  let st = stateFor(account, activityId);
  // Legacy key 迁移安全：读旧 account-only 键，不可借新键 fresh 写消除未知
  let legacy = null;
  try {
    const all = readStateAll();
    const l = all[String(account)];
    if (l && l.date === chinaToday()) legacy = l;
  } catch (_) {}
  if (legacy) {
    if (!st) {
      // 新键无记录：检查 legacy
      if (legacy.activityId && legacy.activityId === activityId) {
        // 旧 entry.activityId 与当前一致：视为同活动，合并沿用
        st = legacy;
        $.log(`♻️ 账号【${index}】沿用 legacy 同活动状态(${legacy.outcome})`);
      } else if (!legacy.activityId && (legacy.outcome === "unknown" || legacy.outcome === "attempting")) {
        // 旧 unknown 无 activityId：不可证无关，保守失败
        throw new BizError(`legacy 未知状态无 activityId，保守失败不借新键消除`, { retryable: false });
      }
      // legacy.activityId 明确不同 → 保留旧 entry，新活动独立进行
    }
  }
  if (st && st.outcome === "success") {
    $.log(`✅ 账号【${index}】今日已签到（活动 ${activityId}）`);
    return;
  }

  if (signed) {
    recordState(account, activityId, { outcome: "success", attempts: Number(st?.attempts || 0), authChecks: 0, lastAttemptAt: new Date().toISOString() });
    $.log(`✅ 账号【${index}】今日已签到（权威确认）`);
    return;
  }

  // 已有 unknown/attempting 残留（按 activityId 隔离）
  if (st && (st.outcome === "unknown" || st.outcome === "attempting")) {
    const last = Date.parse(st.lastAttemptAt || "") || 0;
    const attempts = Number(st.attempts || 0);
    // 重新登录 → 重置 authChecks（activityChanged 已由键隔离天然成立）
    if (freshLogin) {
      recordState(account, activityId, { authChecks: 1 });
      $.log(`🔄 账号【${index}】重新登录，authChecks 重算 1`);
      return;
    }
    let authChecks = Number(st.authChecks || 0) + 1;
    if (attempts >= HARD_TOTAL_WRITES) {
      recordState(account, activityId, { authChecks });
      $.log(`⛔ 账号【${index}】当日写已达硬上限${HARD_TOTAL_WRITES}，停止`);
      throw new WriteUnknownError(`当日写已达硬上限${HARD_TOTAL_WRITES}，只读收敛`);
    }
    if (Date.now() - last < COOLDOWN_MS) {
      recordState(account, activityId, { authChecks });
      $.log(`⏳ 账号【${index}】写后未知冷却中（${authChecks}/2 权威未签），只读等待`);
      throw new WriteUnknownError(`写后未知冷却中，只读收敛(${authChecks}/2)`);
    }
    if (authChecks < 2) {
      recordState(account, activityId, { authChecks });
      $.log(`👁️ 账号【${index}】冷却过但权威未签仅 ${authChecks}/2，本进程只读收敛`);
      throw new WriteUnknownError(`权威未签仅 ${authChecks}/2，只读收敛`);
    }
    $.log(`🔁 账号【${index}】冷却+连续两次权威未签，允许当日唯一恢复写`);
  } else if (st && st.outcome === "failed") {
    // 业务失败终态：不重放，只读收敛
    $.log(`⛔ 账号【${index}】前序业务失败，本进程不重写`);
    throw new WriteUnknownError("前序业务失败终态，只读收敛");
  } else {
    // 首次：authChecks 从 0 开始
    if (READ_ONLY) {
      $.log(`👁️ READ_ONLY=1，跳过 sign:join（权威未签但只读模式）`);
      return;
    }
    recordState(account, activityId, { outcome: "attempting", attempts: Number(st?.attempts || 0) + 1, authChecks: 0, lastAttemptAt: new Date().toISOString() });
    await doJoin(account, index, activityId, token, setToken, st);
    return;
  }

  if (READ_ONLY) {
    $.log(`👁️ READ_ONLY=1，跳过 sign:join`);
    return;
  }

  // 恢复写：attempts 已在 state 里，+1
  recordState(account, activityId, { outcome: "attempting", attempts: Number(st.attempts || 0) + 1, authChecks: 0, lastAttemptAt: new Date().toISOString() });
  await doJoin(account, index, activityId, token, setToken, st);
}

async function doJoin(account, index, activityId, token, setToken, st) {
  $.log(`⏳ 账号【${index}】正在签到...`);
  let joinRes;
  try {
    joinRes = await request("post", `${WXCLIENT_URL}/mkt/activities/sign:join`, token,
      { data: { activityId, activitySceneId: null }, account, onToken: setToken });
  } catch (e) {
    recordState(account, activityId, { outcome: "unknown", lastAttemptAt: new Date().toISOString() });
    throw new WriteUnknownError(`签到写出网异常，已置 unknown 只读收敛: ${e.message}`);
  }

  // 写后分类：5xx/HTML/坏 JSON → unknown retryable=0，绝不 failed 重放
  const raw = typeof joinRes.data === "string" ? joinRes.data : null;
  if (joinRes.status >= 500 || joinRes.status === 0 || raw) {
    recordState(account, activityId, { outcome: "unknown", lastAttemptAt: new Date().toISOString() });
    throw new WriteUnknownError(`签到写返回非预期(HTTP ${joinRes.status})，已置 unknown 只读收敛`);
  }
  if (joinRes.status !== 200 || !joinRes.data || typeof joinRes.data !== "object") {
    recordState(account, activityId, { outcome: "unknown", lastAttemptAt: new Date().toISOString() });
    throw new WriteUnknownError(`签到写响应非 JSON(HTTP ${joinRes.status})，已置 unknown 只读收敛`);
  }

  if (joinRes.data.code === 200) {
    let verifyRes;
    try {
      verifyRes = await request("post", `${WXCLIENT_URL}/mkt/activities/sign:search`, token,
        { data: { activityId }, account, onToken: setToken });
    } catch (e) {
      recordState(account, activityId, { outcome: "unknown", lastAttemptAt: new Date().toISOString() });
      throw new WriteUnknownError(`写后验求出网异常，已置 unknown: ${e.message}`);
    }
    const ss = verifyRes.data?.content?.signStatus;
    const verified = verifyRes.status === 200 && verifyRes.data?.code === 200 && ss === 1;
    if (!verified) {
      recordState(account, activityId, { outcome: "unknown", lastAttemptAt: new Date().toISOString() });
      throw new WriteUnknownError(`签到接口返回成功但后验未确认，已置 unknown 只读收敛`);
    }
    recordState(account, activityId, { outcome: "success", lastAttemptAt: new Date().toISOString() });
    const point = joinRes.data.content?.point || joinRes.data.content?.points || 0;
    $.log(`🎉 账号【${index}】签到成功且后验已签！${point ? `获得 ${point} 积分` : ""}`);
  } else if (typeof joinRes.data.code !== "number") {
    // 200 但无 code 字段 → 未知结构，unknown 不重放
    recordState(account, activityId, { outcome: "unknown", lastAttemptAt: new Date().toISOString() });
    throw new WriteUnknownError(`签到写响应缺 code 字段，未知结构只读收敛`);
  } else {
    const body = joinRes.data;
    recordState(account, activityId, { outcome: "failed", lastAttemptAt: new Date().toISOString() });
    const err = new BizError(`签到业务失败: HTTP ${joinRes.status} ${short(body)}`, { retryable: false, terminal: true });
    throw err;
  }
}

// ================== 主函数 ==================
!(async () => {
  console.log("\n🔔 爱玛会员俱乐部, 开始!" + (READ_ONLY ? " [READ_ONLY]" : ""));
  let accounts = [];
  if ($.isNode()) {
    const env = process.env.aima;
    if (env) accounts = env.split(/&|\n/).map((t) => t.trim()).filter(Boolean);
  }
  if (accounts.length === 0) {
    console.log("[QLRUN_RESULT] FAILURE reason=no-account retryable=0");
    process.exitCode = 1;
    $.done();
    return;
  }
  console.log(`共找到${accounts.length}个账号`);
  let success = 0, failed = 0, skipped = 0, retryable = false;
  for (let i = 0; i < accounts.length; i++) {
    try {
      console.log(`\n🚀 user:【${i + 1}】 start work`);
      const r = await signIn(accounts[i], i + 1);
      if (r && r.skipped) skipped++; else success++;
    } catch (e) {
      failed++;
      if (e && e.retryable === true) retryable = true;
      console.log(`❌ 账号【${i + 1}】执行失败: ${e.message}`);
    }
  }
  if (failed === 0) {
    if (skipped === accounts.length) {
      console.log(`[QLRUN_RESULT] SUCCESS reason=activity_unavailable skipped=${skipped}/${accounts.length}`);
    } else if (skipped > 0) {
      console.log(`[QLRUN_RESULT] SUCCESS core=${success}/${accounts.length} skipped=${skipped}`);
    } else {
      console.log(`[QLRUN_RESULT] SUCCESS core=${success}/${accounts.length}`);
    }
  } else {
    process.exitCode = 1;
    console.log(`[QLRUN_RESULT] FAILURE retryable=${retryable ? 1 : 0} core=${success}/${accounts.length} failed=${failed} skipped=${skipped}`);
  }
})()
  .catch((e) => {
    process.exitCode = 1;
    console.log(`[QLRUN_RESULT] FAILURE reason=entry-exception retryable=0`);
    console.log(e && e.message || e);
  })
  .finally(() => $.done());
