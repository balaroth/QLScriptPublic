/*
百盛呼啦圈：每日签到。变量 parkson：wx_server账号标识，多个账号用 & 或换行；可用 token=会员token。
cron: 38 8 * * *
官方v43：appLogin匿名会话不是会员；手机号授权code通过registerV2恢复既有会员登录。
只读：PARKSON_READ_ONLY=1 或 QL_READ_ONLY=1。只读不写缓存/state/lock，不执行签到。
签到虽然是GET，仍是副作用写；写前耐久attempting，写后权威积分状态收敛，未知不直接重放。
*/
'use strict';
const { Env } = require('../tools/env.js');
const $ = new Env('百盛呼啦圈小程序签到');
const axios = require('axios');
const { request: directRequest } = require('undici');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const APP = 'wx89a714fb03b61b99';
const BASE = 'https://smp-api.iyouke.com/dtapi';
const CACHE = path.join(__dirname,'parkson_token_cache.json');
const STATE = path.join(__dirname,'.parkson_write_state.json');
const LOCK = path.join(__dirname,'.parkson_write.lock');
const READ_ONLY = process.env.PARKSON_READ_ONLY === '1' || process.env.QL_READ_ONLY === '1';
const SIGN = '/pointsSign/user/sign';
const POINTS = '/pointsSign/user/pointsInfo/query';
const LIST = '/pointsSign/user/sign/list';
const LOGIN = '/appLogin';
const BIND = '/user/registerV2';
function today() {
    const d = new Date(Date.now()+8*3600000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function readJson(file) {
    try { const v=JSON.parse(fs.readFileSync(file,'utf8'));if(!v||Array.isArray(v)||typeof v!=='object')throw new Error('persistent_object_invalid');return v; }
    catch(error) { if(error.code==='ENOENT')return {};throw error; }
}
function persist(file, value) {
    if(READ_ONLY)throw new Error('read_only_file_write_blocked');
    const payload=Buffer.from(JSON.stringify(value));
    const tmp=file+`.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
    let fd;
    try {
        fd=fs.openSync(tmp,'wx',0o600);let offset=0;
        while(offset<payload.length) { const n=fs.writeSync(fd,payload,offset,payload.length-offset);if(!Number.isInteger(n)||n<=0||n>payload.length-offset)throw new Error('persistent_short_write');offset+=n; }
        fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,file);
        const dir=fs.openSync(path.dirname(file),'r');try {fs.fsyncSync(dir);}finally {fs.closeSync(dir);}
        if(!fs.readFileSync(file).equals(payload))throw new Error('persistent_readback_failed');
    } finally {if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
function record(key,entry) { const v=readJson(STATE);v[key]=entry;persist(STATE,v); }
function token(v) {const s=String(v||'').trim();return s.replace(/^bearer\s*/i,'');}
function object(v) {return !!v&&typeof v==='object'&&!Array.isArray(v);}
function dataOf(r, endpoint) {
    const d=r.data;
    if(r.status!==200||!object(d)||('error'in d&&d.error!==0)||d.success===false)throw new Error('endpoint_rejected:'+endpoint+':http_'+r.status);
    return Object.prototype.hasOwnProperty.call(d,'data')?d.data:d;
}
function member(d) {return object(d)&&['string','number'].includes(typeof d.userId)&&String(d.userId).length>0&&typeof d.access_token==='string'&&!!d.access_token;}
function points(d) {
    if(!object(d)||typeof d.signTodayResult!=='boolean'||typeof d.pointsNums!=='number'||!Number.isFinite(d.pointsNums)||d.pointsNums<0)throw new Error('points_authority_invalid');
    return d;
}
function calendar(d,date) {
    if(!Array.isArray(d))throw new Error('calendar_invalid');
    const rows=d.filter(x=>object(x)&&x.dateStr===date);
    if(rows.length!==1||rows[0].isToday!==true||!Number.isInteger(rows[0].daySignStatus))throw new Error('calendar_today_ambiguous');
    return rows[0];
}
class Task {
    constructor(raw) {
        this.id=String(raw||'').split('#')[0].trim();this.direct=/^(token=|bearer)/i.test(this.id);
        this.session={access_token:'',userId:''};if(this.direct)this.session.access_token=token(this.id.replace(/^token=/i,''));
        this.writeAttempted=0;
    }
    log(s) {$.log(s);}
    headers() {return {'User-Agent':'Mozilla/5.0 (Linux; Android 13) MicroMessenger/8.0.49 MiniProgramEnv/android',Referer:`https://servicewechat.com/${APP}/43/page-frame.html`,appId:APP,version:'2.33.3',envVersion:'release','Content-Type':'application/json',...(this.session.access_token?{Authorization:'bearer'+token(this.session.access_token)}:{})};}
    async api(endpoint, method='GET', data={}, authenticated=true) {
        const headers=this.headers();if(!authenticated)delete headers.Authorization;
        // Brand traffic uses TLS-verified undici on d3, not the global gateway's retrying GET forwarder.
        // Both authentication POST and the side-effecting GET SIGN are single-send requests.
        const url=new URL(BASE+endpoint);
        if(method==='GET')for(const [k,v] of Object.entries(data))url.searchParams.set(k,String(v));
        const r=await directRequest(url,{method,headers,maxRedirections:0,headersTimeout:20000,bodyTimeout:20000,...(method==='GET'?{}:{body:JSON.stringify(data)})});
        // Authentication may return HTTP 401 with plain text, not JSON.
        // Preserve the status so validateMember can restore the official session.
        const raw=await r.body.text();let body;
        try {body=JSON.parse(raw);}catch(error) {
            if(r.statusCode===401&&endpoint!==SIGN)return {status:401,data:null};
            throw new Error('endpoint_non_json:'+endpoint+':http_'+r.statusCode);
        }
        return {status:r.statusCode,data:body};
    }
    async bridge(endpoint) {
        if(!process.env.wx_auth||!process.env.wx_server_url)throw new Error('missing_bridge_configuration');
        const r=await axios.post(process.env.wx_server_url.replace(/\/+$/,'')+endpoint,{appid:APP,openid:this.id},{headers:{auth:process.env.wx_auth},timeout:100000,maxRedirects:0});
        if(!object(r.data)||r.data.status!==true)throw new Error('bridge_authorization_unavailable');
        return r.data;
    }
    async validateMember() {
        const r=await this.api(POINTS);
        if(r.status===401)return false;
        points(dataOf(r,POINTS));return true;
    }
    async login() {
        const b=await this.bridge('/wx/code');const code=b.code||b.data?.code;
        if(typeof code!=='string'||!code)throw new Error('fresh_code_missing');
        let d=dataOf(await this.api(LOGIN,'POST',{appType:1,principal:code},false),LOGIN);
        if(!member(d)) {
            // Anonymous appLogin token is expected before member-phone authorization, not evidence of unregistration.
            const bundle=await this.bridge('/wx/phone-login-bundle'),body=bundle.data||bundle;
            const loginCode=body.loginCode||bundle.loginCode,phoneCode=body.phoneCode||bundle.phoneCode;
            if(typeof loginCode!=='string'||!loginCode||typeof phoneCode!=='string'||!phoneCode)throw new Error('phone_login_material_missing');
            const temporary=dataOf(await this.api(LOGIN,'POST',{appType:1,principal:loginCode},false),LOGIN);
            if(typeof temporary?.access_token!=='string'||!temporary.access_token)throw new Error('temporary_session_missing');
            this.session={access_token:temporary.access_token,userId:''};
            const response=await this.api(BIND,'POST',{code:phoneCode,parentId:null});
            if(response.data?.error!==0)throw new Error('phone_member_login_rejected');
            d=dataOf(response,BIND);
        }
        if(!member(d))throw new Error('member_session_incomplete');
        this.session={access_token:d.access_token,userId:String(d.userId)};
        if(!await this.validateMember())throw new Error('new_member_session_invalid');
        if(!READ_ONLY) {const c=readJson(CACHE);c[this.id]={accessToken:this.session.access_token,userId:this.session.userId,updatedAt:new Date().toISOString()};persist(CACHE,c);}
        this.log('会员登录成功，已通过受鉴权积分接口校验');
    }
    async ensureLogin() {
        if(!this.id)throw new Error('empty_account');
        if(this.direct) {if(!await this.validateMember())throw new Error('direct_token_invalid');return;}
        const c=readJson(CACHE)[this.id];
        if(object(c)&&c.userId&&(c.accessToken||c.access_token||c.authorization)) {
            this.session={access_token:token(c.accessToken||c.access_token||c.authorization),userId:String(c.userId)};
            if(await this.validateMember())return;
        }
        this.session={access_token:'',userId:''};await this.login();
    }
    async authority() {
        const date=today();
        const p=points(dataOf(await this.api(POINTS),POINTS));
        const row=calendar(dataOf(await this.api(LIST,'GET',{v4Flag:true}),LIST),date);
        if(today()!==date)throw new Error('date_changed_during_authority');
        // Public calendar alone is never authentication. Strict boolean on authenticated POINTS decides signed status.
        return {date,signed:p.signTodayResult,points:p.pointsNums,row};
    }
    key(date) {return crypto.createHash('sha256').update(this.direct?'token:'+token(this.session.access_token):this.id).digest('hex')+'|'+date;}
    reconcile(key,state) {
        const all=readJson(STATE),old=all[key];if(!old)return;
        if(!object(old)||!Number.isInteger(old.attempts)||old.attempts<0||old.attempts>2)throw new Error('persistent_entry_invalid');
        record(key,{...old,status:'success',authorityConfirmed:true,confirmedAt:Date.now()});
    }
    async sign() {
        let a=await this.authority();
        if(READ_ONLY)return {already:Number(a.signed),writeAttempted:0,points:a.points};
        fs.mkdirSync(LOCK,{mode:0o700});
        try {
            a=await this.authority();const key=this.key(a.date);
            if(a.signed) {this.reconcile(key,a);this.log('今日已签（受鉴权权威状态）');return {already:1,writeAttempted:0,points:a.points};}
            const all=readJson(STATE),old=all[key]||{};const attempts=old.attempts??0;
            if(!object(old)||!Number.isInteger(attempts)||attempts<0||attempts>=2)throw new Error('write_attempt_limit_or_invalid');
            if(Object.keys(old).length) {
                if(!['unknown','attempting'].includes(old.status)||!Number.isFinite(old.at)||Date.now()-old.at<600000)throw new Error('write_no_replay_or_cooldown');
                // Two consecutive authoritative negative observations, under lock, before the one final recovery write.
                const second=await this.authority();
                if(second.date!==a.date)throw new Error('date_changed_before_recovery');
                if(second.signed) {this.reconcile(key,second);return {already:1,writeAttempted:0,points:second.points};}
            }
            if(today()!==a.date)throw new Error('date_changed_before_write');
            record(key,{status:'attempting',attempts:attempts+1,at:Date.now()});
            this.writeAttempted=1;let http=null;
            try {const r=await this.api(SIGN,'GET',{date:a.date.replace(/-/g,'/')});http=r.status;}catch(error) { /* write result unknown; never repeat */ }
            let confirmed=null;
            for(let i=0;i<2;i++) {try {const b=await this.authority();if(b.date===a.date&&b.signed){confirmed=b;break;}}catch(error) {/* retain unknown */}}
            record(key,{status:confirmed?'success':'unknown',attempts:attempts+1,at:Date.now(),authorityConfirmed:!!confirmed,responseHttp:http});
            if(!confirmed)throw new Error('sign_not_authority_confirmed_no_replay');
            this.log('签到成功（服务端已签状态确认）');return {already:0,writeAttempted:1,points:confirmed.points,beforePoints:a.points};
        } finally {fs.rmdirSync(LOCK);}
    }
    async run() {try {await this.ensureLogin();return {ok:true,...await this.sign()};}catch(error) {this.log('执行失败：'+error.message);return {ok:false,writeAttempted:this.writeAttempted};}}
}
async function main() {
    $.checkEnv('parkson');let success=0,already=0,writes=0;
    for(const account of $.userList) {const r=await new Task(account).run();if(r.ok)success++;already+=r.already||0;writes+=r.writeAttempted||0;}
    try {await $.sendMsg();}catch(error) {$.log('通知失败，不改变业务结果');}
    const valid=$.userCount>0&&success===$.userCount;
    console.log('[QLRUN_RESULT] '+(valid?'SUCCESS ':'FAILURE ')+JSON.stringify({script:'parkson.js',accounts:$.userCount,failed:$.userCount-success,already,writeAttempted:writes,retryable:0,mode:READ_ONLY?'read_only':'normal'}));process.exitCode=valid?0:1;
}
if(require.main===module)main().catch(error=>{console.error(error.message);console.log('[QLRUN_RESULT] FAILURE {"script":"parkson.js","retryable":0,"reason":"unexpected_error"}');process.exitCode=1;});
module.exports={Task,main,today,readJson,persist,record,member,points,calendar,dataOf,CACHE,STATE,LOCK,SIGN,POINTS,LIST,LOGIN,BIND};
