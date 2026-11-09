/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: 日清食品小程序签到
cron: 28 8 * * *
------------------------------------------
变量名：nissin
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("日清食品签到");
$.done = async function () { await this.sendMsg(); this.log(`日清食品签到结束，耗时 ${(Date.now() - this.startTime) / 1000} 秒`); };
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx21b71db59d93bd6d";
const API_BASE = "https://foodhall-prod-api.nissinfoodium.com.cn/miniapp";
const PAGE_VERSION = "74";
const TOKEN_CACHE_FILE = path.join(__dirname, "nissin_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "nissin";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://192.168.31.196:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

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

function isTokenError(e) {
    const message = String(e?.message || e || "");
    return e?.code === 401 || e?.code === 900001 || /401|900001|token|登录|授权|Auth-Status|invalid/i.test(message);
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.openid = String(openid || "").trim();
        this.token = "";
        this.redOpenId = "";
        this.userId = "";
        this.user = {};
    }

    async run() {
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
            if (!this.token) throw new Error("日清登录未取得token");
        }

        await this.getUser();
        await this.getSignInInfo();
        if (process.env.NISSIN_READ_ONLY === "1") {
            $.log(`账号[${this.index}] 只读权威验证，今日${this.signInfo.hasSignedToday ? "已签" : "未签"}，零签到写`);
            return;
        }
        await this.doSign();
        await this.enterGame();
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
            redOpenId: this.redOpenId,
            userId: this.userId,
            mobile: this.user.mobile || "",
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
        this.redOpenId = "";
        this.userId = "";
    }

    applyToken(data = {}) {
        this.token = data.accessToken || data.access_token || "";
        this.redOpenId = data.redOpenId || data.openId || data.open_id || "";
        this.userId = data.userId || data.user_id || "";
    }

    getHeaders(extra = {}) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            ...extra,
        };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        return headers;
    }

    async request({ method = "GET", apiPath, data, params, skipToken = false }) {
        const options = {
            method,
            url: `${API_BASE}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`,
            headers: this.getHeaders(method === "POST" ? { "Content-Type": "application/json" } : {}),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (params) options.params = params;
        if (data !== undefined) options.data = data;
        if (skipToken) delete options.headers.Authorization;

        const { status, data: result, headers } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (headers && headers["auth-status"] === "false") {
            const err = new Error("Auth-Status=false");
            err.code = 900001;
            throw err;
        }
        if (!result || result.code !== 0) {
            const err = new Error(result?.msg || result?.message || JSON.stringify(result));
            err.code = result?.code;
            throw err;
        }
        return result.data;
    }

    async getLoginCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error(`wx_server 未返回 code: ${JSON.stringify(data)}`);
        return code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const openData = await this.request({
                method: "POST",
                apiPath: "/auth/getOpenId",
                skipToken: true,
                data: {
                    code,
                    invitorMemberId: 0,
                },
            });
            this.redOpenId = openData.openId || "";
            if (!this.redOpenId) throw new Error(`auth/getOpenId 未返回 openId: ${JSON.stringify(openData)}`);

            const loginData = await this.request({
                method: "POST",
                apiPath: "/auth/login",
                skipToken: true,
                data: {
                    openId: this.redOpenId,
                },
            });
            this.applyToken({
                ...loginData,
                redOpenId: this.redOpenId,
            });
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: userId=${this.userId || "未知"}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
            throw e;
        }
    }

    async checkToken() {
        try {
            await this.getSignInInfo(true);
            return true;
        } catch (e) {
            if (!isTokenError(e)) throw e;
            return false;
        }
    }

    async getUser() {
        try {
            const data = await this.request({ apiPath: "/auth/user/current" });
            this.user = data || {};
            this.saveCachedToken();
            $.log(`账号[${this.index}] 用户: ${data?.nickname || data?.name || ""} ${maskPhone(data?.mobile) || ""}`);
        } catch (e) {
            $.log(`账号[${this.index}] 查询用户失败: ${e.message || e}`);
            if (isTokenError(e)) this.removeCachedToken();
        }
    }

    async getSignInInfo(silent = false) {
        const data = await this.request({ apiPath: "/sign-in/statistics" });
        if (!data || typeof data.hasSignedToday !== "boolean") throw new Error("日清签到权威状态缺失或非布尔");
        this.signInfo = data;
        if (!silent) {
            $.log(`账号[${this.index}] 签到状态: ${data?.hasSignedToday ? "已签" : "未签"} 连续${data?.continuousDays || 0}天 总${data?.totalDays || 0}天 今日${data?.todayPoints ?? "未知"}积分`);
        }
        return data;
    }

    async doSign() {
        if (this.signInfo.hasSignedToday === true) {
            $.log(`账号[${this.index}] 今日已签到（权威确认）`);
            return;
        }
        const crypto = require("crypto");
        const key = crypto.createHash("sha256").update(this.openid).digest("hex");
        const file = path.join(__dirname, `nissin_sign_${key}.json`);
        const lock = file + ".lock";
        const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
        const fd = fs.openSync(lock, "wx", 0o600);
        try {
            // Repeat the authority read inside the process lock.
            await this.getSignInInfo(true);
            if (this.signInfo.hasSignedToday === true) return;
            const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
            if (!previous || typeof previous !== "object" || Array.isArray(previous)) throw new Error("日清写状态损坏");
            if (previous.day === day && previous.attempted === true) throw new Error("日清今日已有未收敛写，禁止重放");
            const state = { day, attempted: true, outcome: "attempting" };
            const save = () => {
                const tmp = file + ".tmp." + process.pid;
                const bytes = Buffer.from(JSON.stringify(state));
                const f = fs.openSync(tmp, "wx", 0o600);
                try { fs.writeFileSync(f, bytes); fs.fsyncSync(f); } finally { fs.closeSync(f); }
                fs.renameSync(tmp, file);
                const d = fs.openSync(path.dirname(file), "r");
                try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
                if (!fs.readFileSync(file).equals(bytes)) throw new Error("日清状态回读不一致");
            };
            save();
            this.writeAttempted = true;
            try { await this.request({ method: "POST", apiPath: "/sign-in", data: {} }); }
            catch (_) { /* Any write response is finalized only by the authoritative read. */ }
            for (let i = 0; i < 3; i++) {
                try {
                    await this.getSignInInfo(true);
                    if (this.signInfo.hasSignedToday === true) {
                        state.outcome = "success"; save();
                        $.log(`账号[${this.index}] 签到成功（权威回查已签）`);
                        return;
                    }
                } catch (_) {}
                if (i < 2) await new Promise(r => setTimeout(r, 1000));
            }
            state.outcome = "unknown"; save();
            throw new Error("日清签到写结果未知，不重放");
        } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    }

    async getTaskList() {
        const data = await this.request({ apiPath: "/taskCenter/getEffectiveTask" });
        if (!Array.isArray(data)) throw new Error("日清任务列表结构未知");
        return data;
    }

    async enterGame() {
        try {
            const beforeTasks = await this.getTaskList();
            const gameTask = beforeTasks.find((item) => item?.ruleType === "PLAY_GAME");
            if (gameTask) {
                $.log(`账号[${this.index}] 玩游戏任务: ${gameTask.complete ? "已完成" : "未完成"}`);
                if (gameTask.complete === true) return;
            } else {
                $.log(`账号[${this.index}] 服务端当前未配置PLAY_GAME任务，不调用旧游戏登录接口`);
                return;
            }

            // Official page only gets config and opens the H5; /game/login is obsolete.
            const gameConfig = await this.request({ apiPath: "/game/config" });
            const playCount = await this.request({ apiPath: "/game/count" });
            const gameUrl = `https://foodhall-prod.nissinfoodium.com.cn/game/index.html?version=${Date.now()}&token=${encodeURIComponent(this.token)}&user_id=${encodeURIComponent(this.userId || this.user.id || "")}&webViewHeight=800`;
            const page = await axios.get(gameUrl, {
                headers: {
                    "User-Agent": USER_AGENT,
                    "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
                },
                timeout: 15000,
                validateStatus: () => true,
            });
            if (page.status >= 200 && page.status < 400) {
                $.log(`账号[${this.index}] 已进入游戏: ${gameConfig?.shareTitle || "日清消消乐"} 剩余次数=${playCount ?? "未知"}`);
            } else {
                $.log(`账号[${this.index}] 进入游戏页面异常: HTTP ${page.status}`);
            }

            const afterTasks = await this.getTaskList();
            const updatedGameTask = afterTasks.find((item) => item?.ruleType === "PLAY_GAME");
            if (updatedGameTask) {
                $.log(`账号[${this.index}] 玩游戏任务更新: ${updatedGameTask.complete ? "已完成" : "未完成"}`);
            }
        } catch (e) {
            this.optionalFailures = (this.optionalFailures || 0) + 1;
            $.log(`账号[${this.index}] 可选游戏入口未完成: ${e.message || e}；每日签到单独以权威状态判定`);
            if (isTokenError(e)) this.removeCachedToken();
        }
    }
}

!(async () => {
    $.checkEnv(ckName);
    let failed = 0, optional = 0, wrote = false;
    if (!($.userList || []).length) throw new Error("未配置日清账号");
    for (const openid of $.userList) {
        const task = new Task(openid);
        try { await task.run(); } catch (e) { failed++; $.log(`账号执行失败: ${e.message || e}`); }
        optional += task.optionalFailures || 0;
        wrote = wrote || task.writeAttempted;
    }
    $.log(`[QLRUN_RESULT] ${failed ? "FAILURE" : "SUCCESS"} accounts=${$.userList.length} failed=${failed} optional_failed=${optional} retryable=${failed && !wrote ? 1 : 0} mode=${process.env.NISSIN_READ_ONLY === "1" ? "readonly" : "normal"}`);
    if (failed) process.exitCode = 1;
})()
    .catch((e) => { $.log(e.message || e); $.log("[QLRUN_RESULT] FAILURE reason=script_error retryable=0"); process.exitCode = 1; })
    .finally(() => $.done());
