'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const {
  Task,
  AuthExpiredError,
  parseAccounts,
  generateMd5Signature,
  probeBackend,
} = require(process.env.XINXI_CANDIDATE || './xinxi.js');

const silentLogger = { log() {}, warn() {}, error() {} };

function response(data, status = 200) {
  return { status, data };
}

async function testParseAccounts() {
  assert.deepStrictEqual(parseAccounts('a#甲\nb#乙&c'), [
    { token: 'a', remark: '甲' },
    { token: 'b', remark: '乙' },
    { token: 'c', remark: '账号3' },
  ]);
  assert.deepStrictEqual(parseAccounts(''), []);
}

async function testSignature() {
  assert.strictEqual(
    generateMd5Signature({ request_id: 'b', data: undefined, req_timestamp: 1 }),
    generateMd5Signature({ req_timestamp: 1, request_id: 'b', data: undefined }),
  );
}

async function testAuthExpiredStopsAccount() {
  const calls = [];
  const http = {
    async request(options) {
      calls.push(options.url);
      return response({ code: 40001, msg: '未授权或登录已过期', data: null });
    },
  };
  const task = new Task(
    { token: 'expired', remark: '失效账号' },
    { http, logger: silentLogger, maxRetries: 0, wait: async () => {} },
  );
  const result = await task.run();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.authExpired, true);
  assert.strictEqual(calls.length, 1, '鉴权失效后不应继续调用接口');
}

async function testStringAuthCodeAndHttpAuthStatus() {
  for (const sample of [
    response({ code: '40001', msg: '', data: null }, 200),
    response({ code: 1001, msg: '无效的令牌', data: null }, 200),
    response({ code: 0, msg: '', data: null }, 401),
    response({ code: 0, msg: '', data: null }, 403),
  ]) {
    const task = new Task(
      { token: 'expired', remark: '边界鉴权' },
      {
        http: { async request() { return sample; } },
        logger: silentLogger,
        maxRetries: 0,
        wait: async () => {},
      },
    );
    await assert.rejects(
      task.request({ method: 'GET', url: 'https://example.test' }, { idempotent: true }),
      AuthExpiredError,
    );
  }
}

async function testRejectedHttpAuthStatus() {
  for (const sample of [
    { status: 401, data: { code: 0, msg: '' } },
    { status: 403, data: { code: 0, msg: '' } },
    { status: 500, data: { code: 40001, msg: '登录已过期' } },
  ]) {
    let calls = 0;
    const task = new Task(
      { token: 'expired', remark: 'axios拒绝路径' },
      {
        http: {
          async request() {
            calls += 1;
            const error = new Error(`Request failed with status code ${sample.status}`);
            error.response = sample;
            throw error;
          },
        },
        logger: silentLogger,
        maxRetries: 2,
        wait: async () => {},
      },
    );
    await assert.rejects(
      task.request({ method: 'GET', url: 'https://example.test' }, { idempotent: true }),
      AuthExpiredError,
    );
    assert.strictEqual(calls, 1, '鉴权拒绝不能按瞬时故障重试');
  }
}

async function testReadOnlyNeverWrites() {
  const calls = [];
  const http = {
    async request(options) {
      calls.push({ method: String(options.method || 'GET').toUpperCase(), url: options.url });
      if (options.url.endsWith('/mini/user')) {
        return response({ code: 0, data: { nickname: '测试', integral: 10 } });
      }
      if (options.url.endsWith('/mini/sign/status')) return response({ code: 0, data: false });
      if (options.url.endsWith('/mini/dailyTask/daily')) {
        return response({
          code: 0,
          data: [
            { code: 'COMMENT_POSTS', taskName: '评论', status: false },
            { code: 'SHARE', taskName: '分享', status: false },
          ],
        });
      }
      if (options.url.endsWith('/mini/sign/continuous')) return response({ code: 0, data: 3 });
      if (options.url.includes('/mini/integralGoods?')) {
        return response({ code: 0, data: { list: [{ id: 1, name: '测试商品', stock: 1 }] } });
      }
      if (options.url.includes('/mini/community/home/posts?')) {
        return response({ code: 0, data: { list: [{ id: 2, liked: false }] } });
      }
      throw new Error(`意外请求 ${options.method} ${options.url}`);
    },
  };
  const task = new Task(
    { token: 'valid', remark: '只读' },
    { http, logger: silentLogger, readOnly: true, maxRetries: 0, wait: async () => {} },
  );
  const result = await task.run();
  assert.strictEqual(result.ok, true);
  assert.ok(calls.length >= 6);
  assert.ok(calls.every((item) => item.method === 'GET'), '只读模式只允许 GET');
  assert.ok(!calls.some((item) => item.url.includes('/sign/in')));
  assert.ok(!calls.some((item) => item.url.includes('/postsComments')));
  assert.ok(!calls.some((item) => item.url.includes('/dailyTask/share')));
}

async function testRetryBounded() {
  let attempts = 0;
  const http = {
    async request() {
      attempts += 1;
      const error = new Error('temporary');
      error.response = { status: 503 };
      throw error;
    },
  };
  const task = new Task(
    { token: 'x', remark: '重试' },
    { http, logger: silentLogger, maxRetries: 2, wait: async () => {} },
  );
  await assert.rejects(
    task.request({ method: 'GET', url: 'https://example.test' }, { idempotent: true }),
  );
  assert.strictEqual(attempts, 3);
}

async function testNoCandidateFailsCleanly() {
  const http = {
    async request(options) {
      if (options.url.includes('/community/home/posts')) {
        return response({ code: 0, data: { list: [] } });
      }
      throw new Error('unexpected');
    },
  };
  const task = new Task(
    { token: 'x', remark: '空列表' },
    { http, logger: silentLogger, maxPages: 2, maxRetries: 0, wait: async () => {} },
  );
  await assert.rejects(task.executeTask({ code: 'LIKE_POSTS' }), /没有可点赞帖子/);
  await assert.rejects(task.executeTask({ code: 'COMMENT_POSTS' }), /没有可评论帖子/);
  await assert.rejects(task.executeTask({ code: 'FOCUS_USER' }), /未找到可关注用户/);
}

async function testUnknownTaskSkips() {
  const task = new Task(
    { token: 'x', remark: '未知任务' },
    { http: {}, logger: silentLogger, wait: async () => {} },
  );
  await task.executeTask({ code: 'NEW_TASK', taskName: '新任务' });
}

async function testProbeBackend() {
  let calls = 0;
  const http = {
    async request() {
      calls += 1;
      return response({ code: 40001, msg: '未授权或登录已过期', data: null });
    },
  };
  const result = await probeBackend(http, silentLogger);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls, 4);
}

async function testProbeBackendRetriesTransientFailure() {
  const attemptsByUrl = new Map();
  const http = {
    async request(options) {
      const attempts = (attemptsByUrl.get(options.url) || 0) + 1;
      attemptsByUrl.set(options.url, attempts);
      if (options.url.includes('cdn-api.') && attempts === 1) {
        const error = new Error('temporary timeout');
        error.code = 'ETIMEDOUT';
        throw error;
      }
      return response({ code: '40001', msg: '未授权或登录已过期', data: null });
    },
  };
  const result = await probeBackend(http, silentLogger);
  assert.strictEqual(result.ok, true);
  assert.strictEqual([...attemptsByUrl.values()].reduce((sum, value) => sum + value, 0), 5);
  const cdn = result.details.find((item) => item.url.includes('cdn-api.'));
  assert.strictEqual(cdn.attempts, 2);
}

async function testNoAccountIsExplicitSkip() {
  const script = process.env.XINXI_CANDIDATE || './xinxi.js';
  const child = spawnSync(process.execPath, [script], {
    cwd: __dirname,
    env: { ...process.env, xinxi: '', XSSONF: '', XINXI_PROBE_ONLY: '' },
    encoding: 'utf8',
  });
  const output = `${child.stdout || ''}\n${child.stderr || ''}`;
  assert.strictEqual(child.status, 0, output);
  assert.match(output, /\[QLRUN_RESULT\] SKIP reason=no_accounts configured=0/);
  assert.doesNotMatch(output, /\[QLRUN_RESULT\] SUCCESS/);
  assert.doesNotMatch(output, /\[QLRUN_RESULT\] FAILURE/);
}

async function main() {
  const tests = [
    testParseAccounts,
    testSignature,
    testAuthExpiredStopsAccount,
    testStringAuthCodeAndHttpAuthStatus,
    testRejectedHttpAuthStatus,
    testReadOnlyNeverWrites,
    testRetryBounded,
    testNoCandidateFailsCleanly,
    testUnknownTaskSkips,
    testProbeBackend,
    testProbeBackendRetriesTransientFailure,
    testNoAccountIsExplicitSkip,
  ];
  for (const test of tests) {
    await test();
    console.log(`PASS ${test.name}`);
  }
  console.log(`PASS ${tests.length}/${tests.length}`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
