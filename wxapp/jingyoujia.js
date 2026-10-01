/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: 劲友家小程序签到
cron: 30 8 * * *
------------------------------------------
变量名：jingyoujia
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("劲友家小程序签到");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx10bc773e0851aedd";
const API_BASE = "https://jjw.jingjiu.com/app-jingyoujia";
const TOKEN_CACHE_FILE = path.join(__dirname, "jingyoujia_token_cache.json");
const PAGE_VERSION = "1052";
const AES_KEY = "Z0J7M480h6kppf67";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "jingyoujia";

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

function isTokenError(message) {
    return /401|token|登录|授权|未登录|无效|过期/i.test(String(message || ""));
}

function aesEncrypt(text) {
    const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(AES_KEY, "utf8"), null);
    cipher.setAutoPadding(true);
    return Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]).toString("base64");
}

class Task {
    constructor(account) {
        this.index = $.userIdx++;
        this.account = String(account || "").trim();
        this.token = "";
        this.userInfo = {};
        this.points = "";
        this.task = null;
        this.record = null;
    }

    async run() {
        try {
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
                if (!this.token) return;
            }

            await this.getCustomerDetails();
            await this.getIntegral();
            await this.findCheckTask();
            await this.queryRecord();
            await this.signIn();
            await this.getIntegral();
            this.outcome = this.outcome || "fail";
        } catch (e) {
            this.outcome = "error";
            $.log(`账号[${this.index}] 运行失败: ${e.message || e}`);
        }
    }

    getCachedToken() {
        const cache = readTokenCache();
        const item = cache[this.account];
        return item && item.accessToken ? item : null;
    }

    saveCachedToken() {
        if (!this.token) return;
        const cache = readTokenCache();
        cache[this.account] = {
            accessToken: this.token,
            userInfo: this.userInfo || {},
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        if (cache[this.account]) {
            delete cache[this.account];
            writeTokenCache(cache);
        }
        this.token = "";
        this.userInfo = {};
    }

    applyToken(data = {}) {
        this.token = data.accessToken || data.token || "";
        this.userInfo = data.userInfo || {};
    }

    getHeaders(extra = {}) {
        return {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            appId: MINI_APP_ID,
            Authorization: this.token || "none",
            ...extra,
        };
    }

    async request({ method = "GET", apiPath, params = {}, data = {}, notAuth = false }) {
        const upperMethod = method.toUpperCase();
        const options = {
            method: upperMethod,
            url: `${API_BASE}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`,
            headers: this.getHeaders(notAuth ? { Authorization: "none" } : {}),
            timeout: 20000,
            validateStatus: () => true,
        };
        if (upperMethod === "GET") options.params = params;
        else options.data = data;

        const { data: result, status } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (!result || (Number(result.code) !== 200 && String(result.code) !== "200")) {
            throw new Error(result?.msg || result?.message || JSON.stringify(result));
        }
        return result.data;
    }

    async getLoginCode() {
        const { data } = await wechat.getCode(this.account);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error(`wx_server 未返回 code: ${JSON.stringify(data)}`);
        return code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const data = await this.request({
                method: "POST",
                apiPath: "/login",
                notAuth: true,
                data: { code },
            });
            this.token = data?.accessToken || "";
            if (!this.token) throw new Error(`登录响应未返回 accessToken: ${JSON.stringify(data)}`);
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.request({ apiPath: "/app/jingyoujia/customer/detail" });
            return true;
        } catch (e) {
            return false;
        }
    }

    async getCustomerDetails() {
        try {
            const data = await this.request({ apiPath: "/app/jingyoujia/customer/detail" });
            this.userInfo = data || {};
            this.saveCachedToken();
            $.log(`账号[${this.index}] 会员: ${data?.nickName || data?.nickname || "未知"} ${maskPhone(data?.mobile || "")}`);
        } catch (e) {
            $.log(`账号[${this.index}] 查询会员失败: ${e.message || e}`);
            if (isTokenError(e.message || e)) this.removeCachedToken();
        }
    }

    async getIntegral() {
        try {
            const data = await this.request({ apiPath: "/app/jingyoujia/customer/queryCustIntegral" });
            this.points = data?.usableIntegral ?? data?.integral ?? data?.custIntegral ?? data?.points ?? "";
            $.log(`账号[${this.index}] 当前积分: ${this.points === "" ? JSON.stringify(data) : this.points}`);
        } catch (e) {
            $.log(`账号[${this.index}] 查询积分失败: ${e.message || e}`);
        }
    }

    async findCheckTask() {
        try {
            const data = await this.request({ apiPath: "/app/jingyoujia/taskContinuousRecord/findCheckTask" });
            // 服务端只要返回活动配置（taskName/showIntegralConfigs）即视为有每日签到；
            // 连续记录 id 在首次签到前恒为 null，不能用 data.id 判定有无活动（否则永远签不上）。
            const hasTask = !!data && (data.id || data.taskName || (Array.isArray(data.showIntegralConfigs) && data.showIntegralConfigs.length));
            if (!hasTask) {
                // 账号正常、服务端当前确无签到活动：确定性不可完成，按二分类口径记为不可重试失败。
                this.outcome = "no-task";
                $.log(`账号[${this.index}] 当前无签到活动`);
                return;
            }
            this.task = data;
            const start = String(data.startTime || "").slice(0, 10);
            const end = String(data.endTime || "").slice(0, 10);
            $.log(`账号[${this.index}] 签到活动: ${data.taskName || "每日签到"}${data.id ? ` taskId=${data.id}` : ""}${start || end ? ` ${start}-${end}` : ""}`);
        } catch (e) {
            $.log(`账号[${this.index}] 获取签到活动失败: ${e.message || e}`);
        }
    }

    async queryRecord() {
        if (!this.task?.id) return;
        try {
            const data = await this.request({
                apiPath: "/app/jingyoujia/taskContinuousRecord/queryRecord",
                params: { taskId: this.task.id },
            });
            this.record = data || {};
            $.log(`账号[${this.index}] 签到状态: 连续${data?.continuousNum ?? 0}天 今日=${data?.todayFinish ? "已签" : "未签"}`);
        } catch (e) {
            $.log(`账号[${this.index}] 查询签到状态失败: ${e.message || e}`);
        }
    }

    async signIn() {
        if (!this.task) return;
        if (this.record?.todayFinish) {
            $.log(`账号[${this.index}] 今日已签到`);
            this.outcome = "ok";
            return;
        }
        try {
            const data = await this.request({
                method: "POST",
                apiPath: "/app/jingyoujia/taskContinuousRecord",
                data: {
                    v1: aesEncrypt(JSON.stringify({ taskId: this.task.id })),
                },
            });
            const integral = data?.currentSignIntegral ?? data?.integral ?? "";
            $.log(`账号[${this.index}] 签到成功${integral !== "" ? `: +${integral}积分` : ""}`);
            this.outcome = "ok";
            await this.finishTask();
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|重复|todayFinish/.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                this.outcome = "ok";
                return;
            }
            if (/20230529|captcha|验证码|滑块/.test(message)) {
                $.log(`账号[${this.index}] 签到需要验证码，已跳过`);
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }

    async finishTask() {
        try {
            await this.request({
                method: "POST",
                apiPath: "/business/member/task/finish",
                data: {
                    latitude: 0,
                    longitude: 0,
                    taskType: 1,
                },
            });
        } catch (e) {
            $.log(`账号[${this.index}] 完成任务上报失败: ${e.message || e}`);
        }
    }
}

!(async () => {
    $.checkEnv(ckName);
    let success = 0;
    let failed = 0;
    let retryable = true;
    for (const account of $.userList) {
        const t = new Task(account);
        await t.run();
        if (t.outcome === "ok") success++;
        else {
            failed++;
            // 无签到活动为确定性不可完成（当日重试无效），不可重试；其余运行错误保留可重试。
            if (t.outcome === "no-task") retryable = false;
        }
    }
    if (failed === 0 && success === $.userCount) {
        $.log(`[QLRUN_RESULT] SUCCESS core=${success}/${$.userCount}`);
    } else {
        $.log(`[QLRUN_RESULT] FAILURE retryable=${retryable ? 1 : 0} core=${success}/${$.userCount} failed=${failed}`);
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
