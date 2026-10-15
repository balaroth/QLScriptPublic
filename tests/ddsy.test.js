'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const scriptPath = process.env.DDSY_UNDER_TEST || path.join(__dirname, 'ddsy.new.js');
const {
  Task,
  fetchWxCode,
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
