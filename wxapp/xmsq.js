/*
------------------------------------------
@Description: 小米社区 - 微信小程序登录 + 每日签到（防重放/状态机加固版）
cron: 15 8 * * *
------------------------------------------
变量名：xmsq
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行分隔（可加 #备注）

依赖变量：
wx_server_url  默认 http://192.168.31.196:8787
wx_auth        必填，wx_server 鉴权值

加固点（与 tools/qlall 判定契约对齐）：
  - 读（mypagedata）按权威门控分类：HTTP200 且体可解析且含 entity 才算权威；
    5xx/HTML/缺 entity 一律视为“读未知”，绝不据此发写。
  - 写（addCommunityGrowUpPointByActionV2）发请求前先原子落盘 attempting(tmp+0600+rename+回读)，
    落盘/回读失败即在出网前阻断；写后未知只做只读收敛，本进程不重发。
  - 当日硬上限 2 次写；attempting/unknown 经冷却期 + 连续两次权威读确认未签，才允许最后一次恢复写。
  - 结束输出 [QLRUN_RESULT] SUCCESS|FAILURE ... retryable=0|1；写后未知/硬失败 retryable=0（qlall 停外层整段重放）。
  - XMSQ_READ_ONLY=1：只做登录+权威查询，绝不发写，用于生产只读契约验证。
  - bridge(wcs.getCode) 用 XMSQ_BRIDGE_TIMEOUT_MS 包一层竞态超时（wcs 自身 timeout 单位异常，不改动该共享文件）。
------------------------------------------
*/

const path = require("path");
const fs = require("fs");

const ckName = "xmsq";
const MINI_APP_ID = "wx240a4a764023c444";
const PAGE_VERSION = "73";
const ACCOUNT = "https://account.xiaomi.com";
const BASE = "https://api.vip.miui.com";
const SID = "wx_vip";
const WRITE_ACTION = "WECHAT_CHECKIN_TASK";
const TOKEN_CACHE_FILE = path.join(__dirname, "xmsq_token_cache.json");
const WRITE_STATE_FILE = path.join(__dirname, "xmsq_write_state.json");
const UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
    "Mobile/15E148 MicroMessenger/8.0.73(0x18004939) NetType/WIFI Language/zh_CN";
const REFERER = `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`;

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

// ── 基础工具（保留原行为） ──
function parseAccount(raw = "") {
    const [id, remark] = String(raw).split("#").map((s) => (s || "").trim());
    return { openid: id, remark: remark || "" };
}
function short(v, n = 300) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}
function parseXiaomiJson(text) {
    if (text == null) return {};
    if (typeof text === "object") return text;
    let t = String(text);
    if (t.startsWith("&&&START&&&")) t = t.slice("&&&START&&&".length);
    try { return JSON.parse(t); } catch (e) { return { __raw: t }; }
}
function isAuthzError(m) {
    return /未注册|未绑定|未激活|用户不存在|请先登录|登录已过期|登录失效|未登录|无权限|会话失效|SESSION_INVALID/i.test(String(m));
}
const ALREADY_SIGNED_RE = /已签|签到过|重复|已完成|already/i;
function chinaToday() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
// 瞬时/网关类（仅对幂等读有界重试；写请求绝不内部重试）
function isTransientStatus(s) { return !s || s === 408 || s === 429 || s >= 500; }
function isTransientError(e) {
    if (!e) return false;
    return !!e.transient || /timeout|aborted|network|econn|socket|502|503|504|gateway/i.test(String(e.code || e.message || e));
}

// ── 结构化错误（带可重试标记，供 qlall 契约） ──
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

// ── 原子 JSON 读写：tmp(0600) + rename + 回读校验 ──
function readJsonFile(file, fallback) {
    try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, "utf8")) || fallback; }
    catch (e) { return fallback; }
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

class CookieJar {
    constructor() { this.map = {}; }
    setFromResponse(res) {
        const sc = res && res.headers && res.headers["set-cookie"];
        if (!sc) return;
        for (const line of sc) {
            const seg = String(line).split(";")[0];
            const eq = seg.indexOf("=");
            if (eq < 0) continue;
            this.map[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
        }
    }
    set(name, val) { this.map[name] = String(val); }
    get(name) { return this.map[name]; }
    header() { return Object.entries(this.map).map(([k, v]) => `${k}=${v}`).join("; "); }
}

class Task {
    constructor(raw, options = {}) {
        this.account = parseAccount(raw);
        this.index = options.index ?? 1;
        this.logger = options.logger || console;
        this.http = options.http;          // 可注入；未注入时在 bootstrap 里接 axios
        this.wechat = options.wechat;      // 可注入 bridge
        this.wait = options.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.now = options.now || (() => Date.now());
        this.readOnly = options.readOnly ?? boolEnv("XMSQ_READ_ONLY", false);
        this.maxRetries = options.maxRetries ?? intEnv("XMSQ_MAX_RETRIES", 2, 0, 5);
        this.timeout = options.timeout || intEnv("XMSQ_HTTP_TIMEOUT", 20000, 3000, 60000);
        this.bridgeTimeoutMs = options.bridgeTimeoutMs ?? intEnv("XMSQ_BRIDGE_TIMEOUT_MS", 20000, 3000, 120000);
        this.unknownCooldownMs = options.unknownCooldownMs ?? intEnv("XMSQ_UNKNOWN_RETRY_AFTER_MS", 1800000, 300000, 43200000);
        this.confirmDelayMs = options.confirmDelayMs ?? intEnv("XMSQ_UNKNOWN_CONFIRM_DELAY_MS", 3000, 1000, 30000);
        this.tokenCacheFile = options.tokenCacheFile || TOKEN_CACHE_FILE;
        this.writeStateFile = options.writeStateFile || WRITE_STATE_FILE;
        this.jar = new CookieJar();
        this.ph = null;
        // 结果分类
        this.outcome = "pending";          // pending|already|success|readonly|failed|unknown|skipped
        this.retryable = 0;
        this.loginTransient = false;
    }
    log(text) { this.logger.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`); }

    // ── 缓存：只用于回填 cookie，会话票据 ph 一律现场 STS 重签；不绕过鉴权 ──
    readCache() { return readJsonFile(this.tokenCacheFile, {}) || {}; }
    writeCache(c) {
        if (!writeJsonFileAtomic(this.tokenCacheFile, c)) this.log("⚠️ 写入 token 缓存失败");
    }

    // ── bridge：包一层竞态超时，分类 bridge 失败（wcs 自身 timeout 单位异常，不改该共享文件） ──
    async getCode() {
        const p = this.wechat.getCode(this.account.openid);
        let timer;
        const timeout = new Promise((_, rej) => {
            timer = setTimeout(() => rej(new ApiError("BRIDGE_TIMEOUT:wx_server 取 code 超时", { retryable: true, transient: true })), this.bridgeTimeoutMs);
        });
        try {
            const { data } = await Promise.race([p, timeout]);
            if (data && data.status === false) throw new ApiError(`BRIDGE:wx_server 取 code 失败: ${data.message || short(data)}`, { retryable: true, transient: true });
            const code = data?.data?.code || data?.code;
            if (!code || typeof code !== "string") throw new ApiError(`BRIDGE:wx_server 未返回 code: ${short(data)}`, { retryable: true, transient: true });
            return code;
        } finally { clearTimeout(timer); }
    }
    async getUserInfoBlob() {
        try {
            const res = await this.http.post(`${this.wechat.serverUrl}/wx/getuserinfo`, { appid: MINI_APP_ID, openid: this.account.openid },
                { headers: { auth: this.wechat.auth }, timeout: 20000, validateStatus: () => true });
            const d = res.data && res.data.data;
            if (!res.data || res.data.status === false || !d || !d.encryptedData) return null;
            let profile = {}; try { profile = JSON.parse(d.data); } catch (e) {}
            return { cloudID: d.cloud_id, encryptedData: d.encryptedData, iv: d.iv, signature: d.signature, userInfo: profile, rawData: d.data, errMsg: "getUserInfo:ok" };
        } catch (e) { return null; }
    }

    async req(method, url, { form, params, allowRedirect = true } = {}) {
        const headers = { "User-Agent": UA, Referer: REFERER, Origin: "https://servicewechat.com", Accept: "*/*" };
        const cookie = this.jar.header();
        if (cookie) headers.Cookie = cookie;
        let data;
        if (form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; data = new URLSearchParams(form).toString(); }
        const res = await this.http.request({
            method, url, data, params, headers,
            timeout: this.timeout, responseType: "text",
            transformResponse: (r) => r, maxRedirects: allowRedirect ? 5 : 0, validateStatus: () => true,
        });
        this.jar.setFromResponse(res);
        return res;
    }

    async login() {
        const code = await this.getCode();
        const userInfoBlob = await this.getUserInfoBlob();
        this.jar.set("deviceId", `wp_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);

        // 1) code → wxSToken
        const r1 = await this.req("POST", `${ACCOUNT}/pass/sns/wxapp/v2/code`, { form: { code, appid: MINI_APP_ID, sid: SID, userInfo: "true", _locale: "zh_CN" } });
        const b1 = parseXiaomiJson(r1.data);
        if (b1.__raw || b1.code !== 0) throw new ApiError(`NO_ACCOUNT:微信换取小米登录票据失败(code=${b1.code}, ${b1.description || b1.desc || short(b1)})`, { retryable: !!b1.__raw, transient: !!b1.__raw });
        const wxSToken = b1.data && b1.data.wxSToken;
        if (!wxSToken) throw new ApiError(`NO_ACCOUNT:小米登录响应缺少 wxSToken: ${short(b1)}`, { retryable: false });
        this.jar.set("wxSToken", wxSToken);
        if (userInfoBlob) this.jar.set("userInfo", encodeURIComponent(JSON.stringify(userInfoBlob)));

        // 2) tokenLogin（不跟随重定向；302 时回退本地缓存票据，但 ph 仍现场 STS 重签）
        const r2 = await this.req("POST", `${ACCOUNT}/pass/sns/wxapp/v3/tokenLogin`, { form: { sid: SID, appid: MINI_APP_ID, callback: "", authType: "1", wxSToken, _locale: "zh_CN" }, allowRedirect: false });
        let session = {};
        if (r2.status >= 300 && r2.status < 400) {
            const cached = this.readCache()[this.account.openid] || {};
            if (!cached.passToken || !cached.userId) {
                // minicookie/userInfo 缺失 + 无本地票据 → 明确分类失败，不静默写
                throw new ApiError(`MINICOOKIE:缺少微信 userInfo 资料且本地无首登票据，请在真机小程序登录一次后再跑（tokenLogin 302）`, { retryable: false });
            }
            session = cached;
            this.log("已加载本地缓存会话票据（ph 将现场 STS 重签）");
        } else {
            const b2 = parseXiaomiJson(r2.data);
            if (b2.__raw) throw new ApiError("LOGIN_TRANSIENT:小米 tokenLogin 返回非 JSON/网关错误", { retryable: true, transient: true });
            if (!b2.passToken) {
                if (b2.code === 20003) throw new ApiError(`NO_ACCOUNT:小米账号不存在(20003 ${b2.description || "用户不存在"})`, { retryable: false });
                if (b2.code === 24023) throw new ApiError(`NOT_ACTIVATED:小米账号未设置密码(24023 用户密码未设置)`, { retryable: false });
                throw new ApiError(`小米会话建立失败: ${short(b2)}`, { retryable: false });
            }
            session = { passToken: b2.passToken, userId: b2.userId, cUserId: b2.cUserId };
            const cache = this.readCache();
            cache[this.account.openid] = { ...session, updatedAt: new Date().toISOString() };
            this.writeCache(cache);
        }
        for (const k of ["passToken", "userId", "cUserId"]) if (session[k]) this.jar.set(k, session[k]);

        // 3) serviceLogin → 4) STS 重签 wx_vip_ph（ph 必须现场拿到，拿不到即鉴权失败，不写）
        const r3 = await this.req("GET", `${ACCOUNT}/pass/serviceLogin`, { params: { sid: SID, _json: "true", _locale: "zh_CN" } });
        const b3 = parseXiaomiJson(r3.data);
        if (b3.__raw || b3.code !== 0 || !b3.location) throw new ApiError(b3.__raw ? "LOGIN_TRANSIENT:serviceLogin 网关错误" : `serviceLogin 失败: ${short(b3)}`, { retryable: !!b3.__raw, transient: !!b3.__raw });
        const r4 = await this.req("GET", b3.location);
        const b4 = parseXiaomiJson(r4.data);
        if (b4.__raw || b4.S !== "OK") throw new ApiError(b4.__raw ? "LOGIN_TRANSIENT:STS 网关错误" : `STS 登录失败: ${short(b4)}`, { retryable: !!b4.__raw, transient: !!b4.__raw });
        const ph = this.jar.get("wx_vip_ph");
        if (!ph) throw new ApiError("SESSION_INVALID:STS 未返回 wx_vip_ph", { retryable: false });
        this.ph = ph;
        this.log("登录成功");
    }

    // ── 权威读：mypagedata。返回 {authoritative, already, raw} ──
    async readSignState() {
        let lastErr = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            let res;
            try { res = await this.req("GET", `${BASE}/mtop/planet/wechat/checkin/mypagedata`, { params: { wx_vip_ph: this.ph } }); }
            catch (e) { lastErr = e; if (isTransientError(e) && attempt < this.maxRetries) { await this.wait(this.confirmDelayMs * (attempt + 1)); continue; } throw e; }
            const body = parseXiaomiJson(res.data);
            if (res.status === 401 || body.code === 401) throw new ApiError("SESSION_INVALID:小米登录态无效", { retryable: false });
            // 权威门控：必须 HTTP 2xx + 可解析 + 有 entity.data 数组，否则视为读未知，不发写
            if (!res.status || res.status >= 300 || body.__raw || !body.entity || !Array.isArray(body.entity.data)) {
                lastErr = new ApiError(`READ_UNCERTAIN:签到状态读非权威(status=${res.status})`, { retryable: true, transient: true });
                if (isTransientStatus(res.status) && attempt < this.maxRetries) { await this.wait(this.confirmDelayMs * (attempt + 1)); continue; }
                return { authoritative: false, already: false, raw: body };
            }
            const buttons = body.entity.data || [];
            const already = buttons.some((it) => it && it.title === "每日签到" && it.buttons && it.buttons[0] && it.buttons[0].button === "已签到");
            return { authoritative: true, already, raw: body };
        }
        throw lastErr || new ApiError("READ_UNCERTAIN", { retryable: true, transient: true });
    }

    // ── 写状态机 ──
    stateAll() { return readJsonFile(this.writeStateFile, {}) || {}; }
    stateKey() { return `${this.account.openid}::${WRITE_ACTION}`; }
    stateFor() {
        const all = this.stateAll();
        const k = this.stateKey();
        const today = chinaToday();
        if (!all[k] || all[k].date !== today) return { date: today, outcome: null, attempts: 0 };
        const cur = Object.assign({}, all[k]);
        cur.attempts = Number(cur.attempts || (cur.outcome ? 1 : 0));
        return cur;
    }
    recordState(entry) {
        const all = this.stateAll();
        const k = this.stateKey();
        all[k] = Object.assign({ date: chinaToday() }, all[k] || {}, entry);
        if (!writeJsonFileAtomic(this.writeStateFile, all)) throw new ApiError("防重放状态落盘失败，已阻止写请求", { retryable: false });
        const back = (readJsonFile(this.writeStateFile, {}) || {})[k];
        if (!back || back.date !== all[k].date || back.outcome !== all[k].outcome || Number(back.attempts || 0) !== Number(all[k].attempts || 0)) {
            throw new ApiError("防重放状态回读校验失败，已阻止写请求", { retryable: false });
        }
        return back;
    }
    stateTimeMs(st) {
        const p = Date.parse(st && st.lastAttemptAt || "");
        if (Number.isFinite(p)) return p;
        try { return fs.statSync(this.writeStateFile).mtimeMs; } catch (_) { return 0; }
    }

    async writeOnce(fn, { allowRecovery = false } = {}) {
        const st = this.stateFor();
        const attempts = Number(st.attempts || 0);
        if (st.outcome === "success") return { cached: true };
        if (st.outcome === "attempting" && !allowRecovery) throw new WriteUnknownError("签到写此前请求可能仍在途或进程异常退出，按安全策略不再发起");
        if (st.outcome === "unknown" && !allowRecovery) throw new WriteUnknownError("签到写今日结果未知，按安全策略不再重复发起，需核对服务端状态");
        if (st.outcome !== "failed" && attempts >= (allowRecovery ? 2 : 1)) throw new WriteUnknownError("今日签到写已达安全尝试上限，不再自动发起");

        const attemptNo = attempts + 1;
        const startedAt = new Date(this.now()).toISOString();
        this.recordState({ outcome: "attempting", attempts: attemptNo, lastAttemptAt: startedAt }); // 出网前落盘
        try {
            const res = await fn();
            if (res && res.message === "success") {
                this.recordState({ outcome: "success", attempts: attemptNo, lastAttemptAt: startedAt, confirmedAt: new Date(this.now()).toISOString() });
                return { ok: true, res };
            }
            if (ALREADY_SIGNED_RE.test(String(res && (res.message || res.description)))) {
                this.recordState({ outcome: "success", attempts: attemptNo, lastAttemptAt: startedAt, confirmedAt: new Date(this.now()).toISOString(), source: "business-already" });
                return { ok: true, already: true, res };
            }
            // 明确业务失败（HTTP200 且有业务响应）→ failed，可日后重试，不当作未知
            this.recordState({ outcome: "failed", attempts: attemptNo, lastAttemptAt: startedAt });
            return { ok: false, res };
        } catch (e) {
            if (e instanceof WriteUnknownError) throw e;
            if (isTransientError(e)) {
                this.recordState({ outcome: "unknown", attempts: attemptNo, lastAttemptAt: startedAt });
                throw new WriteUnknownError(`签到写第${attemptNo}次发起后结果未知（${short(e.message || e)}），未在本进程重复发起`);
            }
            this.recordState({ outcome: "failed", attempts: attemptNo, lastAttemptAt: startedAt });
            throw e;
        }
    }

    // 写后只读收敛：只查不写，连续轮询权威状态
    async convergeAfterUnknown() {
        for (const delay of [1000, 3000, 7000]) {
            await this.wait(delay);
            try {
                const s = await this.readSignState();
                if (s.authoritative && s.already) return true;
            } catch (_) {}
        }
        return false;
    }

    async sign() {
        let s;
        try { s = await this.readSignState(); }
        catch (e) {
            if (e instanceof ApiError && /SESSION_INVALID/.test(e.message)) throw e;
            // 读本身失败（非鉴权）→ 不发写，记未知，retryable 视瞬时
            this.outcome = "unknown"; this.retryable = e.retryable ? 1 : 0;
            this.log(`⚠️ 签到状态读失败，本次不发写：${e.message || e}`);
            return;
        }
        if (s.already) {
            this.outcome = "already";
            const st = this.stateFor();
            if (st.outcome && st.outcome !== "success") this.recordState({ outcome: "success", attempts: st.attempts, lastAttemptAt: st.lastAttemptAt, confirmedAt: new Date(this.now()).toISOString(), source: "authoritative-read" });
            this.log("✅ 今日已签到（服务端记录），无需重复执行");
            return;
        }
        if (!s.authoritative) {
            // 读非权威 → 绝不写
            this.outcome = "unknown"; this.retryable = 1;
            this.log("⚠️ 签到状态读非权威（网关/体异常），为避免重复写本次跳过，不发签到");
            return;
        }
        // 权威确认未签
        if (this.readOnly) { this.outcome = "readonly"; this.log("🔒 只读模式：权威确认今日未签到，但按契约不发写"); return; }

        // 重入：attempting/unknown 需冷却 + 连续两次权威确认未签，才允许恢复写
        const st = this.stateFor();
        let allowRecovery = false;
        if (st.outcome === "attempting" || st.outcome === "unknown") {
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
            if (!a1.authoritative || !a2.authoritative || a1.already || a2.already) {
                this.outcome = "unknown"; this.retryable = 0;
                if (a1.already || a2.already) { this.recordState({ outcome: "success", attempts, confirmedAt: new Date(this.now()).toISOString(), source: "authoritative-log" }); this.log("✅ 未知写入已由服务端记录确认"); }
                else this.log("❗冷却期后权威状态未能连续确认，未重复发起");
                return;
            }
            allowRecovery = true;
            this.log("ℹ️ 冷却期已过且连续两次权威读确认未签到，执行最后一次恢复写");
        }

        try {
            const r = await this.writeOnce(() => this.req("POST", `${BASE}/mtop/planet/wechat/member/addCommunityGrowUpPointByActionV2`, { params: { wx_vip_ph: this.ph }, form: { action: WRITE_ACTION } }).then((res) => ({ ...parseXiaomiJson(res.data), __status: res.status })), { allowRecovery });
            if (r.cached) { this.outcome = "success"; this.log("✅ 今日已签到（本日成功状态）"); return; }
            if (r.ok && r.already) { this.outcome = "already"; this.log(`✅ 今日已签到（${r.res.message || "业务返回已签"}）`); return; }
            if (r.ok) { this.outcome = "success"; const t = r.res.entity && r.res.entity.title; this.log(`✅ 签到成功${t ? `，${t}` : "，获得成长值"}`); return; }
            // 明确业务失败
            this.outcome = "failed"; this.retryable = 1;
            this.log(`❌ 签到失败: ${r.res.message || r.res.description || short(r.res)}`);
        } catch (e) {
            if (e instanceof WriteUnknownError) {
                this.outcome = "unknown"; this.retryable = 0;
                const converged = await this.convergeAfterUnknown();
                if (converged) { this.outcome = "already"; this.log("✅ 写后经服务端记录确认今日已签"); }
                else this.log(`❗ ${e.message}`);
                return;
            }
            this.outcome = "failed"; this.retryable = e.retryable ? 1 : 0;
            this.log(`❌ 签到异常: ${e.message || e}`);
        }
    }

    async run() {
        if (!this.account.openid) { this.log("跳过：变量值里没有 openid"); this.outcome = "skipped"; return; }
        try {
            await this.login();
            await this.sign();
        } catch (e) {
            const m = String(e.message || e);
            this.retryable = e.retryable ? 1 : 0;
            if (m.startsWith("NO_ACCOUNT")) { this.outcome = "failed"; this.retryable = 0; this.log(`⚠️ 该微信号尚未注册小米账号/社区。详情：${m.replace(/^NO_ACCOUNT:/, "")}`); return; }
            if (m.startsWith("NOT_ACTIVATED")) { this.outcome = "failed"; this.retryable = 0; this.log(`⚠️ 微信绑定的小米账号未激活。详情：${m.replace(/^NOT_ACTIVATED:/, "")}`); return; }
            if (m.startsWith("MINICOOKIE")) { this.outcome = "failed"; this.retryable = 0; this.log(`⚠️ ${m}`); return; }
            if (m.startsWith("BRIDGE") || m.startsWith("LOGIN_TRANSIENT")) { this.outcome = "unknown"; this.retryable = 1; this.loginTransient = true; this.log(`⚠️ 登录瞬时故障（可外层重试，无副作用）：${m}`); return; }
            this.outcome = "failed"; this.retryable = 0; this.log(`执行失败: ${m}`);
        }
    }
}

// ── qlall 契约汇总 ──
function composeResult({ accounts, failed, retryable, readOnly }) {
    if (failed > 0) {
        return { ok: false, line: `[QLRUN_RESULT] FAILURE accounts=${accounts} failed=${failed} retryable=${retryable}`, retryable };
    }
    return { ok: true, line: `[QLRUN_RESULT] SUCCESS accounts=${accounts} failed=0 retryable=0 mode=${readOnly ? "只读" : "任务"}`, retryable: 0 };
}

module.exports = { Task, composeResult, chinaToday, parseAccount, parseXiaomiJson, ALREADY_SIGNED_RE, ApiError, WriteUnknownError, WRITE_ACTION, TOKEN_CACHE_FILE, WRITE_STATE_FILE };

// ── 直接运行（青龙）入口：测试 require 时不执行 ──
if (require.main === module) {
    const { Env } = require("../tools/env.js");
    const WeChatServer = require("./wcs.js");
    const axios = require("axios");
    const $ = new Env("小米社区签到");
    const wechat = new WeChatServer({
        url: process.env.wx_server_url || "http://192.168.31.196:8787",
        appid: MINI_APP_ID, auth: process.env.wx_auth || "",
    });
    !(async () => {
        $.checkEnv(ckName);
        if (!$.userCount) { $.log(`未找到变量 ${ckName}`); return; }
        let failed = 0; const retr = new Set();
        for (let i = 0; i < $.userList.length; i++) {
            const t = new Task($.userList[i], { index: i + 1, logger: $, http: axios, wechat });
            await t.run();
            if (t.outcome === "failed" || t.outcome === "unknown") failed++;
            if (t.retryable) retr.add(1);
            if (i < $.userList.length - 1) await $.wait(1500, 3000);
        }
        const readOnly = boolEnv("XMSQ_READ_ONLY", false);
        const r = composeResult({ accounts: $.userList.length, failed, retryable: retr.has(1) ? 1 : 0, readOnly });
        $.log(r.line);
    })().catch((e) => $.log(e.message || e)).finally(() => $.done());
}
