/*
------------------------------------------
@Description: 毛铺草本荟 - 微信小程序静默登录 + 每日签到（防重放/状态机加固版）
cron: 43 8 * * *
------------------------------------------
变量名：maopu
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行分隔（可加 #备注）

依赖变量：
wx_server_url  默认 http://192.168.31.196:8787
wx_auth        必填，wx_server 鉴权值

加固点（与 tools/qlall 判定契约对齐，与 xmsq 同款）：
  - 读（mains）按权威门控：HTTP 2xx + code=0 + sign_in_today 为数字才算权威；
    5xx/HTML/缺字段一律“读未知”，绝不据此发写；读瞬态有界重试。
  - 写（adds）发请求前先原子落盘 attempting(tmp+0600+rename+回读)，落盘/回读失败即阻断；
    写后未知只做 1s/3s/7s 只读收敛，本进程不重发，retryable=0。
  - 当日硬上限 2 次写；attempting/unknown 经冷却期 + 连续两次权威读确认未签，才允许最后一次恢复写。
  - 状态文件损坏/不可读 fail-closed，不默认视为可写。
  - token 缓存原子写（tmp+rename+回读）；仅登录成功拿到非空 token 才回写，不被空响应覆盖。
  - 结束输出唯一 [QLRUN_RESULT] SUCCESS|FAILURE ... retryable=0|1；脚本内真实退出码（不沿用 $.done() 固定 exit0）。
  - MAOPU_READ_ONLY=1：只登录+权威查询，绝不发写。
  - -1000 完善资料属账号态门槛：FAILURE retryable=0，不伪装成功。
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("毛铺草本荟");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const ckName = "maopu";
const MINI_APP_ID = "wxefd0fe341e06b815";
const BASE = "https://mpb.jingjiu.com/proxy-he";
const X_VERSION = "0.0.1";
const SALT_SIGN = "DYSHJS^M&.YXZRGS";
const SALT_LOGIN = "DI9ynKTdfWqF";
const TOKEN_CACHE_FILE = path.join(__dirname, "maopu_token_cache.json");
const WRITE_STATE_FILE = path.join(__dirname, "maopu_write_state.json");
const UA =
    "Mozilla/5.0 (Linux; Android 12; M2012K11AC Build/SKQ1.220303.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Version/4.0 Chrome/134.0.6998.136 Mobile Safari/537.36 MicroMessenger/8.0.48.2580(0x28003036) MiniProgramEnv/android";

const EP_LOGIN = "/jp/api/loginauto";
const EP_STATE = "/api/FlanSignInDaily/mains";
const EP_SIGN = "/api/FlanSignInDaily/adds";
const NEED_PROFILE = -1000;

function boolEnv(k, def) {
    const v = process.env[k];
    if (v == null || v === "") return def;
    return /^(1|true|yes|on)$/i.test(String(v));
}
function intEnv(k, def, min, max) {
    const v = Number(process.env[k]);
    if (!Number.isFinite(v)) return def;
    return Math.min(max, Math.max(min, v));
}
const today = () => {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};
const short = (v, n = 200) => {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
};
// 包里的 md5 输出大写，签名要跟它一致
const md5 = (s) => crypto.createHash("md5").update(String(s), "utf8").digest("hex").toUpperCase();
const codeOf = (res) => Number(res && res.code);
const msgOf = (res) => (res && (res.message || res.msg)) || short(res);
const isAuthError = (res) => /登录|token|未授权|未登录|失效|过期/.test(msgOf(res)) || codeOf(res) === 401;
const isAlreadyDone = (t) => /已签|已经签|签到过|重复|已完成|already/i.test(String(t || ""));

class ApiError extends Error {
    constructor(msg, { retryable = false, transient = false } = {}) {
        super(msg);
        this.retryable = retryable;
        this.transient = transient;
    }
}
class WriteUnknownError extends Error {
    constructor(msg) { super(msg); this.retryable = 0; this.writeUnknown = true; }
}
function isTransientStatus(s) { return !s || s === 408 || s === 429 || s >= 500; }
function isTransientError(e) {
    if (!e) return false;
    return !!e.transient || /timeout|aborted|network|econn|socket|502|503|504|gateway/i.test(String(e.code || e.message || e));
}

// ── 原子 JSON 读：写状态文件损坏/不可读 fail-closed ──
function readCacheFile(file) {
    try { if (!fs.existsSync(file)) return {}; return JSON.parse(fs.readFileSync(file, "utf8")) || {}; }
    catch (e) { return {}; } // token 缓存损坏可重建，宽松
}
function readStateFileStrict(file) {
    let raw;
    try {
        if (!fs.existsSync(file)) return {};
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
        throw new ApiError("防重放状态文件损坏/不可读，已阻止写请求", { retryable: false });
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ApiError("防重放状态文件结构非法（非对象），已阻止写请求", { retryable: false });
    }
    const VALID_OUTCOME = new Set(["success", "failed", "unknown", "attempting"]);
    for (const [k, v] of Object.entries(raw)) {
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new ApiError(`防重放状态条目[${k}]结构非法，已阻止写请求`, { retryable: false });
        if (typeof v.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) throw new ApiError(`防重放状态条目[${k}]date非法，已阻止写请求`, { retryable: false });
        if (!VALID_OUTCOME.has(v.outcome)) throw new ApiError(`防重放状态条目[${k}]outcome非法，已阻止写请求`, { retryable: false });
        if (!Number.isInteger(v.attempts) || v.attempts < 0) throw new ApiError(`防重放状态条目[${k}]attempts非法，已阻止写请求`, { retryable: false });
    }
    return raw;
}
function writeJsonFileAtomic(file, obj) {
    const dir = path.dirname(file);
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, file);
        return true;
    } catch (e) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        return false;
    }
}

function parseAccount(raw = "") {
    const [id, remark] = String(raw || "").split("#").map((s) => (s || "").trim());
    return { openid: id, remark: remark || "" };
}

class Task {
    constructor(raw, options = {}) {
        this.account = parseAccount(raw);
        this.index = options.index ?? 1;
        this.logger = options.logger || console;
        this.http = options.http || axios;
        this.wechat = options.wechat;
        this.wait = options.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.now = options.now || (() => Date.now());
        this.readOnly = options.readOnly ?? boolEnv("MAOPU_READ_ONLY", false);
        this.maxRetries = options.maxRetries ?? intEnv("MAOPU_MAX_RETRIES", 2, 0, 5);
        this.timeout = options.timeout || intEnv("MAOPU_HTTP_TIMEOUT", 15000, 3000, 60000);
        this.unknownCooldownMs = options.unknownCooldownMs ?? intEnv("MAOPU_UNKNOWN_RETRY_AFTER_MS", 1800000, 300000, 43200000);
        this.confirmDelayMs = options.confirmDelayMs ?? intEnv("MAOPU_UNKNOWN_CONFIRM_DELAY_MS", 3000, 1000, 30000);
        this.tokenCacheFile = options.tokenCacheFile || TOKEN_CACHE_FILE;
        this.writeStateFile = options.writeStateFile || WRITE_STATE_FILE;
        this.token = "";
        this.outcome = "pending"; // pending|already|success|readonly|failed|unknown|skipped
        this.retryable = 0;
    }
    log(text) { this.logger.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`); }

    // ── token 缓存：仅非空 token 才在共享 wx 锁内合并回写（读磁盘→merge→rename→回读，保留其他账户）──
    readCache() { return readCacheFile(this.tokenCacheFile); }
    writeCacheEntry(entry) {
        const rel = this.sharedLock("maopu_shared_cache.lock");
        if (!rel) throw new ApiError("共享缓存文件锁竞争，已阻止写请求（保留他人锁）", { retryable: false });
        try {
            let cur;
            try {
                if (fs.existsSync(this.tokenCacheFile)) cur = JSON.parse(fs.readFileSync(this.tokenCacheFile, "utf8")) || {};
                else cur = {};
                if (!cur || typeof cur !== "object" || Array.isArray(cur)) throw new ApiError("token 缓存文件损坏，已阻止写请求", { retryable: false });
            } catch (e) {
                if (e instanceof ApiError) throw e;
                throw new ApiError("token 缓存文件损坏，已阻止写请求", { retryable: false });
            }
            const merged = Object.assign({}, cur, entry);
            if (!writeJsonFileAtomic(this.tokenCacheFile, merged)) {
                throw new ApiError("token 缓存原子回写失败（已阻止后续状态写）", { retryable: false });
            }
            const back = readCacheFile(this.tokenCacheFile) || {};
            for (const k of Object.keys(cur)) if (!(k in back)) throw new ApiError("合并回读后其他账户条目丢失，已按阻断处理", { retryable: false });
        } finally { rel(); }
    }

    async request(apiPath, { body = null, signKeys = null, timeout = this.timeout } = {}) {
        const payload = body || {};
        const headers = {
            "content-type": "application/json",
            "x-version": X_VERSION,
            Accept: "application/json, text/plain, */*",
            "User-Agent": UA,
            Referer: `https://servicewechat.com/${MINI_APP_ID}/318/page-frame.html`,
            xweb_xhr: "1",
        };
        if (this.token) headers.Authorization = this.token;
        if (signKeys) {
            const apptime = Math.round(this.now() / 1000);
            let joined = "";
            for (const k of Object.keys(payload)) if (signKeys.includes(k)) joined += `${k}${payload[k]}`;
            headers.apptime = String(apptime);
            headers.appsign = md5(`${apptime}${joined}${SALT_SIGN}${this.token}`).slice(-10);
        }
        let res;
        try {
            res = await this.http.request({
                method: "POST", url: `${BASE}${apiPath}`, data: payload, headers,
                timeout, validateStatus: () => true,
            });
        } catch (e) {
            if (isTransientError(e)) throw new ApiError(`TRANSIENT:HTTP ${apiPath} ${e.message || e}`, { retryable: true, transient: true });
            throw e;
        }
        if (res.status !== 200) {
            if (res.data && typeof res.data === "object") return res.data;
            throw new ApiError(`${apiPath} HTTP ${res.status}: ${short(res.data)}`, { retryable: isTransientStatus(res.status), transient: isTransientStatus(res.status) });
        }
        return res.data;
    }

    async getCode() {
        const { data } = await this.wechat.getCode(this.account.openid);
        if (data && data.status === false) throw new ApiError(`wx_server 取code失败: ${data.message || short(data)}`, { retryable: true, transient: true });
        const code = (data && data.data && data.data.code) || (data && data.code);
        if (!code || typeof code !== "string") throw new ApiError(`wx_server 未返回 code: ${short(data)}`, { retryable: true, transient: true });
        return code;
    }

    async login() {
        const code = await this.getCode();
        const itime = Math.floor(this.now() / 1000);
        const isource = md5(`${code}${SALT_LOGIN}`).slice(0, 16) + md5(`${code}${itime}${SALT_LOGIN}`).slice(-16);
        const res = await this.request(EP_LOGIN, {
            body: { code, unionid: "", user_id: "", user_sources: "0", system: { platform: "android", system: "Android 12", model: "M2012K11AC", SDKVersion: "3.4.5" }, itime, isource },
        });
        if (codeOf(res) !== 0) throw new ApiError(`登录失败: ${msgOf(res)}`, { retryable: !!res && (res.code === -999 || isTransientStatus(res.httpStatus)), transient: false });
        const d = res.data || {};
        const token = String(d.access_token || "");
        if (!token) throw new ApiError(`登录未返回 access_token: ${short(res)}`, { retryable: false });
        this.token = token;
        // 防自覆盖：仅非空 token 才原子合并回写（保留其他账户）
        this.writeCacheEntry({ [this.account.openid]: { token, updatedAt: new Date(this.now()).toISOString() } });
        this.log(`登录成功${d.name ? `: ${d.name}` : ""}`);
    }

    // ── 权威读：mains。返回 {authoritative, signedToday, point, days, raw} ──
    async readSignState() {
        let lastErr = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            let res;
            try { res = await this.request(EP_STATE, { body: {} }); }
            catch (e) {
                lastErr = e;
                if (isTransientError(e) && attempt < this.maxRetries) { await this.wait(this.confirmDelayMs * (attempt + 1)); continue; }
                throw e;
            }
            if (isAuthError(res)) throw new ApiError("SESSION_INVALID:登录态无效", { retryable: false });
            const d = (res && res.data) || null;
            const t = Number(d && d.sign_in_today);
            // 权威门控：code=0 + sign_in_today 为有限数字，否则读未知
            if (codeOf(res) !== 0 || !Number.isFinite(t) || !d || typeof d !== "object") {
                lastErr = new ApiError(`READ_UNCERTAIN:状态读非权威(code=${codeOf(res)})`, { retryable: true, transient: true });
                if (isTransientStatus(res && res.httpStatus) && attempt < this.maxRetries) { await this.wait(this.confirmDelayMs * (attempt + 1)); continue; }
                return { authoritative: false, signedToday: false, point: null, days: null, raw: res };
            }
            const info = {
                authoritative: true,
                signedToday: t > 0, // 未签时实测为 -1
                point: d.user && d.user.point,
                days: d.sign_in_day_continue,
                raw: res,
            };
            this.log(`积分 ${info.point ?? "-"}，连签 ${info.days ?? "-"} 天，今日${info.signedToday ? "已签" : "未签"}`);
            return info;
        }
        throw lastErr || new ApiError("READ_UNCERTAIN", { retryable: true, transient: true });
    }

    async ensureLogin() {
        const cached = this.readCache()[this.account.openid] || {};
        if (!this.token && cached.token) {
            this.token = cached.token;
            try {
                const info = await this.readSignState(); // 5s 短超时检测缓存 token 有效性由 request 超时另配
                this.log("使用缓存token");
                return info;
            } catch (e) {
                this.log("缓存token失效，重新登录");
                this.token = "";
            }
        }
        if (!this.token) await this.login();
        return null;
    }

    // ── 写状态机 ──
    stateAll() { return readStateFileStrict(this.writeStateFile); }
    stateKey() { return `${this.account.openid}::SIGN`; }
    stateFor() {
        const all = this.stateAll();
        const k = this.stateKey();
        const todayStr = today();
        if (!all[k] || all[k].date !== todayStr) return { date: todayStr, outcome: null, attempts: 0 };
        const cur = Object.assign({}, all[k]);
        cur.attempts = Number(cur.attempts || (cur.outcome ? 1 : 0));
        return cur;
    }
    recordState(entry) {
        const k = this.stateKey();
        // 共享 wx 锁覆盖 读磁盘→merge→rename→回读；竞争 fail-closed 阻写，不删他人锁
        const rel = this.sharedLock("maopu_shared_state.lock");
        if (!rel) throw new WriteUnknownError("共享状态文件锁竞争，已阻止写请求（保留他人锁）");
        try {
            const fresh = this.stateAll();
            fresh[k] = Object.assign({}, fresh[k] || {}, entry, { date: today() });
            if (!writeJsonFileAtomic(this.writeStateFile, fresh)) throw new WriteUnknownError("防重放状态落盘失败，已阻止写请求");
            const back = (readStateFileStrict(this.writeStateFile))[k];
            if (!back || back.date !== fresh[k].date || back.outcome !== fresh[k].outcome || Number(back.attempts || 0) !== Number(fresh[k].attempts || 0)) {
                throw new WriteUnknownError("防重放状态回读校验失败，已阻止写请求");
            }
            return back;
        } finally { rel(); }
    }
    stateTimeMs(st) {
        const p = Date.parse(st && st.lastAttemptAt || "");
        if (Number.isFinite(p)) return p;
        try { return fs.statSync(this.writeStateFile).mtimeMs; } catch (_) { return 0; }
    }

    // ── 单账户非阻塞进程锁（B4）：覆盖 权威读→落盘→写/收敛 全程；EEXIST 竞争不写、不删未知锁 ──
    lockFile() {
        const h = crypto.createHash("sha1").update(String(this.account.openid || "default")).digest("hex").slice(0, 12);
        return path.join(path.dirname(this.writeStateFile), `maopu_sign_${h}.lock`);
    }
    acquireLock() {
        const f = this.lockFile();
        let fd = null;
        try {
            fd = fs.openSync(f, "wx");
            fs.writeSync(fd, `pid=${process.pid}\n`);
            return f;
        } catch (e) {
            return null;
        } finally {
            try { if (fd !== null) fs.closeSync(fd); } catch (_) {}
        }
    }
    releaseLock(f) { try { if (f) fs.unlinkSync(f); } catch (_) {} }

    // ── 共享文件级锁（cache/state 多账户合并窗口）：wx 创建锁文件，竞争 fail-closed 阻写，不删他人锁 ──
    sharedLock(name) {
        const f = path.join(path.dirname(this.writeStateFile), name);
        let fd = null;
        try {
            fd = fs.openSync(f, "wx");
            fs.writeSync(fd, `pid=${process.pid}\n`);
            const rel = () => { try { if (fd !== null) fs.closeSync(fd); } catch (_) {} try { fs.unlinkSync(f); } catch (_) {} };
            return rel;
        } catch (e) {
            try { if (fd !== null) fs.closeSync(fd); } catch (_) {}
            return null;
        }
    }

    async writeOnce(fn, { allowRecovery = false } = {}) {
        const st = this.stateFor();
        const attempts = Number(st.attempts || 0);
        if (st.outcome === "success") return { cached: true };
        if (st.outcome === "attempting" && !allowRecovery) throw new WriteUnknownError("签到写此前请求可能仍在途或进程异常退出，按安全策略不再发起");
        if (st.outcome === "unknown" && !allowRecovery) throw new WriteUnknownError("签到写今日结果未知，按安全策略不再重复发起，需核对服务端状态");
        // 总写硬上限：任何 outcome（含 failed）都不豁免，当日最多 2 次写
        if (attempts >= 2) throw new WriteUnknownError("今日签到写已达安全尝试上限（2 次），不再自动发起");

        const attemptNo = attempts + 1;
        const startedAt = new Date(this.now()).toISOString();
        this.recordState({ outcome: "attempting", attempts: attemptNo, lastAttemptAt: startedAt });
        try {
            let res;
            try { res = await fn(); }
            catch (e) {
                // 出网已发起：任何异常（含非2xx/非JSON/网络瞬态）一律 unknown retryable=0
                throw new WriteUnknownError(`签到写第${attemptNo}次发起后结果未知（${short(e.message || e)}），未在本进程重复发起`);
            }
            if (codeOf(res) === 0) {
                this.recordState({ outcome: "success", attempts: attemptNo, lastAttemptAt: startedAt, confirmedAt: new Date(this.now()).toISOString() });
                return { ok: true, res };
            }
            if (isAlreadyDone(msgOf(res))) {
                this.recordState({ outcome: "success", attempts: attemptNo, lastAttemptAt: startedAt, confirmedAt: new Date(this.now()).toISOString(), source: "business-already" });
                return { ok: true, already: true, res };
            }
            if (codeOf(res) === NEED_PROFILE) {
                // 账号态硬门槛：明确失败，不重试，不伪装成功
                this.recordState({ outcome: "failed", attempts: attemptNo, lastAttemptAt: startedAt });
                return { ok: false, res, hard: true };
            }
            // 明确业务失败（有结构化响应）：failed，外层 retryable=0，不整段重放
            if (res && typeof res === "object") {
                this.recordState({ outcome: "failed", attempts: attemptNo, lastAttemptAt: startedAt });
                return { ok: false, res };
            }
            // 其他未知结构（非JSON/HTML）→ unknown0
            throw new WriteUnknownError("签到写响应结构未知，按结果未知只读收敛");
        } catch (e) {
            if (e instanceof WriteUnknownError) throw e;
            throw new WriteUnknownError(`签到写异常（${short(e.message || e)}），按未知处理`);
        }
    }

    async convergeAfterUnknown() {
        for (const delay of [1000, 3000, 7000]) {
            await this.wait(delay);
            try {
                const s = await this.readSignState();
                if (s.authoritative && s.signedToday) return true;
            } catch (_) {}
        }
        return false;
    }

    async sign() {
        const lock = this.acquireLock();
        if (!lock) { this.outcome = "unknown"; this.retryable = 0; this.log("❗检测到同账户签到进程在运行（锁竞争），本次不发写、不删未知进程锁"); return; }
        try { await this._signLocked(); } finally { this.releaseLock(lock); }
    }

    async _signLocked() {
        let info;
        try { info = await this.readSignState(); }
        catch (e) {
            if (e instanceof ApiError && /SESSION_INVALID/.test(e.message)) throw e;
            // 读失败且今日已发生过写 → 不得外层整段重放
            const pw0 = this.stateFor();
            const pwPast = pw0.outcome === "unknown" || pw0.outcome === "attempting" || Number(pw0.attempts || 0) > 0;
            this.outcome = "unknown"; this.retryable = (e.retryable && !pwPast) ? 1 : 0;
            this.log(`⚠️ 签到状态读失败，本次不发写：${e.message || e}`);
            return;
        }
        if (info.signedToday) {
            this.outcome = "already";
            // B1 跨日元数据收敛：权威已签 + lastAttemptAt 属当日 → 对齐 date 保留真实 attempts/时间，不发业务写
            const raw = (this.stateAll()[this.stateKey()] || {});
            const CST = 8 * 3600000;
            const cstDayOf = (ms) => Math.floor((ms + CST) / 86400000);
            const t0 = Date.parse(raw.lastAttemptAt || "");
            const lastIsToday = Number.isFinite(t0) && cstDayOf(t0) === cstDayOf(this.now());
            if (lastIsToday) {
                this.recordState({ outcome: "success", attempts: Number(raw.attempts || 1), lastAttemptAt: raw.lastAttemptAt, confirmedAt: raw.confirmedAt || new Date(this.now()).toISOString(), source: "authoritative-converge" });
            } else if (!raw.date || raw.date !== today()) {
                this.recordState({ outcome: "success", attempts: 0, confirmedAt: new Date(this.now()).toISOString(), source: "authoritative-read" });
            }
            this.log("✅ 今日已签到（服务端记录），无需重复执行");
            return;
        }
        if (!info.authoritative) {
            // 今日已发生过写时 retryable=0（防 unknown 绕过整段重放）
            const pw = this.stateFor();
            const pastWrite = pw.outcome === "unknown" || pw.outcome === "attempting" || Number(pw.attempts || 0) > 0;
            this.outcome = "unknown"; this.retryable = pastWrite ? 0 : 1;
            this.log("⚠️ 签到状态读非权威（网关/体异常），为避免重复写本次跳过，不发签到");
            return;
        }
        if (this.readOnly) { this.outcome = "readonly"; this.log("🔒 只读模式：权威确认今日未签到，但按契约不发写"); return; }

        const st = this.stateFor();
        let allowRecovery = false;
        if (st.outcome === "attempting" || st.outcome === "unknown" || st.outcome === "failed") {
            const attempts = Number(st.attempts || 1);
            const ageMs = this.now() - this.stateTimeMs(st);
            if (attempts >= 2) { this.outcome = "unknown"; this.retryable = 0; this.log("❗今日已两次写且结果未知，不再自动发起"); return; }
            if (ageMs < this.unknownCooldownMs) {
                this.outcome = "unknown"; this.retryable = 0;
                this.log(`❗写结果未知仍在冷却期（约${Math.ceil((this.unknownCooldownMs - ageMs) / 60000)}分钟），未重复发起`);
                return;
            }
            const a1 = await this.readSignState().catch(() => ({ authoritative: false }));
            await this.wait(this.confirmDelayMs);
            const a2 = await this.readSignState().catch(() => ({ authoritative: false }));
            if (!a1.authoritative || !a2.authoritative || a1.signedToday || a2.signedToday) {
                this.outcome = "unknown"; this.retryable = 0;
                if (a1.signedToday || a2.signedToday) { this.recordState({ outcome: "success", attempts, confirmedAt: new Date(this.now()).toISOString(), source: "authoritative-log" }); this.log("✅ 未知写入已由服务端记录确认"); }
                else this.log("❗冷却期后权威状态未能连续确认，未重复发起");
                return;
            }
            allowRecovery = true;
            this.log("ℹ️ 冷却期已过且连续两次权威读确认未签到，执行最后一次恢复写");
        }

        try {
            const r = await this.writeOnce(() => this.request(EP_SIGN, { body: { date: today() }, signKeys: ["date"] }), { allowRecovery });
            if (r.cached) { this.outcome = "success"; this.log("✅ 今日已签到（本日成功状态）"); return; }
            if (r.ok && r.already) { this.outcome = "already"; this.log(`✅ 今日已签到（${msgOf(r.res)}）`); return; }
            if (r.ok) {
                const gained = r.res && r.res.data && r.res.data.point;
                this.outcome = "success";
                this.log(`✅ 签到成功${gained ? `，+${gained} 积分` : ""}`);
                await this.readSignState().catch(() => {});
                return;
            }
            if (r.hard) {
                this.outcome = "failed"; this.retryable = 0;
                this.log(`⚠️ ${msgOf(r.res)} —— 登录和签名都通了，是账号资料没填全（手机号等），先在小程序里完善个人信息再跑`);
                return;
            }
            // 明确业务失败：retryable=0，外层不整段重放
            this.outcome = "failed"; this.retryable = 0;
            this.log(`❌ 签到失败: ${msgOf(r.res)}`);
        } catch (e) {
            if (e instanceof WriteUnknownError) {
                this.outcome = "unknown"; this.retryable = 0;
                const converged = await this.convergeAfterUnknown();
                if (converged) { this.outcome = "already"; this.log("✅ 写后经服务端记录确认今日已签"); }
                else this.log(`❗ ${e.message}`);
                return;
            }
            // 写路径上其他异常：今日已有写发生则不得 retryable=1
            const pw1 = this.stateFor();
            const pwPast1 = pw1.outcome === "unknown" || pw1.outcome === "attempting" || Number(pw1.attempts || 0) > 0;
            this.outcome = "failed"; this.retryable = (e.retryable && !pwPast1) ? 1 : 0;
            this.log(`❌ 签到异常: ${e.message || e}`);
        }
    }

    async run() {
        if (!this.account.openid) { this.log("跳过：变量值里没有 openid"); this.outcome = "skipped"; return; }
        try {
            const info = await this.ensureLogin();
            await this.sign(info);
        } catch (e) {
            const m = String(e.message || e);
            this.retryable = e.retryable ? 1 : 0;
            if (/SESSION_INVALID/.test(m)) { this.outcome = "failed"; this.retryable = 0; this.log(`⚠️ ${m}`); return; }
            this.outcome = "failed"; this.log(`执行失败: ${m}`);
        }
    }
}

function composeResult({ accounts, failed, retryable, readOnly }) {
    if (failed > 0) {
        return { ok: false, line: `[QLRUN_RESULT] FAILURE accounts=${accounts} failed=${failed} retryable=${retryable}`, retryable };
    }
    return { ok: true, line: `[QLRUN_RESULT] SUCCESS accounts=${accounts} failed=0 retryable=0 mode=${readOnly ? "只读" : "任务"}`, retryable: 0 };
}

if (require.main === module) {
    const wechat = new WeChatServer({
        url: process.env.wx_server_url || "http://192.168.31.196:8787",
        appid: MINI_APP_ID,
        auth: process.env.wx_auth || "",
    });

    let result = null;
    const finalize = () => {
        const rc = result && result.ok ? 0 : 1;
        const halt = () => process.exit(rc);
        if ($.sendMsg) $.sendMsg().catch(() => {}).finally(halt); else halt();
    };
    !(async () => {
        $.checkEnv(ckName);
        if (!$.userCount) {
            $.log(`未找到变量 ${ckName}`);
            result = { ok: false, line: `[QLRUN_RESULT] FAILURE accounts=0 failed=1 retryable=0`, retryable: 0 };
            $.log(result.line);
            return;
        }
        let failed = 0; const retr = new Set();
        for (let i = 0; i < $.userList.length; i++) {
            const t = new Task($.userList[i], { index: i + 1, logger: $, http: axios, wechat });
            await t.run();
            if (t.outcome === "failed" || t.outcome === "unknown") failed++;
            if (t.retryable) retr.add(1);
            if (i < $.userList.length - 1) await $.wait(1500, 3000);
        }
        const readOnly = boolEnv("MAOPU_READ_ONLY", false);
        result = composeResult({ accounts: $.userList.length, failed, retryable: retr.has(1) ? 1 : 0, readOnly });
        $.log(result.line);
    })().catch((e) => {
        // B5：入口兜底——任何未捕获异常也要输出唯一契约行并 rc=1
        if (!result) result = { ok: false, line: `[QLRUN_RESULT] FAILURE accounts=0 failed=1 retryable=0 mode=任务 reason=uncaught`, retryable: 0 };
        $.log(`❌ 入口异常: ${e && e.message || e}`);
        $.log(result.line);
    }).finally(finalize);
}

module.exports = { Task, composeResult, today, parseAccount };
