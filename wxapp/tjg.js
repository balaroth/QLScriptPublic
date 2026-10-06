/*
------------------------------------------
@Description: 天机观 - 当前小程序协议登录、任务校验与每日签到
cron: 9 9,14 * * *
------------------------------------------
变量名：tjg
变量值：wx_server 里的账号标识，多账号用 & 或换行分隔（可加 #备注）
依赖变量：wx_server_url、wx_auth
------------------------------------------
当前协议依据：wx7829675630d0305e 正式版 4.4.20（appversion=19）

关键契约：
1. 登录 POST /api/user/autoLogin，form{code} -> data.token。
2. 缓存 token 只有在 /api/user/userinfo 返回 code=1 后才能继续使用。
3. /api/user/sign 是受保护接口。官方前端每次请求前现场执行 wx.login，
   并同时提交 token + wx_code；只传 token 会返回“请求校验失败，请重新打开小程序”。
4. 签到完成以官方 /api/user/tasklist 中“每日签到”的 now >= daily_limit 为准；
   不以扩展成功关键词、隐藏错误或跳过业务代替后验校验。
5. 每个 wx_code 只提交一次。只有服务端明确拒绝校验时，才重新获取全新 wx_code 再试一次。
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("天机观签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const CK_NAME = "tjg";
const MINI_APP_ID = "wx7829675630d0305e";
const APP_VERSION = 19;
const BASE_URL = "https://xcx.tianjiguan.cn";
const WX_SERVER_URL = (process.env.wx_server_url || "http://192.168.31.196:8787").replace(/\/+$/, "");
const TOKEN_CACHE_FILE = process.env.TJG_TOKEN_CACHE_FILE || path.join(__dirname, "tjg_token_cache.json");
const UA = "Mozilla/5.0 (Linux; Android 11; Xiaomi Pad 5 Build/RKQ1.200826.002) AppleWebKit/537.36 " +
    "KHTML, like Gecko Version/4.0 Chrome/107.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.49.2600 " +
    "NetType/WIFI MiniProgramEnv/Android";

const EP = {
    login: "/api/user/autoLogin",
    userInfo: "/api/user/userinfo",
    taskList: "/api/user/tasklist",
    sign: "/api/user/sign",
    pointList: "/api/user/point_list",
};

function short(value, limit = 240) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return "";
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function parseAccount(raw = "") {
    const [id, remark] = String(raw).split("#").map((item) => (item || "").trim());
    return { id, remark: remark || "" };
}

function readCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        const parsed = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
        return {};
    }
}

function writeCache(cache) {
    const tmp = `${TOKEN_CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, TOKEN_CACHE_FILE);
    try { fs.chmodSync(TOKEN_CACHE_FILE, 0o600); } catch (_) {}
}

function cacheToken(accountId, token) {
    const cache = readCache();
    if (token) cache[accountId] = { token, updatedAt: new Date().toISOString() };
    else delete cache[accountId];
    writeCache(cache);
}

function headers(token = "") {
    return {
        "X-Access-Token": token,
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": UA,
        Referer: `https://servicewechat.com/${MINI_APP_ID}/${APP_VERSION}/page-frame.html`,
    };
}

function isAuthFailure(body, status = 0) {
    const msg = String(body?.msg || body?.message || "");
    return status === 401 || status === 403 || Number(body?.code) === -101 || /token错误|token已过期|未登录|登录失效|请登录|鉴权/i.test(msg);
}

function isRetryableError(error) {
    return Boolean(error?.retryable) || /timeout|ECONN|ENOTFOUND|EAI_AGAIN|ECONNRESET|HTTP 50[234]|系统繁忙|稍后再试|超时/i.test(String(error?.message || error));
}

async function apiRequest(method, endpoint, token, params = {}) {
    const upper = String(method || "GET").toUpperCase();
    const request = {
        method: upper,
        url: `${BASE_URL}${endpoint}`,
        headers: headers(token),
        timeout: 20000,
        validateStatus: () => true,
    };
    const payload = { ...(params || {}), ...(token ? { token } : {}) };
    if (upper === "GET") request.params = payload;
    else request.data = new URLSearchParams(payload).toString();

    const response = await axios.request(request);
    const body = response.data && typeof response.data === "object" ? response.data : {};
    if (response.status < 200 || response.status >= 300) {
        const error = new Error(`HTTP ${response.status}: ${short(response.data)}`);
        error.retryable = response.status >= 500;
        throw error;
    }
    return body;
}

async function collectorRuntimeCode(label) {
    if (!process.env.wx_auth) {
        const error = new Error("缺少 wx_auth，无法获取签到所需 wx_code");
        error.retryable = false;
        throw error;
    }
    const nonce = ["tjg", label, process.env.TJG_TEST_NONCE || Date.now(), Math.random().toString(36).slice(2, 10)].join("-");
    const response = await axios.post(`${WX_SERVER_URL}/wx/runtime-code`, {
        appid: MINI_APP_ID,
        openid: nonce,
    }, {
        headers: { auth: process.env.wx_auth, "Content-Type": "application/json" },
        timeout: 65000,
        validateStatus: () => true,
    });
    const body = response.data || {};
    if (response.status !== 200 || body.status === false) {
        const error = new Error(`wx_server runtime取码失败: ${body.message || short(body)}`);
        error.retryable = true;
        throw error;
    }
    const code = body?.data?.code || body?.code;
    if (!code || typeof code !== "string") {
        const error = new Error(`wx_server runtime未返回 code: ${short(body)}`);
        error.retryable = true;
        throw error;
    }
    return code;
}

function findSignTask(tasks) {
    return (Array.isArray(tasks) ? tasks : []).find((task) => task && String(task.task || "").trim() === "每日签到") || null;
}

function isSignTaskDone(task) {
    const now = Number(task?.now);
    const limit = Number(task?.daily_limit);
    return Number.isFinite(now) && Number.isFinite(limit) && limit > 0 && now >= limit;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.token = "";
        this.outcome = "fail";
        this.retryable = true;
    }

    log(message) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${message}`);
    }

    async login() {
        const code = await collectorRuntimeCode(`login-${this.index}`);
        const body = await apiRequest("POST", EP.login, "", { code });
        const token = Number(body.code) === 1 ? String(body?.data?.token || "") : "";
        if (!token) {
            const error = new Error(`登录未返回 token: ${short(body)}`);
            error.retryable = false;
            throw error;
        }
        this.token = token;
        cacheToken(this.account.id, token);
        this.log("登录成功");
    }

    async getUserInfo() {
        return apiRequest("GET", EP.userInfo, this.token);
    }

    async ensureSession() {
        const cached = readCache()[this.account.id] || {};
        if (cached.token) {
            this.token = String(cached.token);
            const info = await this.getUserInfo();
            if (Number(info.code) === 1) {
                this.log("缓存会话真实校验通过");
                return info;
            }
            this.log("缓存会话失效，重新登录");
            this.token = "";
            cacheToken(this.account.id, "");
        }

        await this.login();
        const info = await this.getUserInfo();
        if (Number(info.code) !== 1) {
            throw new Error(`登录后用户身份校验失败: ${short(info)}`);
        }
        return info;
    }

    async getTaskList() {
        const body = await apiRequest("GET", EP.taskList, this.token);
        if (Number(body.code) !== 1 || !Array.isArray(body.data)) {
            throw new Error(`积分任务查询失败: ${short(body)}`);
        }
        return body.data;
    }

    async getPointList() {
        const body = await apiRequest("GET", EP.pointList, this.token, { page: 1, limit: 5 });
        if (Number(body.code) !== 1 || !body.data || !Array.isArray(body.data.data)) {
            throw new Error(`积分流水查询失败: ${short(body)}`);
        }
        this.log(`积分流水同步成功：共 ${Number(body.data.total || body.data.data.length)} 条`);
        return body.data;
    }

    async verifySignDone(maxPolls = 3) {
        let task = null;
        for (let poll = 0; poll < maxPolls; poll++) {
            const tasks = await this.getTaskList();
            task = findSignTask(tasks);
            if (!task) throw new Error("官方任务列表缺少“每日签到”任务");
            if (isSignTaskDone(task)) return task;
            if (poll < maxPolls - 1) await sleep(1000);
        }
        return task;
    }

    async sign() {
        const before = await this.verifySignDone(1);
        if (isSignTaskDone(before)) {
            this.log(`今日已签到（官方任务进度 ${before.now}/${before.daily_limit}）`);
            return "already";
        }

        let lastBody = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            const wxCode = await collectorRuntimeCode(`sign-${this.index}-${attempt}`);
            const body = await apiRequest("GET", EP.sign, this.token, { wx_code: wxCode });
            lastBody = body;

            const after = await this.verifySignDone(Number(body.code) === 1 ? 3 : 1);
            if (isSignTaskDone(after)) {
                this.log(`签到完成（官方任务进度 ${after.now}/${after.daily_limit}，${body.msg || "成功"}）`);
                return "signed";
            }

            if (isAuthFailure(body) && attempt === 1) {
                this.log("签到会话失效，重新登录并获取全新 wx_code");
                cacheToken(this.account.id, "");
                this.token = "";
                await this.login();
                continue;
            }

            if (/请求校验失败|重新打开小程序/.test(String(body.msg || "")) && attempt === 1) {
                this.log("本轮 wx_code 未通过校验，重新获取全新 wx_code");
                continue;
            }
            break;
        }
        throw new Error(`签到失败且官方任务进度未完成: ${short(lastBody)}`);
    }

    async run() {
        if (!this.account.id) {
            const error = new Error("变量值里没有账号标识");
            error.retryable = false;
            throw error;
        }
        const before = await this.ensureSession();
        const beforeUser = before.data || {};
        this.log(`用户身份有效：${beforeUser.nickname || "微信用户"}，积分 ${beforeUser.score ?? "?"}`);

        const signResult = await this.sign();
        const after = await this.getUserInfo();
        if (Number(after.code) !== 1) throw new Error(`签到后用户身份校验失败: ${short(after)}`);
        const afterUser = after.data || {};
        this.log(`签到后积分：${afterUser.score ?? "?"}${signResult === "signed" && Number.isFinite(Number(beforeUser.score)) && Number.isFinite(Number(afterUser.score)) ? `（变化 ${Number(afterUser.score) - Number(beforeUser.score)}）` : ""}`);
        await this.getPointList();
        this.outcome = "ok";
    }
}

!(async () => {
    $.checkEnv(CK_NAME);
    if (!$.userCount) {
        $.log(`[QLRUN_RESULT] FAILURE retryable=0 reason=no-account detail=未找到变量 ${CK_NAME}`);
        process.exitCode = 1;
        return;
    }

    let success = 0;
    let failed = 0;
    let retryable = true;
    for (let i = 0; i < $.userList.length; i++) {
        const task = new Task($.userList[i]);
        try {
            await task.run();
            success++;
        } catch (error) {
            failed++;
            const canRetry = isRetryableError(error);
            if (!canRetry) retryable = false;
            task.log(`执行失败: ${error.message || error}`);
        }
        if (i < $.userList.length - 1) await $.wait(1500, 3000);
    }

    if (failed === 0 && success === $.userCount) {
        $.log(`[QLRUN_RESULT] SUCCESS core=${success}/${$.userCount} reason=tjg_sign_verified`);
    } else {
        $.log(`[QLRUN_RESULT] FAILURE retryable=${retryable ? 1 : 0} core=${success}/${$.userCount} failed=${failed}`);
        process.exitCode = 1;
    }
})()
    .catch((error) => {
        $.log(`[QLRUN_RESULT] FAILURE retryable=${isRetryableError(error) ? 1 : 0} reason=script-exception detail=${short(error.message || error)}`);
        process.exitCode = 1;
    })
    .finally(() => $.done());
