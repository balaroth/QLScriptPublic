'use strict';
const assert = require('assert');
const {
  MINI_APP_ID,
  APP_VERSION,
  Task,
  parseAccounts,
  commonHeaders,
  fetchWxCode,
  requestWxIdentity,
  loginWithIdentity,
  autoLogin,
} = require(process.env.HDL_CANDIDATE || '../daily/hdl.js');

const response = (data, status = 200) => ({ data, status });
const silent = { log() {}, warn() {}, error() {} };

async function testParseAccounts() {
  assert.deepStrictEqual(parseAccounts('wx#o#u#甲\napp#t#乙'), [
    { mode: 'wx', openId: 'o', uid: 'u', remark: '甲' },
    { mode: 'app', token: 't', remark: '乙' },
  ]);
  assert.deepStrictEqual(parseAccounts(''), []);
}

async function testHeaders() {
  const h = commonHeaders('token', 'wechat');
  assert.strictEqual(h.appId, '15');
  assert.strictEqual(h.appName, 'HDLMember');
  assert.strictEqual(h.appVersion, APP_VERSION);
  assert.strictEqual(h._HAIDILAO_APP_TOKEN, 'token');
}

async function testCollectorCodeContract() {
  let seen;
  const http = { async request(o) { seen = o; return response({ status: true, code: 'wx-code' }); } };
  const code = await fetchWxCode({ http, wxServer: { url: 'http://collector', auth: 'secret' }, timeout: 10000 });
  assert.strictEqual(code, 'wx-code');
  assert.strictEqual(seen.url, 'http://collector/wx/code');
  assert.strictEqual(seen.data.appid, MINI_APP_ID);
  assert.strictEqual(seen.headers.auth, 'secret');
}

async function testIdentityExchange() {
  const http = {
    async request(o) {
      assert.strictEqual(o.url.endsWith('/CaterWeixin/ws/external/getId.json'), true);
      assert.strictEqual(String(o.data).includes('code=abc'), true);
      return response({ success: true, rc: 100000, value: { openid: 'open', unionid: 'union' } });
    },
  };
  assert.deepStrictEqual(await requestWxIdentity('abc', { http }), { openId: 'open', uid: 'union' });
}

async function testV2Login() {
  const http = {
    async request(o) {
      assert.strictEqual(o.url.endsWith('/api/gateway/login/center/login/v2/wechatLogin'), true);
      assert.strictEqual(o.data.openId, 'open');
      assert.strictEqual(o.data.uid, 'union');
      return response({ success: true, code: 100000, data: { token: 'token', nickName: '颜先生' } });
    },
  };
  const data = await loginWithIdentity({ openId: 'open', uid: 'union' }, { http });
  assert.strictEqual(data.token, 'token');
}

async function testAutoLoginFlow() {
  const calls = [];
  const http = {
    async request(o) {
      calls.push(o.url);
      if (o.url.endsWith('/wx/code')) return response({ status: true, code: 'wx-code' });
      if (o.url.endsWith('/CaterWeixin/ws/external/getId.json')) return response({ success: true, rc: 100000, value: { openid: 'open', unionid: 'union' } });
      if (o.url.endsWith('/api/gateway/login/center/login/v2/wechatLogin')) return response({ success: true, code: 100000, data: { token: 'token', nickName: '颜先生' } });
      throw new Error(`unexpected ${o.url}`);
    },
  };
  const data = await autoLogin({ http, logger: silent, wxServer: { url: 'http://collector', auth: 'secret' }, timeout: 10000 });
  assert.strictEqual(data.token, 'token');
  assert.strictEqual(calls.length, 3);
}

async function testPhoneRecovery() {
  let phoneCalled = 0;
  const http = {
    async request(o) {
      if (o.url.endsWith('/wx/code')) return response({ status: true, code: 'wx-code' });
      if (o.url.endsWith('/wx/getphonenumber')) { phoneCalled += 1; return response({ status: true, code: 'phone-code', encryptedData: 'enc', iv: 'iv' }); }
      if (o.url.endsWith('/CaterWeixin/ws/external/getId.json')) return response({ success: true, rc: 100000, value: { openid: 'open', unionid: 'union' } });
      if (o.url.endsWith('/api/gateway/login/center/login/v2/wechatLogin')) return response({ success: false, code: 303002, msg: '请绑定手机号' });
      if (o.url.endsWith('/login/safeBind')) {
        assert.strictEqual(o.data.wechatCode, 'phone-code');
        assert.strictEqual(o.data.openId, 'open');
        assert.strictEqual(o.data.uid, 'union');
        return response({ success: true, data: { token: 'bound-token', nickName: '颜先生' } });
      }
      throw new Error(`unexpected ${o.url}`);
    },
  };
  const data = await autoLogin({ http, logger: silent, wxServer: { url: 'http://collector', auth: 'secret' }, timeout: 10000 });
  assert.strictEqual(data.token, 'bound-token');
  assert.strictEqual(phoneCalled, 1);
}

async function testTaskSuccess() {
  const paths = [];
  const http = {
    async request(o) {
      paths.push(o.url);
      if (o.url.endsWith('/queryMemberCacheInfo')) return response({ success: true, data: { customerName: '颜先生', coinNum: 1 } });
      if (o.url.endsWith('/queryFragment')) return response({ success: true, data: { total: 10, expireDate: '2026-10-18' } });
      if (o.url.endsWith('/signin/signin')) return response({ success: true, data: { signinQueryDetailList: [{ currentOr: 1, fragment: 10, activityName: '第五十八期签到' }] } });
      throw new Error(`unexpected ${o.url}`);
    },
  };
  const task = new Task({ mode: 'auto', remark: '自动' }, { http, logger: silent, maxRetries: 0, autoLoginProvider: async () => ({ token: 'token', nickName: '颜先生' }) });
  const result = await task.run();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(paths.filter((x) => x.endsWith('/queryFragment')).length, 2);
}

async function testAlreadySignedIsSuccess() {
  let fragmentCalls = 0;
  const http = {
    async request(o) {
      if (o.url.endsWith('/queryMemberCacheInfo')) return response({ success: true, data: { customerName: '颜先生' } });
      if (o.url.endsWith('/queryFragment')) { fragmentCalls += 1; return response({ success: true, data: { total: 10 } }); }
      if (o.url.endsWith('/signin/signin')) return response({ success: false, code: 'repeat', msg: '请勿重复操作' });
      throw new Error(`unexpected ${o.url}`);
    },
  };
  const task = new Task({ mode: 'app', token: 'token', remark: '已签' }, { http, logger: silent, maxRetries: 0 });
  const result = await task.run();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(fragmentCalls, 2);
}

async function testBusinessFailureIsFailure() {
  const http = {
    async request(o) {
      if (o.url.endsWith('/queryMemberCacheInfo')) return response({ success: true, data: {} });
      if (o.url.endsWith('/queryFragment')) return response({ success: true, data: {} });
      if (o.url.endsWith('/signin/signin')) return response({ success: false, code: 'X', msg: '活动不可用' });
      throw new Error(`unexpected ${o.url}`);
    },
  };
  const task = new Task({ mode: 'app', token: 'token', remark: '失败' }, { http, logger: silent, maxRetries: 0 });
  const result = await task.run();
  assert.strictEqual(result.ok, false);
  assert.match(result.failures.join('\n'), /活动不可用/);
}

async function testIdempotentRetryBounded() {
  let calls = 0;
  const http = { async request() { calls += 1; const e = new Error('timeout'); e.code = 'ECONNABORTED'; throw e; } };
  const task = new Task({ mode: 'app', token: 'token' }, { http, logger: silent, maxRetries: 2, wait: async () => {} });
  await assert.rejects(() => task.queryFragment(), /timeout/);
  assert.strictEqual(calls, 3);
}

async function main() {
  const tests = [
    testParseAccounts,
    testHeaders,
    testCollectorCodeContract,
    testIdentityExchange,
    testV2Login,
    testAutoLoginFlow,
    testPhoneRecovery,
    testTaskSuccess,
    testAlreadySignedIsSuccess,
    testBusinessFailureIsFailure,
    testIdempotentRetryBounded,
  ];
  for (const t of tests) { await t(); console.log(`PASS ${t.name}`); }
  console.log(`PASS ${tests.length}/${tests.length}`);
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
