/*
------------------------------------------
@Author: sm
@Date: 2026.06.09
@Description: 米萌生活 登录/查询/签到/观看视频得米豆
cron: 30 8 * * *
------------------------------------------
变量名：mimengshenghuo
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行

依赖变量：
wx_server_url  默认 http://192.168.31.196:8787
wx_auth        必填，wx_server 鉴权值

可选变量：
mimeng_video_times  限制每个账号本次最多执行几次视频任务，默认完成当天剩余次数
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("米萌生活");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const READ_ONLY = process.env.MIMENG_READ_ONLY === "1";
$.done = async () => { if ($.sendMsg) await $.sendMsg(); };
function dayKey() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
function atomicState(file, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    const tmp = file + '.tmp.' + process.pid + '.' + crypto.randomBytes(6).toString('hex');
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
        let offset = 0;
        while (offset < bytes.length) {
            const n = fs.writeSync(fd, bytes, offset, bytes.length - offset);
            if (!Number.isInteger(n) || n <= 0 || n > bytes.length - offset) throw new Error('state short write');
            offset += n;
        }
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const d = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
    if (!fs.readFileSync(file).equals(bytes)) throw new Error('state readback mismatch');
}
function loadState(file) {
    if (!fs.existsSync(file)) return { entries: {} };
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!d || typeof d !== 'object' || Array.isArray(d) || !d.entries || typeof d.entries !== 'object' || Array.isArray(d.entries)) throw new Error('invalid state');
    for (const e of Object.values(d.entries)) {
        if (!e || !Number.isInteger(e.attempts) || e.attempts < 1 || e.attempts > 2 || !['attempting','success','unknown'].includes(e.outcome) || typeof e.day !== 'string') throw new Error('invalid state entry');
    }
    return d;
}
function safeError(e) { return String(e?.message || e).replace(/eyJ[\w.-]+/g, '<jwt>').slice(0, 160); }


const CK_NAME = "mimengshenghuo";
const APP = { name: "米萌生活", appid: "wx9939a74ee8a8522a" };
const GQL_URL = "https://shd.luxingiot.com/graphql";
const WX_SERVER_URL = (process.env.wx_server_url || "http://192.168.31.196:8787").replace(/\/$/, "");
const WX_AUTH = process.env.wx_auth || "";
const DEFAULT_OPENID = process.env.wx_openid || "";
const TOKEN_CACHE_FILE = path.join(__dirname, "mimengshenghuo_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

function splitAccounts(value = "") {
    return String(value)
        .split(/\n|&/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function short(value, max = 260) {
    if (value === undefined || value === null) return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function maskToken(token = "") {
    const value = String(token || "");
    return value.length > 16 ? `${value.slice(0, 8)}***${value.slice(-6)}` : `${value.slice(0, 4)}***`;
}

function readTokenCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch {
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

async function getWxCode(openid) {
    if (!WX_AUTH) throw new Error("未配置 wx_auth");
    const { status, data } = await request({
        method: "POST",
        url: `${WX_SERVER_URL}/wx/code`,
        headers: { auth: WX_AUTH, "content-type": "application/json" },
        data: { appid: APP.appid, openid },
    });
    const code = data?.data?.code || data?.code;
    if (status !== 200 || !code) throw new Error(`获取code失败 HTTP ${status}: ${short(data)}`);
    return code;
}

function operationName(query) {
    const match = /(query|mutation)\s*?([\w\d\-_]+)?\s*?(\(.*?\))?\s*?\{/.exec(query);
    return match && match[2] ? match[2] : "";
}

class Mimeng {
    constructor(openid, index) {
        this.openid = openid;
        this.index = index;
        this.token = "";
        this.viewer = {};
        this.socialApp = {};
        this.checkIn = null;
        this.videoTask = null;
    }

    cacheKey() {
        return this.openid;
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.cacheKey()]?.token || "";
    }

    saveCachedToken() {
        if (!this.token) return;
        const cache = readTokenCache();
        cache[this.cacheKey()] = {
            token: this.token,
            uid: this.viewer.uid || "",
            points: this.viewer.wallet?.points ?? "",
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        delete cache[this.cacheKey()];
        writeTokenCache(cache);
        this.token = "";
    }

    async gql(query, variables = {}, token = this.token, allowFail = false) {
        const body = { query, variables };
        const opName = operationName(query);
        if (opName) body.operationName = opName;

        const headers = {
            "content-type": "application/json",
            "x-provider-id": APP.appid,
            Referer: `https://servicewechat.com/${APP.appid}/21/page-frame.html`,
        };
        if (token) headers.Authorization = `Bearer ${token}`;

        const res = await request({
            method: "POST",
            url: GQL_URL,
            headers,
            data: body,
        });

        const errors = res.data?.errors || [];
        if ((res.status !== 200 || errors.length) && !allowFail) {
            throw new Error(`GraphQL失败 HTTP ${res.status}: ${short(res.data)}`);
        }
        return res.data;
    }

    async login() {
        const cached = this.getCachedToken();
        if (cached) {
            this.token = cached;
            if (await this.checkToken()) return;
            this.token = '';
            if (!READ_ONLY) this.removeCachedToken();
        }
        // Verified route: fresh runtime code, exchanged by the native request bridge.
        const fresh = await request({method:'POST', url:WX_SERVER_URL+'/wx/runtime-code', headers:{auth:WX_AUTH}, data:{appid:APP.appid,openid:this.openid}, timeout:70000});
        const code = fresh.data?.code || fresh.data?.data?.code;
        if (fresh.status !== 200 || fresh.data?.status !== true || typeof code !== 'string' || !code) throw new Error('runtime code unavailable');
        const query = 'mutation codeLogin($client_id: String! $code: String!) {login(client_id:$client_id,code:$code)}';
        const exchange = await request({method:'POST',url:WX_SERVER_URL+'/wx/proxy',headers:{auth:WX_AUTH}, timeout:70000, data:{appid:APP.appid,openid:this.openid,url:GQL_URL,method:'POST',needCookie:false,headers:{'content-type':'application/json','x-provider-id':APP.appid},body:JSON.stringify({query,variables:{client_id:APP.appid,code},operationName:'codeLogin'})}});
        const data = typeof exchange.data?.data === 'string' ? JSON.parse(exchange.data.data) : exchange.data?.data;
        const token = data?.data?.login;
        if (exchange.status !== 200 || exchange.data?.status !== true || exchange.data.statusCode !== 200 || data?.errors?.length || typeof token !== 'string' || !token) throw new Error('native login token unconfirmed');
        this.token = token;
        if (!(await this.checkToken())) throw new Error('native token unauthorized');
        if (!READ_ONLY) this.saveCachedToken();
        $.log(`账号[${this.index}] 原生会话登录成功`);
    }

    async checkToken() {
        const res = await this.gql(
            `query ViewerBalance {
                viewer {
                    uid
                    wallet {
                        points
                    }
                }
            }`,
            {},
            this.token,
            true
        );
        if (res?.errors?.some(e => e?.message === 'Unauthenticated.')) return false;
        if (!res || res.errors?.length || !res.data?.viewer || !res.data.viewer.uid) throw new Error('viewer authority unavailable');
        return true;
    }

    async queryHome() {
        const res = await this.gql(
            `query home($client_id: String!) {
                viewer {
                    uid
                    wallet {
                        points
                    }
                    todoActivityRecords {
                        id
                        progress
                        rewarded_at
                        completed_at
                        completed_at_today
                        completed_at_yesterday
                        activity {
                            auto_reward
                            button_action
                            full_rules {
                                reward_desc
                                reward_mode
                                reward_type
                                rule_desc
                            }
                            type
                            name
                            need_times
                            id
                            icon
                            description
                            cycle_quota
                            button_name
                            url
                        }
                    }
                }
                socialApp(client_id: $client_id) {
                    name
                    config
                }
            }`,
            { client_id: APP.appid }
        );

        if (!res?.data?.viewer?.uid || !Array.isArray(res.data.viewer.todoActivityRecords)) throw new Error('home authority malformed');
        this.viewer = res.data.viewer;
        this.socialApp = res.data.socialApp || {};
        const records = this.viewer.todoActivityRecords;
        const signs = records.filter((item) => item.activity?.name === "每日签到");
        if (signs.length !== 1 || typeof signs[0].completed_at_today !== 'boolean' || !Number.isInteger(signs[0].activity?.id)) throw new Error('unique daily checkin authority unavailable');
        this.checkIn = signs[0];
        this.videoTask =
            records.find((item) => /视频/.test(item.activity?.name || "") || item.activity?.button_action === "seeVideo") || null;

        $.log(`查询：米豆=${this.viewer.wallet?.points ?? "未知"} 小程序=${this.socialApp.name || APP.name}`);
        if (this.checkIn) {
            $.log(
                `签到任务：id=${this.checkIn.activity.id} 今日${this.checkIn.completed_at_today ? "已完成" : "未完成"} progress=${this.checkIn.progress}/${this.checkIn.activity.cycle_quota}`
            );
        } else {
            $.log("签到任务：未找到");
        }
        if (this.videoTask) {
            $.log(
                `视频任务：id=${this.videoTask.activity.id} 今日${this.videoTask.completed_at_today ? "已完成" : "未完成"} progress=${this.videoTask.progress}/${this.videoTask.activity.cycle_quota}`
            );
        } else {
            $.log("视频任务：未找到");
        }
    }

    async pointsRecords() {
        const res = await this.gql(
            `query records {
                viewer {
                    pointsRecords(page: 1) {
                        data {
                            amount
                            balance
                            action
                            created_at
                            in_out
                            reward_type
                        }
                    }
                }
            }`,
            {},
            this.token,
            true
        );
        const records = res?.data?.viewer?.pointsRecords?.data || [];
        if (records.length) {
            const text = records
                .slice(0, 5)
                .map((item) => `${item.created_at} ${item.action} ${item.amount} 余额=${item.balance}`)
                .join(" | ");
            $.log(`米豆明细：${text}`);
        }
    }

    async activityPush(activityId, label) {
        if (READ_ONLY || !this.writePermit) throw new Error('activity mutation requires durable guard');
        const res = await this.gql(
            `mutation activity($activity_id: Int!) {
                activityPush(id: $activity_id) {
                    code
                    message
                    reward_log {
                        action
                        reward_type
                        amount
                        balance
                    }
                }
            }`,
            { activity_id: Number(activityId) },
            this.token,
            true
        );
        const result = res?.data?.activityPush;
        if (!result) return `${label}失败: ${short(res)}`;
        if (Number(result.code) === 0) {
            const log = result.reward_log || {};
            return `${label}成功：${log.action || label} +${log.amount ?? 0}米豆，余额=${log.balance ?? "未知"}`;
        }
        return `${label}失败：${result.message || short(result)}`;
    }

    async guardedActivity(action, authority, write) {
        if (READ_ONLY) throw new Error('readonly mutation blocked');
        const hash = crypto.createHash('sha256').update(String(this.openid)).digest('hex');
        const file = path.join(__dirname, `mimeng_actions_${hash}.json`), lock = file + '.lock';
        const fd = fs.openSync(lock, 'wx', 0o600);
        try {
            const state = loadState(file), key = dayKey() + ':' + action;
            const check = async () => { const v = await authority(); if (typeof v !== 'boolean') throw new Error('non-boolean authority'); return v; };
            if (await check()) return;
            const old = state.entries[key];
            if (old) {
                if (old.attempts >= 2) throw new Error('daily action attempts exhausted');
                const at = Date.parse(old.attemptedAt);
                if (!Number.isFinite(at) || Date.now() - at < 300000) throw new Error('unconfirmed action cooling');
                await $.wait(500);
                if (await check()) return;
            }
            state.entries[key] = { ...(old || {}), day: dayKey(), attempts: (old?.attempts || 0) + 1, outcome:'attempting', attemptedAt:new Date().toISOString() };
            atomicState(file, state);
            this.writeAttempted = true;
            this.writePermit = true;
            try { await write(); } catch (_) { /* Every attempted mutation is finalized by authority. */ } finally { this.writePermit = false; }
            for (let i = 0; i < 3; i++) {
                try { if (await check()) { state.entries[key].outcome = 'success'; atomicState(file, state); return; } } catch (_) {}
                if (i < 2) await $.wait(500 * (i + 1));
            }
            state.entries[key].outcome = 'unknown'; atomicState(file, state);
            throw new Error('mutation unconfirmed; no replay');
        } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    }

    async doSign() {
        if (!this.checkIn || typeof this.checkIn.completed_at_today !== 'boolean') throw new Error('checkin state unavailable');
        if (this.checkIn.completed_at_today === true) return '今日已签到（权威确认）';
        const id = this.checkIn.activity.id;
        await this.guardedActivity('sign:' + id, async () => {
            await this.queryHome();
            if (this.checkIn.activity.id !== id) throw new Error('activity changed during sign');
            return this.checkIn.completed_at_today;
        }, () => this.activityPush(id, '签到'));
        return '签到成功（权威回查确认）';
    }

    async doVideo() {
        if (!this.videoTask) return ["未找到视频任务"];
        const total = Number(this.videoTask.activity?.cycle_quota || 0);
        const progress = Number(this.videoTask.progress || 0);
        const remaining = Math.max(0, total - progress);
        if (!remaining) return ["视频任务今日已完成"];

        const limit = Number(process.env.mimeng_video_times || remaining);
        const times = Math.max(0, Math.min(remaining, Number.isFinite(limit) ? limit : remaining));
        const results = [];
        for (let i = 0; i < times; i++) {
            await this.queryHome();
            const id = this.videoTask?.activity?.id, before = this.videoTask?.progress;
            if (!Number.isInteger(id) || !Number.isInteger(before)) throw new Error('video progress authority invalid');
            if (before >= total) break;
            await this.guardedActivity('video:' + id + ':' + before, async () => {
                await this.queryHome();
                if (this.videoTask?.activity?.id !== id || !Number.isInteger(this.videoTask?.progress)) throw new Error('video authority changed');
                return this.videoTask.progress > before;
            }, () => this.activityPush(id, `视频任务[${i + 1}/${times}]`));
            results.push('视频进度已权威确认');
            await $.wait(1200);
        }
        return results;
    }

    async run() {
        await this.login();
        await this.queryHome();
        if (READ_ONLY) { $.log(`只读权威验证：${this.checkIn.completed_at_today ? '已签' : '未签'}，零业务写`); return; }
        $.log(`签到：${await this.doSign()}`);
        try {
            const videos = await this.doVideo();
            for (const result of videos) $.log(`视频任务：${result}`);
        } catch (e) { this.optionalFailed = 1; $.log(`可选视频未完成：${safeError(e)}`); }
        await this.queryHome();
        await this.pointsRecords();
        this.saveCachedToken();
    }
}

async function runAccount(openid, index) {
    const runner = new Mimeng(openid, index);
    try { await runner.run(); return { failed:0, optional:runner.optionalFailed || 0, wrote:!!runner.writeAttempted }; }
    catch (e) { $.log(`账号[${index}] 未完成：${safeError(e)}`); return { failed:1, optional:runner.optionalFailed || 0, wrote:!!runner.writeAttempted }; }
}

(async () => {
    const accounts = splitAccounts(process.env[CK_NAME] || DEFAULT_OPENID || "");
    if (!accounts.length) throw new Error('no configured accounts');
    let failed = 0, optional = 0, wrote = false;
    for (let i = 0; i < accounts.length; i++) {
        const r = await runAccount(accounts[i], i + 1);
        failed += r.failed; optional += r.optional; wrote = wrote || r.wrote;
    }
    $.log(`[QLRUN_RESULT] ${failed ? 'FAILURE' : 'SUCCESS'} accounts=${accounts.length} failed=${failed} optional_failed=${optional} retryable=${failed && !wrote ? 1 : 0} mode=${READ_ONLY ? 'readonly' : 'normal'}`);
    if (failed) process.exitCode = 1;
})().catch(e => { $.log(safeError(e)); $.log('[QLRUN_RESULT] FAILURE reason=script_error retryable=0'); process.exitCode = 1; }).finally(() => $.done());
