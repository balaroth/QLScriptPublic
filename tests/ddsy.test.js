'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const scriptPath = process.env.DDSY_UNDER_TEST || path.join(__dirname, 'ddsy.new.js');
const {
  Task,
  fetchDdkySession,
  fetchWxCode,
  main,
  normalizeAccounts,
  parseAccount,
  parseJsonp,
  signedFlag,
} = require(scriptPath);

function jsonp(config, body) {
  return `${config.params.callback}(${JSON.stringify(body)})`;
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.stack || error}`);
    process.exitCode = 1;
  }
}

(async () => {
  await test('normalize legacy single and multiple accounts with ampersands', async () => {
    assert.deepStrictEqual(normalizeAccounts('token&1234567890&20261015134806'), ['token#1234567890#20261015134806']);
    assert.deepStrictEqual(
      normalizeAccounts('token1&1234567890&20261015134806&token2&2234567890&20261015134907'),
      ['token1#1234567890#20261015134806', 'token2#2234567890#20261015134907']
    );
    assert.deepStrictEqual(normalizeAccounts('token1#1234567890#20261015134806&token2#2234567890#20261015134907'), [
      'token1#1234567890#20261015134806',
      'token2#2234567890#20261015134907',
    ]);
  });

  await test('parse account rejects missing fields', async () => {
    assert.throws(() => parseAccount('token#user', 1), /变量格式错误/);
  });

  await test('parse strict JSONP', async () => {
    assert.deepStrictEqual(parseJsonp('cb({"code":0,"result":{"ok":1}})', 'cb'), { code: 0, result: { ok: 1 } });
    assert.throws(() => parseJsonp('not-jsonp', 'cb'), /不是预期 JSONP/);
  });

  await test('collector runtime-code success and explicit failure', async () => {
    const ok = await fetchWxCode({
      appid: 'wx1234567890abcdef',
      auth: 'secret',
      url: 'http://collector',
      http: { request: async (config) => {
        assert.strictEqual(config.url, 'http://collector/wx/runtime-code');
        assert.strictEqual(config.headers.auth, 'secret');
        return { status: 200, data: { status: true, code: 'fresh-code', via: 'runtime-callwx' } };
      } },
    });
    assert.strictEqual(ok.code, 'fresh-code');
    await assert.rejects(
      () => fetchWxCode({ appid: 'wx1234567890abcdef', auth: 'secret', http: { request: async () => ({ status: 200, data: { status: false, message: 'no code' } }) } }),
      /collector 取码失败：no code/
    );
  });

  await test('collector ddky-session returns complete business session', async () => {
    const session = await fetchDdkySession({
      appid: 'wxc2edadc87077fa2a',
      auth: 'secret',
      url: 'http://collector',
      http: { request: async (config) => {
        assert.strictEqual(config.url, 'http://collector/wx/ddky-session');
        assert.strictEqual(config.timeout, 180000);
        return { status: 200, data: { status: true, via: 'runtime-code-openid-checkband', data: { loginToken: 'fresh-token', userId: '1234567890', uDate: '20261015134806', login: '18812341257' } } };
      } },
    });
    assert.deepStrictEqual({ token: session.token, userId: session.userId, uDate: session.uDate, via: session.via }, {
      token: 'fresh-token', userId: '1234567890', uDate: '20261015134806', via: 'runtime-code-openid-checkband',
    });
    assert.match(session.remark, /188\*{4}1257/);
    await assert.rejects(
      () => fetchDdkySession({ appid: 'wxc2edadc87077fa2a', auth: 'secret', http: { request: async () => ({ status: 200, data: { status: false, message: 'not bound' } }) } }),
      /collector 自动登录失败：not bound/
    );
  });

  await test('main prefers collector session over legacy variable', async () => {
    const logs = [];
    const collectorHttp = { request: async () => ({ status: 200, data: { status: true, via: 'runtime-code-openid-checkband', data: { loginToken: 'fresh-token', userId: 'fresh-user', uDate: 'fresh-date', login: '18812341257' } } }) };
    let apiCalls = 0;
    const http = { request: async (config) => {
      apiCalls += 1;
      assert.strictEqual(config.params.loginToken, 'fresh-token');
      assert.strictEqual(config.params.userId, 'fresh-user');
      return { status: 200, data: jsonp(config, { code: 0, result: { signDayVo: { isSingn: true, rewardsInfo: '12叮当币' } } }) };
    } };
    const results = await main({ raw: 'old-token#old-user#old-date', autoLogin: true, auth: 'secret', collectorHttp, http, logger: (x) => logs.push(x), noWait: true });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].ok, true);
    assert.strictEqual(apiCalls, 1);
    assert(logs.some((line) => /collector 自动登录成功/.test(line)));
  });

  await test('main explicitly falls back to legacy after collector failure', async () => {
    const logs = [];
    const collectorHttp = { request: async () => ({ status: 200, data: { status: false, message: 'temporary failure' } }) };
    const http = { request: async (config) => {
      assert.strictEqual(config.params.loginToken, 'old-token');
      return { status: 200, data: jsonp(config, { code: 0, result: { signDayVo: { isSingn: true } } }) };
    } };
    const results = await main({ raw: 'old-token#old-user#old-date', autoLogin: true, auth: 'secret', collectorHttp, http, logger: (x) => logs.push(x), noWait: true });
    assert.strictEqual(results[0].ok, true);
    assert(logs.some((line) => /自动登录失败.*回退旧 ddky 变量/.test(line)));
  });

  await test('pageinfo signature matches legacy ordering', async () => {
    const fixed = new Date(2026, 9, 15, 13, 48, 6);
    let captured;
    const http = { request: async (config) => {
      captured = config.params;
      return { status: 200, data: jsonp(config, { code: 0, result: { signDayVo: { isSingn: true, signinId: 2739 } } }) };
    } };
    const task = new Task('tok#1234567890#20261015134806', { index: 1, now: () => fixed, http, logger: () => {} });
    await task.pageInfo();
    const raw = 'ddky.promotion.signin.pageinfo' +
      'loginTokentok' +
      'methodddky.promotion.signin.pageinfo' +
      'platH5' +
      'platformH5' +
      'signDay2026-10-15' +
      't2026-10-15 13:48:6' +
      'uDate20261015134806' +
      'userId1234567890' +
      'v1.0' +
      'versionName4.9.0' +
      '6C57AB91A1308E26B797F4CD382AC79D';
    const expected = crypto.createHash('md5').update(raw).digest('hex').toUpperCase();
    assert.strictEqual(captured.sign, expected);
  });

  await test('already signed is success without sign request', async () => {
    let calls = 0;
    const logs = [];
    const http = { request: async (config) => {
      calls += 1;
      return { status: 200, data: jsonp(config, { code: 0, result: { signDayVo: { isSingn: true, rewardsInfo: '12叮当币' } } }) };
    } };
    const result = await new Task('tok#1234567890#20261015134806', { index: 1, http, logger: (x) => logs.push(x) }).run();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.already, true);
    assert.strictEqual(calls, 1);
    assert(logs.some((line) => /今日已签到（服务端状态确认）/.test(line)));
  });

  await test('unsigned account signs once and must pass readback', async () => {
    const logs = [];
    let calls = 0;
    const http = { request: async (config) => {
      calls += 1;
      if (calls === 1) return { status: 200, data: jsonp(config, { code: 0, result: { signDayVo: { isSingn: false, signinId: 2739 } } }) };
      if (calls === 2) return { status: 200, data: jsonp(config, { code: 0, result: { successMsg: '恭喜签到成功' } }) };
      return { status: 200, data: jsonp(config, { code: 0, result: { signDayVo: { isSingn: true, rewardsInfo: '12叮当币' } } }) };
    } };
    const result = await new Task('tok#1234567890#20261015134806', { index: 1, http, logger: (x) => logs.push(x) }).run();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.already, false);
    assert.strictEqual(calls, 3);
    assert(logs.some((line) => /签到成功（已回查确认）/.test(line)));
  });

  await test('sign response without signed readback is a failure', async () => {
    let calls = 0;
    const http = { request: async (config) => {
      calls += 1;
      if (calls === 1) return { status: 200, data: jsonp(config, { code: 0, result: { signDayVo: { isSingn: false, signinId: 2739 } } }) };
      if (calls === 2) return { status: 200, data: jsonp(config, { code: 0, result: {} }) };
      return { status: 200, data: jsonp(config, { code: 0, result: { signDayVo: { isSingn: false } } }) };
    } };
    const result = await new Task('tok#1234567890#20261015134806', { index: 1, http, logger: () => {} }).run();
    assert.strictEqual(result.ok, false);
    assert.match(result.error.message, /回查仍是未签到/);
  });

  assert.strictEqual(signedFlag({ singn: true }), true);
  assert.strictEqual(signedFlag({ isSingn: false }), false);
  if (process.exitCode) process.exit(process.exitCode);
})();
