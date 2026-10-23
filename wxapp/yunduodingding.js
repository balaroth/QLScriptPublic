/*
------------------------------------------
@Author: sm
@Date: 2026.06.01
@Description: 云朵叮叮微信小程序签到
cron: 30 8 * * *
------------------------------------------
变量名：yunduodingding
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
依赖变量：wx_server_url、wx_auth
------------------------------------------
*/

const axios = require("axios");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const { Env } = require("../tools/env.js");
const $ = new Env("云朵叮叮微信小程序签到");

const SCRIPT_NAME = "yunduodingding.js";
const ckName = "yunduodingding";
const MINI_APP_ID = "wx5dbc7b1ca99bca9c";
const KDT_ID = "152281203";
const USER_VERSION = "2.213.1";
const CLIENT_ID = "4d65249d377b2c3ed8";
const CLIENT_SECRET = "1cdc05151d64f3a4a6ebd0e9de64422a";
const GRANT_TYPE = "yz_union";
const API_BASE = "https://h5.youzan.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "yunduodingding_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

function readTokenCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) {
        return {};
    }
}

function writeTokenCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function maskToken(token = "") {
    const value = String(token || "");
    return value ? `${value.slice(0, 6)}***${value.slice(-6)}` : "";
}

// —— 聚合结果：整脚本只输出一条 [QLRUN_RESULT]，写请求一旦尝试即禁止外层重放 ——
const summary = { accounts: 0, ok: 0, failed: 0, writeAttempted: false, retryable: true, rows: [] };

function safeShort(text, max = 160) {
    return String(text == null ? "" : text).replace(/[\r\n]+/g, " ").slice(0, max);
}

function emitResult(status, extra = {}) {
    const payload = {
        script: SCRIPT_NAME,
        status,
        retryable: status === "FAILURE" ? (summary.retryable && !summary.writeAttempted ? 1 : 0) : 0,
        accounts: `${summary.ok}/${summary.accounts}`,
        writeAttempted: summary.writeAttempted ? 1 : 0,
        ...extra,
    };
    // 结构化结果行；不含 token/code/手机号
    $.log(`[QLRUN_RESULT] ${status} ${JSON.stringify(payload)}`);
}

async function finish() {
    try { await $.sendMsg(); } catch (_) {}
    const secs = ((Date.now() - $.startTime) / 1000).toFixed(1);
    $.log(`🔔${$.name},结束!🕛 ${secs}秒`);
    process.exit(summary.failed > 0 ? 1 : 0);
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.openid = String(openid || "").trim();
        this.token = {};
        this.checkinId = "";
        this.isShow = undefined; // undefined=未知(页面接口未成功)，true/false=服务端权威结论
        this.writeAttempted = false;
        this.checkinOutcome = "";
        this.readFailed = false;
    }

    get accessToken() {
        return this.token.accessToken || this.token.access_token || "";
    }

    get sessionId() {
        return this.token.sessionId || this.token.session_id || "";
    }

    async run() {
        const outcome = { index: this.index, login: "unknown", checkin: "not_attempted", isShow: this.isShow, writeAttempted: false, hardFail: false, retryableFail: false, reason: "" };

        const cached = this.getCachedToken();
        if (cached) {
            this.token = cached;
            $.log(`账号[${this.index}] 使用缓存token: ${maskToken(this.accessToken)}`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新code登录`);
            }
        }

        if (!this.accessToken) {
            await this.loginByWxCode();
            if (!this.accessToken) {
                outcome.login = "failed";
                outcome.hardFail = true;
                outcome.retryableFail = true;
                outcome.reason = "login_failed";
                return outcome;
            }
            outcome.login = "relogin";
        } else {
            outcome.login = "ok";
        }

        await this.getPoints("签到前");
        await this.getCheckinInfo();
        await this.doCheckin();
        await this.getPoints("签到后");

        outcome.isShow = this.isShow;
        outcome.checkin = this.checkinOutcome || "not_attempted";
        outcome.writeAttempted = this.writeAttempted;
        // 写结果未知/已尝试时不允许外层整脚本重放
        if (this.writeAttempted) summary.retryable = false;
        if (this.readFailed && !this.writeAttempted) outcome.retryableFail = true;
        return outcome;
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.accessToken) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            ...this.token,
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        if (cache[this.openid]) {
            delete cache[this.openid];
            writeTokenCache(cache);
        }
        this.token = {};
    }

    buildExtraData() {
        return JSON.stringify({
            is_weapp: 1,
            sid: this.sessionId,
            version: USER_VERSION,
            client: "weapp",
            bizEnv: "wsc",
        });
    }

    buildUrl(apiPath, query = {}) {
        const pathname = apiPath.replace(/^\/+/, "");
        const params = querystring.stringify({
            store_id: "",
            app_id: MINI_APP_ID,
            kdt_id: KDT_ID,
            access_token: this.accessToken,
            ...query,
        });
        return `${API_BASE}/${pathname}?${params}`;
    }

    getHeaders(extra = {}) {
        return {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/64/page-frame.html`,
            "Extra-Data": this.buildExtraData(),
            "Accept": "application/json, text/plain, */*",
            ...extra,
        };
    }

    // 只读 GET 有界重试(最多2次)；写动作(write=true)只尝试一次，结果未知也不重放
    async request({ method = "GET", apiPath, query = {}, data = {}, skipToken = false, write = false }) {
        const maxAttempts = write ? 1 : 2;
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const oldToken = this.token;
            if (skipToken) this.token = {};
            try {
                const options = {
                    method,
                    url: this.buildUrl(apiPath, query),
                    headers: this.getHeaders(method === "POST" ? { "Content-Type": "application/json" } : {}),
                    timeout: 15000,
                    validateStatus: () => true,
                };
                if (method !== "GET") options.data = data;
                if (skipToken) this.token = oldToken;

                const { status, data: result } = await axios.request(options);
                if (status !== 200) throw new Error(`HTTP ${status}: ${typeof result === "string" ? result.slice(0, 200) : JSON.stringify(result)}`);
                if (!result || result.code !== 0) {
                    const err = new Error(result?.msg || result?.message || JSON.stringify(result));
                    err.code = result?.code;
                    throw err;
                }
                return result.data;
            } catch (e) {
                if (skipToken) this.token = oldToken;
                lastError = e;
                const msg = String(e.message || e);
                const transient = /timeout of|ECONN|ENOTFOUND|EAI_AGAIN|HTTP\s*5\d\d|429|网络|超时|稍后再试|系统繁忙/i.test(msg);
                if (write || !transient || attempt === maxAttempts) throw e;
                await new Promise((r) => setTimeout(r, 800 * attempt));
                $.log(`账号[${this.index}] 只读请求临时失败，${800 * attempt}ms 后重试(${attempt}/${maxAttempts - 1})`);
            }
        }
        throw lastError;
    }

    async getWxCode() {
        const wxServerUrl = process.env.wx_server_url;
        const wxAuth = process.env.wx_auth;
        if (!wxServerUrl || !wxAuth) throw new Error("未配置 wx_server_url 或 wx_auth");

        const { status, data } = await axios.post(
            `${wxServerUrl.replace(/\/$/, "")}/wx/getuserinfo`,
            { appid: MINI_APP_ID, openid: this.openid },
            {
                headers: {
                    auth: wxAuth,
                    "content-type": "application/json",
                },
                timeout: 15000,
                validateStatus: () => true,
            }
        );
        const code = data?.code || data?.data?.code;
        if (status !== 200 || !code) throw new Error(`wx_server 获取code失败: HTTP ${status} ${JSON.stringify(data)}`);
        return code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getWxCode();
            const data = await this.request({
                method: "POST",
                apiPath: "wscshop/weapp/authorize.json",
                skipToken: true,
                data: {
                    appId: MINI_APP_ID,
                    clientId: CLIENT_ID,
                    clientSecret: CLIENT_SECRET,
                    grantType: GRANT_TYPE,
                    code,
                },
            });
            this.token = data || {};
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: ${data?.nick_name || data?.nickName || ""} ${maskPhone(data?.mobile)}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getPoints("缓存校验");
            return true;
        } catch (e) {
            return false;
        }
    }

    async getPoints(label = "积分") {
        const data = await this.request({ apiPath: "wscump/integral/user_points.json" });
        const points = data?.current_points ?? data?.real_points ?? data?.total_points ?? "未知";
        $.log(`账号[${this.index}] ${label}: ${points}小云朵`);
        return data;
    }

    async getCheckinInfo() {
        try {
            const data = await this.request({ apiPath: "wscump/checkin/show_checkin_page_v2.json" });
            this.checkinId = data?.checkinId || data?.checkin_id || "";
            this.isShow = data?.isShow === true; // 仅在页面接口成功时记录权威布尔值
            $.log(`账号[${this.index}] 签到活动: checkinId=${this.checkinId || "未获取"} isShow=${this.isShow} showPage=${data?.showPage}`);
            return data;
        } catch (e) {
            this.readFailed = true;
            $.log(`账号[${this.index}] 获取签到活动失败: ${e.message || e}`);
            if (e.code === -1 || e.code === 40010 || e.code === 40009 || /登录|token|access/i.test(String(e.message || e))) this.removeCachedToken();
            return null;
        }
    }

    async doCheckin() {
        // 权威门控：服务端明确 isShow=false（活动未展示/未开启）时，禁止强制调用 checkinV2 写请求
        if (this.isShow === false) {
            this.checkinOutcome = "skipped_not_displayed";
            $.log(`账号[${this.index}] 当前无每日签到活动可展示(isShow=false)，按权威状态跳过，未发起签到写请求`);
            return;
        }
        // 页面状态未知(接口失败)时不冒险写；无 checkinId 也不写
        if (this.isShow !== true || !this.checkinId) {
            this.checkinOutcome = this.isShow === undefined ? "skipped_unknown" : "skipped_no_checkin";
            $.log(`账号[${this.index}] 签到状态未明确(${this.checkinOutcome})，按安全策略不发起签到写请求`);
            return;
        }
        // 以下为唯一写请求路径，只尝试一次
        this.writeAttempted = true;
        summary.writeAttempted = true;
        try {
            const data = await this.request({
                apiPath: "wscump/checkin/checkinV2.json",
                query: { checkinId: this.checkinId },
                write: true,
            });
            this.checkinOutcome = "signed";
            const award = (data?.list || [])
                .map((item) => item?.infos?.title || item?.infos?.desc || "")
                .filter(Boolean)
                .join(", ");
            $.log(`账号[${this.index}] 签到成功: ${data?.desc || ""}${award ? ` ${award}` : ""}`);
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|已经签到|重复|今日.*签|参与次数/.test(message)) {
                this.checkinOutcome = "already_signed";
                $.log(`账号[${this.index}] 今日已签到`);
                return;
            }
            this.checkinOutcome = "failed";
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (e.code === -1 || e.code === 40010 || e.code === 40009 || /登录|token|access/i.test(message)) this.removeCachedToken();
            throw new Error(message);
        }
    }
}

!(async () => {
    $.checkEnv(ckName);
    summary.accounts = $.userList.length;
    if (!$.userCount) {
        emitResult("SKIP", { reason: "no_accounts", configured: 0, phases: { checkinV2: "not_run" } });
        return finish();
    }
    for (const openid of $.userList) {
        let oc;
        try {
            oc = await new Task(openid).run();
        } catch (e) {
            oc = { index: summary.accounts, hardFail: true, retryableFail: !summary.writeAttempted, reason: safeShort(e.message || e), checkin: "failed" };
        }
        summary.rows.push(oc);
        if (oc.hardFail || oc.checkin === "failed") {
            summary.failed += 1;
            if (!oc.retryableFail) summary.retryable = false;
        } else {
            summary.ok += 1;
        }
    }

    if (summary.failed > 0) {
        emitResult("FAILURE", {
            reason: "account_failed",
            phases: { login: "attempted", show_checkin_page_v2: "read", checkinV2: summary.writeAttempted ? "attempted_once" : "skipped", points: "read" },
            rows: summary.rows.map((r) => ({ index: r.index, checkin: r.checkin, isShow: r.isShow, reason: r.reason || undefined })),
        });
    } else if (summary.rows.every((r) => r.checkin === "skipped_not_displayed")) {
        emitResult("SKIP", {
            reason: "activity_not_displayed",
            phases: { login: "ok", show_checkin_page_v2: "isShow=false", checkinV2: "skipped_not_displayed", points: "read" },
            rows: summary.rows.map((r) => ({ index: r.index, checkin: r.checkin, isShow: r.isShow })),
        });
    } else {
        emitResult("SUCCESS", {
            phases: { login: "ok", show_checkin_page_v2: "read", checkinV2: summary.writeAttempted ? "done" : "skipped", points: "read" },
            rows: summary.rows.map((r) => ({ index: r.index, checkin: r.checkin, isShow: r.isShow })),
        });
    }
})()
    .catch((e) => {
        summary.failed += 1;
        summary.retryable = !summary.writeAttempted;
        $.log(`运行异常: ${e.message || e}`);
        emitResult("FAILURE", { reason: "unhandled_exception", error: safeShort(e.message || e), phases: { checkinV2: summary.writeAttempted ? "attempted_once" : "not_run" } });
    })
    .finally(() => finish());
