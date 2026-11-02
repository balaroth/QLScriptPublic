/*
------------------------------------------
@Description: 汤星球 - 微信小程序静默登录 + 每日签到（硬化候选 v3，离线未部署）
------------------------------------------
变量名：txq；依赖 wx_server_url、wx_auth
契约：appid wx9bb6d5ac457bd69d，host vip.by-health.com，base /vip-api
  两层信封 {success, data:{rspCode:"00", result}}；登录 /auth/ma/login；
  discovery 只读 /sign/activity/detail {}；写 /sign/daily/create {activityId}。
防重放：state 按 CST 业务日 + openid + activityId 分 entry；写前 attempting 原子落盘回读；
  success/failed/unknown 三态；unknown 冷却+双权威确认才恢复写；当日每活动硬上限 2；
  外来锁 fail-closed 不盲删；TXQ_READ_ONLY=1 零写。
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("汤星球");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const ckName = "txq";
const MINI_APP_ID = "wx9bb6d5ac457bd69d";
const BASE = "https://vip.by-health.com/vip-api";
const H5_REFERER = "https://vip.by-health.com/web/vip-center-h5/";
const TOKEN_CACHE_FILE = path.join(__dirname, "txq_token_cache.json");
const STATE_FILE = path.join(__dirname, "txq_sign_state.json");
const LOCK_DIR = path.join(__dirname, "txq.lock");
const CACHE_LOCK_DIR = path.join(__dirname, "txq.cache.lock");
const READ_ONLY = process.env.TXQ_READ_ONLY === "1";
const COOLDOWN_MS = Number(process.env.TXQ_RECOVER_COOLDOWN_MS || 1800 * 1000);
const MAX_WRITES_PER_ACTIVITY = 2;
const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 12; M2012K11AC Build/SKQ1.220303.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Version/4.0 Chrome/134.0.6998.136 Mobile Safari/537.36 MicroMessenger/8.0.48.2580(0x28003036) MiniProgramEnv/android";

const EP_LOGIN = "/auth/ma/login";
const EP_SIGN_DETAIL = "/sign/activity/detail";
const EP_SIGN_CREATE = "/sign/daily/create";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://192.168.31.196:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

/* env.done() 可能 process.exit(0) 覆盖退出码；包装为最终以 exitCode 为准 */
const _origExit = process.exit.bind(process);
process.exit = (code) => {
    const finalCode = process.exitCode !== undefined ? process.exitCode : code;
    _origExit(finalCode === undefined ? 0 : finalCode);
};

/* ---------- 工具 ---------- */
/* 业务日 = Asia/Shanghai (UTC+8)，不用 UTC 串 */
function cstToday() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
}
function readJsonStrict(file) {
    // 不存在返回 null；存在但坏 JSON/类型错直接 throw（fail-closed，不吞）
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    let v;
    try { v = JSON.parse(raw); } catch (e) { throw new Error(`坏JSON ${path.basename(file)}: ${e.message}`); }
    return v;
}
function writeJsonAtomic(file, obj) {
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, file);
    const back = readJsonStrict(file);
    return back !== null && JSON.stringify(back) === JSON.stringify(obj);
}

function readCache() {
    const v = readJsonStrict(TOKEN_CACHE_FILE);
    if (v === null) return {};
    if (typeof v !== "object" || Array.isArray(v)) throw new Error("token cache schema 异常");
    return v;
}
function writeCache(cache) {
    try {
        if (!writeJsonAtomic(TOKEN_CACHE_FILE, cache)) throw new Error("回读校验失败");
        return true;
    } catch (e) {
        $.log(`写入token缓存失败，保留旧缓存`);
        return false;
    }
}
function readState() {
    const v = readJsonStrict(STATE_FILE);
    if (v === null) {
        if (fs.existsSync(STATE_FILE)) throw new Error("state 文件存在但内容为 null，fail-closed");
        return {};
    }
    if (typeof v !== "object" || Array.isArray(v)) throw new Error("state schema 异常：根非对象");
    const OK_STATUS = new Set(["success", "failed", "unknown", "attempting"]);
    for (const day of Object.keys(v)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`state key ${day} 非日期`);
        const d = v[day];
        if (typeof d !== "object" || d === null || Array.isArray(d)) throw new Error(`state[${day}] 非对象`);
        for (const openid of Object.keys(d)) {
            const acct = d[openid];
            if (typeof acct !== "object" || acct === null || Array.isArray(acct)) throw new Error(`state[${day}][${openid}] 非对象`);
            /* legacy: openid 直存 {status, attempts, ts} 扁平 entry（无 activityId 键）→ 跳过 schema 校验，由 run 保守处理 */
            if (typeof acct.status === "string" && !Object.values(acct).some(v => v && typeof v === "object")) continue;
            for (const act of Object.keys(acct)) {
                const e = acct[act];
                if (typeof e !== "object" || e === null || Array.isArray(e)) throw new Error(`entry 非对象`);
                if (e.status !== undefined && !OK_STATUS.has(e.status)) throw new Error(`entry status 非法: ${e.status}`);
                if (e.attempts !== undefined && (!Number.isInteger(e.attempts) || e.attempts < 0)) throw new Error(`entry attempts 非法`);
                if (e.ts !== undefined && (!Number.isFinite(e.ts) || e.ts < 0)) throw new Error(`entry ts 非法`);
            }
        }
    }
    return v;
}

function withCacheLock(fn) {
    try { fs.mkdirSync(CACHE_LOCK_DIR); } catch { return null; }
    try { return fn(); } finally { try { fs.rmdirSync(CACHE_LOCK_DIR); } catch {} }
}
function acquireLock() { try { fs.mkdirSync(LOCK_DIR); return true; } catch { return false; } }
function releaseLock() { try { fs.rmdirSync(LOCK_DIR); } catch {} }

function parseAccount(raw = "") {
    const [id, remark] = String(raw).split("#").map((s) => (s || "").trim());
    return { openid: id, remark: remark || "" };
}
function short(v, n = 200) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}
const bodyOf = (res) => (res && res.data) || {};
const isOk = (res) => res && res.success === true && String(bodyOf(res).rspCode) === "00";
const resultOf = (res) => bodyOf(res).result || {};
const msgOf = (res) => bodyOf(res).rspMsg || bodyOf(res).rspCode || short(res);
const codeOf = (res) => String(bodyOf(res).rspCode || "");
const isAlreadyDone = (t) => /已签|已经签|签到过|重复|已完成|already/i.test(String(t || ""));
const isAuthError = (res) =>
    /UNAUTHORIZED|TOKEN/i.test(codeOf(res)) || /登录|未授权|未登录|失效|过期|重新/.test(msgOf(res));
const isNotRegistered = (res) =>
    /REGISTER_REQUIRED|NOT_REGIST/i.test(codeOf(res)) || /未注册|请先注册|未成为会员/.test(msgOf(res));

const summary = { accounts: 0, done: 0, already: 0, writeAttempted: 0, fail: 0, ambiguous: 0, unavailable: 0 };

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.token = "";
        this.outcome = "skip";
        this.retryable = 0;
        this.reason = "";
    }
    log(text) { $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`); }

    async request(apiPath, body = {}, withAuth = true) {
        const headers = {
            "Content-Type": "application/json;charset=utf-8",
            Accept: "application/json, text/plain, */*",
            "User-Agent": USER_AGENT,
            Referer: H5_REFERER,
            xweb_xhr: "1",
        };
        if (withAuth && this.token) headers.Authorization = this.token;
        const res = await axios.request({
            method: "POST", url: `${BASE}${apiPath}`, data: body, headers,
            timeout: 20000, validateStatus: () => true,
        });
        if (res.status !== 200) throw new Error(`${apiPath} HTTP ${res.status}: ${short(res.data)}`);
        return res.data;
    }

    async getCode() {
        const { data } = await wechat.getCode(this.account.openid);
        if (data && data.status === false) throw new Error(`wx_server 取code失败: ${data.message || short(data)}`);
        const code = data?.data?.code || data?.code;
        if (!code || typeof code !== "string") throw new Error(`wx_server 未返回 code`);
        return code;
    }

    async login() {
        const code = await this.getCode();
        const res = await this.request(EP_LOGIN, { appId: MINI_APP_ID, code }, false);
        if (!isOk(res)) throw new Error(`登录失败: ${msgOf(res)}`);
        const r = resultOf(res);
        this.token = String(r.token || "");
        if (!this.token) throw new Error(`登录未返回 token`);
        const ok = withCacheLock(() => {
            const cache = readCache();
            cache[this.account.openid] = { token: this.token, updatedAt: new Date().toISOString() };
            return writeCache(cache);
        });
        if (!ok) throw new Error("token缓存落盘失败，阻写");
        this.log("登录成功");
    }

    async signDetail() {
        const res = await this.request(EP_SIGN_DETAIL, {});
        if (!isOk(res)) {
            if (isNotRegistered(res)) return { notRegistered: true, msg: msgOf(res) };
            return isAuthError(res) ? null : { failed: true, msg: msgOf(res) };
        }
        const body = bodyOf(res);
        const r = body && body.result;
        if (typeof r !== "object" || r === null || Array.isArray(r)) return { failed: true, msg: "detail result 非对象" };
        /* 现场 statusFlag=2 时 activityId/signFlag/startDate/endDate 全部显式 null；
           必须 hasOwn 判定，缺失键（undefined）= 结构未知 FAILURE，不吞 */
        const out = { hasOwn: {} };
        for (const k of ["activityId", "signFlag", "statusFlag", "startDate", "endDate"]) {
            out.hasOwn[k] = Object.prototype.hasOwnProperty.call(r, k);
        }
        out.activityId = r.activityId;
        out.signFlag = r.signFlag;
        out.rawSignFlag = r.signFlag;
        out.statusFlag = r.statusFlag;
        out.startDate = r.startDate;
        out.endDate = r.endDate;
        out.accumulateDay = r.accumulateDay ?? r.continuousDay;
        return out;
    }

    async ensureLogin() {
        const cached = readCache()[this.account.openid] || {};
        if (!this.token && cached.token) {
            this.token = cached.token;
            const probe = await this.signDetail();
            if (probe !== null) { this.log("使用缓存token"); return probe; }
            this.log("缓存token失效，重新登录");
            this.token = "";
        }
        if (!this.token) await this.login();
        return null;
    }

    /* 按 openid+activityId 取当日 entry；不覆盖其他活动 entry */
    entry(state, activityId) {
        const day = state[cstToday()] || {};
        const acct = day[this.account.openid] || {};
        return acct[activityId] || null;
    }
    setEntry(activityId, patch) {
        const state = readState();
        const day = state[cstToday()] = state[cstToday()] || {};
        const acct = day[this.account.openid] = day[this.account.openid] || {};
        const prev = acct[activityId] || {};
        acct[activityId] = Object.assign({}, prev, patch);
        return writeJsonAtomic(STATE_FILE, state);
    }

    async run() {
        summary.accounts++;
        if (!this.account.openid) { this.log("跳过：变量值里没有 openid"); this.outcome = "skip"; return; }
        try {
            let detail = await this.ensureLogin();
            if (detail === null) detail = await this.signDetail();
            if (detail === null) { this.log("❌ 会话无效"); this.outcome = "failed"; this.retryable = 1; summary.fail++; return; }
            if (detail.notRegistered) { this.log(`⚠️ ${detail.msg}（未注册会员）`); this.outcome = "notRegistered"; summary.done++; return; }
            if (detail.failed) { this.log(`❌ 读取活动失败: ${detail.msg}`); this.outcome = "failed"; this.retryable = 1; summary.fail++; return; }

            /* 权威已签：仅当 statusFlag===1 且 signFlag===true 才认；缺字段/其他值不判已签 */
            /* statusFlag 必须显式存在且整数；缺失=结构未知 FAILURE */
            if (!detail.hasOwn.statusFlag || !Number.isInteger(detail.statusFlag)) {
                this.log("❌ detail statusFlag 缺失/非整数，FAILURE"); this.outcome = "failed"; this.retryable = 1; summary.fail++; return;
            }
            /* statusFlag===2：activityId/signFlag/startDate/endDate 必须显式存在且全 null = 合法未开放 */
            if (detail.statusFlag === 2) {
                const allNull = ["activityId", "signFlag", "startDate", "endDate"].every(k => detail.hasOwn[k] && detail[k] === null);
                if (allNull) {
                    this.log("当前无可签到活动，本次成功跳过（未签到）");
                    this.outcome = "activity_unavailable"; this.reason = "activity_unavailable";
                    summary.done++; summary.unavailable++; return;
                }
                this.log("❌ statusFlag=2 但字段非全 null/缺键，FAILURE"); this.outcome = "failed"; this.retryable = 1; summary.fail++; return;
            }
            /* statusFlag===1：必须 activityId(string) + signFlag 严格布尔，再判已签 */
            if (detail.statusFlag === 1) {
                if (!detail.hasOwn.activityId || typeof detail.activityId !== "string" || !detail.activityId) {
                    this.log("❌ statusFlag=1 但缺 activityId，FAILURE"); this.outcome = "failed"; this.retryable = 1; summary.fail++; return;
                }
                if (!detail.hasOwn.signFlag || typeof detail.rawSignFlag !== "boolean") {
                    this.log("❌ statusFlag=1 但 signFlag 缺/非布尔，FAILURE"); this.outcome = "failed"; this.retryable = 1; summary.fail++; return;
                }
                if (detail.rawSignFlag === true) {
                    this.log(`✅ 今日已签（活动 ${detail.activityId}）`);
                    this.outcome = "already"; summary.done++; summary.already++; return;
                }
            } else {
                this.log("❌ statusFlag 非 1/2，FAILURE"); this.outcome = "failed"; this.retryable = 1; summary.fail++; return;
            }

            if (READ_ONLY) { this.log("只读模式：跳过写"); this.outcome = "skip"; summary.done++; return; }

            if (!acquireLock()) { this.log("⚠️ 他进程持有写锁，跳过"); this.outcome = "blocked"; this.retryable = 1; summary.fail++; return; }
            try {
                const state = readState();
                const day = state[cstToday()] || {};
                const legacy = day[this.account.openid];
                /* legacy 扁平 entry：若带 activityId 且等于当前活动，归到本活动 prev；无 id 保守阻写 */
                let prev = this.entry(state, detail.activityId);
                if (!prev && legacy && typeof legacy === "object" && legacy.status && !Object.values(legacy).some(v => v && typeof v === "object")) {
                    if (legacy.activityId === detail.activityId) {
                        prev = legacy; // 同 id 旧 unknown/attempting/success 门控生效
                    } else if (!legacy.activityId) {
                        this.log(`⚠️ legacy ${legacy.status} 无 activityId，保守失败不借新键消除`);
                        this.outcome = "failed"; this.retryable = 0; summary.fail++; return;
                    }
                    // legacy.activityId 已知且不同 → 保留旧 entry，新活动独立
                }
                prev = prev || {};
                /* 本活动当日已 success：跳过；不影响其他活动 entry */
                if (prev.status === "success") { this.log("✅ 本活动本地 success，跳过写"); this.outcome = "already"; summary.done++; summary.already++; return; }
                /* attempting：上一进程未确认，fail-closed 不重发 */
                if (prev.status === "attempting") { this.log("⚠️ 本活动上一写未确认(attempting)，fail-closed 不重发"); this.outcome = "unknown"; this.retryable = 0; summary.fail++; return; }
                /* failed：明确业务拒绝，当日不再重放 */
                if (prev.status === "failed") { this.log("⚠️ 本活动当日已 failed，不重放"); this.outcome = "failed"; this.retryable = 0; summary.fail++; return; }
                if ((prev.attempts || 0) >= MAX_WRITES_PER_ACTIVITY) { this.log("❌ 本活动当日写达硬上限"); this.outcome = "blocked"; summary.fail++; return; }

                /* unknown 恢复：冷却 + 连续两次权威未签确认 */
                if (prev.status === "unknown") {
                    const age = Date.now() - (prev.ts || 0);
                    if (age < COOLDOWN_MS) { this.log("⚠️ 写后未知冷却中"); this.outcome = "unknown"; this.retryable = 0; summary.fail++; return; }
                    const confirms = (prev.authoritativeConfirms || 0) + 1;
                    if (confirms < 2) {
                        if (!this.setEntry(detail.activityId, { status: "unknown", authoritativeConfirms: confirms, ts: Date.now() })) {
                            this.log("❌ 状态落盘失败阻写"); this.outcome = "failed"; summary.fail++; return;
                        }
                        this.log(`⚠️ 写后未知，权威确认 ${confirms}/2`); this.outcome = "unknown"; this.retryable = 0; summary.fail++; return;
                    }
                }

                /* 写前落盘 attempting 并回读 */
                if (!this.setEntry(detail.activityId, { status: "attempting", activityId: detail.activityId, attempts: (prev.attempts || 0) + 1, ts: Date.now() })) {
                    this.log("❌ 状态落盘失败阻写"); this.outcome = "failed"; summary.fail++; return;
                }
                summary.writeAttempted++;

                let res;
                try {
                    res = await this.request(EP_SIGN_CREATE, { activityId: detail.activityId });
                } catch (e) {
                    this.safeSet(detail.activityId, { status: "unknown", ts: Date.now() });
                    this.log(`⚠️ 写后未知: ${e.message || e}`); this.outcome = "unknown"; this.retryable = 0; summary.fail++; return;
                }
                if (typeof res === "string") {
                    this.safeSet(detail.activityId, { status: "unknown", ts: Date.now() });
                    this.log("⚠️ 写后未知(非JSON)"); this.outcome = "unknown"; this.retryable = 0; summary.fail++; return;
                }
                if (isOk(res)) {
                    const r = resultOf(res);
                    const days = r && (r.accumulateDay ?? r.continuousDay);
                    if (!this.setEntry(detail.activityId, { status: "success", ts: Date.now() })) {
                        this.log("⚠️ 写后落盘失败，标 unknown"); this.outcome = "unknown"; this.retryable = 0; summary.fail++; return;
                    }
                    this.log(`✅ 签到成功${days ? `，累计 ${days} 天` : ""}`);
                    this.outcome = "success"; summary.done++; return;
                }
                if (isAlreadyDone(msgOf(res))) {
                    this.setEntry(detail.activityId, { status: "success", ts: Date.now() });
                    this.log(`✅ 今日已签（${msgOf(res)}）`); this.outcome = "already"; summary.done++; summary.already++; return;
                }
                if (isNotRegistered(res)) {
                    this.log(`⚠️ ${msgOf(res)}（未注册）`); this.outcome = "notRegistered"; summary.done++; return;
                }
                this.setEntry(detail.activityId, { status: "failed", ts: Date.now() });
                this.log(`❌ 签到失败: ${msgOf(res)}`);
                this.outcome = "failed"; this.retryable = 0; summary.fail++;
            } finally { releaseLock(); }
        } catch (e) {
            this.log(`执行失败: ${e.message || e}`);
            this.outcome = "failed"; this.retryable = 1; summary.fail++;
        }
    }
    safeSet(activityId, patch) { try { this.setEntry(activityId, patch); } catch {} }
}

!(async () => {
    $.checkEnv(ckName);
    if (!$.userCount) {
        console.log(`[QLRUN_RESULT] FAILURE {"script":"txq.js","reason":"no_env","retryable":0}`);
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
    console.log(`[QLRUN_RESULT] ${ok ? "SUCCESS" : "FAILURE"} ${"{\"script\":\"txq.js\"," +
        "\"accounts\":\"" + summary.accounts + "\"," +
        "\"done\":\"" + summary.done + "\"," +
        "\"already\":\"" + summary.already + "\"," +
        "\"writeAttempted\":\"" + summary.writeAttempted + "\"," +
        "\"fail\":\"" + summary.fail + "\"," +
        "\"ambiguous\":\"" + summary.ambiguous + "\"," +
        "\"unavailable\":\"" + summary.unavailable + "\"," +
        "\"reason\":\"" + reason + "\"," +
        "\"mode\":\"" + (READ_ONLY ? "read_only" : "normal") + "\"}"} retryable=${tasks.some(t => t.retryable === 1) ? 1 : 0}`);
    process.exitCode = code;
    $.done?.();
})().catch((e) => {
    $.log(String(e && e.message || e));
    console.log(`[QLRUN_RESULT] FAILURE {"script":"txq.js","reason":"exception","retryable":1}`);
    process.exitCode = 1;
});
