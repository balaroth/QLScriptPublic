/*
骁龙骁友会每日签到。cron: 20 9 * * *
变量 wx_xlxyh：wx_server账号标识，可加#备注，多账号用&或换行；兼容旧sessionKey#userId。
官方734版正式API已迁移至miniprogram-service.qualcomm.cn。微信code登录协议未变。
只读：WX_XLXYH_READ_ONLY=1 或 QL_READ_ONLY=1，不写缓存/state/lock，不发签到。
本版本只运行每日签到及权威回读，不自动抽奖、点赞、补签、答题或模拟阅读/视频计时。
签到GET按副作用写处理：耐久attempting、并发锁、写后权威确认、未知禁止同进程重放；
冷却10分钟后连续两次权威未签才允许一次最后恢复写，当日总上限2。
*/
'use strict';
const {Env}=require('../tools/env.js');
const $=new Env('骁龙骁友会');
const axios=require('axios');
const {request:directRequest}=require('undici');
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const APP='wx026c06df6adc5d06';
const BASE='https://miniprogram-service.qualcomm.cn/qualcomm-app';
const PAGE_VERSION='734';
const CACHE=path.join(__dirname,'wx_xlxyh_token_cache.json');
const STATE=path.join(__dirname,'.wx_xlxyh_write_state.json');
const LOCK=path.join(__dirname,'.wx_xlxyh_write.lock');
const READ_ONLY=process.env.WX_XLXYH_READ_ONLY==='1'||process.env.QL_READ_ONLY==='1';
const LOGIN='/api/user/getOpenId',INFO='/api/user/info',LIST='/api/user/signList',SIGN='/api/user/signIn';
const UA='Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/119.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.49 MiniProgramEnv/android';
function today(){const d=new Date(Date.now()+8*3600000);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;}
function object(d){return !!d&&typeof d==='object'&&!Array.isArray(d);}
function readJson(file){try{const d=JSON.parse(fs.readFileSync(file,'utf8'));if(!object(d))throw Error('persistent_object_invalid');return d;}catch(e){if(e.code==='ENOENT')return {};throw e;}}
function persist(file,d){
    if(READ_ONLY)throw Error('read_only_file_write_blocked');
    const bytes=Buffer.from(JSON.stringify(d)),tmp=file+`.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;let fd;
    try{
        fd=fs.openSync(tmp,'wx',0o600);let offset=0;
        while(offset<bytes.length){const n=fs.writeSync(fd,bytes,offset,bytes.length-offset);if(!Number.isInteger(n)||n<=0||n>bytes.length-offset)throw Error('persistent_short_write');offset+=n;}
        fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,file);
        const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
        if(!fs.readFileSync(file).equals(bytes))throw Error('persistent_readback_failed');
    }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
function record(key,entry){const d=readJson(STATE);d[key]=entry;persist(STATE,d);}
function joinJson(d){return Object.keys(d||{}).map(k=>`${k}=${encodeURIComponent(d[k])}`).join('&');}
function requestId(){const t=[];for(let i=0;i<36;i++)t[i]='0123456789abcdef'[Math.floor(Math.random()*16)];t[14]='4';t[19]='0123456789abcdef'[(3&parseInt(t[19],16))|8];t[8]=t[13]=t[18]=t[23]=undefined;return t.join('');}
function dataOf(r,endpoint){if(r.status!==200||!object(r.data)||!['200','40003'].includes(String(r.data.code)))throw Error(`endpoint_rejected:${endpoint}:http_${r.status}:code_${String(r.data?.code??'invalid')}`);return r.data.data;}
function completeSession(d){return object(d)&&Number.isSafeInteger(d.userId)&&d.userId>0&&typeof d.sessionKey==='string'&&!!d.sessionKey&&typeof d.openId==='string'&&!!d.openId;}
function signRecord(d,date){
    if(!object(d)||![0,1].includes(d.isSignToday)||!Array.isArray(d.weekList)||!d.weekList.every(Array.isArray))throw Error('sign_authority_invalid');
    const rows=d.weekList.flat().filter(x=>object(x)&&x.date===date);
    if(rows.length!==1||rows[0].dateState!==0||![0,1,2].includes(rows[0].signState))throw Error('sign_today_ambiguous');
    const signed=[1,2].includes(rows[0].signState);
    if(signed!==(d.isSignToday===1))throw Error('sign_authority_conflict');
    return {signed,date,row:rows[0]};
}
function entryValid(e){return object(e)&&Number.isInteger(e.attempts)&&e.attempts>=0&&e.attempts<=2&&['attempting','unknown','success','failed'].includes(e.status)&&Number.isFinite(e.at);}
class Task{
    constructor(raw){
        this.raw=String(raw||'').trim();const [id,remark]=this.raw.split('#');this.id=id.trim();this.remark=remark||'';
        this.legacy=/^\d+$/.test(this.remark)&&/[=+/]/.test(this.id);this.session={userId:0,sessionKey:'',openId:''};
        if(this.legacy)this.session={userId:Number(this.remark),sessionKey:this.id,openId:''};this.writeAttempted=0;
    }
    log(s){$.log(s);}
    async api(endpoint,method='GET',data={},auth=true){
        if(![LOGIN,INFO,LIST,SIGN].includes(endpoint))throw Error('endpoint_out_of_scope');
        if(READ_ONLY&&endpoint===SIGN)throw Error('read_only_business_write_blocked');
        if(endpoint===SIGN&&(method!=='GET'||this.writeAttempted!==1))throw Error('sign_without_durable_attempt');
        const body=joinJson(data),rid=requestId(),ts=String(Date.now());
        const headers={'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','User-Agent':UA,Referer:`https://servicewechat.com/${APP}/${PAGE_VERSION}/page-frame.html`,userId:auth?String(this.session.userId):'0',sessionKey:auth?this.session.sessionKey:'',openId:auth?this.session.openId:'',timestamp:ts,requestId:rid,sign:crypto.createHash('md5').update(body+rid+ts).digest('hex')};
        const url=BASE+endpoint+(method==='GET'&&body?'?'+body:'');
        const r=await directRequest(url,{method,headers,maxRedirections:0,headersTimeout:20000,bodyTimeout:20000,...(method==='GET'?{}:{body})});
        let d;try{d=await r.body.json();}catch(e){throw Error(`endpoint_non_json:${endpoint}:http_${r.statusCode}`);}
        return {status:r.statusCode,data:d}; // Single-send. No request-layer re-login or replay of any write.
    }
    async getCode(){
        if(!process.env.wx_auth||!process.env.wx_server_url)throw Error('missing_bridge_configuration');
        const r=await axios.post(process.env.wx_server_url.replace(/\/+$/,'')+'/wx/code',{appid:APP,openid:this.id},{headers:{auth:process.env.wx_auth},timeout:75000,maxRedirects:0});
        const code=r.data?.code||r.data?.data?.code;if(r.data?.status!==true||typeof code!=='string'||!code)throw Error('fresh_code_unavailable');return code;
    }
    async checkMember(){
        const r=await this.api(INFO,'GET',{userId:this.session.userId});if(r.status===401||String(r.data?.code)==='40001')return false;
        const d=dataOf(r,INFO);
        if(!object(d)||d.id!==this.session.userId||!Number.isFinite(d.coreCoin)||d.coreCoin<0)throw Error('member_authority_invalid');return d;
    }
    async login(){
        const d=dataOf(await this.api(LOGIN,'POST',{code:await this.getCode()},false),LOGIN);
        const s={userId:d?.userInfo?.id,sessionKey:d?.sessionKey,openId:d?.openId};if(!completeSession(s))throw Error('member_session_incomplete');this.session=s;
        if(!await this.checkMember())throw Error('new_session_invalid');
        if(!READ_ONLY){const c=readJson(CACHE);c[this.id]={...s,updatedAt:new Date().toISOString()};persist(CACHE,c);}this.log('新域名登录成功，会员身份已校验');
    }
    async ensureLogin(){
        if(!this.id)throw Error('empty_account');
        if(this.legacy){const d=await this.checkMember();if(!d)throw Error('legacy_session_expired');if(typeof d.openId==='string')this.session.openId=d.openId;return;}
        const c=readJson(CACHE)[this.id];if(completeSession(c)){this.session={userId:c.userId,sessionKey:c.sessionKey,openId:c.openId};if(await this.checkMember())return;}
        await this.login();
    }
    async authority(){const date=today(),d=dataOf(await this.api(LIST,'GET',{userId:this.session.userId}),LIST),a=signRecord(d,date);if(today()!==date)throw Error('date_changed_during_authority');return a;}
    key(date){return crypto.createHash('sha256').update((this.legacy?String(this.session.userId):this.id)+'|'+this.session.userId).digest('hex')+'|'+date;}
    reconcile(key){const old=readJson(STATE)[key];if(!old)return;if(!entryValid(old))throw Error('persistent_entry_invalid');record(key,{...old,status:'success',authorityConfirmed:true,confirmedAt:Date.now()});}
    async sign(){
        let a=await this.authority();if(READ_ONLY)return {already:Number(a.signed),writeAttempted:0};
        if(this.writeAttempted&&!a.signed)throw Error('same_process_write_no_replay');
        fs.mkdirSync(LOCK,{mode:0o700});try{
            a=await this.authority();const key=this.key(a.date);
            if(a.signed){this.reconcile(key);this.log('今日已签到（服务端当日记录）');return {already:1,writeAttempted:0};}
            const ledger=readJson(STATE),hasOld=Object.prototype.hasOwnProperty.call(ledger,key),old=ledger[key],attempts=hasOld?old?.attempts:0;
            if(hasOld&&(!entryValid(old)||attempts>=2||!['unknown','attempting'].includes(old.status)||Date.now()-old.at<600000))throw Error('write_no_replay_or_cooldown_or_limit');
            if(hasOld){const b=await this.authority();if(b.date!==a.date)throw Error('date_changed_before_recovery');if(b.signed){this.reconcile(key);return {already:1,writeAttempted:0};}}
            if(today()!==a.date)throw Error('date_changed_before_write');
            record(key,{status:'attempting',attempts:attempts+1,at:Date.now()});this.writeAttempted=1;
            let http=null;try{http=(await this.api(SIGN,'GET',{userId:this.session.userId})).status;}catch(e){/* any sent write may have succeeded; converge by read only */}
            let confirmed=false;for(let i=0;i<2;i++){try{const b=await this.authority();if(b.date===a.date&&b.signed){confirmed=true;break;}}catch(e){/* unknown fail closed */}}
            record(key,{status:confirmed?'success':'unknown',attempts:attempts+1,at:Date.now(),authorityConfirmed:confirmed,responseHttp:http});
            if(!confirmed)throw Error('sign_unconfirmed_no_replay');this.log('签到成功（服务端当日记录确认）');return {already:0,writeAttempted:1};
        }finally{fs.rmdirSync(LOCK);}
    }
    async run(){try{await this.ensureLogin();const r=await this.sign();const member=await this.checkMember();if(!member)throw Error('final_member_authority_invalid');return {ok:true,...r,points:member.coreCoin};}catch(e){this.log('执行失败：'+e.message);return {ok:false,writeAttempted:this.writeAttempted};}}
}
async function main(){
    $.checkEnv('wx_xlxyh');let success=0,already=0,writes=0;
    for(const raw of $.userList){const r=await new Task(raw).run();if(r.ok)success++;already+=r.already||0;writes+=r.writeAttempted||0;}
    try{await $.sendMsg();}catch(e){$.log('通知失败，不改变业务结果');}
    const valid=$.userCount>0&&success===$.userCount;console.log('[QLRUN_RESULT] '+(valid?'SUCCESS ':'FAILURE ')+JSON.stringify({script:'wx_xlxyh.js',accounts:$.userCount,failed:$.userCount-success,already,writeAttempted:writes,retryable:0,mode:READ_ONLY?'read_only':'normal'}));process.exitCode=valid?0:1;
}
if(require.main===module)main().catch(e=>{console.error(e.message);console.log('[QLRUN_RESULT] FAILURE {"script":"wx_xlxyh.js","retryable":0,"reason":"unexpected_error"}');process.exitCode=1;});
module.exports={Task,main,today,readJson,persist,record,signRecord,completeSession,dataOf,joinJson,requestId,CACHE,STATE,LOCK,BASE,LOGIN,INFO,LIST,SIGN};
