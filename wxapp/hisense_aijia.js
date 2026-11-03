/*
------------------------------------------
@Description: 海信爱家 - 签到/查询（硬化候选 v1，离线未部署）
变量名：hisense_aijia
依赖：wx_server_url、wx_auth
防重放：state 按 CST 业务日 + cacheKey + taskId 分 entry；写前 attempting 原子落盘回读；
  success/failed/unknown 三态；unknown 冷却+双权威确认才恢复写（最多恢复总 2 次）；
  当日每 task 硬上限 2；同账号全窗锁；cache 原子+shared lock；HISENSE_AIJIA_READ_ONLY=1 零写。
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("海信爱家");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const ckName = "hisense_aijia";
const MINI_APP_ID = "wxf488d623a17cd7b5";
const PACKAGE_VERSION = "115";
const MINI_ID = "105";
const APP_PACKAGE = "com.hisense.miniapp-aiot";
const FEATURE_CODE = "86100300000100100000fffe";
const APP_VERSION = "m_p.16.000";
const DEFAULT_VALUE = "-1";
const DEFAULT_LICENSE = "-1";
const SOURCE_TYPE = 21;
const SIGN_APP_KEY = "commonweb";
const SIGN_APP_SECRET = "MORZRbkuiWxjp+SM4vR_GxY4pZxLZ6rn";
const POINT_BASE = "https://mobile-aiot.hismarttv.com";
const WXTV_BASE = "https://public-wxtv.hismarttv.com";
const MINI_MOBI_BASE = "https://mini-mobi.hismarttv.com";
const ACCOUNT_BASE = "https://portal-account.hismarttv.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "hisense_aijia_token_cache.json");
const STATE_FILE = path.join(__dirname, "hisense_aijia_sign_state.json");
const LOCK_DIR = path.join(__dirname, "hisense_aijia.lock");
const CACHE_LOCK_DIR = path.join(__dirname, "hisense_aijia.cache.lock");
const READ_ONLY = process.env.HISENSE_AIJIA_READ_ONLY === "1";
const COOLDOWN_MS = Number(process.env.HISENSE_RECOVER_COOLDOWN_MS || 1800 * 1000);
const MAX_WRITES_PER_TASK = 2;
const MAX_RECOVER_TOTAL = 2;

/* env.done() 可能 process.exit(0) 覆盖退出码；包装为最终以 exitCode 为准 */
const _origExit = process.exit.bind(process);
process.exit = (code) => {
    const finalCode = process.exitCode !== undefined ? process.exitCode : code;
    _origExit(finalCode === undefined ? 0 : finalCode);
};

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://192.168.31.196:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "your-api-key",
});

/* ---------- 工具 ---------- */
function cstToday() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function readJsonStrict(file, label) {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    let v;
    try { v = JSON.parse(raw); } catch (e) { throw new Error(`坏JSON ${label}: ${e.message}`); }
    return v;
}
function writeJsonAtomic(file, obj) {
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, file);
    const back = readJsonStrict(file, path.basename(file));
    return back !== null && JSON.stringify(back) === JSON.stringify(obj);
}

function readCacheStrict() {
    const v = readJsonStrict(TOKEN_CACHE_FILE, "token cache");
    if (v === null) return {};
    if (typeof v !== "object" || Array.isArray(v) || v === null) throw new Error("token cache 根非对象");
    return v;
}
function writeCacheAtomic(cache) {
    try {
        if (!writeJsonAtomic(TOKEN_CACHE_FILE, cache)) throw new Error("回读校验失败");
        return true;
    } catch (e) {
        $.log(`token缓存写入失败: ${e.message || e}`);
        return false;
    }
}
function withCacheLock(fn) {
    try { fs.mkdirSync(CACHE_LOCK_DIR); } catch { return null; }
    try { return fn(); } finally { try { fs.rmdirSync(CACHE_LOCK_DIR); } catch {} }
}
function acquireLock() { try { fs.mkdirSync(LOCK_DIR); return true; } catch { return false; } }
function releaseLock() { try { fs.rmdirSync(LOCK_DIR); } catch {} }

function readStateStrict() {
    const v = readJsonStrict(STATE_FILE, "sign state");
    if (v === null) {
        if (fs.existsSync(STATE_FILE)) throw new Error("state 文件存在但内容为 null，fail-closed");
        return {};
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("state 根非对象");
    const OK_STATUS = new Set(["success", "failed", "unknown", "attempting"]);
    for (const day of Object.keys(v)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`state key ${day} 非日期`);
        const d = v[day];
        if (typeof d !== "object" || d === null || Array.isArray(d)) throw new Error(`state[${day}] 非对象`);
        for (const ck of Object.keys(d)) {
            const acct = d[ck];
            if (typeof acct !== "object" || acct === null || Array.isArray(acct)) throw new Error(`state[${day}][${ck}] 非对象`);
            for (const task of Object.keys(acct)) {
                const e = acct[task];
                if (typeof e !== "object" || e === null || Array.isArray(e)) throw new Error(`entry 非对象`);
                if (e.status !== undefined && !OK_STATUS.has(e.status)) throw new Error(`entry status 非法: ${e.status}`);
                if (e.attempts !== undefined && (!Number.isInteger(e.attempts) || e.attempts < 0)) throw new Error(`entry attempts 非法`);
                if (e.ts !== undefined && (!Number.isFinite(e.ts) || e.ts < 0)) throw new Error(`entry ts 非法`);
            }
        }
    }
    return v;
}

function md5(text) { return crypto.createHash("md5").update(String(text)).digest("hex"); }
function mask(value = "") {
    value = String(value || "");
    if (!value) return "";
    if (value.length <= 12) return `${value.slice(0, 3)}***`;
    return `${value.slice(0, 6)}***${value.slice(-6)}`;
}
function short(value, limit = 500) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text && text.length > limit ? `${text.slice(0, limit)}...` : text;
}
function randHex(len = 4) { return Math.floor(Math.random() * Math.pow(16, len)).toString(16); }
function getSignSecret(appKey = SIGN_APP_KEY) {
    if (appKey !== SIGN_APP_KEY) throw new Error(`appSecret not found: ${appKey}`);
    return SIGN_APP_SECRET;
}
function signString(data, postAndJSON = false, appKey = SIGN_APP_KEY) {
    const secret = getSignSecret(appKey);
    let text = "";
    if (postAndJSON) {
        text = typeof data === "string" ? data : JSON.stringify(data || {});
    } else if (typeof data === "string") {
        text = data;
    } else {
        text = Object.keys(data || {})
            .map((key) => {
                let value = data[key];
                if (value === "" || value === null || value === undefined) return "";
                if (typeof value === "object") value = JSON.stringify(value);
                return `${key}=${value}`;
            })
            .filter(Boolean).sort().join("&");
    }
    return crypto.createHash("md5").update(`${text}${secret}`).digest("base64");
}
function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
function generateDeviceId() {
    const identifier = (`0${MINI_ID}0${Date.now().toString(16)}${randHex(8)}${randHex(8)}`).slice(0, 32);
    return `${FEATURE_CODE}${identifier}`;
}
function pureGuid() { return uuid().replace(/-/g, ""); }
function buildSign(data, postAndJSON) { return signString(data || {}, postAndJSON, SIGN_APP_KEY); }
function encryptByAppKey(value) {
    if (!value) return "";
    const secret = getSignSecret(SIGN_APP_KEY);
    const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(secret, "utf8"), Buffer.from(secret.slice(0, 16), "utf8"));
    return Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]).toString("base64");
}
function decryptByAppKey(value) {
    if (!value) return "";
    try {
        const secret = getSignSecret(SIGN_APP_KEY);
        const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(secret, "utf8"), Buffer.from(secret.slice(0, 16), "utf8"));
        return Buffer.concat([decipher.update(String(value), "base64"), decipher.final()]).toString("utf8");
    } catch { return value; }
}
function cleanPayload(data = {}) {
    return Object.entries(data).reduce((obj, [key, val]) => {
        if (val === undefined || val === null || Number.isNaN(val)) return obj;
        obj[key] = val; return obj;
    }, {});
}
function parseAccount(raw) {
    const text = String(raw || "").trim();
    if (!text) return {};
    if (text.startsWith("{")) {
        try {
            const data = JSON.parse(text);
            return {
                openid: data.openid || data.openId || data.account || "",
                customerId: data.customerId || data.userId || "",
                accessToken: data.accessToken || data.token || "",
                refreshToken: data.refreshToken || "",
                loginKey: data.loginKey || "",
                phone: data.phone || data.mobilePhone || "",
                phoneCode: data.phoneCode || "",
                encryptedData: data.encryptedData || "",
                iv: data.iv || "",
                loginCode: data.loginCode || data.code || "",
            };
        } catch {}
    }
    if (text.includes("#") || text.includes("|")) {
        const sep = text.includes("#") ? "#" : "|";
        const parts = text.split(sep).map((v) => v.trim()).filter(Boolean);
        if (parts.length >= 3) return { openid: parts[0], customerId: parts[1], accessToken: parts.slice(2).join(sep) };
        if (parts.length === 2) {
            if (parts[0].startsWith("o")) return { openid: parts[0], accessToken: parts[1] };
            return { customerId: parts[0], accessToken: parts[1] };
        }
    }
    if (text.startsWith("o")) return { openid: text };
    return { accessToken: text };
}
function isTokenError(data) {
    const text = short(data, 1000) || "";
    const code = data?.resultCode ?? data?.code;
    return /token|登录|未登录|失效|access/i.test(text) || ["A00001", "B0101", "B0102", "401", 401].includes(code);
}
function requestHeaders(contentType = "application/json") {
    return {
        Accept: "*/*",
        "content-type": contentType,
        "User-Agent": "Mozilla/5.0 MicroMessenger MiniProgramEnv/Windows",
        Referer: `https://servicewechat.com/${MINI_APP_ID}/${PACKAGE_VERSION}/page-frame.html`,
    };
}
function addSearch(url, params = {}) {
    const u = new URL(url);
    Object.entries(params).forEach(([key, val]) => {
        if (val !== undefined && val !== null && val !== "") u.searchParams.set(key, String(val));
    });
    return u.toString();
}
/* 错误携带 method + symbolic step，不携带含敏感 query 的 URL */
function reqError(step, method, e) {
    const err = new Error(`[${method} ${step}] ${e && e.message || e}`);
    err.step = step; err.method = method; err.cause = e;
    return err;
}
async function request(method, base, urlPath, data = {}, options = {}) {
    const url = urlPath.startsWith("http") ? urlPath : `${base}${urlPath}`;
    const postAndJSON = method.toUpperCase() === "POST" && (options.contentType || "application/json").includes("json");
    const payload = cleanPayload({ _t: Date.now(), ...(data || {}) });
    const headers = requestHeaders(options.contentType || "application/json");
    if (options.signType === "WEB_CN_GW") {
        headers["X-Sign-For"] = buildSign(payload, postAndJSON);
        headers.appKey = SIGN_APP_KEY;
    } else if (options.signType === "WEB_CN") {
        payload.sign = buildSign(payload, postAndJSON);
        payload.appKey = SIGN_APP_KEY;
    }
    const config = { method, url, timeout: options.timeout || 30000, validateStatus: () => true, headers };
    if (method.toUpperCase() === "GET") config.params = payload; else config.data = payload;
    try {
        const res = await axios(config);
        return { status: res.status, data: res.data, text: typeof res.data === "string" ? res.data : JSON.stringify(res.data) };
    } catch (e) {
        throw reqError(options.step || urlPath, method, e);
    }
}
function extractSceneParam(res, sceneCode) {
    const pageParams = res?.pageParams || res?.data?.pageParams || [];
    if (Array.isArray(pageParams)) {
        const item = pageParams.find((v) => v.sceneCode === sceneCode) || pageParams[0] || {};
        return normalizeMaybeJson(item);
    }
    return normalizeMaybeJson(res?.[sceneCode] || res?.data || res || {});
}
function normalizeMaybeJson(value) {
    if (typeof value === "string") { try { return JSON.parse(value); } catch { return value; } }
    if (!value || typeof value !== "object") return value;
    const out = Array.isArray(value) ? [] : {};
    for (const [key, val] of Object.entries(value)) out[key] = normalizeMaybeJson(val);
    return out;
}
function findTaskId(value) {
    if (!value || typeof value !== "object") return "";
    if (value.mpSignInfo?.taskId) return value.mpSignInfo.taskId;
    if (value.taskId && /sign|签到/i.test(JSON.stringify(value).slice(0, 300))) return value.taskId;
    for (const val of Object.values(value)) { const found = findTaskId(val); if (found) return found; }
    return "";
}
/* 严格解析：pageParams[] -> entry.mpSignInfo.taskId (string 非空)。
   现场已证：pageParams[0] 直接含 mpSignInfo{taskId,signInfo} 和 appSignInfo{...}，
   无 params JSON wrapper。递归任意字段/未证 params 分支禁止。 */
function strictTaskId(scene) {
    if (typeof scene !== "object" || scene === null || Array.isArray(scene)) return "";
    const pageParams = scene.pageParams;
    if (!Array.isArray(pageParams) || pageParams.length === 0) return "";
    const entry = pageParams.find(v => v && v.sceneCode === "STATIC_AILIFE_SIGN_INFO") || pageParams[0];
    if (typeof entry !== "object" || entry === null) return "";
    const mp = entry.mpSignInfo;
    if (typeof mp !== "object" || mp === null) return "";
    const t = mp.taskId;
    if (typeof t === "string" && t) return t;
    return "";
}
function formatSignStatus(status = {}) {
    const today = status.signedToday ? "已签" : "未签";
    const days = status.keepSigningDays ?? 0;
    const rewards = Array.isArray(status.rewardSignTaskList) ? status.rewardSignTaskList : [];
    const next = rewards[Math.max(0, Number(days) || 0)] || rewards[0] || {};
    const point = Number(next.rewardType) === 130 ? next.rewardNum : "";
    return `今日${today}，连续${days}天${point !== "" ? `，下次奖励${point}积分` : ""}`;
}
/* checkInStatus schema：signedToday 仅接受 boolean 或 number 0/1（不兼容任意字符串）；
   rewardSignTaskList 必须显式数组（缺失当结构缺失 FAILURE，不默认 []）。
   真实 API 形状待探针证实后再放宽。 */
function strictSignStatus(status) {
    if (typeof status !== "object" || status === null || Array.isArray(status)) throw new Error("checkInStatus 非对象");
    if (!("signedToday" in status)) throw new Error("signedToday 缺失");
    const st = status.signedToday;
    let signedToday;
    if (st === true || st === false) signedToday = st;
    else if (st === 0 || st === 1) signedToday = Boolean(st);
    else throw new Error(`signedToday 类型异常: ${typeof st}`);
    const days = Number.isInteger(status.keepSigningDays) && status.keepSigningDays >= 0 ? status.keepSigningDays : 0;
    if (!("rewardSignTaskList" in status) || !Array.isArray(status.rewardSignTaskList)) {
        throw new Error("rewardSignTaskList 缺失/非数组，结构未知 FAILURE");
    }
    for (const r of status.rewardSignTaskList) {
        if (typeof r !== "object" || r === null) throw new Error("reward 非对象");
    }
    return { signedToday, days, rewards: status.rewardSignTaskList };
}

const summary = { accounts: 0, done: 0, already: 0, unavailable: 0, writeAttempted: 0, fail: 0, ambiguous: 0 };

function hasAccountFields(o) {
    return o && typeof o === "object" && !Array.isArray(o) &&
        (o.accessToken || o.customerId || o.openid || o.refreshToken || o.loginKey || o.phone || o.updatedAt);
}
function detectCacheShape(root) {
    if (root && root._schema === 2 && root.accounts && typeof root.accounts === "object" && !Array.isArray(root.accounts)) return "v2";
    if (!root || typeof root !== "object" || Array.isArray(root)) return "empty";
    if (hasAccountFields(root)) return "A_flat";
    const keys = Object.keys(root).filter(k => k !== "_schema" && k !== "accounts");
    if (keys.length > 0 && keys.every(k => hasAccountFields(root[k]))) return "B_keyed";
    return "unknown";
}
function matchBKey(root, openid, customerId) {
    const keys = Object.keys(root).filter(k => k !== "_schema" && k !== "accounts");
    if (keys.length === 0) return "";
    for (const k of keys) {
        const e = root[k];
        if (openid && e.openid && e.openid === openid) return k;
        if (customerId && e.customerId && String(e.customerId) === String(customerId)) return k;
    }
    if (keys.length === 1 && !openid && !customerId) return keys[0];
    return "";
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        const account = parseAccount(raw);
        this.openid = account.openid || "";
        this.customerId = account.customerId || process.env.hisense_aijia_customerId || "";
        this.accessToken = account.accessToken || process.env.hisense_aijia_token || "";
        this.refreshToken = account.refreshToken || process.env.hisense_aijia_refreshToken || "";
        this.loginKey = account.loginKey || process.env.hisense_aijia_loginKey || "";
        this.phone = account.phone || "";
        this.phoneCode = account.phoneCode || "";
        this.encryptedData = account.encryptedData || "";
        this.iv = account.iv || "";
        this.loginCode = account.loginCode || "";
        this.deviceId = generateDeviceId();
        // v9: accountKey 稳定优先 md5(phone)，登录前后不漂移；无 phone 才 openid/customerId；最后 index 兜底。
        this.accountKey = this.phone ? md5(this.phone).slice(0, 16)
            : (this.openid || this.customerId || `account_${this.index}`);
        this.cacheKey = this.accountKey;
        this.matchedCacheKey = "";
        this.outcome = "skip";
        this.retryable = 0;
    }
    log(text) { $.log(`账号[${this.index}]${this.customerId ? `[${mask(this.customerId)}]` : ""} ${text}`); }

    getCached() {
        const root = readCacheStrict();
        const shape = detectCacheShape(root);
        if (shape === "v2") {
            this.matchedCacheKey = root.accounts[this.accountKey] ? this.accountKey : "";
            return root.accounts[this.accountKey] || {};
        }
        if (shape === "A_flat") {
            /* 仅当 env 身份匹配 root 才使用，避免多账号 A-flat 错绑；
               env 无 openid/customerId（token-only）时也允许单账号 root 为当前。 */
            const match = (!this.openid && !this.customerId)
                || (this.openid && root.openid === this.openid)
                || (this.customerId && String(root.customerId) === String(this.customerId));
            if (!match) return {};
            this.matchedCacheKey = this.accountKey;
            return root;
        }
        if (shape === "B_keyed") {
            const k = matchBKey(root, this.openid, this.customerId);
            if (!k) return {};
            this.matchedCacheKey = k; /* 保留原 key，不漂移到 phone-hash */
            return root[k];
        }
        return {};
    }
    saveCache(extra = {}) {
        if (READ_ONLY) return true; // readonly 零写，含 cache
        const ok = withCacheLock(() => {
            const root = readCacheStrict();
            const shape = detectCacheShape(root);
            let accounts;
            if (shape === "v2") {
                accounts = root.accounts;
            } else if (shape === "B_keyed") {
                /* 逐 entry 迁移，保留所有账号独立 entry 与原 key，不把其他账号并到当前 */
                accounts = {};
                for (const k of Object.keys(root)) {
                    if (k === "_schema" || k === "accounts") continue;
                    if (hasAccountFields(root[k])) accounts[k] = { ...root[k] };
                }
            } else if (shape === "A_flat") {
                /* 仅当当前身份匹配 root 才迁移；否则 failclosed 不写，避免把别人 token 并到当前 */
                const match = (!this.openid && !this.customerId)
                    || (this.openid && root.openid === this.openid)
                    || (this.customerId && String(root.customerId) === String(this.customerId));
                if (!match) throw new Error("A_flat cache 身份不匹配，拒迁移防错绑");
                accounts = {};
                const { _schema: _s, accounts: _a, ...legacyFields } = root;
                accounts[this.matchedCacheKey || this.accountKey] = { ...legacyFields };
            } else {
                accounts = {};
            }
            const writeKey = this.matchedCacheKey || this.accountKey;
            const cur = { ...(accounts[writeKey] || {}) };
            Object.assign(cur, extra,
                ...(this.openid ? [{ openid: this.openid }] : []),
                ...(this.customerId ? [{ customerId: this.customerId }] : []),
                ...(this.accessToken ? [{ accessToken: this.accessToken }] : []),
                ...(this.refreshToken ? [{ refreshToken: this.refreshToken }] : []),
                ...(this.loginKey ? [{ loginKey: this.loginKey }] : []),
                ...(this.phone ? [{ phone: this.phone }] : []),
                { updatedAt: new Date().toISOString() });
            accounts[writeKey] = cur;
            const next = { _schema: 2, accounts };
            return writeCacheAtomic(next);
        });
        if (ok === null) { this.log("⚠️ cache 锁被占用，本轮不写 cache"); throw new Error("cache 锁被占用"); }
        if (ok === false) throw new Error("cache 落盘失败，阻写");
        return ok;
    }
    removeToken() {
        if (READ_ONLY) return; // readonly 零写，含 removeToken
        withCacheLock(() => {
            const root = readCacheStrict();
            const shape = detectCacheShape(root);
            if (shape === "v2" && root.accounts[this.accountKey]) {
                delete root.accounts[this.accountKey].accessToken;
                writeCacheAtomic(root);
                return;
            }
            if (shape === "B_keyed") {
                const k = matchBKey(root, this.openid, this.customerId);
                if (k && root[k]) { delete root[k].accessToken; writeCacheAtomic(root); }
                return;
            }
            if (shape === "A_flat" && root.accessToken) {
                const next = { ...root }; delete next.accessToken;
                writeCacheAtomic(next);
            }
        });
    }
    loadCache() {
        this.matchedCacheKey = "";
        const cached = this.getCached();
        this.openid = this.openid || cached.openid || "";
        this.customerId = this.customerId || cached.customerId || "";
        this.accessToken = this.accessToken || cached.accessToken || "";
        this.refreshToken = this.refreshToken || cached.refreshToken || "";
        this.loginKey = this.loginKey || cached.loginKey || "";
        this.phone = this.phone || cached.phone || "";
        /* 稳定 key：若已从 B/A 匹配到原 key，保留它；否则按 env 身份生成（phone 优先），不漂移 */
        if (this.matchedCacheKey) {
            this.accountKey = this.matchedCacheKey;
        } else {
            this.accountKey = this.phone ? md5(this.phone).slice(0, 16)
                : (this.openid || this.customerId || `account_${this.index}`);
        }
        this.cacheKey = this.accountKey;
    }

    async getWxCode() {
        if (!this.openid) throw new Error("缺少 openid，无法从 wx_server 获取 code");
        const { data } = await wechat.getCode(this.openid);
        if (!data?.status) throw new Error(data?.message || "wx_server 获取 code 失败");
        const code = data.data?.code || data.code;
        if (!code || typeof code !== "string") throw new Error(`wx_server 未返回 code`);
        return code;
    }
    async getPhoneNumberData() {
        if (!this.openid) throw new Error("缺少 openid");
        const { data } = await axios.post(`${wechat.serverUrl}/wx/getphonenumber`,
            { appid: MINI_APP_ID, openid: this.openid },
            { headers: { auth: wechat.auth }, timeout: 60000, validateStatus: () => true });
        if (!data?.status) throw new Error(data?.message || "wx_server 获取手机号授权 code 失败");
        const phoneCode = data.data?.code || data.code || "";
        if (!phoneCode) throw new Error(`wx_server 未返回手机号 code`);
        const raw = data.data?.raw || {};
        const rawData = normalizeMaybeJson(raw.data || {});
        if (rawData?.mobile) this.phone = this.phone || rawData.mobile;
        return { phoneCode, raw };
    }
    async refreshAccessToken() {
        if (!this.accessToken || !this.refreshToken) return false;
        const res = await request("POST", MINI_MOBI_BASE, "/MobileMiniAppAPI/1.2/adapter/refreshToken",
            { token: this.accessToken, refreshToken: this.refreshToken }, { step: "refreshToken" });
        const data = res.data?.data || {};
        if (res.status === 200 && Number(res.data?.resultCode) === 0 && Number(data.resultCode) === 0 && data.token) {
            this.accessToken = data.token;
            this.refreshToken = data.refreshToken || this.refreshToken;
            this.customerId = data.customerId || this.customerId;
            this.saveCache({ loginType: "refreshToken" });
            this.log(`refreshToken 刷新成功`);
            return true;
        }
        this.log(`refreshToken 刷新失败`);
        return false;
    }
    async loginByLoginKey() {
        if (!this.loginKey) return false;
        const res = await request("POST", ACCOUNT_BASE, "/mobile/s/quickLogin", {
            serverCode: 9006, requestSource: 2, qrCodeFlag: 0, accCategory: "newminihxaj",
            termType: "1", loginKey: this.loginKey, sid: `sid-${Date.now()}-${randHex()}`,
        }, { signType: "WEB_CN_GW", step: "quickLogin" });
        const data = res.data?.data || {};
        const tokenInfo = data.tokenInfo || {};
        if (res.status === 200 && Number(data.resultCode) === 0 && tokenInfo.token) {
            this.customerId = tokenInfo.customerId || this.customerId;
            this.accessToken = tokenInfo.token;
            this.refreshToken = tokenInfo.refreshToken || this.refreshToken;
            this.saveCache({ loginType: "loginKey" });
            this.log(`loginKey 登录成功`);
            return true;
        }
        this.log(`loginKey 登录失败`);
        return false;
    }
    async fetchLoginKey() {
        if (!this.accessToken || this.loginKey) return;
        const res = await request("GET", ACCOUNT_BASE, "/mobile/st/getLoginKey",
            { accessToken: this.accessToken, keyType: 1 }, { signType: "WEB_CN_GW", step: "getLoginKey" });
        const data = res.data?.data || {};
        if (res.status === 200 && Number(data.resultCode) === 0 && data.loginKey) {
            this.loginKey = data.loginKey;
            this.saveCache({ loginKey: this.loginKey });
        }
    }
    async loginByPhoneAuth() {
        let op = {};
        if (this.phoneCode || (this.encryptedData && this.iv)) {
            op = { phoneCode: this.phoneCode, encryptedData: this.encryptedData, iv: this.iv, code: this.loginCode };
        } else if (this.openid) {
            op = await this.getPhoneNumberData();
        } else { return false; }
        const phoneCode = op.phoneCode || this.phoneCode || "";
        const loginCode = this.loginCode || (phoneCode ? "" : op.code || (this.openid ? await this.getWxCode() : ""));
        const loginPayload = {
            deviceId: this.deviceId,
            ...(phoneCode ? { phoneCode } : { iv: op.iv, loginCode, encryptedData: op.encryptedData }),
            miniId: MINI_ID, sid: uuid(),
        };
        const res = await request("POST", WXTV_BASE, "/weixintv/oauth/login4MiniAPPByPhone",
            loginPayload, { signType: "WEB_CN", step: "phoneLogin" });
        const data = res.data || {};
        if (res.status === 200 && Number(data.resultCode) === 0 && data.token) {
            this.customerId = data.customerId || this.customerId;
            this.accessToken = data.token;
            this.refreshToken = data.refreshToken || this.refreshToken;
            this.saveCache({ loginType: "phoneAuth" });
            this.log(`手机授权登录成功`);
            return true;
        }
        this.log(`手机授权登录失败`);
        return false;
    }
    async ensureLogin() {
        this.loadCache();
        if (this.accessToken && this.customerId) { this.saveCache({ loginType: "direct" }); return; }
        if (await this.refreshAccessToken()) return;
        if (await this.loginByLoginKey()) return;
        if (await this.loginByPhoneAuth()) return;
        throw new Error("未获取到海信业务 customerId/accessToken");
    }

    commonPointParams() {
        const mobile = this.phone ? encryptByAppKey(this.phone) : "";
        return { customerId: String(this.customerId), mobile, accessToken: this.accessToken, appType: MINI_ID };
    }
    commonSignParams() {
        const mobile = this.phone ? encryptByAppKey(this.phone) : "";
        return {
            deviceId: this.deviceId, appPackageName: APP_PACKAGE, appVersionName: DEFAULT_VALUE,
            appVersionCode: DEFAULT_VALUE, license: DEFAULT_LICENSE, appVersion: APP_VERSION,
            deviceExt: "Windows", userType: "1", customerId: String(this.customerId), mobile,
            accessToken: this.accessToken, userId: String(this.customerId),
        };
    }
    async pointScore(pathname, data = {}, step) {
        const res = await request("POST", POINT_BASE, pathname, { ...this.commonPointParams(), ...data },
            { signType: "WEB_CN_GW", step: step || pathname });
        if (res.status !== 200) throw reqError(step || pathname, "POST", new Error(`HTTP ${res.status}`));
        if (typeof res.data === "string") throw reqError(step || pathname, "POST", new Error("响应非JSON(HTML?)"));
        if (isTokenError(res.data)) throw reqError(step || pathname, "POST", new Error("token失效"));
        return res.data;
    }
    async pointSign(pathname, data = {}, query = {}, step) {
        const url = Object.keys(query).length ? addSearch(`${POINT_BASE}${pathname}`, query) : `${POINT_BASE}${pathname}`;
        /* v11: HiVip 网关现场已证走 WEB_CN_GW header 签名（X-Sign-For + appKey），
           body 不再带 sign/appKey；phoneLogin 等其它 WEB_CN body 签名端点不动。 */
        const res = await request("POST", "", url, { ...this.commonSignParams(), ...data },
            { signType: "WEB_CN_GW", step: step || pathname });
        if (res.status !== 200) throw reqError(step || pathname, "POST", new Error(`HTTP ${res.status}`));
        if (typeof res.data === "string") throw reqError(step || pathname, "POST", new Error("响应非JSON(HTML?)"));
        if (isTokenError(res.data)) throw reqError(step || pathname, "POST", new Error("token失效"));
        return res.data;
    }
    async queryProfile() {
        try {
            const res = await request("GET", "", `${POINT_BASE}/MobileMiniAppAPI/s/6.3/account/getCustomerProfile`,
                { accessToken: this.accessToken, timeStamp: Math.floor(Date.now() / 1000), customerId: this.customerId, randStr: pureGuid() },
                { signType: "WEB_CN_GW", step: "profile" });
            if (res.status === 200 && Number(res.data?.resultCode) === 0) {
                const data = res.data.data || {};
                this.phone = decryptByAppKey(data.mobilePhone || "") || this.phone;
                this.saveCache({ phone: this.phone });
            }
        } catch (e) { this.log(`profile 查询瞬态失败: ${e.message}`); }
    }
    async queryPoints() {
        const res = await this.pointScore("/AIoTPointsMall/gw/svc/HiScore/1.0/userPoints", {}, "userPoints");
        if (Number(res.resultCode) !== 0) throw new Error(`积分查询失败`);
        const data = res.data || {};
        this.log(`总积分: ${data.totalScore ?? 0}`);
    }
    async queryTodayRecords() {
        const start = new Date(); start.setHours(0, 0, 0, 0);
        const end = new Date(); end.setHours(23, 59, 59, 999);
        try {
            await this.pointScore("/AIoTPointsMall/gw/svc/HiScore/1.0/userPointRecords",
                { pageNo: "1", pageSize: "100", startTime: start.getTime(), endTime: end.getTime() }, "userPointRecords");
        } catch (e) { this.log(`今日记录瞬态失败: ${e.message}`); }
    }
    async getSceneParam(sceneCode) {
        /* 现场根因：公共 sceneParams 必须 omit accessToken（带 token 会 10s hang）；
           不传 Authorization，payload 只含 type/sceneCode */
        const res = await request("GET", WXTV_BASE, "/vodapptv/5.10/sceneParams/data/get",
            { type: 2, sceneCode }, { signType: "NONE", step: "sceneParams", timeout: 10000 });
        if (res.status !== 200) throw reqError("sceneParams", "GET", new Error(`HTTP ${res.status}`));
        if (typeof res.data === "string") throw reqError("sceneParams", "GET", new Error("响应非JSON"));
        if (Number(res.data?.resultCode) !== 0) throw reqError("sceneParams", "GET", new Error(`resultCode=${res.data?.resultCode}`));
        return res.data;
    }
    async resolveTaskId() {
        if (process.env.hisense_aijia_sign_task_id) return { taskId: process.env.hisense_aijia_sign_task_id };
        const scene = await this.getSceneParam("STATIC_AILIFE_SIGN_INFO");
        const taskId = strictTaskId(scene);
        if (!taskId) {
            /* fail-closed：未探针证实前不猜为 unavailable；结构未知 → 失败 */
            throw new Error("未解析到签到 taskId（scene 结构未知，fail-closed）");
        }
        return { taskId };
    }
    async querySignStatus(taskId) {
        const res = await this.pointSign("/AIoTPointsMall/gw/svc/HiVip/1.0/getCheckInStatus",
            { taskId, sourceType: SOURCE_TYPE }, {}, "getCheckInStatus");
        if (String(res.code ?? "1") !== "0") throw reqError("getCheckInStatus", "POST", new Error(`code=${res.code}`));
        return strictSignStatus(res.checkInStatus || {});
    }

    entry(state, taskId) {
        const day = state[cstToday()] || {};
        /* 业务状态键：已认证稳定 customerId，不随 cacheKey/phone 漂移 */
        const idKey = this.customerId || this.accountKey;
        const acct = day[idKey] || {};
        return acct[taskId] || null;
    }
    setEntry(taskId, patch) {
        const state = readStateStrict();
        const day = state[cstToday()] = state[cstToday()] || {};
        const idKey = this.customerId || this.accountKey;
        const acct = day[idKey] = day[idKey] || {};
        const prev = acct[taskId] || {};
        acct[taskId] = Object.assign({}, prev, patch);
        return writeJsonAtomic(STATE_FILE, state);
    }
    safeSet(taskId, patch) { try { this.setEntry(taskId, patch); } catch (e) { this.log(`⚠️ state 落盘失败: ${e.message}`); } }

    async doSign(taskId, signedInfo) {
        if (READ_ONLY) { this.log("只读模式：跳过写"); this.outcome = "skip"; summary.done++; return; }
        if (!acquireLock()) {
            this.log("⚠️ 他进程持有写锁，跳过");
            this.outcome = "blocked"; this.retryable = 1; summary.fail++; return;
        }
        try {
            const state = readStateStrict();
            let prev = this.entry(state, taskId) || {};
            if (prev.status === "success") { this.log("本任务本地 success，跳过写"); this.outcome = "already"; summary.done++; summary.already++; return; }
            if (prev.status === "attempting") { this.log("上一写未确认(attempting)，fail-closed"); this.outcome = "unknown"; this.retryable = 0; summary.fail++; return; }
            if (prev.status === "failed") { this.log("本任务当日已 failed，不重放"); this.outcome = "failed"; this.retryable = 0; summary.fail++; return; }
            if ((prev.attempts || 0) >= MAX_WRITES_PER_TASK) { this.log("写达硬上限"); this.outcome = "blocked"; summary.fail++; return; }

            if (prev.status === "unknown") {
                const age = Date.now() - (prev.ts || 0);
                if (age < COOLDOWN_MS) { this.log("写后未知冷却中"); this.outcome = "unknown"; this.retryable = 0; summary.fail++; return; }
                if ((prev.recoverCount || 0) >= MAX_RECOVER_TOTAL) { this.log("unknown 恢复次数用尽"); this.outcome = "unknown"; this.retryable = 0; summary.fail++; return; }
                const confirms = (prev.authoritativeConfirms || 0) + 1;
                if (confirms < 2) {
                    if (!this.setEntry(taskId, { status: "unknown", authoritativeConfirms: confirms, recoverCount: prev.recoverCount || 0, ts: Date.now() })) {
                        this.outcome = "failed"; summary.fail++; return;
                    }
                    this.log(`写后未知，权威确认 ${confirms}/2`);
                    this.outcome = "unknown"; this.retryable = 0; summary.fail++; return;
                }
            }
            const recoverCount = prev.status === "unknown" ? (prev.recoverCount || 0) + 1 : (prev.recoverCount || 0);
            if (!this.setEntry(taskId, { status: "attempting", taskId, attempts: (prev.attempts || 0) + 1, recoverCount, ts: Date.now() })) {
                this.log("state 落盘失败阻写"); this.outcome = "failed"; summary.fail++; return;
            }
            summary.writeAttempted++;
            let res;
            try {
                res = await this.pointSign("/AIoTPointsMall/gw/svc/HiVip/1.0/checkIn",
                    { returnCheckInStatus: false, requestId: `ailife_sign-${Date.now()}-${randHex()}`, taskId, reportToGroup: 1, requestTime: String(Date.now()) },
                    { customerId: this.customerId }, "checkIn");
            } catch (e) {
                this.safeSet(taskId, { status: "unknown", ts: Date.now() });
                this.log(`写后未知: ${e.message}`); this.outcome = "unknown"; this.retryable = 0; summary.fail++; return;
            }
            /* v6: checkIn code0/duplicate 不直接当 success；持锁内有界权威 querySignStatus，
               最多 2 次读（eventual consistency，短退避测试可 0）。signedToday=true 才落 success；
               false 两次或任一异常 → unknown retry0（不是 failed，不是 success）。 */
            const codeOk = String(res.code ?? "1") === "0";
            const msgDup = !codeOk && /已签|重复|today/i.test(res.message || res.msg || short(res, 300));
            if (codeOk || msgDup) {
                this.log(codeOk ? "checkIn code0，持锁权威收敛" : `checkIn dup，持锁权威收敛: ${res.message || res.msg}`);
                let confirmedSigned = false, anyReadErr = false;
                for (let i = 0; i < 2; i++) {
                    if (i > 0) await new Promise(r => setTimeout(r, Number(process.env.HISENSE_VERIFY_BACKOFF_MS ?? 800)));
                    try {
                        const st = await this.querySignStatus(taskId);
                        if (st.signedToday) { confirmedSigned = true; break; }
                    } catch (e) { anyReadErr = true; this.log(`权威收敛读 ${i + 1}/2 失败: ${e.message}`); }
                }
                if (confirmedSigned) {
                    if (!this.setEntry(taskId, { status: "success", ts: Date.now() })) {
                        this.safeSet(taskId, { status: "unknown", ts: Date.now() });
                        this.outcome = "unknown"; this.retryable = 0; summary.fail++; return;
                    }
                    this.log(`✅ 权威确认已签`);
                    this.outcome = "success"; summary.done++; return;
                }
                // false 两次或读异常 → unknown retry0
                this.safeSet(taskId, { status: "unknown", ts: Date.now() });
                this.log(`⚠️ 权威未确认（${anyReadErr ? "读异常" : "signedToday=false"}），unknown retry0`);
                this.outcome = "unknown"; this.retryable = 0; summary.fail++; return;
            }
            const msg = res.message || res.msg || short(res, 300);
            this.safeSet(taskId, { status: "failed", ts: Date.now() });
            this.log(`❌ 签到失败: ${msg}`);
            this.outcome = "failed"; this.retryable = 0; summary.fail++;
        } finally { releaseLock(); }
    }

    async run(isRetry = false) {
        summary.accounts++;
        try {
            await this.ensureLogin();
            this.log(`登录态 OK`);
            await this.queryProfile();
            await this.queryPoints();
            await this.queryTodayRecords();
            const { taskId } = await this.resolveTaskId();
            const signed = await this.querySignStatus(taskId);
            this.log(`签到状态: ${formatSignStatus(signed)}`);
            if (signed.signedToday) {
                this.log("今日已签");
                this.outcome = "already"; summary.done++; summary.already++; return;
            }
            await this.doSign(taskId, signed);
            try { await this.queryPoints(); } catch {}
        } catch (e) {
            const msg = String(e.message || e);
            if (!isRetry && /028012|AccessToken无效|accessToken is illegal|illegal|未登录|登录失效|失效/i.test(msg)) {
                this.log("检测到 accessToken 失效，refreshToken 刷新后重试一次");
                if (await this.refreshAccessToken()) return this.run(true);
            }
            this.log(`运行失败: ${msg}`);
            this.outcome = "failed"; this.retryable = 1; summary.fail++;
        }
    }
}

!(async () => {
    $.checkEnv(ckName);
    if (!$.userCount) {
        console.log(`[QLRUN_RESULT] FAILURE {"script":"hisense_aijia.js","reason":"no_env","retryable":0}`);
        process.exitCode = 1; $.done?.(); return;
    }
    const tasks = [];
    for (let i = 0; i < $.userList.length; i++) {
        const t = new Task($.userList[i]);
        tasks.push(t);
        await t.run();
        if (i < $.userList.length - 1) await $.wait(1500, 3000);
    }
    const ok = summary.fail === 0 && summary.ambiguous === 0;
    const code = ok ? 0 : 1;
    const reason = tasks.length && tasks.every(t => t.outcome === "activity_unavailable") ? "activity_unavailable" : "";
    console.log(`[QLRUN_RESULT] ${ok ? "SUCCESS" : "FAILURE"} ${"{\"script\":\"hisense_aijia.js\"," +
        "\"accounts\":\"" + summary.accounts + "\"," +
        "\"done\":\"" + summary.done + "\"," +
        "\"already\":\"" + summary.already + "\"," +
        "\"unavailable\":\"" + summary.unavailable + "\"," +
        "\"writeAttempted\":\"" + summary.writeAttempted + "\"," +
        "\"fail\":\"" + summary.fail + "\"," +
        "\"ambiguous\":\"" + summary.ambiguous + "\"," +
        "\"reason\":\"" + reason + "\"," +
        "\"mode\":\"" + (READ_ONLY ? "read_only" : "normal") + "\"}"} retryable=${tasks.some(t => t.retryable === 1) ? 1 : 0}`);
    process.exitCode = code;
    $.done?.();
})().catch((e) => {
    $.log(String(e && e.message || e));
    console.log(`[QLRUN_RESULT] FAILURE {"script":"hisense_aijia.js","reason":"exception","retryable":1}`);
    process.exitCode = 1;
});
