/*
------------------------------------------
@Author: sm
@Date: 2026.06.01
@Description: 五个女博士微信小程序签到
cron: 30 8 * * *
------------------------------------------
变量名：wugenvboshi
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
依赖变量：wx_server_url、wx_auth
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("五个女博士微信小程序签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");

const MINI_APP_ID = "wx271704a01704744b";
const KDT_ID = "44519665";
const USER_VERSION = "2.228.701";
const CLIENT_ID = "4d65249d377b2c3ed8";
const CLIENT_SECRET = "1cdc05151d64f3a4a6ebd0e9de64422a";
const GRANT_TYPE = "yz_union";
const API_BASE = "https://h5.youzan.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "wugenvboshi_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "wugenvboshi";

// —— 统一结构化结果与安全门控（与 tools/qlrun、tools/qlall.js 判定契约对齐）——
const SCRIPT_NAME = "wugenvboshi.js";
// YOUZAN_READ_ONLY=1：只做登录/查询等只读动作，禁止任何签到写请求，用于安全只读权威验证。
const YOUZAN_READ_ONLY = /^(1|true|yes|on)$/i.test(process.env.YOUZAN_READ_ONLY || "");

// 仅接受服务端明确布尔：true/false；其它（缺失/字符串非真/对象）一律归为 unknown，不据此写。
function normalizeIsShow(raw) {
    if (raw === true || raw === "true" || raw === 1) return true;
    if (raw === false || raw === "false" || raw === 0) return false;
    return null;
}

// 只读传输/5xx 瞬时错误才允许界内重试；业务码错误、鉴权错误不重试。
function isTransientReadError(error) {
    const message = String((error && error.message) || error || "");
    const code = error && error.code;
    if (code && ["ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "EAI_AGAIN", "EPIPE"].includes(code)) return true;
    return /timeout of \d+ ms exceeded|网络|服务器繁忙|系统繁忙|服务暂时不可用|HTTP 5\d\d/i.test(message);
}

function phaseSummary(list, key) {
    const counts = {};
    for (const item of list || []) {
        const v = item[key] || "unknown";
        counts[v] = (counts[v] || 0) + 1;
    }
    return counts;
}

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
    if (!token) return "";
    return token.length > 12 ? `${token.slice(0, 6)}***${token.slice(-6)}` : `${token.slice(0, 3)}***`;
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.openid = String(openid || "").trim();
        this.token = {};
        this.checkinId = "";
        // campaignVisible：null=状态未知（不写），true=服务端明确展示，false=服务端明确不展示
        this.campaignVisible = null;
        this.writeAttempted = false;
        this.summary = {
            index: this.index,
            login: "pending",
            showCheckin: "pending",
            checkin: "pending",
            points: "pending",
            wrote: false,
            ok: true,
            errors: [],
        };
    }

    async run() {
        const s = this.summary;
        const cached = this.getCachedToken();
        if (cached) {
            this.token = cached;
            $.log(`账号[${this.index}] 使用缓存token: ${maskToken(this.token.accessToken || this.token.access_token)}`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新code登录`);
            }
        }

        if (!this.token.accessToken && !this.token.access_token) {
            await this.loginByWxCode();
        }
        if (!this.token.accessToken && !this.token.access_token) {
            s.login = "fail";
            s.ok = false;
            s.errors.push("登录失败，未获取 token");
            return s;
        }
        s.login = "ok";

        await this.safePoints("签到前");
        await this.getCheckinInfo();
        await this.doCheckin();
        await this.safePoints("签到后");
        s.wrote = this.writeAttempted;
        return s;
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.token.accessToken && !this.token.access_token) return;
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

    get accessToken() {
        return this.token.accessToken || this.token.access_token || "";
    }

    get sessionId() {
        return this.token.sessionId || this.token.session_id || "";
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
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/142/page-frame.html`,
            "Extra-Data": this.buildExtraData(),
            "Accept": "application/json, text/plain, */*",
            ...extra,
        };
    }

    async request({ method = "GET", apiPath, query = {}, data = {}, skipToken = false }) {
        const oldToken = this.token;
        if (skipToken) this.token = {};
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
        $.log(`账号[${this.index}] ${label}: ${points}积分`);
        return data;
    }

    // 积分查询为非致命只读：失败只记录，不判定账号失败。
    async safePoints(label) {
        try {
            await this.getPoints(label);
            this.summary.points = "ok";
        } catch (e) {
            $.log(`账号[${this.index}] ${label}查询失败: ${e.message || e}`);
            this.summary.points = "error";
        }
    }

    async getCheckinInfo() {
        // 只读探测：仅传输/5xx 瞬时错误界内重试（最多3次），业务码/鉴权错误不重试。
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const data = await this.request({ apiPath: "wscump/checkin/show_checkin_page_v2.json" });
                this.checkinId = data?.checkinId || data?.checkin_id || "";
                this.campaignVisible = normalizeIsShow(data?.isShow);
                this.summary.showCheckin =
                    this.campaignVisible === false ? "hidden" : this.campaignVisible === true ? "shown" : "unknown";
                $.log(
                    `账号[${this.index}] 签到活动: checkinId=${this.checkinId || "未获取"} isShow=${this.campaignVisible} showPage=${data?.showPage}`
                );
                return data;
            } catch (e) {
                lastError = e;
                if (!isTransientReadError(e) || attempt === 3) break;
                await new Promise((r) => setTimeout(r, 1500 * attempt));
            }
        }
        $.log(`账号[${this.index}] 获取签到活动失败: ${lastError?.message || lastError}`);
        this.summary.showCheckin = "error";
        this.summary.ok = false;
        this.summary.errors.push(`showCheckin: ${lastError?.message || lastError}`);
        if (lastError && (lastError.code === -1 || lastError.code === 40010 || lastError.code === 40009 || /登录|token|access/i.test(String(lastError.message)))) {
            this.removeCachedToken();
        }
        return null;
    }

    async doCheckin() {
        // 核心门控：只有服务端明确 isShow===true 才允许发起 checkinV2 写请求。
        // isShow=false（活动未开启/当前无每日签到活动）或状态未知，一律不强制调用 checkinV2。
        if (this.campaignVisible !== true) {
            if (this.campaignVisible === false) {
                $.log(
                    `账号[${this.index}] 签到活动 isShow=false：活动未开启/当前无每日签到活动，no_action，跳过提交，不调用 checkinV2`
                );
                this.summary.checkin = "skipped_hidden";
            } else {
                $.log(`账号[${this.index}] 签到活动状态未知，安全起见不发起签到写请求`);
                this.summary.checkin = "skipped_unknown";
            }
            return;
        }
        if (!this.checkinId) {
            $.log(`账号[${this.index}] 活动已展示但未获取到签到活动，跳过`);
            this.summary.checkin = "skipped_no_id";
            return;
        }
        if (YOUZAN_READ_ONLY) {
            $.log(`账号[${this.index}] 只读模式(YOUZAN_READ_ONLY=1)：禁止签到写请求`);
            this.summary.checkin = "blocked_readonly";
            return;
        }
        // 写请求一旦尝试即置位；结果未知/失败都禁止外层整脚本重放。
        this.writeAttempted = true;
        try {
            const data = await this.request({
                apiPath: "wscump/checkin/checkinV2.json",
                query: { checkinId: this.checkinId },
            });
            const award = (data?.list || [])
                .map((item) => item?.infos?.title || item?.infos?.desc || "")
                .filter(Boolean)
                .join(", ");
            $.log(`账号[${this.index}] 签到成功: ${data?.desc || ""}${award ? ` ${award}` : ""}`);
            this.summary.checkin = "done";
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|已经签到|重复|今日.*签|参与次数/.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                this.summary.checkin = "already";
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            this.summary.checkin = "fail";
            this.summary.ok = false;
            this.summary.errors.push(`checkin: ${message}`);
            if (e.code === -1 || e.code === 40010 || e.code === 40009 || /登录|token|access/i.test(message)) this.removeCachedToken();
        }
    }
}

!(async () => {
    $.checkEnv(ckName);
    const summaries = [];
    for (const openid of $.userList) {
        summaries.push(await new Task(openid).run());
    }

    const accounts = summaries.length;
    const failed = summaries.filter((s) => !s.ok).length;
    const wrote = summaries.some((s) => s.wrote) ? 1 : 0;
    // 写请求一旦尝试/结果未知，retryable=0，禁止外层整脚本重放。
    const retryable = wrote === 0 && failed > 0 ? 1 : 0;
    const status = failed > 0 ? "FAILURE" : "SUCCESS";
    const reason =
        accounts === 0
            ? "no_accounts"
            : failed > 0
                ? summaries.flatMap((s) => s.errors).join("; ") || "failed"
                : "ok";
    const result = {
        script: SCRIPT_NAME,
        status,
        exitCode: failed > 0 ? 1 : 0,
        accounts,
        failed,
        wrote,
        retryable,
        phases: {
            login: phaseSummary(summaries, "login"),
            showCheckin: phaseSummary(summaries, "showCheckin"),
            checkin: phaseSummary(summaries, "checkin"),
            points: phaseSummary(summaries, "points"),
        },
        reason,
    };
    const head = status === "FAILURE" ? (retryable === 0 ? "FAILURE retryable=0" : "FAILURE") : "SUCCESS";
    console.log(`[QLRUN_RESULT] ${head} ${JSON.stringify(result)}`);
    try {
        await $.sendMsg();
    } catch (_) {
        console.log("通知失败；业务结果保持不变");
    }
    const secs = ((Date.now() - $.startTime) / 1000).toFixed(3);
    $.log(`🔔${$.name},结束!🕛 ${secs}秒`);
    process.exitCode = failed > 0 ? 1 : 0;
})()
    .catch((e) => {
        // 未捕获异常：确定性失败 retryable=0，且不回显可能含 token/code 的原始错误文本。
        console.log(
            `[QLRUN_RESULT] FAILURE retryable=0 ${JSON.stringify({
                script: SCRIPT_NAME,
                status: "FAILURE",
                exitCode: 1,
                reason: "unhandled_exception",
            })}`
        );
        process.exitCode = 1;
    });
