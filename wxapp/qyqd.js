/*
------------------------------------------
@Description: 期云积签兑 - 微信小程序静默登录 + 每日签到
cron: 36 8 * * *
------------------------------------------
变量名：qyqd
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行分隔（可加 #备注）

依赖变量：
wx_server_url  默认 http://192.168.31.196:8787
wx_auth        必填，wx_server 鉴权值
------------------------------------------
契约（appid wx958515f1809b73c0，host api.jiqiandui.cn/api/v1）：
  登录  POST /auth/wechat-login  {code} -> code===0 && data.token
  资料  GET  /user/info
  状态  GET  /signin/status
  签到  POST /signin/do {}

可靠性约束：
  1. GET 和其他只读请求遇瞬时网络错误可安全重试。
  2. 签到 POST 不盲目重放；超时后必须用 /signin/status 回查服务端状态。
  3. 只有服务端确认 today_signed=true 才判定签到成功。
  4. 输出结构化 [QLRUN_RESULT]，由 qlrun/qlall 统一判定、重试和通知。
  5. 广告任务与抽奖故意不做：看广告类按规则不绕。
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("期云积签兑");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const ckName = "qyqd";
const MINI_APP_ID = "wx958515f1809b73c0";
const BASE = "https://api.jiqiandui.cn/api/v1";
const TOKEN_CACHE_FILE = path.join(__dirname, "qyqd_token_cache.json");
const REQUEST_TIMEOUT_MS = 15000;
const READ_ATTEMPTS = 3;
const LOGIN_ATTEMPTS = 2;
const EP_LOGIN = "/auth/wechat-login";
const EP_SIGN = "/signin/do";
const EP_STATUS = "/signin/status";
const EP_USER = "/user/info";
const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 12; M2012K11AC Build/SKQ1.220303.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Version/4.0 Chrome/134.0.6998.136 Mobile Safari/537.36 MicroMessenger/8.0.49 MiniProgramEnv/android";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://192.168.31.196:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (_) {
        return {};
    }
}

function writeCache(cache) {
    const tmp = `${TOKEN_CACHE_FILE}.tmp-${process.pid}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, TOKEN_CACHE_FILE);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function parseAccount(raw = "") {
    const [id, remark] = String(raw).split("#").map((s) => (s || "").trim());
    return { openid: id, remark: remark || "" };
}

function short(v, n = 200) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}

function form(obj) {
    return Object.entries(obj)
        .map(([k, v]) => `${k}=${encodeURIComponent(v === undefined || v === null ? "" : v)}`)
        .join("&");
}

const isOk = (res) => Number(res?.code) === 0;
const msgOf = (res) => res?.message || res?.msg || short(res);
const isAlreadyDone = (t) => /已签|已经签|签到过|重复|已完成|already/i.test(String(t || ""));
const isAuthError = (t) => /登录|token|未授权|未登录|失效|过期|重新|401/i.test(String(t || ""));
const isNotRegistered = (t) => /未注册|未绑定|请先注册|请先绑定|not regist/i.test(String(t || ""));

function isTransientError(err) {
    const code = String(err?.code || "").toUpperCase();
    const status = Number(err?.response?.status || err?.httpStatus || 0);
    return ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "ECONNREFUSED"].includes(code)
        || status === 408 || status === 425 || status === 429 || status >= 500
        || /timeout|timed out|socket hang up|network error/i.test(String(err?.message || err || ""));
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.token = "";
        this.failureRetryable = true;
        this.deviceId = "d_" + crypto.createHash("md5")
            .update(String(this.account.openid || raw)).digest("hex").slice(0, 16);
    }

    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }

    async request(apiPath, body = null, withAuth = true, method = "POST", query = null, options = {}) {
        const isGet = String(method).toUpperCase() === "GET";
        const attempts = Number(options.attempts || (isGet ? READ_ATTEMPTS : 1));
        const payload = body || {};
        const qs = query ? form(query) : (isGet && Object.keys(payload).length ? form(payload) : "");
        const headers = {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            Referer: `https://servicewechat.com/${MINI_APP_ID}/0/page-frame.html`,
            Accept: "application/json, text/plain, */*",
            xweb_xhr: "1",
            "X-Client-Type": "miniprogram",
            "X-Platform-Type": "wechat",
            "X-Device-ID": this.deviceId,
            ...(options.headers || {}),
        };
        if (withAuth && this.token) headers.Authorization = `Bearer ${this.token}`;

        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                const res = await axios.request({
                    method: isGet ? "GET" : "POST",
                    url: `${BASE}${apiPath}${qs ? `?${qs}` : ""}`,
                    data: isGet ? undefined : payload,
                    headers,
                    timeout: Number(options.timeout || REQUEST_TIMEOUT_MS),
                    validateStatus: () => true,
                });
                if (res.status >= 200 && res.status < 300) return res.data;
                if (res.data && typeof res.data === "object" && res.status < 500 && res.status !== 429) return res.data;
                const e = new Error(`${apiPath} HTTP ${res.status}: ${short(res.data)}`);
                e.httpStatus = res.status;
                e.response = res;
                throw e;
            } catch (e) {
                lastError = e;
                if (attempt >= attempts || !isTransientError(e)) throw e;
                this.log(`${apiPath} 瞬时请求失败（${attempt}/${attempts}）：${e.code || e.message}，准备重试`);
                await wait(600 * attempt + Math.floor(Math.random() * 300));
            }
        }
        throw lastError;
    }

    async getCode() {
        const { data } = await wechat.getCode(this.account.openid);
        if (data && data.status === false) throw new Error(`wx_server 取code失败: ${data.message || short(data)}`);
        const code = data?.data?.code || data?.code;
        if (!code || typeof code !== "string") throw new Error(`wx_server 未返回 code: ${short(data)}`);
        return code;
    }

    async login() {
        let lastError;
        for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt++) {
            try {
                const code = await this.getCode();
                const res = await this.request(EP_LOGIN, { code }, false, "POST");
                if (!isOk(res)) throw new Error(`登录失败: ${msgOf(res)}`);
                this.token = (res.data || {}).token || "";
                if (!this.token) throw new Error(`登录未返回 token: ${short(res)}`);
                const cache = readCache();
                cache[this.account.openid] = { token: this.token, updatedAt: new Date().toISOString() };
                writeCache(cache);
                this.log("登录成功");
                return;
            } catch (e) {
                lastError = e;
                if (attempt >= LOGIN_ATTEMPTS || !isTransientError(e)) throw e;
                this.log(`登录交换瞬时失败（${attempt}/${LOGIN_ATTEMPTS}），重新取code后重试`);
                await wait(900 * attempt);
            }
        }
        throw lastError;
    }

    async ensureLogin() {
        const cached = readCache()[this.account.openid] || {};
        if (!this.token && cached.token) {
            this.token = cached.token;
            const valid = await this.queryUser(false);
            if (valid) {
                this.log("使用缓存token");
                return;
            }
            this.log("缓存token失效，重新登录");
            this.token = "";
        }
        if (!this.token) await this.login();
    }

    async queryUser(needLog = true) {
        const res = await this.request(EP_USER, {}, true, "GET");
        if (!isOk(res)) {
            if (needLog) this.log(`读取资料失败: ${msgOf(res)}`);
            return false;
        }
        const d = res.data || res.datas || res.body || res || {};
        if (needLog) {
            const bits = [];
            for (const k of ["nickname", "nickName", "name", "memberId", "integral", "points", "point", "score", "credits", "balance", "coin", "amount"]) {
                if (d[k] !== undefined && d[k] !== null && d[k] !== "") bits.push(`${k}=${d[k]}`);
            }
            this.log(`会员: ${bits.join(" ") || short(d, 120)}`);
        }
        return true;
    }

    async querySignStatus(needLog = false) {
        const res = await this.request(EP_STATUS, {}, true, "GET");
        if (!isOk(res)) {
            if (isAuthError(msgOf(res))) return { authInvalid: true, raw: res };
            throw new Error(`签到状态查询失败: ${msgOf(res)}`);
        }
        const d = res.data || {};
        if (needLog) this.log(`签到状态: today_signed=${Boolean(d.today_signed)} continuous_days=${d.continuous_days ?? "?"} reward=${d.today_reward ?? "?"}`);
        return { signed: Boolean(d.today_signed), data: d, raw: res };
    }

    async verifySigned(context) {
        const status = await this.querySignStatus(false);
        if (status.authInvalid) throw new Error(`${context}：会话已失效`);
        if (!status.signed) throw new Error(`${context}：服务端状态仍为未签到`);
        const reward = status.data?.today_reward;
        this.log(`✅ ${context}（服务端状态确认）${reward !== undefined ? `，奖励 ${reward} 积分` : ""}`);
        return true;
    }

    async sign(allowRelogin = true) {
        const before = await this.querySignStatus(false);
        if (before.authInvalid) {
            if (!allowRelogin) throw new Error("签到前会话仍无效");
            this.log("会话失效，重新登录后重试");
            this.token = "";
            await this.login();
            return this.sign(false);
        }
        if (before.signed) {
            this.log("✅ 今日已签到（服务端状态确认）");
            return true;
        }

        let res;
        try {
            // 不可幂等写操作只发一次。若超时，走状态回查，禁止盲目重放。
            res = await this.request(EP_SIGN, {}, true, "POST");
        } catch (e) {
            if (!isTransientError(e)) throw e;
            this.log(`签到请求结果未知（${e.code || e.message}），正在回查服务端状态`);
            return this.verifySigned("签到成功");
        }

        if (isOk(res) || isAlreadyDone(msgOf(res))) return this.verifySigned(isAlreadyDone(msgOf(res)) ? "今日已签到" : "签到成功");
        if (isNotRegistered(msgOf(res))) {
            this.failureRetryable = false;
            throw new Error(`${msgOf(res)}；该微信号尚未注册/绑定会员`);
        }
        if (allowRelogin && isAuthError(msgOf(res))) {
            this.log("会话失效，重新登录后重试");
            this.token = "";
            await this.login();
            return this.sign(false);
        }
        throw new Error(`签到失败: ${msgOf(res)}`);
    }

    async run() {
        if (!this.account.openid) {
            this.failureRetryable = false;
            this.log("执行失败: 变量值里没有 openid");
            return { ok: false, retryable: false, reason: "missing_openid" };
        }
        try {
            await this.ensureLogin();
            await this.queryUser(true);
            await this.sign(true);
            return { ok: true, retryable: false, reason: "signed_verified" };
        } catch (e) {
            const retryable = this.failureRetryable && (isTransientError(e) || !/未注册|未绑定|没有 openid/i.test(String(e.message || e)));
            this.log(`执行失败: ${e.message || e}`);
            return { ok: false, retryable, reason: String(e.message || e) };
        }
    }
}

async function main() {
    $.checkEnv(ckName);
    if (!$.userCount) {
        $.log(`未找到变量 ${ckName}`);
        $.log("[QLRUN_RESULT] FAILURE retryable=0 reason=missing_env");
        process.exitCode = 1;
        return;
    }

    const results = [];
    for (let i = 0; i < $.userList.length; i++) {
        results.push(await new Task($.userList[i]).run());
        if (i < $.userList.length - 1) await $.wait(1500, 3000);
    }
    const failed = results.filter((x) => !x.ok);
    if (!failed.length) {
        $.log(`[QLRUN_RESULT] SUCCESS core=${results.length}/${results.length} reason=qyqd_sign_verified`);
        return;
    }
    const retryable = failed.some((x) => x.retryable) ? 1 : 0;
    $.log(`[QLRUN_RESULT] FAILURE retryable=${retryable} failed=${failed.length}/${results.length} reason=qyqd_account_failed`);
    process.exitCode = 1;
}

if (require.main === module) {
    main()
        .catch((e) => {
            $.log(`运行失败: ${e.message || e}`);
            $.log(`[QLRUN_RESULT] FAILURE retryable=${isTransientError(e) ? 1 : 0} reason=qyqd_main_failed`);
            process.exitCode = 1;
        })
        .finally(() => $.done());
}

module.exports = {
    Task,
    isAlreadyDone,
    isAuthError,
    isNotRegistered,
    isOk,
    isTransientError,
    msgOf,
    parseAccount,
};
