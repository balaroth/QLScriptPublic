/*
洽洽会员俱乐部：每日签到。cron: 39 8 * * *
变量 qqhyjlb：wx_server账号标识，多账号用 & 或换行，可加 #备注。
依赖 wx_server_url、wx_auth；只读开关 QQHYJLB_READ_ONLY=1 或 QL_READ_ONLY=1。
官方v538会员链：UPMS code登录 -> Authorization token + uid=loginId。
每日签到 /vip/member/sign；权威记录 /vip/member/listUserSignLog。
旧品鉴厅商户ID和SESSION不是会员签到前置，不再调用mobile登录。
当前DNS入口只用TLS校验的无鉴权GET选择，业务POST单次发送不自动重试。
写前耐久attempting；写后只读收敛；冷却后双权威允许一次最后恢复，总上限2。
*/
'use strict';
const { Env } = require('../tools/env.js');
const $ = new Env('洽洽会员俱乐部');
const axios = require('axios');
const { Agent, request } = require('undici');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const APP = 'wxc72491b6cd007333';
const HOST = 'vip.qiaqiafood.com';
const BASE = 'https://' + HOST;
const CACHE = path.join(__dirname, 'qqhyjlb_token_cache.json');
const STATE = path.join(__dirname, '.qqhyjlb_write_state.json');
const LOCK = path.join(__dirname, '.qqhyjlb_write.lock');
const READ_ONLY = process.env.QQHYJLB_READ_ONLY === '1' || process.env.QL_READ_ONLY === '1';
const SIGN = '/vip/member/sign';
const LIST = '/vip/member/listUserSignLog';
const EXT = '/vip/member/getVipExtInfo';
const LOGIN = '/upms/wechat/login/code';
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/119.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.49 MiniProgramEnv/android';
function today() {
    const d = new Date(Date.now() + 8 * 3600000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function readJson(file) {
    try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!d || Array.isArray(d) || typeof d !== 'object') throw new Error('persistent_object_invalid');
        return d;
    } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function persist(file, value) {
    if (READ_ONLY) throw new Error('read_only_file_write_blocked');
    const payload = Buffer.from(JSON.stringify(value));
    const tmp = file + `.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
    let fd;
    try {
        fd = fs.openSync(tmp, 'wx', 0o600);
        let offset = 0;
        while (offset < payload.length) {
            const n = fs.writeSync(fd, payload, offset, payload.length-offset);
            if (!Number.isInteger(n) || n <= 0 || n > payload.length-offset) throw new Error('persistent_short_write');
            offset += n;
        }
        fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(tmp, file);
        const dir = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
        if (!fs.readFileSync(file).equals(payload)) throw new Error('persistent_readback_failed');
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
}
function record(key, entry) { const d = readJson(STATE); d[key] = entry; persist(STATE, d); }
function ok(http, d) { return http === 200 && d && d.status === '0' && d.success !== false; }
function message(d) { return typeof d?.msg === 'string' ? d.msg.slice(0,180) : 'invalid_response'; }
function dayOf(row, month) {
    if (!row || typeof row !== 'object' || !/^\d{1,2}$/.test(String(row.dayMonth))) throw new Error('sign_record_day_invalid');
    const day = Number(row.dayMonth);
    if (day < 1 || day > 31 || typeof row.createTime !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]/.test(row.createTime)) throw new Error('sign_record_date_invalid');
    if (row.createTime.slice(0,7) !== month || Number(row.createTime.slice(8,10)) !== day) throw new Error('sign_record_date_conflict');
    return `${month}-${String(day).padStart(2,'0')}`;
}
class Task {
    constructor(raw) {
        const [id, remark] = String(raw).split('#');
        this.id = id.trim(); this.remark = remark || ''; this.agent = null;
        this.session = {token:'', loginId:''}; this.writeAttempted = 0;
    }
    log(s) { $.log(s); }
    makeAgent(ip) {
        return new Agent({ connect: {timeout:5000, lookup:(host, options, callback) => {
            if (host !== HOST) return callback(new Error('unexpected_lookup_host'));
            if (options.all) callback(null,[{address:ip,family:4}]); else callback(null,ip,4);
        }}});
    }
    async selectEdge() {
        if (this.agent) return;
        const found = await dns.lookup(HOST, {all:true,family:4});
        const addresses = [...new Set(found.filter(x=>x.family===4).map(x=>x.address))].slice(0,8);
        for (const ip of addresses) {
            const agent = this.makeAgent(ip);
            try {
                // Unauthenticated parameter-error response proves a reachable correct API, not login success.
                const r = await request(BASE+LOGIN, {dispatcher:agent,headersTimeout:5000,bodyTimeout:5000,maxRedirections:0});
                const d = await r.body.json();
                if (r.statusCode === 200 && d.code === '010001' && d.status === '-1' && d.success === false) {
                    this.agent = agent; return;
                }
            } catch (error) { this.log('跳过当前不可达入口，尚未发送业务写入'); }
            await agent.close();
        }
        throw new Error('no_verified_reachable_edge');
    }
    async api(endpoint, data, authenticated=true) {
        if (!this.agent) throw new Error('edge_not_ready');
        const body = new URLSearchParams({...data, ...(authenticated?{uid:this.session.loginId}:{}),tenantId:'1'}).toString();
        const r = await request(BASE+endpoint, {method:'POST',body,dispatcher:this.agent,maxRedirections:0,headersTimeout:15000,bodyTimeout:10000,headers:{'content-type':'application/x-www-form-urlencoded; charset=UTF-8','User-Agent':UA,Referer:`https://servicewechat.com/${APP}/538/page-frame.html`,...(authenticated?{Authorization:this.session.token}:{})}});
        let d;
        try { d = await r.body.json(); } catch (error) { throw new Error('non_json_response:'+endpoint); }
        return {http:r.statusCode,data:d};
    }
    async getCode() {
        if (!process.env.wx_auth) throw new Error('missing_wx_auth');
        const r = await axios.post((process.env.wx_server_url || 'http://192.168.31.196:8787').replace(/\/+$/,'')+'/wx/code',{appid:APP,openid:this.id},{headers:{auth:process.env.wx_auth},timeout:65000});
        const d = r.data, code = d?.code || d?.data?.code;
        if (d?.status === false || typeof code !== 'string' || !code) throw new Error('fresh_code_unavailable');
        return code;
    }
    async checkMember() {
        const r = await this.api(EXT,{});
        if (r.data?.status === '-2' || r.http === 401) return false;
        if (!ok(r.http,r.data) || !r.data.data || Array.isArray(r.data.data)) throw new Error('member_authority_unavailable:'+message(r.data));
        const v = r.data.data.vipLevel;
        if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) throw new Error('member_qualification_unconfirmed');
        return true;
    }
    async login() {
        const r = await this.api(LOGIN,{code:await this.getCode(),appId:APP,componentAppId:APP},false);
        const d = r.data?.data?.data || r.data?.data;
        if (!ok(r.http,r.data) || typeof d?.token !== 'string' || !d.token || !['string','number'].includes(typeof d.loginId) || !String(d.loginId)) throw new Error('upms_login_failed:'+message(r.data));
        this.session = {token:d.token,loginId:String(d.loginId)};
        if (!(await this.checkMember())) throw new Error('new_session_invalid');
        if (!READ_ONLY) { const cache = readJson(CACHE); cache[this.id] = {...this.session,updatedAt:new Date().toISOString()}; persist(CACHE,cache); }
        this.log('会员中心登录成功，已验证会员资格');
    }
    async ensureLogin() {
        await this.selectEdge();
        const cached = readJson(CACHE)[this.id];
        // Old userId contained a merchant identifier. Never migrate it into uid.
        if (typeof cached?.token === 'string' && cached.token && typeof cached.loginId === 'string' && cached.loginId) {
            this.session = {token:cached.token,loginId:cached.loginId};
            if (await this.checkMember()) { this.log('使用已验证会员会话'); return; }
        }
        await this.login();
    }
    async authority() {
        const date = today(), month = date.slice(0,7);
        const r = await this.api(LIST,{yearMonth:month});
        if (!ok(r.http,r.data) || !Array.isArray(r.data.data)) throw new Error('sign_record_unavailable:'+message(r.data));
        const dates = r.data.data.map(x=>dayOf(x,month));
        if (new Set(dates).size !== dates.length) throw new Error('duplicate_sign_records');
        return {signed:dates.includes(date),date,rows:r.data.data};
    }
    async sign() {
        let state = await this.authority();
        if (state.signed) { this.log('今日已签到（权威记录）'); return {already:1,writeAttempted:0}; }
        if (READ_ONLY) { this.log('只读：今日未签，零业务写'); return {already:0,writeAttempted:0}; }
        fs.mkdirSync(LOCK,{mode:0o700});
        try {
            const key = crypto.createHash('sha256').update(this.id).digest('hex')+'|'+state.date;
            state = await this.authority();
            if (state.signed) return {already:1,writeAttempted:0};
            const old = readJson(STATE)[key] || {}, attempts = old.attempts ?? 0;
            if (!Number.isInteger(attempts) || attempts < 0 || attempts >= 2) throw new Error('write_attempt_limit_or_invalid');
            if (Object.keys(old).length) {
                if (!['unknown','attempting'].includes(old.status) || !Number.isFinite(old.at) || Date.now()-old.at < 600000) throw new Error('existing_write_no_replay_or_cooldown');
                if ((await this.authority()).signed) return {already:1,writeAttempted:0};
            }
            if (today() !== state.date) throw new Error('date_changed_before_write');
            record(key,{status:'attempting',attempts:attempts+1,at:Date.now()});
            this.writeAttempted = 1;
            let responseStatus = '', responseMessage = '';
            try { const r = await this.api(SIGN,{channel:''}); responseStatus=String(r.data?.status??'');responseMessage=message(r.data); }
            catch (error) { responseMessage=error.message; }
            let confirmed = false;
            for (let n=0;n<2;n++) {
                try { const r = await this.authority(); confirmed=r.date===state.date && r.signed; } catch(error) { /* unknown remains fail-closed */ }
                if (confirmed) break;
            }
            record(key,{status:confirmed?'success':'unknown',attempts:attempts+1,at:Date.now(),authorityConfirmed:confirmed,responseStatus,responseMessage});
            if (!confirmed) throw new Error('sign_not_confirmed_no_replay:'+responseMessage);
            this.log('签到成功（服务端记录确认）');
            return {already:0,writeAttempted:1};
        } finally { fs.rmdirSync(LOCK); }
    }
    async run() {
        try { if(!this.id)throw new Error('empty_account');await this.ensureLogin();const r=await this.sign();return {ok:true,...r}; }
        catch(error) { this.log('执行失败：'+error.message);return {ok:false,writeAttempted:this.writeAttempted}; }
        finally { if(this.agent)await this.agent.close(); }
    }
}
async function main() {
    $.checkEnv('qqhyjlb');
    let success=0,already=0,writes=0;
    for(const account of $.userList){ const r=await new Task(account).run();if(r.ok)success++;already+=r.already||0;writes+=r.writeAttempted||0; }
    try { await $.sendMsg(); } catch(error) { $.log('通知失败，不改变业务结论'); }
    const valid=$.userCount>0&&success===$.userCount;
    console.log('[QLRUN_RESULT] '+(valid?'SUCCESS ':'FAILURE ')+JSON.stringify({script:'qqhyjlb.js',accounts:$.userCount,failed:$.userCount-success,already,writeAttempted:writes,retryable:0,mode:READ_ONLY?'read_only':'normal'}));
    process.exitCode=valid?0:1;
}
if(require.main===module) main().catch(error=>{console.error(error.message);console.log('[QLRUN_RESULT] FAILURE {"script":"qqhyjlb.js","retryable":0,"reason":"unexpected_error"}');process.exitCode=1;});
module.exports={Task,main,today,dayOf,readJson,persist,record,CACHE,STATE,LOCK,SIGN,LIST,EXT,LOGIN};
