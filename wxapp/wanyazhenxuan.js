/*
------------------------------------------
@Author: sm
@Date: 2026.08.16
@Description: 丸丫甄选（有赞微商城）每日签到得积分
cron: 18 8 * * *
------------------------------------------
变量名：wyzx
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
依赖变量：wx_server_url、wx_auth
------------------------------------------
接口契约（h5.youzan.com，有赞 SaaS 通用签到，与本仓库 yz19.js 同一套）：
  静默登录 POST /wscshop/weapp/authorize.json  {appId, clientBiz, code}
        -> {accessToken|access_token, sessionId, kdtId, ...}
  签到活动 GET  /wscump/checkin/show_checkin_page_v2.json -> {checkinId, isShow}
  执行签到 GET  /wscump/checkin/checkinV2.json?checkinId=<id>
        -> {desc, list[{infos:{title}}]}；重复签到报「已达最大参与次数」
  积分余额 GET  /wscump/integral/user_points.json -> {current_points|real_points}
  公共 query：app_id / kdt_id / access_token；公共头：Extra-Data(sid/version/...)
  统一响应：code==0 成功，否则 msg 为错误原因
------------------------------------------
常量来源（反编译 wx35322299c6492f6e 主包）：
  app-config.json /ext -> kdtId=100939936、userVersion=2.219.11.101
  app.js  authorize.json（静默登录，登录失败码 135000025/160210092 会重试）
  app.js / c.js  wscump/integral/user_points.json（getPoints）
说明：签到页 packages/ump/sign-in/index 等均在分包内，smallcat 的
  /wx/downloadurl 按文档只返回主包（参数仅 openid/appid/version_type），
  分包 js 解包后为空壳。故签到接口不是从该小程序分包里读出来的，而是沿用
  本仓库已验证可用的有赞通用签到契约（wxapp/yz19.js、yz9d.js），并已在主包中
  确认 authorize.json 与 user_points.json 存在，接口族一致，未做接口盲猜。
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("丸丫甄选签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const MINI_APP_ID = "wx35322299c6492f6e";
const CLIENT_BIZ = "weapp_wsc";
const KDT_ID = "100939936";
const USER_VERSION = "2.219.11.101";
const PAGE_VERSION = "0"; // Referer 里的版本号，仅用于伪装来源，不参与校验
const API_BASE = "https://h5.youzan.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "wanyazhenxuan_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

const ckName = "wyzx";
const WX_SERVER_URL = (process.env.wx_server_url || "http://192.168.31.196:8787").replace(/\/$/, "");
const WX_AUTH = process.env.wx_auth || "";

// —— 统一结构化结果与安全门控（与 tools/qlrun、tools/qlall.js 判定契约对齐）——
const SCRIPT_NAME = "wanyazhenxuan.js";
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

function short(value, max = 200) {
    if (value === undefined || value === null) return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
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

function pickToken(data = {}) {
    return data.accessToken || data.access_token || "";
}

function isTokenError(message) {
    return /access_token|token|登录|invalid session|session/i.test(String(message || ""));
}

function isRepeatCheckin(message) {
    return /已达最大参与次数|已签到|重复签到|今日已参与|已经签到/.test(String(message || ""));
}

// smallcat 偶发 "获取失败"(运行时会话抖动)：刷新会话后间隔重试，最多 4 次
async function getWxCode(openid) {
    if (!WX_AUTH) throw new Error("未配置 wx_auth");
    const headers = { auth: WX_AUTH, "Content-Type": "application/json" };
    const body = { appid: MINI_APP_ID, openid };
    let lastMsg = "";
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) {
            try {
                await axios.request({
                    method: "POST",
                    url: `${WX_SERVER_URL}/wx/refresh`,
                    headers,
                    data: body,
                    timeout: 30000,
                    validateStatus: () => true,
                });
            } catch (e) {
                // 刷新失败不阻断，继续重试取 code
            }
            await new Promise((r) => setTimeout(r, 3000));
        }
        const { status, data } = await axios.request({
            method: "POST",
            url: `${WX_SERVER_URL}/wx/code`,
            headers,
            data: body,
            timeout: 30000,
            validateStatus: () => true,
        });
        if (data && data.status === false) {
            lastMsg = data.message || "获取失败";
            continue;
        }
        const code = data?.code || data?.data?.code;
        if (status === 200 && code) return code;
        lastMsg = `HTTP ${status}: ${short(data)}`;
    }
    throw new Error(`获取code失败(已重试): ${lastMsg}`);
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.openid = String(openid || "").trim();
        this.token = "";
        this.sessionId = "";
        this.cookie = "";
        this.kdtId = KDT_ID;
        this.userInfo = {};
        this.checkinId = "";
        this.isShow = false;
        // campaignVisible：null=状态未知（不写），true=服务端明确展示，false=服务端明确不展示
        this.campaignVisible = null;
        this.signedBefore = false;
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
            this.applyToken(cached);
            $.log(`账号[${this.index}] 使用缓存token`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
            }
        }

        if (!this.token) {
            await this.loginByWxCode();
            if (!this.token) {
                s.login = "fail";
                s.ok = false;
                s.errors.push("登录失败，未获取 token");
                return s;
            }
        }
        s.login = "ok";

        await this.showCheckinPage();
        await this.doCheckin();
        await this.getPoints();
        s.wrote = this.writeAttempted;
        return s;
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.token) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            accessToken: this.token,
            sessionId: this.sessionId,
            kdtId: this.kdtId,
            cookie: this.cookie,
            mobile: this.userInfo.mobile || "",
            nickName: this.userInfo.nick_name || this.userInfo.nickName || "",
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
        this.token = "";
        this.sessionId = "";
        this.cookie = "";
    }

    applyToken(data = {}) {
        this.token = pickToken(data);
        this.sessionId = data.sessionId || data.session_id || "";
        this.kdtId = String(data.kdtId || data.kdt_id || KDT_ID);
        // 登录响应本身不带 cookie 字段，此时不要覆盖 request() 从 Set-Cookie 抓到的值
        if (data.cookie) this.cookie = data.cookie;
    }

    getHeaders(extra = {}) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Accept": "*/*",
            "Extra-Data": JSON.stringify({
                sid: this.sessionId || "",
                version: USER_VERSION,
                clientType: "weapp-miniprogram",
                client: "weapp",
                bizEnv: "wsc",
            }),
            ...extra,
        };
        if (this.cookie) headers.Cookie = this.cookie;
        return headers;
    }

    getBaseParams(params = {}) {
        return {
            app_id: MINI_APP_ID,
            kdt_id: this.kdtId,
            access_token: this.token,
            ...params,
        };
    }

    async request({ method = "GET", path: apiPath, params = {}, data = {}, skipToken = false }) {
        const options = {
            method,
            url: `${API_BASE}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`,
            headers: this.getHeaders(method === "POST" ? { "Content-Type": "application/json" } : {}),
            timeout: 15000,
            validateStatus: () => true,
        };
        options.params = skipToken ? params : this.getBaseParams(params);
        if (method !== "GET") options.data = data;

        const { data: result, status, headers } = await axios.request(options);
        if (headers && headers["set-cookie"]) {
            this.cookie = headers["set-cookie"].map((item) => item.split(";")[0]).join("; ");
        }
        if (status !== 200) throw new Error(`HTTP ${status}: ${short(result)}`);
        if (!result || result.code !== 0) throw new Error(result?.msg || short(result));
        return result.data;
    }

    async loginByWxCode() {
        try {
            const code = await getWxCode(this.openid);
            const data = await this.request({
                method: "POST",
                path: "/wscshop/weapp/authorize.json",
                skipToken: true,
                data: {
                    appId: MINI_APP_ID,
                    clientBiz: CLIENT_BIZ,
                    code,
                },
            });
            this.applyToken(data);
            this.userInfo = data || {};
            if (!this.token) throw new Error(`登录响应未包含 accessToken: ${short(data)}`);
            this.saveCachedToken();
            $.log(
                `账号[${this.index}] 登录成功: ${data.nick_name || data.nickName || ""} ${maskPhone(data.mobile) || ""}`
            );
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.request({ path: "/wscump/integral/user_points.json" });
            return true;
        } catch (e) {
            return false;
        }
    }

    async showCheckinPage() {
        // 只读探测：仅传输/5xx 瞬时错误界内重试（最多3次），业务码/鉴权错误不重试。
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const data = await this.request({ path: "/wscump/checkin/show_checkin_page_v2.json" });
                this.checkinId = data?.checkinId || "";
                this.campaignVisible = normalizeIsShow(data?.isShow);
                this.isShow = this.campaignVisible === true;
                // 幂等预检：仅当服务端明确给出「今日已签」标记时才跳过提交
                this.signedBefore =
                    data?.todayCheckin === true || data?.isCheckin === true || data?.hasCheckinToday === true;
                this.summary.showCheckin =
                    this.campaignVisible === false ? "hidden" : this.campaignVisible === true ? "shown" : "unknown";
                $.log(
                    `账号[${this.index}] 签到活动: checkinId=${this.checkinId || "未获取"} isShow=${this.campaignVisible}` +
                        (this.signedBefore ? " 今日已签" : "")
                );
                return;
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
        if (isTokenError(lastError?.message || lastError)) this.removeCachedToken();
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
            $.log(`账号[${this.index}] 活动已展示但未获取到 checkinId，跳过签到`);
            this.summary.checkin = "skipped_no_id";
            return;
        }
        if (this.signedBefore) {
            $.log(`账号[${this.index}] 今日已签到，跳过提交`);
            this.summary.checkin = "already";
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
                path: "/wscump/checkin/checkinV2.json",
                params: { checkinId: this.checkinId },
            });
            const awards = (data?.list || [])
                .map((item) => item?.infos?.title)
                .filter(Boolean)
                .join(", ");
            $.log(`账号[${this.index}] 签到成功: ${data?.desc || ""}${awards ? ` ${awards}` : ""}`);
            this.summary.checkin = "done";
        } catch (e) {
            const message = String(e.message || e);
            if (isRepeatCheckin(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                this.summary.checkin = "already";
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            this.summary.checkin = "fail";
            this.summary.ok = false;
            this.summary.errors.push(`checkin: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }

    async getPoints() {
        try {
            const data = await this.request({ path: "/wscump/integral/user_points.json" });
            $.log(`账号[${this.index}] 当前积分: ${data?.current_points ?? data?.real_points ?? "未知"}`);
            this.summary.points = "ok";
        } catch (e) {
            $.log(`账号[${this.index}] 查询积分失败: ${e.message || e}`);
            this.summary.points = "error";
        }
    }
}

!(async () => {
    $.checkEnv(ckName);
    const summaries = [];
    for (const openid of $.userList) {
        summaries.push(await new Task(openid).run());
        await $.wait(800);
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
