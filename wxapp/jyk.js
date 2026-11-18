/*
------------------------------------------
@Description: 旧衣客(JYK) - 微信小程序静默登录 + 每日签到
cron: 22 9 * * *
------------------------------------------
变量名：jyk
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行分隔（可加 #备注）

依赖变量：
wx_server_url  默认 http://192.168.31.196:8787
wx_auth        必填，wx_server 鉴权值
------------------------------------------
契约（appid wx3f0209cc35a953a4，host jyk.scjyx.com）：
（迁移自 YYB-GO 系脚本，原脚本已 code 登录）

登录  POST /api/index/get_openid {code, pid:"", device_info:"android_MEIZU_22_370"}
        -> errno==0，data.access_token；头 Authorization: Bearer <token> + X-Payconfig-Id:2
状态  GET /api/checkin/home -> data.{enabled, today_signed, can_sign}
签到  ① POST /api/checkin/prepare -> data.ad_token
      ② POST /api/checkin/sign {ad_token} -> errno==0 成功
响应壳：{errno:0, data}；errno!=0 视为失败/未开启。只做普通签到，不做广告签到。
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("旧衣客签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const ckName = "jyk";
const MINI_APP_ID = "wx3f0209cc35a953a4";
const TARGET_VERSION = "68";
const BASE_URL = "https://jyk.scjyx.com";
const PAYCONFIG_ID = "2";
const PID = "";
const DEVICE_INFO = "android_MEIZU_22_370";
const TOKEN_CACHE_FILE = path.join(__dirname, "jyk_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 " +
    "Chrome/107.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.5 MiniProgramEnv/android";

const EP_LOGIN = "/api/index/get_openid";
const EP_HOME = "/api/checkin/home";
const READ_ONLY = process.env.JYK_READ_ONLY === "1" || process.env.QL_READ_ONLY === "1";
const WRITE_STATE_FILE = path.join(__dirname, ".jyk_write_state.json");
const crypto = require("crypto");
function writeKey(alias) {
    return crypto.createHash("sha256").update(String(alias)).digest("hex") + "|" + new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}
function readWriteState() {
    let raw;
    try { raw = fs.readFileSync(WRITE_STATE_FILE, "utf8"); }
    catch (e) { if (e.code === "ENOENT") return {}; throw e; }
    const state = JSON.parse(raw);
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("写状态损坏");
    return state;
}
function acquireWriteLock(alias) {
    const file = WRITE_STATE_FILE + ".lock";
    const fd = fs.openSync(file, "wx", 0o600);
    fs.closeSync(fd);
    return () => fs.unlinkSync(file);
}
function persistWriteState(key, entry) {
    const state = readWriteState(); state[key] = entry;
    const data = Buffer.from(JSON.stringify(state));
    const tmp = WRITE_STATE_FILE + ".tmp." + process.pid;
    let fd = -1;
    try {
        fd = fs.openSync(tmp, "wx", 0o600);
        let offset = 0;
        while (offset < data.length) {
            const n = fs.writeSync(fd, data, offset, data.length - offset);
            if (!Number.isInteger(n) || n <= 0 || n > data.length - offset) throw new Error("状态短写失败");
            offset += n;
        }
        fs.fsyncSync(fd); fs.closeSync(fd); fd = -1;
        fs.renameSync(tmp, WRITE_STATE_FILE);
        const dfd = fs.openSync(path.dirname(WRITE_STATE_FILE), "r");
        try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
        if (!fs.readFileSync(WRITE_STATE_FILE).equals(data)) throw new Error("状态回读不一致");
    } catch (e) {
        if (fd >= 0) { try { fs.closeSync(fd); } catch {} }
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
    }
}
const EP_SIGN = "/api/checkin/sign";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://192.168.31.196:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

function readCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) {
        return {};
    }
}
function writeCache(cache) {
    if (READ_ONLY) return;
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
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

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.token = "";
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    headers() {
        const h = {
            "content-type": "application/json",
            "X-Payconfig-Id": PAYCONFIG_ID,
            Referer: `https://servicewechat.com/${MINI_APP_ID}/${TARGET_VERSION}/page-frame.html`,
            "User-Agent": USER_AGENT,
        };
        if (this.token) h.Authorization = `Bearer ${this.token}`;
        return h;
    }
    async request(method, apiPath, payload) {
        const res = await axios.request({
            method,
            url: `${BASE_URL}${apiPath}`,
            data: method === "POST" ? payload || {} : undefined,
            headers: this.headers(),
            timeout: 20000,
            validateStatus: () => true,
        });
        if (res.status !== 200) throw new Error(`${apiPath} HTTP ${res.status}`);
        if (!res.data || typeof res.data !== "object" || Array.isArray(res.data) || !Object.prototype.hasOwnProperty.call(res.data, "errno")) {
            throw new Error(`${apiPath} 响应信封无效`);
        }
        return res.data;
    }
    async getCode() {
        const { data } = await wechat.getCode(this.account.openid);
        if (data && data.status === false) throw new Error(`wx_server 取code失败: ${data.message || short(data)}`);
        const code = data?.data?.code || data?.code;
        if (!code || typeof code !== "string") throw new Error(`wx_server 未返回 code: ${short(data)}`);
        return code;
    }
    async login() {
        const code = await this.getCode();
        const res = await this.request("POST", EP_LOGIN, { code, pid: PID, device_info: DEVICE_INFO });
        if (Number(res?.errno) !== 0) throw new Error(`登录失败: ${res?.errmsg || res?.msg || short(res)}`);
        const info = res.data || {};
        this.token = String(info.access_token || "");
        if (!this.token) throw new Error(`登录未返回 access_token: ${short(res)}`);
        const cache = readCache();
        cache[this.account.openid] = { token: this.token, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log("登录成功");
    }
    async home() {
        const res = await this.request("GET", EP_HOME);
        if (Number(res?.errno) !== 0) throw new Error(`home失败: ${res?.errmsg || short(res)}`);
        return res.data || {};
    }
    async checkin_sign() {
        let home;
        try { home = await this.home(); }
        catch (e) {
            if (!/token|登录|未授权|失效|过期|401/i.test(String(e.message))) throw e;
            this.token = "";
            await this.login();
            home = await this.home();
        }
        this.log(`可用积分：${home.integral}`);
        /* Only a complete, explicit server state can authorize a skip or POST. */
        if (typeof home.enabled !== "boolean" || typeof home.today_signed !== "boolean" || typeof home.can_sign !== "boolean") {
            throw new Error("签到权威字段缺失或类型错误");
        }
        if (home.today_signed) return { ok: true, reason: "already_signed", wrote: 0 };
        if (home.enabled === false && home.can_sign === false) {
            this.log("普通签到未开启（服务端明确关闭）；不执行广告签到");
            return { ok: true, reason: "ordinary_checkin_disabled", wrote: 0, adEnabled: home.ad?.enabled === true };
        }
        if (!home.enabled || !home.can_sign) throw new Error("签到资格不可用且不是明确关闭状态");
        if (READ_ONLY) return { ok: true, reason: "read_only_unsigned", wrote: 0 };
        const lock = acquireWriteLock(this.account.openid);
        try {
            const second = await this.home();
            if (typeof second.today_signed !== "boolean" || second.enabled !== true || second.can_sign !== true && !second.today_signed) throw new Error("写前权威状态不可确认");
            if (second.today_signed) return { ok: true, reason: "already_signed", wrote: 0 };
            const stateKey = writeKey(this.account.openid);
            const prev = readWriteState()[stateKey];
            if (prev) throw new Error("当日已有写入记录，禁止自动重放");
            persistWriteState(stateKey, { status: "attempting", attemptedAt: Date.now(), attempts: 1 });
            let response;
            try { response = await this.request("POST", EP_SIGN, {}); }
            catch { /* Only the subsequent authority read decides business success. */ }
            let after;
            try { after = await this.home(); } catch {}
            if (after?.today_signed === true) {
                persistWriteState(stateKey, { status: "success", attempts: 1, confirmedAt: Date.now() });
                this.log("普通签到成功（服务端确认）");
                return { ok: true, reason: "signed", wrote: 1 };
            }
            persistWriteState(stateKey, { status: "unknown", attempts: 1, checkedAt: Date.now() });
            return { ok: false, reason: "write_unconfirmed", retryable: 0, wrote: 1 };
        } finally { lock(); }
    }
    async ensureLogin() {
        const cached = readCache()[this.account.openid] || {};
        if (!this.token && cached.token) { this.token = cached.token; this.log("使用缓存token"); return; }
        if (!this.token) await this.login();
    }
    async run() {
        if (!this.account.openid) return { ok: false, reason: "no_account", retryable: 0 };
        try {
            await this.ensureLogin();
            return await this.checkin_sign();
        } catch (e) {
            this.log(`执行失败: ${e.message || e}`);
            return { ok: false, reason: "execution_failed", retryable: 0 };
        }
    }
}

async function finish(code) {
    const exit = process.exit.bind(process);
    process.exit = () => {};
    try { await $.done(); } finally { process.exit = exit; }
    exit(code);
}
!(async () => {
    $.checkEnv(ckName);
    const results = [];
    if (!$.userCount) results.push({ ok: false, reason: "no_env", retryable: 0 });
    for (let i = 0; i < $.userList.length; i++) {
        results.push(await new Task($.userList[i]).run());
        if (i < $.userList.length - 1) await $.wait(1500, 3000);
    }
    const ok = results.length > 0 && results.every(r => r.ok);
    console.log(`[QLRUN_RESULT] ${ok ? "SUCCESS" : "FAILURE"} ${JSON.stringify({ script: "jyk.js", accounts: $.userCount, failed: results.filter(r => !r.ok).length, retryable: 0, mode: READ_ONLY ? "read_only" : "normal", results })}`);
    await finish(ok ? 0 : 1);
})().catch(async () => {
    console.log('[QLRUN_RESULT] FAILURE {"script":"jyk.js","reason":"exception","retryable":0}');
    await finish(1);
});
