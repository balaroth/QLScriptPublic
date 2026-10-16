'use strict';
// Zero external dependency tests; no real credentials, network or device calls.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const path = require('path');
const candidate = process.argv[2] || path.join(__dirname, '../wxapp/tjg.js');
const source = fs.readFileSync(candidate, 'utf8').split('!(async () => {')[0];
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function load(post = async () => ({status:200,data:{status:true,data:{code:'fresh'}}})) {
  const logs=[]; const env={wx_auth:'test-secret',wx_server_url:'http://test.invalid'};
  const axios={post,request:async()=>({status:200,data:{code:1}})};
  class Env { constructor(){this.userIdx=1;} log(x){logs.push(x);} }
  const context={require:n=>n==='axios'?axios:n==='../tools/env.js'?{Env}:require(n),process:{env},__dirname:'/tmp',URLSearchParams,console,setTimeout:fn=>fn()};
  vm.createContext(context);
  vm.runInContext(source+'\nthis.exports={Task,collectorSecureNetworkInit,findSignTask,isSignTaskDone};',context);
  return {context,api:context.exports,axios,logs,env};
}
const unsigned={task:'每日签到',now:0,daily_limit:1};
const signed={task:'每日签到',now:1,daily_limit:1};
test('secure-code request is one atomic endpoint',async()=>{
  let calls=[];let x=load(async(u,b)=>{calls.push([u,b]);return {status:200,data:{status:true,data:{code:'fresh'}}};});
  assert.equal(await x.api.collectorSecureNetworkInit('a',true),'fresh');
  assert.equal(calls.length,1);assert.equal(calls[0][1].includeCode,true);assert.ok(calls[0][0].endsWith('/wx/secure-network-init'));
});
test('fresh nonce for each invocation',async()=>{let ns=[];let x=load(async(u,b)=>{ns.push(b.openid);return {status:200,data:{status:true,data:{code:'x'}}};});await x.api.collectorSecureNetworkInit('a',true);await x.api.collectorSecureNetworkInit('a',true);assert.notEqual(ns[0],ns[1]);});
test('missing code fails closed',async()=>{let x=load(async()=>({status:200,data:{status:true}}));await assert.rejects(x.api.collectorSecureNetworkInit('x',true),/未返回/);});
test('false status never passes',async()=>{let x=load(async()=>({status:200,data:{status:false,message:'bad'}}));await assert.rejects(x.api.collectorSecureNetworkInit('x',true),/bad/);});
test('unauthorized is not retried',async()=>{let x=load(async()=>({status:401,data:{status:false}}));await assert.rejects(x.api.collectorSecureNetworkInit('x',true),e=>e.retryable===false);});
test('missing auth blocks network',async()=>{let x=load(()=>{throw Error('network called')});delete x.env.wx_auth;await assert.rejects(x.api.collectorSecureNetworkInit('x',true),/缺少 wx_auth/);});
test('already signed avoids mutation and initialization',async()=>{let x=load(()=>{throw Error('unexpected secure init')});let t=new x.api.Task('test');t.verifySignDone=async()=>signed;assert.equal(await t.sign(),'already');});
test('gate still checks initialization when already signed',async()=>{let calls=0,x=load(async()=>{calls++;return {status:200,data:{status:true}}});x.env.TJG_GATE_FORCE_SECURE_INIT='1';let t=new x.api.Task('test');t.verifySignDone=async()=>signed;assert.equal(await t.sign(),'already');assert.equal(calls,1);});
test('sign sends token with atomic fresh wx_code',async()=>{let x=load(),t=new x.api.Task('test'),n=0;t.token='test-token';t.verifySignDone=async()=>++n===1?unsigned:signed;x.axios.request=async r=>{assert.equal(r.params.wx_code,'fresh');assert.equal(r.params.token,'test-token');return {status:200,data:{code:1,msg:'签到成功'}}};assert.equal(await t.sign(),'signed');});
test('HTTP success without server task completion fails',async()=>{let x=load(),t=new x.api.Task('test');t.verifySignDone=async()=>unsigned;await assert.rejects(t.sign(),/官方任务进度未完成/);});
test('lost response requires readback without replay',async()=>{let x=load(),t=new x.api.Task('test'),n=0,writes=0;t.verifySignDone=async()=>++n===1?unsigned:signed;x.axios.request=async()=>{writes++;throw Error('ETIMEDOUT')};assert.equal(await t.sign(),'signed');assert.equal(writes,1);});
test('lost response with incomplete server state fails',async()=>{let x=load(),t=new x.api.Task('test');t.verifySignDone=async()=>unsigned;x.axios.request=async()=>{throw Error('ETIMEDOUT')};await assert.rejects(t.sign(),/ETIMEDOUT/);});
test('rejected code reacquires initialization and new code once',async()=>{let codes=[],n=0;let x=load(async()=>({status:200,data:{status:true,data:{code:'fresh-'+(++n)}}}));let t=new x.api.Task('test'),poll=0;t.verifySignDone=async()=>++poll===3?signed:unsigned;x.axios.request=async r=>{codes.push(r.params.wx_code);return {status:200,data:{code:0,msg:'请求校验失败'}}};assert.equal(await t.sign(),'signed');assert.deepEqual(codes,['fresh-1','fresh-2']);});
test('invalid daily task data cannot pass',async()=>{let x=load();for(let task of [null,{}, {now:1,daily_limit:0},{now:'bad',daily_limit:1}])assert.equal(x.api.isSignTaskDone(task),false);});
(async()=>{let failed=0;for(const [n,f] of tests){try{await f();console.log('PASS '+n)}catch(e){failed++;console.error('FAIL '+n+': '+e.message)}}console.log(`RESULT PASS=${tests.length-failed} FAIL=${failed}`);process.exitCode=failed?1:0;})();
