/*
------------------------------------------
@Author: sm
@Date: 2026.06.09
@Description: 飞鹤星妈会 登录/查询/签到 (v2: state machine + retry safety)
cron: 20 8 * * *
------------------------------------------
变量名：fhxmh
变量值：wx_server里的openid/账号标识，多账号用 & 或换行
依赖变量：wx_server_url、wx_auth
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const fs = require("fs");
const path = require("path");
const os = require("os");
const $ = new Env("飞鹤星妈会");
/* Env.done 默认 process.exit(0)；包裹以先完成通知再按业务 rc 退出 */
async function finish(code) {
    const realExit = process.exit.bind(process);
    process.exit = (c) => { /* swallow Env.done's exit(0) */ };
    try { await $.done(); } catch {}
    finally { process.exit = realExit; }
    realExit(code);
}
const axios = require("axios");
const crypto = require("crypto");

const CK_NAME = "fhxmh";
const APP = { name: "飞鹤星妈会", appid: "wxc83b55d61c7fc51d" };
/* endpoint-specific success codes (probe-evidenced, exact) */
const LOGIN_OK_CODES = ["00000"];          /* social/ma */
const MEMBER_OK_CODES = ["00000"];         /* /c/user/memberInfo */
const USERINFO_OK_CODES = ["00000"];        /* /p/user/userInfo */
const TODO_OK_CODES = ["000000"];          /* /c/activity/todo/list only */
const SIGN_OK_CODES = ["00000"];           /* /c/activity/todo/checkIn only */
const WX_SERVER_URL = (process.env.wx_server_url || "http://192.168.31.196:8787").replace(/\/$/, "");
const WX_AUTH = process.env.wx_auth || "";
const DEFAULT_OPENID = process.env.wx_openid || "";
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

const READ_ONLY = process.env.FHXMH_READ_ONLY === "1" || process.env.QL_READ_ONLY === "1";
const STATE_FILE = path.join(__dirname, ".fhxmh_state.json");
const LOCK_FILE = path.join(__dirname, ".fhxmh.lock");
const SCHEMA_VERSION = 1;
const MAX_WRITE_PER_TASK = 2;
const MAX_RECOVER_TOTAL = 1;
const COOLDOWN_MS = 10 * 60 * 1000;
function nowMs() { return Date.now(); }
const LOGIN_MAX_ATTEMPTS = 2;

function short(value, max = 220) {
    if (value === undefined || value === null) return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function accountKey(alias) { return sha256(String(alias)); } /* full 64-hex, no truncation */
function cstDay() {
    /* Beijing date = UTC+8, explicit to avoid server TZ drift */
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, "0"), dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
}

const summary = { accounts: 0, done: 0, already: 0, unavailable: 0, skipped: 0, wouldWrite: 0, writeAttempted: 0, fail: 0, ambiguous: 0, reason: "" };

async function request(options) {
    const res = await axios.request({
        timeout: 20000,
        validateStatus: () => true,
        ...options,
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json, text/plain, */*",
            ...(options.headers || {}),
        },
    });
    return { status: res.status, headers: res.headers || {}, data: res.data };
}

async function getWxCode(appid, openid) {
    if (!WX_AUTH) throw new Error("未配置 wx_auth");
    const { status, data } = await request({
        method: "POST",
        url: `${WX_SERVER_URL}/wx/code`,
        headers: { auth: WX_AUTH, "content-type": "application/json" },
        data: { appid, openid },
    });
    const code = data?.code || data?.data?.code || data?.phoneCode || data?.data?.phoneCode;
    if (status !== 200 || !code) throw new Error(`获取code失败 HTTP ${status}`);
    return code;
}

/* ---------- state / lock ---------- */
function readState() {
    let raw;
    try { raw = fs.readFileSync(STATE_FILE, "utf8"); }
    catch { return { _schema: SCHEMA_VERSION, entries: {} }; }
    let obj;
    try { obj = JSON.parse(raw); }
    catch (e) { const err = new Error(`state bad JSON: ${e.message}`); err.stateCorrupt = true; throw err; }
    if (!obj || obj._schema !== SCHEMA_VERSION || typeof obj.entries !== "object") {
        const err = new Error(`state schema v${obj?._schema ?? "?"} invalid`); err.stateCorrupt = true; throw err;
    }
    return obj;
}
function writeStateAtomic(state) {
    if (READ_ONLY) return false;
    const tmp = STATE_FILE + ".tmp." + process.pid + "." + Date.now() + "." + Math.random().toString(36).slice(2);
    const payload = JSON.stringify(state);
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
        fs.writeSync(fd, payload);
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, STATE_FILE); }
    catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
    /* dir fsync where supported */
    try {
        const dfd = fs.openSync(path.dirname(STATE_FILE), "r");
        try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch {}
    /* strict readback */
    const back = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(back);
    if (!parsed || parsed._schema !== SCHEMA_VERSION || typeof parsed.entries !== "object") {
        const err = new Error("state readback mismatch"); err.stateCorrupt = true; throw err;
    }
    if (JSON.stringify(parsed) !== payload) {
        const err = new Error("state readback content mismatch"); err.stateCorrupt = true; throw err;
    }
    return true;
}
function acquireLock() {
    if (READ_ONLY) return { locked: true, release: () => {} };
    const content = JSON.stringify({ pid: process.pid, start: Date.now() });
    try {
        fs.writeFileSync(LOCK_FILE, content, { flag: "wx", mode: 0o600 });
        return { locked: true, mine: true, release: () => releaseLock(JSON.parse(content).start) };
    } catch (e) {
        /* try stale once */
        try {
            const raw = fs.readFileSync(LOCK_FILE, "utf8").trim();
            const old = JSON.parse(raw);
            const age = Date.now() - (old.start || 0);
            let dead = false;
            try { process.kill(old.pid, 0); dead = false; } catch { dead = true; }
            if (old.pid && dead && age > 30 * 1000) {
                fs.writeFileSync(LOCK_FILE, content, { flag: "w", mode: 0o600 });
                return { locked: true, mine: true, release: () => releaseLock(JSON.parse(content).start) };
            }
        } catch {}
        return { locked: false, mine: false, release: () => {} };
    }
}
function releaseLock(myStart) {
    try {
        const raw = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
        if (raw.pid !== process.pid || raw.start !== myStart) return; /* foreign/stale, don't unlink */
        fs.unlinkSync(LOCK_FILE);
    } catch {}
}

/* ---------- FeiheMom ---------- */
class FeiheMom {
    constructor(openid) {
        this.openid = openid;
        this.base = "https://momclub.feihe.com/capis";
        this.token = "";
        this.outcome = "";
        this.retryable = 0;
    }

    async api({ method = "GET", path, data, allowFail = false, okCodes = MEMBER_OK_CODES, strictSuccess = false }) {
        const opts = {
            method,
            url: `${this.base}${path}`,
            headers: { Authorization: this.token, locale: "zh_CN", "content-type": "application/json" },
        };
        if (method === "GET") opts.params = data || {};
        else opts.data = data === undefined ? {} : data;
        const res = await request(opts);
        const ok = res.status === 200 && okCodes.includes(String(res.data?.code)) && (!strictSuccess || res.data?.success === true);
        if (!ok && !allowFail) throw new Error(`HTTP ${res.status}: ${short(res.data)}`);
        return res.data;
    }

    async loginOnce() {
        const code = await getWxCode(APP.appid, this.openid);
        const res = await request({
            method: "POST",
            url: `${this.base}/social/ma`,
            headers: { "content-type": "application/json", locale: "zh_CN" },
            data: code,
            transformRequest: [(d) => d],
        });
        const body = res.data;
        if (res.status !== 200 || typeof body !== "object" || body === null || Object.keys(body).length === 0) {
            const e = new Error(`登录空/异常 body HTTP ${res.status}`);
            e.emptyBody = true;
            throw e;
        }
        if (!LOGIN_OK_CODES.includes(String(body?.code)) || body?.success !== true) {
            const e = new Error(`登录业务码拒绝 HTTP ${res.status}: ${short(body)}`);
            e.credential = true;
            throw e;
        }
        const token = body?.data?.tokenInfo?.accessToken || body?.data?.accessToken || "";
        if (res.status === 200 && !token && body?.data?.tempUid) {
            const e = new Error("NO_ACCOUNT:登录只返回临时身份(tokenInfo 为空)");
            e.unregistered = true;
            throw e;
        }
        if (!token) {
            const e = new Error(`登录失败 HTTP ${res.status}: ${short(body)}`);
            e.credential = true;
            throw e;
        }
        this.token = token;
        return true;
    }

    async login() {
        let lastErr;
        for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
            try { return await this.loginOnce(); }
            catch (e) {
                lastErr = e;
                if (e.unregistered) throw e;
                if (e.credential) throw e;
                // empty body / network / 5xx → retry with fresh code
            }
        }
        throw lastErr;
    }

    async query() {
        const ui = await this.api({ path: "/p/user/userInfo", okCodes: USERINFO_OK_CODES, strictSuccess: true });
        if (!ui || typeof ui.data !== "object" || ui.data === null) throw new Error("userInfo.data 非对象");
        const member = await this.api({ path: "/c/user/memberInfo", okCodes: MEMBER_OK_CODES, strictSuccess: true });
        if (!member || typeof member.data !== "object" || member.data === null) throw new Error("memberInfo.data 非对象");
        const data = member.data;
        if (!Object.prototype.hasOwnProperty.call(data, "points")) throw new Error("memberInfo.data.points 缺失");
        const score = data.points;
        return `积分=${score}`;
    }

    /* strict authority: data.checkInTodo.checkInExtra.taskId + joinRecord[]
       signed = exactly one joinRecord with today===true and joined===true */
    async fetchCheckIn() {
        const todo = await this.api({ path: "/c/activity/todo/list", data: { mockTime: Date.now() }, okCodes: TODO_OK_CODES, strictSuccess: true });
        if (!todo || !TODO_OK_CODES.includes(String(todo?.code)) || todo?.success !== true || typeof todo?.data !== "object") {
            throw new Error(`todo/list 信封异常: ${short(todo)}`);
        }
        if (!Object.prototype.hasOwnProperty.call(todo.data, "checkInTodo")) {
            const e = new Error("status_missing: 官方未返回 checkInTodo");
            e.statusMissing = true;
            throw e;
        }
        const item = todo.data.checkInTodo;
        if (item === null || typeof item !== "object") {
            const e = new Error("status_missing: checkInTodo 非对象");
            e.statusMissing = true;
            throw e;
        }
        const extra = item.checkInExtra;
        if (!extra || typeof extra !== "object") throw new Error(`checkInExtra 缺失: ${short(item)}`);
        const activityId = extra.taskId || item.id;
        if (!activityId || typeof activityId !== "string" && typeof activityId !== "number") throw new Error(`taskId 缺失: ${short(extra)}`);
        const recs = extra.joinRecord;
        if (!Array.isArray(recs)) throw new Error(`joinRecord 非数组: ${short(extra)}`);
        const todays = recs.filter(r => r && r.today === true);
        if (todays.length === 0) throw new Error(`joinRecord 无 today=true 项`);
        if (todays.length > 1) throw new Error(`joinRecord 多个 today=true 项`);
        if (typeof todays[0].joined !== "boolean") throw new Error(`joined 非 bool: ${short(todays[0])}`);
        return { activityId: String(activityId), todaySigned: todays[0].joined === true };
    }

    async doSign(activityId) {
        const sign = await this.api({ method: "POST", path: "/c/activity/todo/checkIn", data: { activityId, mockTime: Date.now() }, allowFail: true });
        if (SIGN_OK_CODES.includes(String(sign?.code)) && (sign?.success === undefined || sign?.success === true)) return { ok: true, credits: sign?.data?.credits };
        if (String(sign?.code) === "A00001") {
            return { ok: true, already: true };
        }
        const e = new Error(`签到业务拒绝: ${short(sign)}`);
        e.definite = true;
        throw e;
    }
}

/* ---------- per-account run ---------- */
async function runAccount(openid, index, state) {
    if (!state.entries) state.entries = {};
    const alias = accountKey(openid);
    const day = cstDay();
    const action = "todo_checkin";

    this.outcome = "";
    const runner = new FeiheMom(openid);

    try {
        await runner.login();
        await runner.query();

        // authority read #1
        let chk1;
        try { chk1 = await runner.fetchCheckIn(); }
        catch (e) {
            if (e.statusMissing) {
                runner.outcome = "status_missing"; runner.retryable = 0; summary.fail++; summary.reason = "status_missing";
                $.log(`[${alias}] ${e.message}`); return;
            }
            throw e;
        }
        const entryKey = `${alias}|${action}|${day}|${sha256(String(chk1.activityId))}`;
        if (chk1.todaySigned) {
            runner.outcome = "already";
            summary.done++; summary.already++;
            if (!READ_ONLY) persistStateLocked(entryKey, { alias, action, day, activityId: chk1.activityId, status: "success", attempts: 0, ts: Date.now(), authorityConfirmed: true });
            $.log(`[${alias}] 今日已签 activity=${chk1.activityId}`);
            return;
        }

        // READ_ONLY unsigned: observe only, never lock/state/doSign
        if (READ_ONLY) {
            runner.outcome = "would_write";
            summary.skipped++; summary.wouldWrite++;
            $.log(`[${alias}] READ_ONLY 未签 activity=${chk1.activityId}（不执行签到）`);
            return;
        }

        // state precheck
        const prev = state.entries[entryKey] || {};
        if (prev.status === "success") {
            runner.outcome = "already"; summary.done++; summary.already++;
            return;
        }
        if (prev.status === "attempting") {
            runner.outcome = "unknown"; runner.retryable = 0; summary.fail++;
            return;
        }
        if (prev.status === "failed") {
            runner.outcome = "failed"; runner.retryable = 0; summary.fail++;
            return;
        }
        if ((prev.attempts || 0) >= MAX_WRITE_PER_TASK) {
            runner.outcome = "blocked"; summary.fail++; return;
        }
        if (prev.status === "unknown") {
            // recovery path: authority-only, no re-write unless cooldown + count
            const age = Date.now() - (prev.ts || 0);
            if (age < COOLDOWN_MS) { runner.outcome = "unknown"; runner.retryable = 0; summary.fail++; return; }
            if ((prev.recoverCount || 0) >= MAX_RECOVER_TOTAL || (prev.attempts || 0) >= MAX_WRITE_PER_TASK) {
                runner.outcome = "unknown"; runner.retryable = 0; summary.fail++; return;
            }
        }

        // lock + reread authority #2
        const lock = acquireLock();
        if (!lock.locked) { runner.outcome = "blocked"; runner.retryable = 1; summary.fail++; return; }
        try {
            let chk2;
            try { chk2 = await runner.fetchCheckIn(); }
            catch (e) { if (e.statusMissing) { runner.outcome = "status_missing"; runner.retryable = 0; summary.fail++; summary.reason = "status_missing"; return; } throw e; }
            if (chk2 && chk2.todaySigned) {
                runner.outcome = "already"; summary.done++; summary.already++;
                mergeStateEntry(entryKey, { alias, action, day, activityId: chk2.activityId, status: "success", attempts: prev.attempts || 0, ts: Date.now(), authorityConfirmed: true });
                return;
            }

            // persist attempting
            mergeStateEntry(entryKey, {
                alias, action, day, activityId: chk1.activityId,
                status: "attempting", attempts: (prev.attempts || 0) + 1,
                recoverCount: prev.recoverCount || 0, ts: Date.now(),
            });
            summary.writeAttempted++;

            try {
                const r = await runner.doSign(chk1.activityId);
                // post-write authority
                let chk3;
                try { chk3 = await runner.fetchCheckIn(); }
                catch (e) { chk3 = null; }
                if (chk3 && chk3.todaySigned) {
                    runner.outcome = "success"; summary.done++;
                    mergeStateEntry(entryKey, {
                        alias, action, day, activityId: chk1.activityId, status: "success",
                        attempts: (prev.attempts || 0) + 1, recoverCount: prev.recoverCount || 0,
                        ts: Date.now(), authorityConfirmed: true,
                    });
                } else {
                    runner.outcome = "write_unknown"; runner.retryable = 0; summary.fail++; summary.ambiguous++;
                    mergeStateEntry(entryKey, {
                        alias, action, day, activityId: chk1.activityId, status: "unknown",
                        attempts: (prev.attempts || 0) + 1, recoverCount: (prev.recoverCount || 0) + 1,
                        ts: Date.now(), authorityConfirmed: false,
                    });
                }
            } catch (e) {
                if (e.definite) {
                    runner.outcome = "failed"; runner.retryable = 0; summary.fail++;
                    mergeStateEntry(entryKey, {
                        alias, action, day, activityId: chk1.activityId, status: "failed",
                        attempts: (prev.attempts || 0) + 1, recoverCount: prev.recoverCount || 0, ts: Date.now(),
                    });
                } else {
                    runner.outcome = "write_unknown"; runner.retryable = 0; summary.fail++; summary.ambiguous++;
                    mergeStateEntry(entryKey, {
                        alias, action, day, activityId: chk1.activityId, status: "unknown",
                        attempts: (prev.attempts || 0) + 1, recoverCount: prev.recoverCount || 0, ts: Date.now(),
                    });
                }
            }
        } finally { lock.release(); }
    } catch (e) {
        const m = String(e.message || e);
        if (e.unregistered) {
            runner.outcome = "unregistered";
            summary.unavailable++;
            $.log(`[${alias}] 未注册会员`);
            return;
        }
        if (e.emptyBody) {
            runner.outcome = "login_empty";
            runner.retryable = 1;
            summary.fail++;
            summary.reason = "login_empty";
            return;
        }
        runner.outcome = "failed";
        runner.retryable = 1;
        summary.fail++;
        summary.reason = m.slice(0, 80);
    }
}

function mergeStateEntry(key, entry) {
    /* caller MUST hold lock; plain merge-write */
    if (READ_ONLY) return false;
    let fresh = { _schema: SCHEMA_VERSION, entries: {} };
    try { fresh = readState(); } catch {}
    fresh.entries[key] = entry;
    return writeStateAtomic(fresh);
}
function persistStateLocked(key, entry) {
    /* for call sites outside the main write lock (e.g. already-signed) */
    if (READ_ONLY) return false;
    const lock = acquireLock();
    if (!lock.locked) return false;
    try { return mergeStateEntry(key, entry); }
    finally { lock.release(); }
}

(async () => {
    const rawEnv = process.env[CK_NAME] || DEFAULT_OPENID || "";
    const accounts = rawEnv
        .split(rawEnv.includes("\n") ? "\n" : "&")
        .map((x) => x.trim())
        .filter(Boolean);

    let state = readState();

    if (!accounts.length) {
        console.log(`[QLRUN_RESULT] FAILURE {"script":"fhxmh.js","reason":"no_env","retryable":0}`);
        await finish(1);
        return;
    }

    for (let i = 0; i < accounts.length; i++) {
        summary.accounts++;
        await runAccount(accounts[i], i + 1, state);
        await $.wait(800);
    }

    const ok = summary.fail === 0 && summary.ambiguous === 0;
    const rc = ok ? 0 : 1;
    const retryable = summary.reason === "login_empty" ? 1 : 0;
    console.log(`[QLRUN_RESULT] ${ok ? "SUCCESS" : "FAILURE"} {"script":"fhxmh.js","accounts":"${summary.accounts}","done":"${summary.done}","already":"${summary.already}","unavailable":"${summary.unavailable}","skipped":"${summary.skipped}","wouldWrite":"${summary.wouldWrite}","writeAttempted":"${summary.writeAttempted}","fail":"${summary.fail}","ambiguous":"${summary.ambiguous}","reason":"${summary.reason}","mode":"${READ_ONLY ? "read_only" : "normal"}"} retryable=${retryable}`);
    await finish(rc);
})().catch(async (e) => {
    console.log(`[QLRUN_RESULT] FAILURE {"script":"fhxmh.js","reason":"exception","retryable":1}`);
    await finish(1);
});
