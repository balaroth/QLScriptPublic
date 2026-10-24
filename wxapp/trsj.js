'use strict';
/*
------------------------------------------
@Description: 甜润世界 - 微信小程序静默登录 + 每日签到(签到有奖[核心] + 石斛签到[可选])
cron: 5 9,12,20 * * *
------------------------------------------
变量名：trsj
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行分隔（可加 #备注）

依赖变量：
wx_server_url  默认 http://192.168.31.196:8787
wx_auth        必填，wx_server 鉴权值

可选开关（均有安全默认值，不配即保持原行为）：
TRSJ_READ_ONLY=1        只读验证：只登录+查询，不发起任何写请求（核心签到/播种/石斛签到/阅读上报均跳过）
TRSJ_MAX_RETRIES=2      只读(GET/幂等)请求最大重试次数 0..5，写请求不做请求层自动重试
TRSJ_HTTP_TIMEOUT=20000 请求超时毫秒 3000..60000
TRSJ_UNKNOWN_RETRY_AFTER_MS=1800000 核心写结果未知后至少等待多久，才允许最后一次恢复尝试（5分钟..12小时）
TRSJ_UNKNOWN_CONFIRM_DELAY_MS=3000 恢复前两次权威状态查询的间隔（1..30秒）
TRSJ_DENDRobium=0       关闭可选石斛模块（默认 1 开启；该模块成败不影响核心签到结论）

契约（appid wx210e40a77dbe7a27，host m.ahzyssl.com）：
（迁移自 YYB-GO 系脚本 TRSJ.py，原脚本已 code 登录，无签名/无手机号）

登录  GET /wx/user/appletLogin?code=<wx.login code>（无签名，UA 用 WMPF）
        -> code==200，data 即 applet_auth_token（后续所有请求放 Authorization 头，裸 token 非 Bearer）
验证  GET /applet/user/getUserBaseInfo -> code==200，data.userName（用来判定 ck 有效 / 未注册）
签到有奖(核心，决定成败)
  查询  GET  /applet/user/signIn/getUserSignInLog -> data.userSignInList[]{signInDate,signInStatus==1 表已签}
  签到  POST /applet/user/signIn -> code==200 成功（已签走 msg)
石斛签到(可选，best-effort，非致命，不影响核心结论)
  状态  GET  /applet/game/dendrobium/get -> code==200&data 已种植；code==500/msg含"没有正在培养" 未种植
  播种  GET  /applet/game/dendrobium/sowing （原脚本带作者个人 inviteUserId 邀请码，已剔除）
  查询  GET  /applet/game/dendrobium/signIn/getUserSignInLog -> data.todaySignInStatus
  签到  GET  /applet/game/dendrobium/signIn -> code==200 成功
  任务列表 GET /applet/game/dendrobium/task/list -> code==200 成功
  文章列表 GET /applet/game/dendrobium/article/list
  浏览  GET  /applet/game/dendrobium/article/completeRead -> code==200成功

安全约定：
- 只读/幂等 GET 在网络错误/超时/408/429/5xx 下有界重试；普通写请求只发起一次，结果未知(502/超时/断连)
  会先落盘并阻止外层整脚本重放。仅核心签到允许一次受控恢复：冷却期后连续两次权威查询均明确未签到，
  且状态落盘可靠时，才允许第二次也是最后一次写入；之后无论结果如何都不再自动发起。
- 核心签到成功(服务端记录或 code==200)才报 SUCCESS；502/失败/未知一律如实报 FAILURE，不伪装成功。
- 全程不输出 token / code / 手机号。
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const ckName = "trsj";
const MINI_APP_ID = "wx210e40a77dbe7a27";
const API_HOST = "https://m.ahzyssl.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "trsj_token_cache.json");
const WRITE_STATE_FILE = path.join(__dirname, "trsj_write_state.json");
const BUSINESS_UA =
    "Mozilla/5.0 (Linux; Android 14; PJE110) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/142.0.0.0 Mobile Safari/537.36 MiniProgramEnv/android";
const LOGIN_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 " +
    "Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

const EP_LOGIN = "/wx/user/appletLogin";
const EP_USERINFO = "/applet/user/getUserBaseInfo";
const EP_SIGN_LOG = "/applet/user/signIn/getUserSignInLog";
const EP_SIGN = "/applet/user/signIn";
const EP_DEN_GET = "/applet/game/dendrobium/get";
const EP_DEN_SOW = "/applet/game/dendrobium/sowing";
const EP_DEN_SIGN_LOG = "/applet/game/dendrobium/signIn/getUserSignInLog";
const EP_DEN_SIGN = "/applet/game/dendrobium/signIn";
const EP_DEN_TASK_LIST = "/applet/game/dendrobium/task/list";
const EP_DEN_ARTICLE_LIST = "/applet/game/dendrobium/article/list";
const EP_DEN_COMPLETEREAD = "/applet/game/dendrobium/article/completeRead";

const intEnv = (name, fallback, min, max) => {
    const v = Number.parseInt(process.env[name] || "", 10);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};
const boolEnv = (name, fallback = false) => {
    const v = process.env[name];
    if (v == null || v === "") return fallback;
    return /^(1|true|yes|on)$/i.test(v);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ApiError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "ApiError";
        Object.assign(this, details);
    }
}
class AuthExpiredError extends ApiError {}
class WriteUnknownError extends ApiError {}

function readJsonFile(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, "utf8")) || fallback;
    } catch (e) {
        return fallback;
    }
}
function writeJsonFile(file, obj) {
    const dir = path.dirname(file);
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, file);
        return true;
    } catch (e) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        return false;
    }
}
function parseAccount(raw = "") {
    const [id, remark] = String(raw).split("#").map((s) => (s || "").trim());
    return { openid: id, remark: remark || "" };
}
function short(v, n = 200) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}…` : t;
}
function chinaToday() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}
const AUTH_EXPIRED_RE = /未注册|未绑定|未激活|不存在|请先登录|登录已过期|登录失效|未登录|无权限|token\s*(?:invalid|expired)|invalid session|会话失效/;
const ALREADY_SIGNED_RE = /已签|签到过|重复|已完成/;
const TRANSIENT_STATUS = (s) => !s || s === 408 || s === 429 || s >= 500;

class Task {
    constructor(raw, options = {}) {
        this.account = parseAccount(raw);
        this.index = options.index ?? 1;
        this.logger = options.logger || console;
        this.wait = options.wait || sleep;
        this.http = options.http || axios;
        this.readOnly = options.readOnly ?? boolEnv("TRSJ_READ_ONLY", false);
        this.maxRetries = options.maxRetries ?? intEnv("TRSJ_MAX_RETRIES", 2, 0, 5);
        this.timeout = options.timeout || intEnv("TRSJ_HTTP_TIMEOUT", 20000, 3000, 60000);
        this.unknownRetryAfterMs = options.unknownRetryAfterMs ?? intEnv("TRSJ_UNKNOWN_RETRY_AFTER_MS", 1800000, 300000, 43200000);
        this.unknownConfirmDelayMs = options.unknownConfirmDelayMs ?? intEnv("TRSJ_UNKNOWN_CONFIRM_DELAY_MS", 3000, 1000, 30000);
        this.now = options.now || (() => Date.now());
        this.denEnabled = options.denEnabled ?? boolEnv("TRSJ_DENDRobium", true);
        this.tokenCacheFile = options.tokenCacheFile || TOKEN_CACHE_FILE;
        this.writeStateFile = options.writeStateFile || WRITE_STATE_FILE;
        this.wechat = options.wechat || new WeChatServer({
            url: process.env.wx_server_url || "http://192.168.31.196:8787",
            appid: MINI_APP_ID,
            auth: process.env.wx_auth || "",
        });
        this.token = "";
        this.unregistered = false;
        this.core = "pending"; // pending|already|success|readonly|failed|unknown
        this.writeAttempted = false;
        this.failures = [];
        this.optionalNotes = [];
    }

    log(text) {
        this.logger.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    warn(text) { this.logger.warn ? this.logger.warn(`账号[${this.index}] ${text}`) : this.log(text); }

    // 状态落盘：记录每个写动作当日 outcome=attempting|success|unknown，供重入防重复写
    _state() { return readJsonFile(this.writeStateFile, {}) || {}; }
    _saveState(s) { return writeJsonFile(this.writeStateFile, s); }
    _stateKey(action) { return `${this.account.openid}::${action}`; }
    stateFor(action) {
        const all = this._state();
        const key = this._stateKey(action);
        if (!all[key] || all[key].date !== chinaToday()) return { date: chinaToday(), outcome: null, attempts: 0 };
        const current = Object.assign({}, all[key]);
        current.attempts = Number(current.attempts || (current.outcome ? 1 : 0));
        return current;
    }
    stateTimeMs(st) {
        const parsed = Date.parse(st && st.lastAttemptAt || "");
        if (Number.isFinite(parsed)) return parsed;
        try { return fs.statSync(this.writeStateFile).mtimeMs; } catch (_) { return 0; }
    }
    recordState(action, entry) {
        const all = this._state();
        const key = this._stateKey(action);
        all[key] = Object.assign({ date: chinaToday() }, all[key] || {}, entry);
        if (!this._saveState(all)) throw new ApiError(`${action} 防重放状态落盘失败，已阻止写请求`, { statePersistFailed: true, retryable: false });
        const saved = this._state()[key];
        if (!saved || saved.date !== all[key].date || saved.outcome !== all[key].outcome || Number(saved.attempts || 0) !== Number(all[key].attempts || 0)) {
            throw new ApiError(`${action} 防重放状态回读校验失败，已阻止写请求`, { statePersistFailed: true, retryable: false });
        }
        return saved;
    }
    isSignedRecord(rec, today = chinaToday()) {
        return !!(rec && rec.code === 200 && (rec.data?.userSignInList || []).some((i) => i.signInDate === today && i.signInStatus === 1));
    }
    async authoritativeCoreStatusTwice(today) {
        const first = await this.call("GET", EP_SIGN_LOG, { idempotent: true });
        if (!first || first.code !== 200) return { confirmed: false, signed: false };
        if (this.isSignedRecord(first, today)) return { confirmed: true, signed: true };
        await this.wait(this.unknownConfirmDelayMs);
        const second = await this.call("GET", EP_SIGN_LOG, { idempotent: true });
        if (!second || second.code !== 200) return { confirmed: false, signed: false };
        return { confirmed: true, signed: this.isSignedRecord(second, today) };
    }

    // 统一请求：idempotent(GET/幂等) 才有界重试；写请求单次发起，transient 标记供上层判定未知
    async call(method, apiPath, { data, params, auth = true, idempotent = false } = {}) {
        const headers = {
            Host: "m.ahzyssl.com",
            Connection: "keep-alive",
            charset: "utf-8",
            "Content-Type": "application/json;charset=utf-8",
            "User-Agent": BUSINESS_UA,
            Referer: `https://servicewechat.com/${MINI_APP_ID}/page-frame.html`,
            Accept: "*/*",
        };
        if (auth && this.token) headers.Authorization = this.token;

        const attempts = idempotent ? this.maxRetries + 1 : 1;
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                const res = await this.http.request({
                    method, url: `${API_HOST}${apiPath}`, data, params, headers,
                    timeout: this.timeout, validateStatus: () => true,
                });
                const body = res.data;
                if (res.status !== 200 && !(body && typeof body === "object")) {
                    // 502 HTML / 网关错误等非 JSON 响应
                    const transient = TRANSIENT_STATUS(res.status);
                    const err = new ApiError(`${apiPath} HTTP ${res.status}: ${short(body)}`, {
                        httpStatus: res.status, endpoint: apiPath, transient, retryable: idempotent && transient,
                    });
                    if (idempotent && transient && attempt < attempts) {
                        lastError = err;
                        await this.wait(Math.min(3000, 300 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 150));
                        continue;
                    }
                    throw err;
                }
                if (body && (res.status === 401 || res.status === 403)) {
                    throw new AuthExpiredError(body.msg || `鉴权失败 HTTP ${res.status}`, { httpStatus: res.status });
                }
                return body;
            } catch (e) {
                lastError = e;
                if (e instanceof AuthExpiredError) throw e;
                const status = e.response && e.response.status;
                const transient = TRANSIENT_STATUS(status) || e.code === "ECONNABORTED" || e.code === "ETIMEDOUT" || /timeout|timeout of|502|Bad Gateway|network|ENOTFOUND|ECONNRESET|EAI_AGAIN/i.test(String(e.message || ""));
                e.transient = transient;
                e.endpoint = apiPath;
                const retryable = idempotent && transient && attempt < attempts;
                e.retryable = idempotent && transient;
                if (!retryable) throw e;
                this.warn(`只读请求暂时不可用，${attempt}/${attempts - 1} 后重试：${short(e.message)}`);
                await this.wait(Math.min(3000, 300 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 150));
            }
        }
        throw lastError || new ApiError(`${apiPath} 请求失败`);
    }

    async getCode() {
        const { data } = await this.wechat.getCode(this.account.openid);
        if (data && data.status === false) throw new ApiError(`wx_server 取code失败: ${data.message || short(data)}`);
        const code = data?.data?.code || data?.code;
        if (!code || typeof code !== "string") throw new ApiError("wx_server 未返回 code");
        return code;
    }

    async login() {
        const code = await this.getCode();
        const res = await this.http.request({
            method: "GET", url: `${API_HOST}${EP_LOGIN}`, params: { code },
            headers: {
                Host: "m.ahzyssl.com", "User-Agent": LOGIN_UA, Accept: "*/*",
                Referer: `https://servicewechat.com/${MINI_APP_ID}/page-frame.html`,
            },
            timeout: this.timeout, validateStatus: () => true,
        });
        const body = res.data || {};
        if (body.code === 200 && body.data) {
            this.token = String(body.data);
            const cache = readJsonFile(this.tokenCacheFile, {}) || {};
            cache[this.account.openid] = { token: this.token, updatedAt: new Date().toISOString() };
            writeJsonFile(this.tokenCacheFile, cache);
            this.log("登录成功");
            return;
        }
        const msg = body.msg || body.message || short(body);
        if (/未注册|未绑定|未激活|不存在|请先|注册/.test(String(msg))) {
            this.unregistered = true;
            throw new ApiError("NO_ACCOUNT:未注册甜润世界", { noAccount: true });
        }
        throw new ApiError(`登录失败(HTTP ${res.status}): ${msg}`, { authFail: true });
    }

    async verify() {
        try {
            const res = await this.call("GET", EP_USERINFO, { idempotent: true });
            if (res && res.code === 200 && res.data) {
                this.log(`ck 有效：${(res.data.userName || res.data.nickName || "用户")}`);
                this.unregistered = false;
                return true;
            }
            const msg = res?.msg || res?.message || short(res);
            if (AUTH_EXPIRED_RE.test(String(msg))) this.unregistered = true;
            this.log(`ck 验证异常：${short(res)}`);
            return false;
        } catch (e) {
            if (e instanceof AuthExpiredError) { this.unregistered = true; return false; }
            this.log(`ck 验证请求失败：${short(e.message)}`);
            return false;
        }
    }

    async ensureLogin() {
        const cached = (readJsonFile(this.tokenCacheFile, {}) || {})[this.account.openid] || {};
        if (!this.token && cached.token) {
            this.token = cached.token;
            if (await this.verify()) { this.log("使用缓存token"); return; }
            this.token = "";
        }
        if (!this.token) {
            await this.login();
            await this.verify();
        }
    }

    // 写动作默认仅一次。发请求前先持久化 attempting，避免进程在途退出造成无锁重放。
    // allowRecovery 仅供核心签到：状态机明确批准后允许第二次且最后一次尝试。
    async writeOnce(action, fn, { allowRecovery = false } = {}) {
        const st = this.stateFor(action);
        const attempts = Number(st.attempts || 0);
        if (st.outcome === "success") return { cached: true };
        if (st.outcome === "attempting" && !allowRecovery) {
            throw new WriteUnknownError(`${action} 此前请求可能仍在途或进程异常退出，按安全策略不再发起`);
        }
        if (st.outcome === "unknown" && !allowRecovery) {
            throw new WriteUnknownError(`${action} 今日此前结果未知，按安全策略不再重复发起，需核对服务端状态`);
        }
        if (st.outcome !== "failed" && attempts >= (allowRecovery ? 2 : 1)) {
            throw new WriteUnknownError(`${action} 今日已达到安全尝试上限，不再自动发起`);
        }
        const attemptNo = attempts + 1;
        const startedAt = new Date(this.now()).toISOString();
        this.recordState(action, { outcome: "attempting", attempts: attemptNo, lastAttemptAt: startedAt });
        this.writeAttempted = true;
        try {
            const result = await fn();
            const msg = result?.msg || result?.message || "";
            if (result && (result.code === 200 || ALREADY_SIGNED_RE.test(String(msg)))) {
                this.recordState(action, { outcome: "success", attempts: attemptNo, lastAttemptAt: startedAt, confirmedAt: new Date(this.now()).toISOString() });
            } else {
                this.recordState(action, { outcome: "failed", attempts: attemptNo, lastAttemptAt: startedAt });
            }
            return result;
        } catch (e) {
            if (e instanceof WriteUnknownError) throw e;
            if (e.transient) {
                try {
                    this.recordState(action, { outcome: "unknown", attempts: attemptNo, lastAttemptAt: startedAt });
                } catch (stateError) {
                    throw new WriteUnknownError(`${action} 写请求结果未知且状态更新失败，禁止自动重试：${short(stateError.message)}`);
                }
            } else {
                // 已收到确定业务响应，允许由上层解释；仍保留尝试次数审计。
                this.recordState(action, { outcome: "failed", attempts: attemptNo, lastAttemptAt: startedAt });
            }
            throw e;
        }
    }

    // —— 核心：签到有奖 ——
    async coreSignAward() {
        const rec = await this.call("GET", EP_SIGN_LOG, { idempotent: true });
        if (!rec || rec.code !== 200) {
            const msg = rec?.msg || rec?.message || short(rec);
            if (AUTH_EXPIRED_RE.test(String(msg))) this.unregistered = true;
            throw new ApiError(`查询签到有奖状态失败：${msg}`, { retryable: true });
        }
        const list = (rec.data && rec.data.userSignInList) || [];
        const today = chinaToday();
        if (this.isSignedRecord(rec, today)) {
            this.core = "already";
            const st = this.stateFor("coreSign");
            if (st.outcome && st.outcome !== "success") {
                this.recordState("coreSign", { outcome: "success", attempts: st.attempts, lastAttemptAt: st.lastAttemptAt, confirmedAt: new Date(this.now()).toISOString(), source: "authoritative-log" });
            }
            this.log("✅ 签到有奖：今日已签到（服务端记录）");
            return;
        }
        if (this.readOnly) {
            this.core = "readonly";
            this.log("只读模式：服务端今日无签到记录，未发起签到");
            return;
        }
        let recovery = false;
        const st = this.stateFor("coreSign");
        if (st.outcome === "attempting" || st.outcome === "unknown") {
            const attempts = Number(st.attempts || 1);
            const ageMs = this.now() - this.stateTimeMs(st);
            if (attempts >= 2) {
                this.core = "unknown";
                throw new WriteUnknownError("核心签到今日已完成两次安全尝试且结果未知，不再自动发起");
            }
            if (ageMs < this.unknownRetryAfterMs) {
                this.core = "unknown";
                const source = st.outcome === "attempting" ? "请求可能仍在途或进程异常退出" : "结果未知";
                throw new WriteUnknownError(`核心签到${source}，仍在冷却期（剩余约${Math.ceil((this.unknownRetryAfterMs - ageMs) / 60000)}分钟），未重复发起`);
            }
            const authority = await this.authoritativeCoreStatusTwice(today);
            if (!authority.confirmed) {
                this.core = "unknown";
                throw new WriteUnknownError("核心签到结果未知，权威状态未能连续确认，未重复发起");
            }
            if (authority.signed) {
                this.recordState("coreSign", { outcome: "success", attempts, lastAttemptAt: st.lastAttemptAt, confirmedAt: new Date(this.now()).toISOString(), source: "authoritative-log" });
                this.core = "already";
                this.log("✅ 签到有奖：未知写入已由服务端记录确认");
                return;
            }
            recovery = true;
            this.log("ℹ️ 核心签到：冷却期已过且两次权威查询均确认未签到，执行最后一次恢复尝试");
        } else if (st.outcome === "success") {
            this.core = "success";
            this.log("✅ 签到有奖：今日已签到（本日成功状态）");
            return;
        } else if (st.outcome === "failed") {
            this.log("ℹ️ 核心签到：此前收到明确失败响应，本次允许重新尝试，不按未知结果处理");
        }
        let doSign;
        try {
            doSign = await this.writeOnce("coreSign", () => this.call("POST", EP_SIGN, { data: {}, idempotent: false }), { allowRecovery: recovery });
            if (doSign && doSign.cached) {
                this.core = "success";
                this.log("✅ 签到有奖：今日已签到（本日已成功记录）");
                return;
            }
        } catch (e) {
            if (e.transient) {
                // 写已尝试但结果未知：有界轮询权威记录；能确认已签才算成功，绝不在本进程重发。
                let signed = false;
                for (const delay of [1000, 3000, 7000]) {
                    await this.wait(delay);
                    const recheck = await this.call("GET", EP_SIGN_LOG, { idempotent: true }).catch(() => null);
                    if (this.isSignedRecord(recheck, today)) { signed = true; break; }
                }
                if (signed) {
                    const current = this.stateFor("coreSign");
                    this.recordState("coreSign", { outcome: "success", attempts: current.attempts, lastAttemptAt: current.lastAttemptAt, confirmedAt: new Date(this.now()).toISOString(), source: "authoritative-log" });
                    this.core = "already";
                    this.log("✅ 签到有奖：写入后经服务端记录确认今日已签");
                    return;
                }
                this.core = "unknown";
                throw new WriteUnknownError(`核心签到第${recovery ? 2 : 1}次发起后结果未知（${short(e.message)}），未在本进程重复发起`);
            }
            throw e;
        }
        if (doSign && doSign.code === 200) {
            this.core = "success";
            this.log(`✅ 签到有奖：签到成功${doSign.msg ? `（${doSign.msg}）` : ""}`);
            return;
        }
        const msg = doSign?.msg || doSign?.message || short(doSign);
        if (ALREADY_SIGNED_RE.test(String(msg))) {
            this.core = "already";
            this.log(`✅ 签到有奖：今日已签到（${msg}）`);
            return;
        }
        this.core = "failed";
        throw new ApiError(`签到有奖失败：${msg}`, { retryable: false });
    }

    // —— 可选：石斛模块（成败不影响核心结论）——
    async dendrobiumModule() {
        if (!this.denEnabled) { this.optionalNotes.push("石斛模块已关闭"); return; }
        try {
            const info = await this.call("GET", EP_DEN_GET, { idempotent: true });
            let planted = !!(info && info.code === 200 && info.data);
            if (!planted && info && (info.code === 500 || /没有正在培养/.test(info.msg || ""))) {
                if (this.readOnly) {
                    this.optionalNotes.push("只读模式：未种植，跳过播种");
                } else {
                    try {
                        const sow = await this.writeOnce("denSow", () => this.call("GET", EP_DEN_SOW, { idempotent: false }));
                        planted = !!(sow && (sow.code === 200 || sow.cached));
                        this.log(planted ? "🌱 石斛播种成功" : `🌱 石斛播种未成功：${sow?.msg || short(sow)}`);
                    } catch (e) {
                        this.optionalNotes.push(`石斛播种未完成：${short(e.message)}`);
                    }
                }
            }
            const rec = await this.call("GET", EP_DEN_SIGN_LOG, { idempotent: true });
            if (rec && rec.data && rec.data.todaySignInStatus) {
                this.log("✅ 石斛签到：今日已签到");
            } else if (this.readOnly) {
                this.optionalNotes.push("只读模式：跳过石斛签到");
            } else {
                try {
                    const s = await this.writeOnce("denSign", () => this.call("GET", EP_DEN_SIGN, { idempotent: false }));
                    if (s && (s.code === 200 || s.cached)) {
                        this.log(`✅ 石斛签到：${s.cached ? "今日已签到（本日已成功记录）" : `签到成功${s.msg ? `（${s.msg}）` : ""}`}`);
                    } else if (ALREADY_SIGNED_RE.test(String(s?.msg || ""))) {
                        this.log(`✅ 石斛签到：今日已签到（${s.msg}）`);
                    } else {
                        this.optionalNotes.push(`石斛签到未完成：${s?.msg || short(s)}`);
                    }
                } catch (e) {
                    this.optionalNotes.push(`石斛签到未完成：${short(e.message)}`);
                }
            }
            // 可选：浏览任务（任务列表/文章列表/阅读上报均为可选，失败不影响核心）
            if (this.readOnly) { this.optionalNotes.push("只读模式：跳过石斛浏览任务"); return; }
            const taskList = await this.call("GET", EP_DEN_TASK_LIST, { idempotent: true }).catch(() => []);
            const tasks = Array.isArray(taskList) ? taskList : (taskList && Array.isArray(taskList.data) ? taskList.data : []);
            for (const task of tasks) {
                if (!task || !String(task.taskName || "").match(/浏览/)) continue;
                if (task.status != 0) { this.log(`ℹ️ 石斛任务：${task.taskName}，已完成`); continue; }
                this.log(`ℹ️ 石斛任务：${task.taskName}，未完成，开始阅读文章`);
                const articleRes = await this.call("GET", EP_DEN_ARTICLE_LIST, { idempotent: true }).catch((e) => {
                    this.optionalNotes.push(`石斛文章列表本次未获取：${short(e.message)}（不影响核心签到）`);
                    return null;
                });
                const articles = articleRes && articleRes.data && Array.isArray(articleRes.data.records) ? articleRes.data.records : [];
                if (!articles.length) { this.log("ℹ️ 没有可阅读的石斛文章"); continue; }
                this.log(`ℹ️ 开始石斛文章阅读，共 ${articles.length} 篇，计划阅读前 ${task.times} 篇`);
                for (let i = 0; i < (task.times || 0); i += 1) {
                    const article = articles[i];
                    if (!article) break;
                    this.log(`ℹ️ 阅读文章 ${i + 1}：${article.articleTitle || "未知标题"}`);
                    try {
                        if (article.articleUrl) {
                            await this.http.request({ method: "GET", url: article.articleUrl, headers: { Connection: "keep-alive" }, timeout: this.timeout, validateStatus: () => true });
                        }
                        await this.wait(3000 + Math.floor(Math.random() * 7000));
                        await this.writeOnce(`denRead:${i}`, () => this.call("GET", EP_DEN_COMPLETEREAD, { idempotent: false }));
                        this.log("✅ 石斛阅读已完成");
                    } catch (e) {
                        this.optionalNotes.push(`石斛阅读第${i + 1}篇未完成：${short(e.message)}`);
                    }
                    await this.wait(1000 + Math.floor(Math.random() * 2000));
                }
            }
        } catch (e) {
            this.optionalNotes.push(`石斛模块本次未执行：${short(e.message)}（不影响核心签到）`);
        }
    }

    async run() {
        if (!this.account.openid) {
            this.log("跳过：变量值里没有 openid");
            return { ok: true, core: "skipped", failures: [], optionalNotes: this.optionalNotes, writeAttempted: this.writeAttempted };
        }
        try {
            await this.ensureLogin();
            if (this.unregistered) {
                this.log("⚠️ 该微信号还没在甜润世界注册/激活会员，先在小程序里登录一次再跑");
                return { ok: true, core: "unregistered", failures: [], optionalNotes: this.optionalNotes, writeAttempted: this.writeAttempted };
            }
            await this.coreSignAward();
            await this.dendrobiumModule();
            const ok = this.core === "already" || this.core === "success" || this.core === "readonly";
            return { ok, core: this.core, failures: this.failures, optionalNotes: this.optionalNotes, writeAttempted: this.writeAttempted };
        } catch (e) {
            if (e.noAccount) {
                this.log("⚠️ 该微信号还没在甜润世界注册/激活会员，先在小程序里登录一次再跑");
                return { ok: true, core: "unregistered", failures: [], optionalNotes: this.optionalNotes, writeAttempted: this.writeAttempted };
            }
            const unknown = e instanceof WriteUnknownError || this.core === "unknown";
            this.failures.push(short(e.message));
            this.log(`${unknown ? "❗" : "❌"} ${short(e.message)}`);
            return {
                ok: false,
                core: this.core || (unknown ? "unknown" : "failed"),
                failures: this.failures,
                optionalNotes: this.optionalNotes,
                writeAttempted: this.writeAttempted,
                retryable: unknown ? 0 : (e.retryable ? 1 : 0),
            };
        }
    }
}

// 唯一结构化结果行 + 退出码映射（纯函数，便于测试）
function composeResult({ configured, accounts, failed, retryable, readOnly }) {
    if (!configured) {
        return { verdict: "SKIP", exitCode: 0, line: "[QLRUN_RESULT] SKIP reason=no_accounts configured=0" };
    }
    if (failed > 0) {
        return {
            verdict: "FAILURE", exitCode: 1,
            line: `[QLRUN_RESULT] FAILURE accounts=${accounts} failed=${failed} retryable=${retryable}`,
        };
    }
    return {
        verdict: "SUCCESS", exitCode: 0,
        line: `[QLRUN_RESULT] SUCCESS accounts=${accounts} failed=0 mode=${readOnly ? "只读" : "任务"}`,
    };
}

async function main() {
    const env = new Env("甜润世界签到");
    env.checkEnv(ckName);
    const readOnly = boolEnv("TRSJ_READ_ONLY", false);
    const accounts = env.userList || [];

    let failed = 0;
    let retryable = 0;
    const results = [];
    if (!accounts.length) {
        env.log("未找到变量 trsj 账号，本次按未配置跳过，不冒充业务成功");
    } else {
        for (let i = 0; i < accounts.length; i += 1) {
            const task = new Task(accounts[i], { index: i + 1, logger: env, readOnly });
            const r = await task.run();
            results.push(r);
            if (!r.ok) {
                failed += 1;
                retryable = Math.max(retryable, r.retryable || 0);
            }
            if (i < accounts.length - 1) await env.wait(1500, 3000);
        }
    }

    env.log(`执行汇总：账号=${accounts.length}，失败=${failed}，模式=${readOnly ? "只读" : "任务"}`);
    const result = composeResult({
        configured: accounts.length > 0,
        accounts: accounts.length, failed, retryable, readOnly,
    });
    console.log(result.line);

    await env.sendMsg();
    const seconds = ((Date.now() - env.startTime) / 1000).toFixed(3);
    env.log(`🔔${env.name},结束!🕛 ${seconds}秒`);
    process.exit(result.exitCode);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`甜润世界脚本未捕获异常：${short(e && e.message || e)}`);
        console.log("[QLRUN_RESULT] FAILURE accounts=0 failed=1 retryable=0");
        process.exit(1);
    });
}

module.exports = {
    API_HOST, MINI_APP_ID, EP_SIGN, EP_SIGN_LOG, EP_DEN_GET, EP_DEN_SIGN,
    ApiError, AuthExpiredError, WriteUnknownError, Task, parseAccount, chinaToday, composeResult,
};
