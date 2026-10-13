/*
------------------------------------------
@Description: 携程会员 - 微信小程序静默登录 + 每日签到
cron: 24 7,19 * * *
------------------------------------------
变量名：xchy
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行分隔（可加 #备注）

依赖变量：
wx_server_url  默认 http://192.168.31.196:8787
wx_auth        必填，wx_server 鉴权值
------------------------------------------
契约（appid wx0e6ed4f51db9d078，passport.ctrip.com / m.ctrip.com）：
（迁移自 YYB-GO 系脚本，原脚本已 code 登录；登录仅需 wx code，无需明文 openid/加密手机号）

登录三步（PASSPORT gateway，均包 {ReturnCode,Result}，ReturnCode==0 且 Result.resultStatus.returnCode==0）：
  1) soa2/14553/wechatLogin.json   {AccountHead:{},Data:{authCode:code,thirdConfigCode:ACCESS_CODE,Context:{}}} -> Result.wechatCode
  2) soa2/14553/authenticate.json  {AccountHead:{},Data:{authCode:wechatCode,thirdType:"wechat_app",thirdConfigCode:ACCESS_CODE,context:{encryptedData:"",iv:"",uuid:""}}} -> Result.token
  3) soa2/12559/thirdPartyLogin.json {...token,extendedProperties:{clientID:CLIENT_ID,thirdConfigCode:ACCESS_CODE,...}} -> Result.ticket(=cticket cookie)/duid/udl/uid
签到状态  POST m.ctrip.com/restapi/soa2/13012/getSignTodayInfoProxy （带 _fxpcqlniredt=CLIENT_ID + head.auth=ticket）
          注意：携程"运行态校验"可能 401 code=11001 拦截此代理接口
签到      POST m.ctrip.com/restapi/soa2/22769/signToday {openId} 头 Cookie: cticket=<ticket> -> ResponseStatus.Ack=Success
ACCESS_CODE(XTHYY69RNSKLWEICHATMINI)/CLIENT_ID/PACKAGE_VERSION 是这家小程序固定应用常量（原脚本硬编码，非个人凭证）。
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("携程会员签到");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const ckName = "xchy";
const MINI_APP_ID = "wx0e6ed4f51db9d078";
const PACKAGE_VERSION = "1055";
const CLIENT_ID = "09031101311473737701";
const ACCESS_CODE = "XTHYY69RNSKLWEICHATMINI";
const API_BASE = "https://m.ctrip.com";
const PASSPORT_BASE = "https://passport.ctrip.com/gateway/api";
const TOKEN_CACHE_FILE = path.join(__dirname, "xchy_token_cache.json");
const UA_MP =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

const DEBUG = process.env.xchy_debug === "1";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://192.168.31.196:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

function readCache() {
    try { if (!fs.existsSync(TOKEN_CACHE_FILE)) return {}; return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {}; } catch (e) { return {}; }
}
function writeCache(c) {
    try { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(c, null, 2), "utf8"); } catch (e) { $.log(`写入缓存失败: ${e.message || e}`); }
}
function parseAccount(raw = "") {
    const [id, remark] = String(raw).split("#").map((s) => (s || "").trim());
    return { openid: id, remark: remark || "" };
}
function short(v, n = 300) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}
function mask(value = "") {
    value = String(value);
    if (!value) return "";
    if (value.length <= 12) return `${value.slice(0, 3)}***`;
    return `${value.slice(0, 6)}***${value.slice(-6)}`;
}
function parseJsonMaybe(text) {
    if (!text || typeof text !== "string") return text;
    try { return JSON.parse(text); } catch { return text; }
}
function okResponseStatus(data) {
    return data?.ResponseStatus?.Ack === "Success" || data?.responseStatus?.ack === "Success";
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.openid = this.account.openid || "";
        this.ticket = "";
        this.duid = "";
        this.udl = "";
        this.uid = "";
        this.retryable = true;
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }

    async getCode() {
        const { data } = await wechat.getCode(this.openid);
        if (data && data.status === false) throw new Error(`wx_server 取code失败: ${data.message || short(data)}`);
        const code = data?.data?.code || data?.code;
        if (!code || typeof code !== "string") throw new Error(`wx_server 未返回 code: ${short(data)}`);
        return code;
    }

    // PASSPORT gateway：body 为 JSON 字符串，返回 {ReturnCode, Result(字符串)}
    async gateway(pathname, data) {
        const res = await axios.post(`${PASSPORT_BASE}/${pathname}`, JSON.stringify(data), {
            timeout: 30000,
            validateStatus: () => true,
            headers: {
                "Content-Type": "application/json",
                "User-Agent": UA_MP,
                Referer: `https://servicewechat.com/${MINI_APP_ID}/${PACKAGE_VERSION}/page-frame.html`,
            },
        });
        if (DEBUG) this.log(`gateway ${pathname} [${res.status}]: ${short(res.data, 500)}`);
        if (res.status !== 200 || Number(res.data?.ReturnCode) !== 0) {
            throw new Error(`${pathname} 失败[${res.status}]: ${short(res.data)}`);
        }
        return parseJsonMaybe(res.data.Result || "{}");
    }

    // m.ctrip.com H5 接口（cticket cookie 鉴权）
    async h5Api(pathname, data) {
        const cookies = [];
        if (this.ticket) cookies.push(`cticket=${this.ticket}`);
        if (this.duid) cookies.push(`DUID=${encodeURIComponent(this.duid)}`);
        if (this.udl) cookies.push(`_udl=${this.udl}`);
        cookies.push(`GUID=${CLIENT_ID}`);
        const res = await axios.post(`${API_BASE}${pathname}`, JSON.stringify(data || {}), {
            timeout: 30000,
            validateStatus: () => true,
            headers: {
                "Content-Type": "application/json",
                "User-Agent": UA_MP,
                Referer: "https://m.ctrip.com/",
                Cookie: `${cookies.join("; ")};`,
            },
        });
        return { status: res.status, data: res.data, text: typeof res.data === "string" ? res.data : JSON.stringify(res.data) };
    }

    // XWeb 桥：经 wx_server /wx/xweb 转发到 d4 hook 模块，在真实微信 WebView 会话内执行 JS
    // （外部 passport cticket 体系不被 m.ctrip.com/restapi 认可 -> 404001；真实会话内读接口全部成功）
    async xwebEval(script, urlPrefix) {
        const serverUrl = (process.env.wx_server_url || "http://192.168.31.196:8787").replace(/\/+$/, "");
        const res = await axios.post(`${serverUrl}/wx/xweb`, { appid: MINI_APP_ID, script, urlPrefix }, {
            timeout: 45000,
            validateStatus: () => true,
            headers: { "Content-Type": "application/json", auth: process.env.wx_auth || "" },
        });
        const data = res.data || {};
        if (res.status !== 200 || data.status === false) throw new Error(`xweb 桥: ${data.message || res.status}`);
        return data; // {ok, url, out}
    }

    // 在真实签到 H5 会话内执行 signToday（页面自身会话 cookie + 动态 GUID），如实拿到服务端判定
    async signViaXWeb() {
        const PREFIX = "https://m.ctrip.com/activitysetupapp/mkt/index/membersignin2021";
        const inj = "(function(){if(window.__xchyR)return window.__xchyR;window.__xchyR='PENDING';" +
            "var u=document.URL||'';var cid='';var m=u.match(/cid%22%3A%22([0-9]+)/);if(m)cid=m[1];" +
            "var oid='';m=u.match(/mpopenid=([^&]+)/);if(m){try{oid=decodeURIComponent(m[1]);}catch(e){oid=m[1];}}" +
            "var body=JSON.stringify({platform:'miniProgram',openId:oid,rmsToken:'',head:{cid:cid,ctok:'',cver:'1.0',lang:'01',sid:'8888',syscode:'09',auth:'',xsid:'',extension:[]}});" +
            "fetch('https://m.ctrip.com/restapi/soa2/22769/signToday',{method:'POST',headers:{'Content-Type':'application/json'},body:body})" +
            ".then(function(r){return r.text();}).then(function(t){window.__xchyR=t;})" +
            ".catch(function(e){window.__xchyR='ERR:'+String(e&&e.message||e);});" +
            "return 'PENDING';})()";
        const r1 = await this.xwebEval(inj, PREFIX);
        if (r1.out && r1.out !== 'PENDING') return parseJsonMaybe(r1.out);
        for (let i = 0; i < 10; i++) {
            await new Promise((rs) => setTimeout(rs, 2000));
            const rr = await this.xwebEval("(function(){return window.__xchyR||'NONE';})()", PREFIX);
            const out = rr.out || '';
            if (out && out !== 'PENDING' && out !== 'NONE') return parseJsonMaybe(out);
        }
        throw new Error('XWeb 代签超时（20s 无响应）');
    }

    async fetchMarketOpenId() {
        const code = await this.getCode();
        const res = await this.h5Api("/restapi/soa2/13447/getMKTOpenID.json", {
            appID: MINI_APP_ID,
            code,
            platformType: "android",
            allianceID: "262684",
            sID: "711465",
            oUID: "",
            sourceID: "",
            exMKTID: "",
            pageID: "",
        });
        const data = res.data || {};
        const openId = data?.data?.mktOpenID || data?.mktOpenID || "";
        const resultCode = String(data?.data?.resultCode ?? data?.resultCode ?? "");
        if (res.status !== 200 || resultCode !== "0" || !openId) {
            throw new Error(`获取携程市场openId失败[${res.status}]: ${data?.resultMsg || data?.message || short(data)}`);
        }
        this.ctripOpenId = String(openId);
        this.log("携程市场身份获取成功");
        return this.ctripOpenId;
    }

    saveCache() {
        const cache = readCache();
        cache[this.openid] = {
            ticket: this.ticket, duid: this.duid, udl: this.udl, uid: this.uid,
            ctripOpenId: this.ctripOpenId, updatedAt: new Date().toISOString(),
        };
        writeCache(cache);
    }

    async login() {
        const code = await this.getCode();

        const wxLogin = await this.gateway("soa2/14553/wechatLogin.json", {
            AccountHead: {},
            Data: { authCode: code, thirdConfigCode: ACCESS_CODE, Context: {} },
        });
        if (!wxLogin?.wechatCode || wxLogin?.resultStatus?.returnCode !== 0) {
            throw new Error(`wechatLogin未返回wechatCode: ${short(wxLogin)}`);
        }

        const auth = await this.gateway("soa2/14553/authenticate.json", {
            AccountHead: {},
            Data: {
                authCode: wxLogin.wechatCode, thirdType: "wechat_app", thirdConfigCode: ACCESS_CODE,
                context: { encryptedData: "", iv: "", uuid: "" },
            },
        });
        if (!auth?.token || auth?.resultStatus?.returnCode !== 0) {
            throw new Error(`authenticate未返回token: ${short(auth)}`);
        }

        const login = await this.gateway("soa2/12559/thirdPartyLogin.json", {
            AccountHead: {},
            Data: {
                accountHead: { locale: "zh_CN", platform: "MINIAPP" },
                token: auth.token,
                extendedProperties: {
                    clientID: CLIENT_ID, page_id: "", Url: "", thirdConfigCode: ACCESS_CODE,
                    deviceName: "Windows PC", OsType: "windows",
                },
            },
        });
        if (!login?.ticket || login?.resultStatus?.returnCode !== 0) {
            // 登录链走通但没换到 ticket —— 视作该微信号未在携程注册/绑定
            this.unregistered = true;
            throw new Error(`NO_ACCOUNT:thirdPartyLogin未返回ticket: ${short(login)}`);
        }

        this.ticket = login.ticket;
        this.duid = login.duid || login.extendedProperties?.duid || "";
        this.udl = login.udl || "";
        this.uid = login.uid || login.extendedProperties?.uid || "";
        await this.fetchMarketOpenId();
        this.saveCache();
        this.log(`登录成功: ${mask(this.uid || this.ticket)}`);
    }

    async ensureLogin() {
        const cached = readCache()[this.openid] || {};
        if (!this.ticket && cached.ticket) {
            this.ticket = cached.ticket; this.duid = cached.duid || ""; this.udl = cached.udl || "";
            this.uid = cached.uid || ""; this.ctripOpenId = cached.ctripOpenId || "";
            this.log("使用缓存ticket");
            if (!this.ctripOpenId) {
                this.log("缓存缺少携程市场身份，正在自动补齐");
                await this.fetchMarketOpenId();
                this.saveCache();
            }
            return;
        }
        if (!this.ticket) await this.login();
    }

    async querySignStatus() {
        // getSignTodayInfoProxy 走 Cookie 直连通道可读（_fxpcqlniredt 代理通道会被运行态校验 401/11001 拦截）
        const res = await this.h5Api("/restapi/soa2/13012/getSignTodayInfoProxy", {});
        if (res.status !== 200 || !okResponseStatus(res.data)) {
            if (DEBUG) this.log(`签到状态查询异常[${res.status}]: ${short(res.text, 400)}`);
            return null;
        }
        const info = parseJsonMaybe(res.data.responseJson || "{}");
        const signed = !!(info && (info.sign === true));
        this.log(`今日签到状态: ${signed ? "已签到" : "未签到"}${info.totalPoint !== undefined ? `，积分${info.totalPoint}` : ""}`);
        return { signed, raw: info };
    }

    async sign(retry = true) {
        const st = await this.querySignStatus();
        if (st && st.signed) {
            this.log("✅ 今日已签到");
            return true;
        }

        // ===== 主路径：XWeb 桥代签（真实微信 WebView 会话；外部直连必然 404001 未登录）=====
        try {
            const r = await this.signViaXWeb();
            const message = (r && (r.message || r.Message)) || "";
            const code = Number(r && r.code);
            const points = Number(r && (r.baseIntegratedPoint || 0)) + Number(r && (r.extraIntegratedPoint || 0));
            if (okResponseStatus(r) && (code === 0 || /成功/.test(message))) {
                this.log(`✅ 签到成功（真实小程序会话）${message ? `：${message}` : ""}${points ? `，积分+${points}` : ""}`);
                return true;
            }
            if (/已签到|已经签到|无法补签|重复/.test(message) || code === 400001) {
                this.log(`✅ 今日已签到（真实小程序会话：${message || code}）`);
                return true;
            }
            if (code === 404002 || /未满足当前活动参与条件/.test(message)) {
                throw new Error(`ACCOUNT_RISK:签到失败[404002 账号活动风控]：${message || "未满足当前活动参与条件"}。已由真实手机复现，与脚本、登录态及 VPS 地域无关；该账号当前不可参与活动`);
            }
            if (code === 404001 || /未登录|登录失效|请重新登录/.test(message)) {
                if (retry) { this.log("XWeb 桥会话未登录(404001)，等待后重试"); await new Promise((rs) => setTimeout(rs, 4000)); return this.sign(false); }
                throw new Error(`签到失败[404001]：${message || ""}`);
            }
            if (/^ERR:/.test(String(r))) {
                this.log(`XWeb 桥注入执行错误：${String(r).slice(0, 200)}，降级外部直连`);
            } else {
                this.log(`XWeb 桥返回未识别响应：${short(r, 300)}，降级外部直连`);
            }
        } catch (e) {
            if (/404002|未满足当前活动参与条件/.test(e.message)) throw e;
            this.log(`XWeb 桥代签不可用：${e.message}，降级外部直连`);
        }

        // ===== 降级：外部 Cookie 直连（passport cticket 体系；历史验证会被 404001 未登录拦截）=====
        if (!this.ctripOpenId) throw new Error("缺少携程市场openId，禁止使用账号标签冒充签到身份");
        const res = await this.h5Api("/restapi/soa2/22769/signToday", { openId: this.ctripOpenId });
        if (DEBUG) this.log(`signToday [${res.status}]: ${short(res.text, 500)}`);

        if (res.status === 401 && (res.data?.code === "11001" || res.data?.code === 11001)) {
            throw new Error(`签到接口被携程运行态校验拦截(401/11001)：${res.data.message || ""}`);
        }
        if (res.status !== 200) {
            // 会话失效重登重试一次
            if (retry && (res.status === 403 || /token|登录|未授权|失效|过期|未登录|鉴权/i.test(res.text))) {
                this.log("会话可能失效，重新登录后重试");
                this.ticket = ""; delete readCache()[this.openid];
                await this.login();
                return this.sign(false);
            }
            throw new Error(`签到请求异常[${res.status}]: ${short(res.text, 500)}`);
        }
        const d = res.data || {};
        const message = d.message || d.Message || "";
        const code = Number(d.code);
        const points = Number(d.baseIntegratedPoint || 0) + Number(d.extraIntegratedPoint || 0);
        if (okResponseStatus(d) && (code === 0 || /成功/.test(message))) {
            this.log(`✅ 签到成功${message ? `：${message}` : ""}${points ? `，积分+${points}` : ""}`);
            return true;
        }
        if (/已签到|已经签到|无法补签|重复/.test(message) || code === 400001) {
            this.log(`✅ 今日已签到（${message || code}）`);
            return true;
        }
        // 404002「未满足当前活动参与条件」= 携程运行态校验(风控)：真正的签到走 _fxpcqlniredt 代理通道，
        // 需小程序运行态生成的私有签名(n-payload-source/cSign)，Cookie 直连通道拿不到该上下文 -> 被拦。
        if (code === 404002 || /未满足当前活动参与条件/.test(message)) {
            throw new Error(`签到被携程运行态校验拦截：${message || code}`);
        }
        // 404001「未登录」：携程业务码，HTTP 200 + Ack=Success 时会被下方 okResponseStatus 分支当成
        // 正常返回直接打印，导致缓存 cticket 失效却不触发重登。显式在此拦截并刷新 ticket 重试一次。
        if (code === 404001 || /未登录|登录失效|请重新登录/.test(message)) {
            if (retry) {
                this.log("会话失效(404001 未登录)，重新登录后重试");
                this.ticket = ""; delete readCache()[this.openid];
                await this.login();
                return this.sign(false);
            }
            throw new Error(`签到失败：${message || code}`);
        }
        if (okResponseStatus(d)) {
            return this.log(`签到返回：${short(res.text, 500)}`);
        }
        // 未授权类 -> 重登重试
        if (retry && /token|登录|未授权|失效|过期|未登录|鉴权/i.test(res.text)) {
            this.log("会话可能失效，重新登录后重试");
            this.ticket = "";
            await this.login();
            return this.sign(false);
        }
        throw new Error(`签到失败：${short(res.text, 500)}`);
    }

    async run() {
        if (!this.openid) { this.log("跳过：变量值里没有账号标识"); return false; }
        try {
            await this.ensureLogin();
            return await this.sign();
        } catch (e) {
            if (String(e.message).startsWith("ACCOUNT_RISK:")) {
                this.retryable = false;
                this.log(`执行失败: ${String(e.message).replace(/^ACCOUNT_RISK:/, "")}`);
                return false;
            }
            if (String(e.message).startsWith("NO_ACCOUNT")) {
                this.log("⚠️ 该微信号还没在携程注册/绑定会员，先在小程序里登录一次再跑");
                return false;
            }
            this.log(`执行失败: ${e.message || e}`);
            return false;
        }
    }
}

!(async () => {
    $.checkEnv(ckName);
    if (!$.userCount) {
        $.log(`未找到变量 ${ckName}`);
        console.log("[QLRUN_RESULT] FAILURE accounts=0 failed=1 retryable=0");
        return;
    }
    let failed = 0, retryableFailed = 0;
    for (let i = 0; i < $.userList.length; i++) {
        const task = new Task($.userList[i]);
        if (!(await task.run())) {
            failed += 1;
            if (task.retryable !== false) retryableFailed += 1;
        }
        if (i < $.userList.length - 1) await $.wait(1500, 3000);
    }
    if (failed) console.log(`[QLRUN_RESULT] FAILURE accounts=${$.userList.length} failed=${failed} retryable=${retryableFailed ? 1 : 0}`);
    else console.log(`[QLRUN_RESULT] SUCCESS accounts=${$.userList.length} failed=0`);
})().catch((e) => {
    $.log(e.message || e);
    console.log("[QLRUN_RESULT] FAILURE accounts=0 failed=1 retryable=1");
}).finally(() => $.done());
