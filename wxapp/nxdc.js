/*
------------------------------------------
@Description: 奈雪(pin-dao) - 微信小程序静默登录 + 每日签到
cron: 45 8 * * *
------------------------------------------
变量名：nxdc
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行分隔（可加 #备注）

依赖变量：
wx_server_url  默认 http://192.168.31.196:8787
wx_auth        必填，wx_server 鉴权值

环境开关：
NXDC_READ_ONLY=1            只读验证：只登录+查询，不发起签到写
NXDC_UNKNOWN_COOLDOWN_MS    写后未知冷却期（默认 10 分钟），期内禁止重发
NXDC_CONFIRM_DELAY_MS       恢复写前两次权威查询间隔（默认 3000ms）
------------------------------------------
状态机（与 trsj/xmsq 同一防重放语义）：
- 写（/user/sign/save）出网前先原子落盘 attempting 并回读校验，落盘/回读失败即阻断写请求；
- success/failed/unknown 区分；写后未知只做有界只读权威收敛，本进程绝不重发；
- 当日最多一次恢复写：冷却期过后连续两次权威查询均确认未签到，才允许第二次且最后一次写；
- 读接口（records）的瞬态故障（网络/超时/5xx/上游间歇 sign 校验抖动）做有界重试，耗尽抛 retryable=1 交外层重跑；
  写后未知 retryable=0，阻止外层整脚本重放。
- 唯一 [QLRUN_RESULT] 结构化结果行，退出码与整体结论一致。
------------------------------------------
契约（appid wxab7430e6e8b9a4ab，登录 tm-api.pin-dao.cn / 业务 tm-web.pin-dao.cn）：
signature = base64(hmac_sha1(SIGN_SECRET, `nonce=<n>&openId=<OPEN_ID>&timestamp=<ts>`))
登录  POST /passport/authenticate/wxapp/verify/grc -> token
状态  POST /user/sign/records {signDate:YYYY-MM-01, startDate:today} -> code0，data.status(已签)/signCount
签到  POST /user/sign/save {signDate:today} -> code0 && data.flag 成功
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const ckName = "nxdc";
const MINI_APP_ID = "wxab7430e6e8b9a4ab";
const OPEN_ID = "QL6ZOftGzbziPlZwfiXM";
const SIGN_SECRET = "sArMTldQ9tqU19XIRDMWz7BO5WaeBnrezA";
const LOGIN_URL = "https://tm-api.pin-dao.cn/passport/authenticate/wxapp/verify/grc";
const WEB_BASE = "https://tm-web.pin-dao.cn";
const TOKEN_CACHE_FILE = path.join(__dirname, "nxdc_token_cache.json");
const WRITE_STATE_FILE = path.join(__dirname, "nxdc_write_state.json");
const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 " +
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

const MAX_WRITE_ATTEMPTS = 2; // 当日：首次 + 冷却后一次恢复，硬上限，不再第三次自动写

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://192.168.31.196:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

function boolEnv(name, def) {
    const v = process.env[name];
    if (v === undefined || v === "") return def;
    return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function intEnv(name, def) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : def;
}

class ApiError extends Error {
    constructor(message, opt = {}) {
        super(message);
        this.name = "ApiError";
        this.transient = !!opt.transient;
        this.retryable = !!opt.retryable;
        this.authFail = !!opt.authFail;
        this.noAccount = !!opt.noAccount;
        this.statePersistFailed = !!opt.statePersistFailed;
    }
}
class WriteUnknownError extends Error {
    constructor(message) { super(message); this.name = "WriteUnknownError"; }
}

function readJsonSafe(file) {
    try { if (!fs.existsSync(file)) return {}; return JSON.parse(fs.readFileSync(file, "utf8")) || {}; }
    catch (e) { return {}; }
}
function atomicWriteJson(file, obj) {
    // 同目录临时文件 + 原子重命名；调用方再回读校验
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, file);
}

function readTokenCache() { return readJsonSafe(TOKEN_CACHE_FILE); }
function writeTokenCache(c) {
    try { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(c, null, 2), "utf8"); }
    catch (e) { /* 缓存非关键，失败不阻断主流程 */ }
}
function readWriteState() { return readJsonSafe(WRITE_STATE_FILE); }
function saveWriteState(all) { atomicWriteJson(WRITE_STATE_FILE, all); }

function parseAccount(raw = "") {
    const [id, remark] = String(raw).split("#").map((s) => (s || "").trim());
    return { openid: id, remark: remark || "" };
}
function short(v, n = 200) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}
function randomIntString(n) {
    let s = "";
    for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
    return s;
}
function hmacSha1Base64(secret, message) {
    return crypto.createHmac("sha1", secret).update(message, "utf8").digest("base64");
}
function buildRequestData(extra) {
    const nonce = randomIntString(6);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = hmacSha1Base64(SIGN_SECRET, `nonce=${nonce}&openId=${OPEN_ID}&timestamp=${timestamp}`);
    const common = {
        platform: "wxapp", version: "6.0.42", imei: "", osn: "microsoft", sv: "Windows 10 x64",
        lat: "", lng: "", lang: "zh_CN", currency: "CNY", timeZone: "",
        nonce: Number(nonce), openId: OPEN_ID, timestamp, signature,
    };
    const params = {
        businessType: 1, brand: 26000252, tenantId: 1, channel: 2,
        stallType: null, storeId: "", storeType: "", cityId: "",
        ...(extra || {}),
    };
    return { common, params };
}
function chinaDateParts() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
function chinaToday() {
    const { y, m, d } = chinaDateParts();
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function extractToken(data) {
    if (!data || typeof data !== "object") return "";
    const inner = data.data || {};
    for (const k of ["token", "accessToken", "access_token", "authToken", "memberToken"]) {
        const v = data[k] || inner[k];
        if (v && String(v) !== "null") return String(v);
    }
    return "";
}
// 上游间歇抖动：records 读接口偶发返回 "request sign ... is not valid"，同请求稍后即成功，按瞬态处理
function isTransientBusiness(msg) {
    return /sign[^\n]{0,40}is not valid|系统繁忙|稍后重试|请重试/i.test(String(msg || ""));
}
function isAuthBusiness(msg) {
    return /token|未登录|登录失效|授权|unauthorized|login/i.test(String(msg || ""));
}

class Task {
    constructor(raw, opt = {}) {
        this.index = opt.index || 1;
        this.account = parseAccount(raw);
        this.token = "";
        this.readOnly = !!opt.readOnly;
        this.cooldownMs = opt.cooldownMs ?? intEnv("NXDC_UNKNOWN_COOLDOWN_MS", 10 * 60 * 1000);
        this.confirmDelayMs = opt.confirmDelayMs ?? intEnv("NXDC_CONFIRM_DELAY_MS", 3000);
        this.writeAttempted = false;
        this.failures = [];
        this.core = "";
    }
    log(text) { console.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`); }

    async getCode() {
        const { data } = await wechat.getCode(this.account.openid);
        if (data && data.status === false) throw new ApiError(`wx_server 取code失败: ${data.message || short(data)}`);
        const code = data?.data?.code || data?.code;
        if (!code || typeof code !== "string") throw new ApiError(`wx_server 未返回 code: ${short(data)}`, { noAccount: true });
        return code;
    }
    async login() {
        const code = await this.getCode();
        const body = buildRequestData({ appId: MINI_APP_ID, dAId: "", type: 3, wxappCode: code, regChannelCode: "|1027" });
        const res = await axios.request({
            method: "POST", url: LOGIN_URL, data: JSON.stringify(body),
            headers: { Host: "tm-api.pin-dao.cn", Authorization: "Bearer null", "User-Agent": UA, xweb_xhr: "1", storeId: "", "Content-Type": "application/json", iv: randomIntString(16), Accept: "*/*", Referer: `https://servicewechat.com/${MINI_APP_ID}/1/page-frame.html` },
            timeout: 20000, validateStatus: () => true,
        });
        this.token = extractToken(res.data);
        if (!this.token) throw new ApiError(`登录未返回 token（可能未注册）: ${short(res.data)}`, { noAccount: true });
        const cache = readTokenCache();
        cache[this.account.openid] = { token: this.token, updatedAt: new Date().toISOString() };
        writeTokenCache(cache);
        this.log("登录成功");
    }
    async ensureLogin() {
        const cached = readTokenCache()[this.account.openid] || {};
        if (!this.token && cached.token) { this.token = cached.token; this.log("使用缓存token"); return; }
        await this.login();
    }
    // 底层签名请求；idempotent 时对瞬态有界重试。返回业务 data。
    async callSigned(url, body, { idempotent = false, attempts = 3 } = {}) {
        let lastErr = null;
        for (let i = 1; i <= attempts; i++) {
            try {
                const payload = buildRequestData(body || {});
                const res = await axios.request({
                    method: "POST", url, data: JSON.stringify(payload),
                    headers: { "User-Agent": UA, Authorization: `Bearer ${this.token}`, Referer: `${WEB_BASE}/`, Origin: WEB_BASE, "Content-Type": "application/json" },
                    timeout: 20000, validateStatus: () => true,
                });
                const httpStatus = res.status || 0;
                const data = res.data || {};
                if (httpStatus >= 500 || httpStatus === 429) throw new ApiError(`HTTP ${httpStatus}`, { transient: true });
                if (Number(data.code) === 0) return data;
                const msg = data.message || data.msg || short(data);
                if (isTransientBusiness(msg)) throw new ApiError(`业务瞬态: ${msg}`, { transient: true });
                if (isAuthBusiness(msg)) throw new ApiError(`鉴权失效: ${msg}`, { authFail: true });
                // 明确业务拒绝，不重试
                throw new ApiError(msg, { transient: false });
            } catch (e) {
                lastErr = e;
                const transient = e.transient || /timeout|ECONNRESET|ENOTFOUND|ETIMEDOUT|network|5\d\d/.test(String(e.message));
                e.transient = transient;
                if (!idempotent || !transient || i >= attempts) {
                    e.retryable = idempotent && transient;
                    throw e;
                }
                await new Promise((r) => setTimeout(r, 800 * i));
            }
        }
        throw lastErr || new ApiError("未知请求错误", { transient: true, retryable: idempotent });
    }
    // 权威读：今日是否已签到（幂等，可重试）
    async querySignStatus() {
        const { y, m } = chinaDateParts();
        const signDate = `${y}-${String(m).padStart(2, "0")}-01`;
        const today = chinaToday();
        const data = await this.callSigned(`${WEB_BASE}/user/sign/records`, { signDate, startDate: today }, { idempotent: true, attempts: 3 });
        const d = data.data || {};
        return { signed: !!d.status, signCount: d.signCount };
    }
    readAccountState() {
        const all = readWriteState();
        return all[this.account.openid] || {};
    }
    persistAttempt(attemptNo, outcome) {
        const all = readWriteState();
        all[this.account.openid] = {
            date: chinaToday(), outcome, attempts: attemptNo,
            lastAttemptAt: new Date().toISOString(),
        };
        saveWriteState(all);
        // 回读校验：失败即阻断写请求（进程在途窗口）
        const back = readWriteState()[this.account.openid] || {};
        if (back.date !== chinaToday() || back.outcome !== outcome) {
            throw new ApiError("防重放状态回读校验失败，已阻止写请求", { statePersistFailed: true });
        }
    }
    persistOutcome(outcome, attemptNo) {
        const all = readWriteState();
        all[this.account.openid] = {
            date: chinaToday(), outcome, attempts: attemptNo,
            lastAttemptAt: new Date().toISOString(),
        };
        try { saveWriteState(all); } catch (e) { this.log(`⚠️ 状态落盘失败(非阻断): ${e.message || e}`); }
    }
    // 一次签到写（不自动重试）
    async doSignWrite() {
        this.writeAttempted = true;
        const today = chinaToday();
        const attemptNo = (this.readAccountState().attempts || 0) + 1;
        this.persistAttempt(attemptNo, "attempting");
        try {
            const data = await this.callSigned(`${WEB_BASE}/user/sign/save`, { signDate: today }, { idempotent: false, attempts: 1 });
            const inner = (data && data.data) || data || {};
            if (inner.flag) { this.persistOutcome("success", attemptNo); return { ok: true, signCount: inner.signCount }; }
            const msg = data.message || data.msg || short(data);
            // 明确业务失败（非瞬态），记 failed，后续调度可重试
            this.persistOutcome("failed", attemptNo);
            throw new ApiError(`签到失败: ${msg}`, { transient: false });
        } catch (e) {
            if (e instanceof ApiError && e.statePersistFailed) throw e;
            if (e.authFail) { this.persistOutcome("failed", attemptNo); throw e; }
            if (!e.transient) { this.persistOutcome("failed", attemptNo); throw e; }
            // 写请求已出网但结果未知：落盘 unknown，只做权威收敛，不重发
            this.persistOutcome("unknown", attemptNo);
            throw new WriteUnknownError(`签到写结果未知(${e.message || e})，已冷却等待，本进程不重发`);
        }
    }
    async wait(ms) { await new Promise((r) => setTimeout(r, ms)); }

    async run() {
        if (!this.account.openid) { this.log("跳过：变量值里没有 openid"); return { ok: true, core: "skipped", writeAttempted: false }; }
        try {
            await this.ensureLogin();
            // 权威读（幂等，内部有界重试；鉴权失效则清缓存重登一次）
            let status;
            try {
                status = await this.querySignStatus();
            } catch (e) {
                if (e.authFail) {
                    const cache = readTokenCache(); delete cache[this.account.openid]; writeTokenCache(cache);
                    this.token = ""; await this.login();
                    status = await this.querySignStatus();
                } else throw e;
            }
            if (status.signed) {
                this.persistOutcome("success", this.readAccountState().attempts || 1);
                this.log(`✅ 今日已签到，累计 ${status.signCount ?? "?"} 天`);
                return { ok: true, core: "already", writeAttempted: this.writeAttempted };
            }

            const st = this.readAccountState();
            if (this.readOnly) {
                this.log("ℹ️ 只读模式(NXDC_READ_ONLY=1)：确认今日未签到，跳过签到写");
                return { ok: true, core: "readonly", writeAttempted: this.writeAttempted };
            }

            // 已存在 attempting/unknown：冷却 + 连续两次权威确认后才允许一次恢复写
            if (st.date === chinaToday() && (st.outcome === "attempting" || st.outcome === "unknown")) {
                const attempts = st.attempts || 1;
                if (attempts >= MAX_WRITE_ATTEMPTS) {
                    throw new WriteUnknownError(`今日写已达上限(${attempts}次)，等待明日或人工核查，未重复发起`);
                }
                const age = Date.now() - new Date(st.lastAttemptAt || Date.now()).getTime();
                if (age < this.cooldownMs) {
                    throw new WriteUnknownError(`签到写${st.outcome === "attempting" ? "可能仍在途" : "结果未知"}，冷却期内(剩余约${Math.ceil((this.cooldownMs - age) / 60000)}分钟)，未重发`);
                }
                await this.wait(this.confirmDelayMs);
                const second = await this.querySignStatus();
                if (second.signed) {
                    this.persistOutcome("success", attempts);
                    this.log(`✅ 权威收敛：服务端已有今日签到记录，累计 ${second.signCount ?? "?"} 天`);
                    return { ok: true, core: "already", writeAttempted: this.writeAttempted };
                }
                this.log(`ℹ️ 冷却期已过且两次权威查询均确认未签到，执行最后一次恢复写(第${attempts + 1}次)`);
            }

            const r = await this.doSignWrite();
            this.log(`✅ 签到成功，累计 ${r.signCount ?? status.signCount ?? "?"} 天`);
            return { ok: true, core: "success", writeAttempted: this.writeAttempted };
        } catch (e) {
            if (e.noAccount) {
                this.log("⚠️ 登录未拿到 token（该微信号可能未注册奈雪会员），先在小程序里注册一次再跑");
                return { ok: true, core: "unregistered", writeAttempted: this.writeAttempted };
            }
            const unknown = e instanceof WriteUnknownError;
            this.failures.push(short(e.message));
            this.log(`${unknown ? "❗" : "❌"} ${short(e.message)}`);
            return {
                ok: false, core: unknown ? "unknown" : "failed",
                writeAttempted: this.writeAttempted,
                // 写已尝试过 => retryable=0 阻止外层整段重放；读瞬态耗尽 => retryable=1 交外层重跑
                retryable: this.writeAttempted ? 0 : (e.retryable ? 1 : 0),
            };
        }
    }
}

function composeResult({ configured, accounts, failed, retryable, readOnly }) {
    if (!configured) return { verdict: "SKIP", exitCode: 0, line: "[QLRUN_RESULT] SKIP reason=no_accounts configured=0" };
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
    const env = new Env("奈雪签到");
    env.checkEnv(ckName);
    const readOnly = boolEnv("NXDC_READ_ONLY", false);
    const accounts = env.userList || [];

    let failed = 0;
    let retryable = 0;
    let writeAttemptedAny = false;
    if (!accounts.length) {
        env.log("未找到变量 nxdc 账号，本次按未配置跳过，不冒充业务成功");
    } else {
        for (let i = 0; i < accounts.length; i += 1) {
            const task = new Task(accounts[i], { index: i + 1, logger: env, readOnly });
            const r = await task.run();
            writeAttemptedAny = writeAttemptedAny || r.writeAttempted;
            if (!r.ok) { failed += 1; retryable = Math.max(retryable, r.retryable || 0); }
            if (i < accounts.length - 1) await env.wait(1500, 3000);
        }
    }
    // 任一账号写已尝试 => 整体不可由外层重放
    if (writeAttemptedAny && failed > 0) retryable = Math.min(retryable, 0);

    env.log(`执行汇总：账号=${accounts.length}，失败=${failed}，模式=${readOnly ? "只读" : "任务"}`);
    const result = composeResult({ configured: accounts.length > 0, accounts: accounts.length, failed, retryable, readOnly });
    console.log(result.line);
    await env.sendMsg();
    const seconds = ((Date.now() - (env.startTime || Date.now())) / 1000).toFixed(3);
    env.log(`🔔奈雪签到,结束!🕛 ${seconds}秒`);
    process.exit(result.exitCode);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`奈雪签到未捕获异常：${short(e && e.message || e)}`);
        console.log("[QLRUN_RESULT] FAILURE accounts=0 failed=1 retryable=0");
        process.exit(1);
    });
}

module.exports = {
    MINI_APP_ID, OPEN_ID, Task, ApiError, WriteUnknownError, composeResult, chinaToday, parseAccount,
};
