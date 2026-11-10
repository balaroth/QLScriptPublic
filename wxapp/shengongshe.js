/*
申工社：官方公众号 OAuth 会话恢复及每日签到。不是微信小程序。
cron: 34 8 * * *
变量 shengongshe：wx_server 设备别名（当前专用恢复支持 ql），可用 #备注。
依赖 wx_server_url、wx_auth、Node >=18；SHENGONGSHE_READ_ONLY=1 零签到及本地缓存/state/lock写。
积分及签到目前仍开放；停运与活动状态只依据官方业务权威响应，不按时间猜测。
*/
'use strict';
const {Env}=require('../tools/env.js'),$=new Env('申工社');
const fs=require('fs'),path=require('path'),crypto=require('crypto'),axios=require('axios');
require('dns').setDefaultResultOrder('ipv4first');
const READ_ONLY=process.env.SHENGONGSHE_READ_ONLY==='1',APPID='wx63d70210fcc108fd';
const BASE='https://fwdt.shszgh.cn/fwdt-wechat-xc/api',CACHE=path.join(__dirname,'shengongshe_token_cache.json');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),day=()=>new Date(Date.now()+28800000).toISOString().slice(0,10);
$.done=async()=>{if($.sendMsg)await $.sendMsg()};
function atomic(file,value){
 const bytes=Buffer.from(JSON.stringify(value)),tmp=file+'.tmp.'+process.pid+'.'+crypto.randomBytes(6).toString('hex');
 const fd=fs.openSync(tmp,'wx',0o600);
 try{let offset=0;while(offset<bytes.length){const n=fs.writeSync(fd,bytes,offset,bytes.length-offset);if(!Number.isInteger(n)||n<=0||n>bytes.length-offset)throw Error('short state write');offset+=n}fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 fs.renameSync(tmp,file);const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d)}finally{fs.closeSync(d)}
 if(!fs.readFileSync(file).equals(bytes))throw Error('state readback mismatch');
}
function objectFile(file,fallback){if(!fs.existsSync(file))return fallback;const d=JSON.parse(fs.readFileSync(file,'utf8'));if(!d||typeof d!=='object'||Array.isArray(d))throw Error('invalid persisted object');return d}
function readState(file){const d=objectFile(file,{entries:{}});if(!d.entries||typeof d.entries!=='object'||Array.isArray(d.entries))throw Error('invalid state');for(const e of Object.values(d.entries)){if(!e||!Number.isInteger(e.attempts)||e.attempts<0||e.attempts>2||!['attempting','unknown','success'].includes(e.outcome))throw Error('invalid state entry')}return d}
function safe(e){return String(e?.message||'script failure').replace(/eyJ[\w.-]+/g,'<redacted>').replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g,'<redacted>').slice(0,120)}
class Task{
 constructor(raw){this.index=$.userIdx++;this.account=String(raw).split('#')[0].trim();this.token='';this.identity='';this.wrote=false}
 log(s){$.log(`账号[${this.index}] ${s}`)}
 stateFile(){return path.join(__dirname,'shengongshe_actions_'+crypto.createHash('sha256').update(this.account).digest('hex')+'.json')}
 async request(api,read=true){
  if(!['/member/info/get','/integral/checkSign','/integral/my','/integral/sign'].includes(api))throw Error('endpoint not allowed');
  for(let i=0;i<(read?3:1);i++){
   try{const r=await fetch(BASE+api+'?_t='+Date.now(),{headers:{token:this.token,Referer:'https://fwdt.shszgh.cn/fwdt-h5/'},signal:AbortSignal.timeout(18000),redirect:'error'});const text=await r.text();let d;try{d=JSON.parse(text)}catch(_){const e=Error('HTTP '+r.status+' invalid JSON');e.transient=r.status>=500;throw e}
    if(r.status!==200||d?.code!==0||d.success!==true){const e=Error('HTTP '+r.status+' business '+String(d?.code));e.auth=d?.code===100&&d?.message==='用户未登录';e.transient=[408,429,500,502,503,504].includes(r.status);throw e}return d;
   }catch(e){if(['TimeoutError','AbortError'].includes(e.name)||e.cause?.code||e.message==='fetch failed')e.transient=true;if(read&&i<2&&e.transient){await sleep(500*(i+1));continue}throw e}
  }
 }
 async profile(){const d=(await this.request('/member/info/get')).data;if(!d||typeof d.openid!=='string'||!d.openid||!Number.isFinite(d.integral))throw Error('invalid member authority');if(this.identity&&this.identity!==d.openid)throw Error('account identity mismatch');this.identity=d.openid;this.points=d.integral;return d}
 saveCache(){if(READ_ONLY)return;const d=objectFile(CACHE,{});d[this.account]={token:this.token,identity:this.identity,updatedAt:new Date().toISOString()};atomic(CACHE,d)}
 async login(){
  if(this.account!=='ql')throw Error('official OAuth device alias unsupported');
  const cached=objectFile(CACHE,{})[this.account];if(cached?.identity)this.identity=cached.identity;
  if(cached?.token){this.token=cached.token;try{await this.profile();return}catch(e){if(!e.auth)throw e;this.token=''}}
  if(!process.env.wx_auth||!process.env.wx_server_url)throw Error('wx_server configuration missing');
  const r=await axios.post(process.env.wx_server_url.replace(/\/$/,'')+'/wx/shengongshe-session',{appid:APPID,openid:this.account,refresh:!!cached?.token},{headers:{auth:process.env.wx_auth},timeout:150000});
  const d=r.data?.data;if(r.data?.status!==true||typeof d?.token!=='string'||!d.token||typeof d.identity!=='string'||!d.identity)throw Error('official OAuth session unavailable');
  if(this.identity&&this.identity!==d.identity)throw Error('OAuth account identity mismatch');this.token=d.token;this.identity=d.identity;await this.profile();this.saveCache();this.log('公众号会话已确认');
 }
 async authority(){
  const flag=(await this.request('/integral/checkSign')).data,my=(await this.request('/integral/my')).data;
  if(typeof flag!=='boolean'||!my||!Array.isArray(my.thisWeekSignLog)||!Number.isFinite(my.total))throw Error('invalid sign authority');
  const rows=my.thisWeekSignLog.filter(r=>r?.date===day()+' 00:00:00');if(rows.length!==1||typeof rows[0].isSign!=='boolean'||rows[0].isSign!==flag)throw Error('ambiguous daily sign authority');
  this.points=my.total;return flag;
 }
 async run(){
  if(!this.account)throw Error('empty account');await this.login();
  if(READ_ONLY){this.log('只读权威状态：'+(await this.authority()?'已签':'未签')+'，零签到写');return}
  const file=this.stateFile(),lock=file+'.lock',fd=fs.openSync(lock,'wx',0o600);
  try{const state=readState(file),key=day();if(await this.authority()){if(state.entries[key]){state.entries[key].outcome='success';atomic(file,state)}this.log('今日已签（权威确认）');return}
   const old=state.entries[key];if(old){if(old.attempts>=2)throw Error('daily write attempts exhausted');if(!Number.isFinite(Date.parse(old.attemptedAt))||Date.now()-Date.parse(old.attemptedAt)<300000)throw Error('unknown write cooling; no replay');await sleep(500);if(await this.authority()){old.outcome='success';atomic(file,state);return}}
   // Persist and read back before the GET with business side effects. No HTTP-level retry.
   state.entries[key]={...(old||{}),attempts:(old?.attempts||0)+1,outcome:'attempting',attemptedAt:new Date().toISOString(),identity:this.identity};atomic(file,state);this.wrote=true;
   try{await this.request('/integral/sign',false)}catch(_){}
   for(let i=0;i<3;i++){let signed;try{signed=await this.authority()}catch(_){}if(signed===true){state.entries[key].outcome='success';atomic(file,state);this.saveCache();this.log('签到成功（权威记录确认）积分='+this.points);return}if(i<2)await sleep(700*(i+1))}
   state.entries[key].outcome='unknown';atomic(file,state);throw Error('sign write unconfirmed; no replay');
  }finally{fs.closeSync(fd);fs.unlinkSync(lock)}
 }
}
!(async()=>{
 $.checkEnv('shengongshe');if(!$.userList?.length)throw Error('no configured accounts');let failed=0;
 for(const raw of $.userList){const t=new Task(raw);try{await t.run()}catch(e){failed++;t.log('未完成：'+safe(e))}}
 $.log(`[QLRUN_RESULT] ${failed?'FAILURE':'SUCCESS'} accounts=${$.userList.length} failed=${failed} retryable=0 mode=${READ_ONLY?'readonly':'normal'}`);if(failed)process.exitCode=1;
})().catch(e=>{$.log(safe(e));$.log('[QLRUN_RESULT] FAILURE reason=script_error retryable=0');process.exitCode=1}).finally(()=>$.done());
