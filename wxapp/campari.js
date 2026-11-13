/*
@Description: 金巴厘杯中空间签到
cron: 31 8 * * *
变量名：campari，wx_server账号标识，多账号用&或换行。
依赖：wx_server_url、wx_auth；Node.js >=18。
CAMPARI_READ_ONLY=1：仅认证及权威查询，零签到/cache/state/lock写。
正式70包：状态POST wechatInfoSignIn；签到POST point/changePoint {type:4}。
业务HTTPS由d3原生fetch发出，避免透明网关对POST的二次重放。
*/
'use strict';
const {Env}=require('../tools/env.js');const $=new Env('金巴厘杯中空间签到');
const fs=require('fs'),path=require('path'),crypto=require('crypto'),axios=require('axios');
const {Agent,fetch:businessFetch}=require('undici');
// Explicit direct IPv4 connector, paired with its own fetch ABI. Keeps TLS
// verification and avoids both the shared fetch pool and gateway POST replay.
const businessAgent=new Agent({connect:{family:4,timeout:18000}});
const READ_ONLY=process.env.CAMPARI_READ_ONLY==='1';
$.done=async()=>{if($.sendMsg)await $.sendMsg()};
const APPID='wx059d0e2508ab7045',BASE='https://camparicrm.81680.cn';
const CACHE=path.join(__dirname,'campari_token_cache.json');
const EP_INFO='/cgs-api/wxApi/wechatUser/wechatInfoSignIn',EP_SIGN='/cgs-api/wxApi/point/changePoint';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const day=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
function atomic(file,value){
 const bytes=Buffer.from(JSON.stringify(value)),tmp=file+'.tmp.'+process.pid+'.'+crypto.randomBytes(6).toString('hex');
 const fd=fs.openSync(tmp,'wx',0o600);
 try{let offset=0;while(offset<bytes.length){const n=fs.writeSync(fd,bytes,offset,bytes.length-offset);if(!Number.isInteger(n)||n<=0||n>bytes.length-offset)throw Error('short state write');offset+=n}fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 fs.renameSync(tmp,file);const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d)}finally{fs.closeSync(d)}
 if(!fs.readFileSync(file).equals(bytes))throw Error('state readback mismatch');
}
function objectFile(file,fallback){if(!fs.existsSync(file))return fallback;const d=JSON.parse(fs.readFileSync(file,'utf8'));if(!d||typeof d!=='object'||Array.isArray(d))throw Error('invalid persisted object');return d}
function readState(file){const d=objectFile(file,{entries:{}});if(!d.entries||typeof d.entries!=='object'||Array.isArray(d.entries))throw Error('invalid state');for(const e of Object.values(d.entries)){if(!e||!Number.isInteger(e.attempts)||e.attempts<0||e.attempts>2||!['attempting','unknown','success'].includes(e.outcome))throw Error('invalid state entry')}return d}
function transient(e){return !!e?.transient}
function safe(e){return String(e?.message||e).replace(/eyJ[\w.-]+/g,'<jwt>').replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g,'<phone>').slice(0,160)}
class Task{
 constructor(account){this.index=$.userIdx++;this.account=String(account).trim();this.session={};this.wrote=false}
 log(s){$.log(`账号[${this.index}] ${s}`)}
 stateFile(){return path.join(__dirname,'campari_actions_'+crypto.createHash('sha256').update(this.account).digest('hex')+'.json')}
 async request(api,data={},auth=true,read=false){
  const tries=read?3:1;
  for(let i=0;i<tries;i++){
   try{
    const r=await businessFetch(BASE+api,{dispatcher:businessAgent,method:'POST',headers:{'Content-Type':'application/json',Referer:`https://servicewechat.com/${APPID}/70/page-frame.html`,...(auth?{Authorization:'Bearer '+this.session.token}:{})},body:JSON.stringify(data),signal:AbortSignal.timeout(18000),redirect:'error'});
    const text=await r.text();let v;try{v=JSON.parse(text)}catch(_){const e=Error('HTTP '+r.status+' invalid JSON');e.transient=r.status>=500;throw e}
    if(r.status!==200||v?.code!==200){const e=Error('HTTP '+r.status+' business '+String(v?.code)+' '+String(v?.msg||'request rejected').slice(0,100));e.auth=r.status===401||v?.code===401;e.transient=[408,429,500,502,503,504].includes(r.status);throw e}
    return v;
   }catch(e){if(e.name==='TimeoutError'||e.name==='AbortError'||e.cause?.code||e.message==='fetch failed')e.transient=true;if(i+1<tries&&transient(e)){await sleep(500*(i+1));continue}throw e}
  }
 }
 async code(){
  if(!process.env.wx_auth||!process.env.wx_server_url)throw Error('wx_server configuration missing');
  const r=await axios.post(process.env.wx_server_url.replace(/\/$/,'')+'/wx/code',{appid:APPID,openid:this.account},{headers:{auth:process.env.wx_auth},timeout:130000});
  const c=r.data?.code||r.data?.data?.code;if(r.data?.status!==true||typeof c!=='string'||!c){const e=Error('wx code unavailable');e.transient=true;throw e}return c;
 }
 saveCache(){if(READ_ONLY)return;const d=objectFile(CACHE,{});d[this.account]={...this.session,updatedAt:new Date().toISOString()};atomic(CACHE,d)}
 async login(){
  const cached=objectFile(CACHE,{})[this.account];if(cached?.token){this.session=cached;try{await this.authority();return}catch(e){if(!e.auth)throw e;this.session={}}}
  for(let i=0;i<3;i++){
   try{const c=await this.code(),r=await this.request('/cgs-api/wxApi/getCodeToSession/'+encodeURIComponent(c),{},false,false);if(typeof r.data?.token!=='string'||!r.data.token)throw Error('login token missing');this.session=r.data;await this.authority();this.saveCache();this.log('登录成功');return}catch(e){if(i<2&&transient(e)){await sleep(1000*(i+1));continue}throw e}
  }
 }
 async authority(){const v=(await this.request(EP_INFO,{},true,true)).data;if(!v||typeof v.todaySignInFlag!=='boolean'||!(v.pointFlowList===null||Array.isArray(v.pointFlowList)))throw Error('invalid sign authority');this.info=v;return v.todaySignInFlag}
 async run(){
  if(!this.account)throw Error('empty account');await this.login();
  if(READ_ONLY){const signed=await this.authority();this.log('只读权威状态：'+(signed?'已签':'未签')+'，零业务写');return}
  const file=this.stateFile(),lock=file+'.lock',fd=fs.openSync(lock,'wx',0o600);
  try{
   const state=readState(file),key=day();
   if(await this.authority()){if(state.entries[key]){state.entries[key].outcome='success';atomic(file,state)}this.log('今日已签到（权威确认）');return}
   const old=state.entries[key];
   if(old){if(old.attempts>=2)throw Error('daily write attempts exhausted');const at=Date.parse(old.attemptedAt);if(!Number.isFinite(at)||Date.now()-at<300000)throw Error('unknown write cooling; no replay');await sleep(500);if(await this.authority()){old.outcome='success';atomic(file,state);return}}
   state.entries[key]={...(old||{}),attempts:(old?.attempts||0)+1,outcome:'attempting',attemptedAt:new Date().toISOString()};atomic(file,state);this.wrote=true;
   let writeError;try{await this.request(EP_SIGN,{type:4},true,false)}catch(e){writeError=e}
   for(let i=0;i<3;i++){let signed;try{signed=await this.authority()}catch(_){}if(signed===true){state.entries[key].outcome='success';atomic(file,state);this.saveCache();this.log('签到成功（权威确认）');return}if(i<2)await sleep(700*(i+1))}
   state.entries[key].outcome='unknown';atomic(file,state);throw Error('sign write unconfirmed; no replay'+(writeError?' '+safe(writeError):''));
  }finally{fs.closeSync(fd);fs.unlinkSync(lock)}
 }
}
!(async()=>{
 $.checkEnv('campari');if(!$.userList?.length)throw Error('no configured accounts');let failed=0,wrote=false,retryable=true;
 for(const account of $.userList){const t=new Task(account);try{await t.run()}catch(e){failed++;retryable=retryable&&transient(e);t.log('未完成：'+safe(e))}wrote=wrote||t.wrote}
 $.log(`[QLRUN_RESULT] ${failed?'FAILURE':'SUCCESS'} accounts=${$.userList.length} failed=${failed} retryable=${failed&&!wrote&&retryable?1:0} mode=${READ_ONLY?'readonly':'normal'}`);if(failed)process.exitCode=1;
})().catch(e=>{$.log(safe(e));$.log('[QLRUN_RESULT] FAILURE reason=script_error retryable=0');process.exitCode=1}).finally(async()=>{try{await $.done()}finally{await businessAgent.close()}});
