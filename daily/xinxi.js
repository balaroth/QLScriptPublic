'use strict';

/*
------------------------------------------
@Author: sm / hardened by balaroth
@Description: 辛喜小程序任务
cron: 30 7 * * *
------------------------------------------
环境变量：
  xinxi=sso#备注              多账号使用换行或 & 分隔（兼容旧变量 XSSONF）
  XINXI_READ_ONLY=1           只读验证，不执行签到/评论/点赞/关注/分享
  XINXI_PROBE_ONLY=1          未配置账号时仅探测后端；默认缺账号会失败，防止误报成功
  XINXI_HTTP_TIMEOUT=15000    请求超时（毫秒）
  XINXI_MAX_RETRIES=2         只读请求最大重试次数
  XINXI_MAX_PAGES=10          查找可关注帖子的最大页数
  XINXI_BROWSE_GOODS_ID=22    浏览商品任务参数（保持旧脚本默认值）
*/

const axios = require('axios');
const crypto = require('crypto');
const { Env } = require('../tools/env');

const API_BASE = 'https://api.xinc818.com';
const CDN_API_BASE = 'https://cdn-api.xinc818.com';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ' +
  'MicroMessenger/8.0.49 NetType/WIFI Language/zh_CN miniProgram';

class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, details);
  }
}

class AuthExpiredError extends ApiError {
  constructor(message = 'sso 已失效或登录已过期', details = {}) {
    super(message, details);
    this.name = 'AuthExpiredError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const intEnv = (name, fallback, min, max) => {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
};
const boolEnv = (name, fallback = false) => {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
};
const asArray = (value) => (Array.isArray(value) ? value : []);
const errorText = (error) => {
  if (!error) return '未知错误';
  if (error instanceof AuthExpiredError) return error.message;
  const status = error.response && error.response.status;
  const code = error.code ? ` ${error.code}` : '';
  const http = status ? ` HTTP ${status}` : '';
  return `${error.message || String(error)}${code}${http}`.trim();
};

function parseAccounts(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/\r?\n|&/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item, index) => {
      const splitAt = item.indexOf('#');
      const token = (splitAt >= 0 ? item.slice(0, splitAt) : item).trim();
      const remark = (splitAt >= 0 ? item.slice(splitAt + 1) : '').trim();
      return { token, remark: remark || `账号${index + 1}` };
    })
    .filter((item) => item.token);
}

function generateMd5Signature(payload) {
  const text = Object.keys(payload)
    .sort()
    .map((key) => `${key}=${payload[key]}`)
    .join('&');
  return crypto.createHash('md5').update(text).digest('hex');
}

function randomRequestId(timestamp) {
  if (typeof crypto.randomUUID === 'function') {
    return `${crypto.randomUUID()}-${timestamp}`;
  }
  return `${crypto.randomBytes(12).toString('hex')}-${timestamp}`;
}

function createLogger(env) {
  return {
    log: (message) => env.log(message),
    warn: (message) => env.log(`⚠️ ${message}`),
    error: (message) => env.log(`❌ ${message}`),
  };
}

class Task {
  constructor(account, options = {}) {
    this.index = options.index || 1;
    this.token = account.token;
    this.remark = account.remark || `账号${this.index}`;
    this.http = options.http || axios;
    this.logger = options.logger || console;
    this.wait = options.wait || sleep;
    this.readOnly = options.readOnly ?? boolEnv('XINXI_READ_ONLY', false);
    this.timeout = options.timeout || intEnv('XINXI_HTTP_TIMEOUT', 15000, 3000, 60000);
    this.maxRetries = options.maxRetries ?? intEnv('XINXI_MAX_RETRIES', 2, 0, 5);
    this.maxPages = options.maxPages || intEnv('XINXI_MAX_PAGES', 10, 1, 100);
    this.browseGoodsId =
      options.browseGoodsId || intEnv('XINXI_BROWSE_GOODS_ID', 22, 1, Number.MAX_SAFE_INTEGER);
    this.posts = [];
    this.goods = [];
    this.failures = [];
    this.authValid = false;
  }

  prefix(message) {
    return `账号[${this.index}]【${this.remark}】${message}`;
  }

  async request(options, meta = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const idempotent = meta.idempotent === true;
    const attempts = idempotent ? this.maxRetries + 1 : 1;
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const reqTimestamp = Date.now();
      const requestId = randomRequestId(reqTimestamp);
      const signedData = JSON.stringify(options.data);
      const headers = {
        req_timestamp: reqTimestamp,
        request_id: requestId,
        'User-Agent': DEFAULT_USER_AGENT,
        sso: this.token,
        sign: generateMd5Signature({
          data: signedData,
          req_timestamp: reqTimestamp,
          request_id: requestId,
        }),
        ...(options.headers || {}),
      };

      try {
        const response = await this.http.request({
          ...options,
          method,
          headers,
          timeout: options.timeout || this.timeout,
        });
        const result = response && response.data;
        if (!result || typeof result !== 'object') {
          throw new ApiError('接口返回的不是 JSON 对象', { endpoint: options.url });
        }
        const apiCode = Number(result.code);
        if (
          response.status === 401 ||
          response.status === 403 ||
          apiCode === 40001 ||
          /未授权|登录已过期|请先登录|无效的令牌|令牌无效|token\s*(?:invalid|expired)/i.test(
            result.msg || '',
          )
        ) {
          throw new AuthExpiredError(result.msg || undefined, {
            apiCode: result.code,
            httpStatus: response.status,
            endpoint: options.url,
          });
        }
        return result;
      } catch (error) {
        lastError = error;
        if (error instanceof AuthExpiredError) throw error;
        const status = error.response && error.response.status;
        const retryable =
          idempotent &&
          attempt < attempts &&
          (!status || status === 408 || status === 429 || status >= 500);
        if (!retryable) break;
        const delay = Math.min(3000, 300 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 150);
        this.logger.warn(this.prefix(`只读请求失败，${delay}ms 后重试（${attempt}/${attempts - 1}）：${errorText(error)}`));
        await this.wait(delay);
      }
    }

    throw new ApiError(`请求失败：${errorText(lastError)}`, {
      cause: lastError,
      endpoint: options.url,
    });
  }

  unwrap(result, action) {
    if (result.code !== 0) {
      throw new ApiError(`${action}失败：${result.msg || `接口码 ${result.code}`}`, {
        apiCode: result.code,
      });
    }
    return result.data;
  }

  async userInfo() {
    const result = await this.request(
      { method: 'GET', url: `${API_BASE}/mini/user` },
      { idempotent: true },
    );
    const data = this.unwrap(result, '用户查询') || {};
    this.authValid = true;
    this.logger.log(this.prefix(`用户【${data.nickname || '未命名'}】，积分【${data.integral ?? '未知'}】`));
    return data;
  }

  async signStatus() {
    const result = await this.request(
      {
        method: 'GET',
        url: `${API_BASE}/mini/sign/status`,
        headers: { 'Content-Type': 'application/json' },
      },
      { idempotent: true },
    );
    return Boolean(this.unwrap(result, '签到状态查询'));
  }

  async signIn() {
    const result = await this.request({
      method: 'GET',
      url: `${API_BASE}/mini/sign/in?dailyTaskId=`,
      headers: { 'Content-Type': 'application/json' },
    });
    const data = this.unwrap(result, '签到') || {};
    this.logger.log(this.prefix(`签到成功，获得积分【${data.integral ?? '未知'}】`));
    return data;
  }

  async signContinuous() {
    const result = await this.request(
      {
        method: 'GET',
        url: `${API_BASE}/mini/sign/continuous`,
        headers: { 'Content-Type': 'application/json' },
      },
      { idempotent: true },
    );
    const data = this.unwrap(result, '连续签到查询');
    this.logger.log(this.prefix(`连续签到【${data ?? '未知'}】天`));
    return data;
  }

  async getDailyTasks() {
    const result = await this.request(
      { method: 'GET', url: `${API_BASE}/mini/dailyTask/daily` },
      { idempotent: true },
    );
    const data = this.unwrap(result, '任务列表查询');
    if (!Array.isArray(data)) throw new ApiError('任务列表格式异常');
    return data;
  }

  async getPosts(pageNum = 1) {
    const result = await this.request(
      {
        method: 'GET',
        url: `${API_BASE}/mini/community/home/posts?pageNum=${pageNum}&pageSize=100&queryType=3&position=2`,
      },
      { idempotent: true },
    );
    const data = this.unwrap(result, '帖子列表查询') || {};
    const list = asArray(data.list);
    if (pageNum === 1) this.posts = list;
    return list;
  }

  async getGoods() {
    const result = await this.request(
      {
        method: 'GET',
        url: `${CDN_API_BASE}/mini/integralGoods?miniIs=1&orderField=sort&orderScheme=DESC&pageSize=50&pageNum=1`,
      },
      { idempotent: true },
    );
    const data = this.unwrap(result, '积分商品查询') || {};
    this.goods = asArray(data.list);
    return this.goods;
  }

  async getGoodDetail(id) {
    const result = await this.request(
      { method: 'GET', url: `${API_BASE}/mini/integralGoods/${encodeURIComponent(id)}` },
      { idempotent: true },
    );
    return this.unwrap(result, '商品详情查询') || {};
  }

  async share() {
    const result = await this.request({ method: 'GET', url: `${API_BASE}/mini/dailyTask/share` });
    const data = this.unwrap(result, '分享任务') || {};
    this.logger.log(this.prefix(`完成分享任务，获得【${data.singleReward ?? '未知'}】积分`));
  }

  async browseGoods(task) {
    const targetId = task && (task.targetId || task.goodsId || task.postsId);
    const id = targetId || this.browseGoodsId;
    const result = await this.request({
      method: 'GET',
      url: `${API_BASE}/mini/dailyTask/browseGoods/${encodeURIComponent(id)}`,
    });
    const data = this.unwrap(result, '浏览商品任务') || {};
    this.logger.log(this.prefix(`完成浏览商品任务，获得【${data.singleReward ?? '未知'}】积分`));
  }

  async postsComments(postId) {
    const result = await this.request({
      method: 'POST',
      url: `${API_BASE}/mini/postsComments`,
      headers: { 'Content-Type': 'application/json' },
      data: { content: '👍👍👍👍👍', postsId: postId },
    });
    const data = this.unwrap(result, '发表评论') || {};
    const reward = data.taskResult && data.taskResult.singleReward;
    this.logger.log(this.prefix(`发表评论成功，获得【${reward ?? '未知'}】积分`));
  }

  async likePosts(postId) {
    const result = await this.request({
      method: 'PUT',
      url: `${API_BASE}/mini/posts/like`,
      headers: { 'Content-Type': 'application/json' },
      data: { postsId: postId, decision: true },
    });
    const data = this.unwrap(result, '点赞帖子') || {};
    this.logger.log(this.prefix(`点赞帖子成功，获得【${data.singleReward ?? '未知'}】积分`));
  }

  async followUser(publisherId) {
    const result = await this.request({
      method: 'PUT',
      url: `${API_BASE}/mini/user/follow`,
      headers: { 'Content-Type': 'application/json' },
      data: { followUserId: publisherId, decision: true },
    });
    const data = this.unwrap(result, '关注用户') || {};
    this.logger.log(this.prefix(`关注用户成功，获得【${data.singleReward ?? '未知'}】积分`));
  }

  async likeGoods(productId, dailyTaskId) {
    const taskId = dailyTaskId || 20;
    const likeResult = await this.request({
      method: 'POST',
      url: `${API_BASE}/mini/live/likeLiveItem`,
      headers: { 'Content-Type': 'application/json' },
      data: { isLike: true, dailyTaskId: taskId, productId },
    });
    const data = this.unwrap(likeResult, '点赞商品') || {};
    this.logger.log(this.prefix(`点赞商品成功，获得【${data.singleReward ?? '未知'}】积分`));

    await this.wait(1000);
    try {
      const unlikeResult = await this.request({
        method: 'POST',
        url: `${API_BASE}/mini/live/likeLiveItem`,
        headers: { 'Content-Type': 'application/json' },
        data: { isLike: false, dailyTaskId: taskId, productId },
      });
      this.unwrap(unlikeResult, '取消点赞商品');
      this.logger.log(this.prefix('已恢复商品点赞状态'));
    } catch (error) {
      this.logger.warn(this.prefix(`取消商品点赞失败，不影响任务奖励：${errorText(error)}`));
    }
  }

  async ensurePosts() {
    if (!this.posts.length) await this.getPosts(1);
    return this.posts;
  }

  async findFollowCandidate() {
    for (let page = 1; page <= this.maxPages; page += 1) {
      const posts = page === 1 && this.posts.length ? this.posts : await this.getPosts(page);
      const candidate = posts.find(
        (item) =>
          item &&
          item.publisherId &&
          (item.concernSign === 1 || item.followed === false || item.concern === false),
      );
      if (candidate) return candidate;
      if (posts.length < 100) break;
      if (page < this.maxPages) await this.wait(300);
    }
    throw new ApiError(`前 ${this.maxPages} 页未找到可关注用户`);
  }

  async executeTask(task) {
    switch (task.code) {
      case 'BROWSE_PRODUCTS':
        return this.browseGoods(task);
      case 'COMMENT_POSTS': {
        const posts = await this.ensurePosts();
        const post = posts.find((item) => item && item.id);
        if (!post) throw new ApiError('没有可评论帖子');
        return this.postsComments(post.id);
      }
      case 'LIKE_POSTS': {
        const posts = await this.ensurePosts();
        const post = posts.find((item) => item && item.id && item.liked === false);
        if (!post) throw new ApiError('没有可点赞帖子');
        return this.likePosts(post.id);
      }
      case 'FOCUS_USER': {
        const post = await this.findFollowCandidate();
        return this.followUser(post.publisherId);
      }
      case 'WANT_GOODS': {
        if (!this.goods.length) await this.getGoods();
        for (const good of this.goods) {
          if (!good || good.id == null) continue;
          const detail = await this.getGoodDetail(good.id);
          if (detail.outerId) {
            return this.likeGoods(detail.outerId, task.id || task.dailyTaskId);
          }
        }
        throw new ApiError('积分商品中没有可点赞的外部商品');
      }
      case 'SHARE':
        return this.share();
      default:
        this.logger.warn(this.prefix(`暂不支持任务【${task.taskName || task.code} / ${task.code || '无编码'}】，已跳过`));
    }
  }

  async readOnlySnapshot(tasks, signState) {
    const needsPosts = tasks.some((task) =>
      ['COMMENT_POSTS', 'LIKE_POSTS', 'FOCUS_USER'].includes(task.code),
    );
    const results = await Promise.allSettled([
      this.signContinuous(),
      this.getGoods(),
      ...(needsPosts ? [this.getPosts(1)] : []),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.failures.push(errorText(result.reason));
        this.logger.warn(this.prefix(`只读检查项失败：${errorText(result.reason)}`));
      }
    }
    const incomplete = tasks.filter((task) => task && task.status === false);
    this.logger.log(
      this.prefix(
        `只读检查完成：签到=${signState ? '已签到' : '未签到'}，任务=${tasks.length}，未完成=${incomplete.length}，商品=${this.goods.length}，帖子=${this.posts.length}`,
      ),
    );
  }

  async run() {
    this.logger.log(this.prefix(`开始${this.readOnly ? '只读验证' : '执行任务'}`));
    try {
      await this.userInfo();
      const signState = await this.signStatus();
      if (!signState && !this.readOnly) {
        await this.signIn();
      } else {
        this.logger.log(this.prefix(`签到状态：${signState ? '已签到' : '未签到'}`));
      }

      const tasks = await this.getDailyTasks();
      if (this.readOnly) {
        await this.readOnlySnapshot(tasks, signState);
        return { ok: this.failures.length === 0, failures: this.failures };
      }

      for (const task of tasks) {
        if (!task || task.status !== false) continue;
        this.logger.log(
          this.prefix(
            `执行任务【${task.taskName || task.code}】${task.annotation ? `：${task.annotation}` : ''}`,
          ),
        );
        try {
          await this.executeTask(task);
          await this.wait(500);
        } catch (error) {
          const message = `${task.taskName || task.code || '未知任务'}：${errorText(error)}`;
          this.failures.push(message);
          this.logger.error(this.prefix(message));
          if (error instanceof AuthExpiredError) throw error;
        }
      }

      try {
        await this.signContinuous();
        await this.getGoods();
      } catch (error) {
        this.failures.push(errorText(error));
        this.logger.warn(this.prefix(`收尾查询失败：${errorText(error)}`));
      }

      for (const item of this.goods) {
        this.logger.log(`积分物品【${item.name || item.id || '未命名'}】，库存【${item.stock ?? '未知'}】`);
      }
      return { ok: this.failures.length === 0, failures: this.failures };
    } catch (error) {
      const message = error instanceof AuthExpiredError ? 'sso 已失效，请重新抓取' : errorText(error);
      this.failures.push(message);
      this.logger.error(this.prefix(message));
      return { ok: false, authExpired: error instanceof AuthExpiredError, failures: this.failures };
    }
  }
}

async function probeBackend(http = axios, logger = console) {
  const endpoints = [
    `${API_BASE}/mini/user`,
    `${API_BASE}/mini/sign/status`,
    `${API_BASE}/mini/dailyTask/daily`,
    `${CDN_API_BASE}/mini/integralGoods?miniIs=1&pageSize=1&pageNum=1`,
  ];
  const details = [];
  for (const url of endpoints) {
    let detail = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await http.request({
          method: 'GET',
          url,
          timeout: intEnv('XINXI_HTTP_TIMEOUT', 15000, 3000, 60000),
          headers: { 'User-Agent': DEFAULT_USER_AGENT },
          validateStatus: () => true,
        });
        const body = response.data;
        const apiCode = body && typeof body === 'object' ? Number(body.code) : null;
        const reachable = response.status < 500 && (apiCode === 0 || apiCode === 40001);
        detail = { url, httpStatus: response.status, apiCode, reachable, attempts: attempt };
        if (reachable || attempt === 2) break;
      } catch (error) {
        detail = { url, reachable: false, attempts: attempt, error: errorText(error) };
        if (attempt < 2) await sleep(300);
      }
    }
    details.push(detail);
  }
  const ok = details.every((item) => item.reachable);
  logger[ok ? 'log' : 'error'](
    `后端探活${ok ? '通过' : '失败'}：${details
      .map((item) => `${new URL(item.url).pathname}[${item.httpStatus || '-'}|${item.apiCode ?? '-'}]`)
      .join('，')}`,
  );
  return { ok, details };
}

async function main() {
  const env = new Env('辛喜小程序');
  const logger = createLogger(env);
  const raw = process.env.xinxi || process.env.XSSONF || '';
  const accounts = parseAccounts(raw);
  const readOnly = boolEnv('XINXI_READ_ONLY', false);
  const probeOnly = boolEnv('XINXI_PROBE_ONLY', false);
  logger.log(
    `共找到${accounts.length}个账号${readOnly ? '（只读模式）' : ''}${probeOnly ? '（仅探活）' : ''}`,
  );

  let failed = 0;
  if (!accounts.length) {
    if (!probeOnly) {
      logger.error('未配置 xinxi（兼容 XSSONF）账号；拒绝把后端探活误报为业务成功');
      logger.log('如只需检查后端是否在线，请显式设置 XINXI_PROBE_ONLY=1');
      failed += 1;
    } else {
      logger.warn('未配置业务账号，按 XINXI_PROBE_ONLY=1 仅执行后端探活');
      const probe = await probeBackend(axios, logger);
      if (!probe.ok) failed += 1;
    }
  } else {
    for (let index = 0; index < accounts.length; index += 1) {
      const task = new Task(accounts[index], {
        index: index + 1,
        logger,
        readOnly,
      });
      const result = await task.run();
      if (!result.ok) failed += 1;
    }
  }

  logger.log(`执行汇总：账号=${accounts.length}，失败=${failed}，模式=${readOnly ? '只读' : '任务'}`);
  await env.sendMsg();
  const seconds = ((Date.now() - env.startTime) / 1000).toFixed(3);
  console.log(`🔔${env.name},结束!🕛 ${seconds}秒`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`辛喜脚本未捕获异常：${errorText(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  API_BASE,
  CDN_API_BASE,
  ApiError,
  AuthExpiredError,
  Task,
  parseAccounts,
  generateMd5Signature,
  probeBackend,
  errorText,
};
