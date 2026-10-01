#!/usr/bin/env node
/*
------------------------------------------
@Description: 捷停车 - 当前微信小程序登录 + 每日签到
cron: 57 8 * * *
------------------------------------------
变量名：jtc
变量值：账号标识（仅用于多账号标签和 wx_server nonce），多账号用 & 或换行分隔，可加 #备注
依赖变量：wx_server_url、wx_auth

当前协议（小程序版本 342）：
登录：POST https://www.jslife.com.cn/wxhttp/weixin/xcx/get_openid_by_code
查询：POST https://mbr.jparking.cn/member-core-gateway/integral/v2/show/query
签到：POST https://mbr.jparking.cn/member-core-gateway/integral/v2/task/receive
------------------------------------------
*/

'use strict';

const { Env } = require('../tools/env.js');
const $ = new Env('捷停车签到');
const axios = require('axios');
const WeChatServer = require('./wcs.js');

const CK_NAME = 'jtc';
const APPID = 'wx24b70f0ad2a9a89a';
const APP_VERSION = '342';
const APP_TYPE = 'WX_XCX_JTC';
const LOGIN_URL = 'https://www.jslife.com.cn/wxhttp/weixin/xcx/get_openid_by_code';
const MEMBER_CORE = 'https://mbr.jparking.cn/member-core-gateway/integral/v2';
const UA = 'Mozilla/5.0 (Linux; Android 10; wv) AppleWebKit/537.36 Mobile MicroMessenger/8.0 MiniProgramEnv/Android';
const REQUEST_TIMEOUT = Number(process.env.JTC_REQUEST_TIMEOUT || 20000);

const wechat = new WeChatServer({
    url: process.env.wx_server_url || 'http://d4.dqf.cc.cd:8787',
    appid: APPID,
    auth: process.env.wx_auth || '',
});

let successCount = 0;
let failureCount = 0;
let retryableFailure = false;

function parseAccount(raw = '') {
    const [id, remark] = String(raw).split('#').map((part) => (part || '').trim());
    return { id, remark: remark || '' };
}

function text(value, limit = 240) {
    const output = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return output.length > limit ? `${output.slice(0, limit)}...` : output;
}

function isRetryable(error) {
    return /timeout|ECONN|ENOTFOUND|EAI_AGAIN|网络|系统繁忙|稍后再试|超时|502|503|504/i.test(String(error?.message || error));
}

class JtcAccount {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.token = '';
        this.userId = '';
        this.openId = '';
    }

    log(message) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ''} ${message}`);
    }

    async getCode() {
        const nonce = `${this.account.id || 'jtc'}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const { data } = await wechat.getCode(nonce);
        if (data?.status === false) throw new Error(`wx_server 取code失败: ${data.message || text(data)}`);
        const code = data?.data?.code || data?.code;
        if (!code || typeof code !== 'string') throw new Error(`wx_server 未返回 code: ${text(data)}`);
        return code;
    }

    async login() {
        const code = await this.getCode();
        const response = await axios.request({
            method: 'POST',
            url: `${LOGIN_URL}?t=${Date.now()}`,
            data: { code, userType: APP_TYPE, appId: APPID },
            headers: {
                applicationVersion: '1.0.1',
                xweb_xhr: '1',
                'User-Agent': UA,
                'Content-Type': 'application/json;charset=UTF-8',
                Accept: '*/*',
                Referer: `https://servicewechat.com/${APPID}/${APP_VERSION}/page-frame.html`,
            },
            timeout: REQUEST_TIMEOUT,
            validateStatus: () => true,
        });
        if (response.status !== 200) throw new Error(`登录HTTP ${response.status}: ${text(response.data)}`);
        const body = response.data || {};
        const info = body.obj || body.data || {};
        this.token = String(info.jieshunToken || info.token || '');
        this.userId = String(info.userId || '');
        this.openId = String(info.openId || info.serviceId || '');
        if (String(body.resultCode) !== '0' || !this.token || !this.userId || !this.openId) {
            throw new Error(`登录失败: ${body.message || text(body)}`);
        }
        this.log('登录成功');
    }

    async post(path, data) {
        const response = await axios.request({
            method: 'POST',
            url: `${MEMBER_CORE}${path}`,
            data,
            headers: {
                'User-Agent': UA,
                'Content-Type': 'application/json',
                Referer: `https://servicewechat.com/${APPID}/${APP_VERSION}/page-frame.html`,
            },
            timeout: REQUEST_TIMEOUT,
            validateStatus: () => true,
        });
        if (response.status !== 200) throw new Error(`${path} HTTP ${response.status}: ${text(response.data)}`);
        return response.data || {};
    }

    async querySign() {
        const body = await this.post('/show/query', {
            userId: this.userId,
            openId: this.openId,
            h5Source: APP_TYPE,
            reqVersion: 'V2.0',
        });
        if (!body.success || String(body.code) !== '0') {
            throw new Error(`签到状态查询失败: ${body.message || text(body)}`);
        }
        const signArea = body.data?.signArea;
        if (!signArea || signArea.signStatus === undefined) {
            throw new Error(`签到状态响应缺少 signArea: ${text(body)}`);
        }
        return signArea;
    }

    async receiveSign() {
        const body = await this.post('/task/receive', {
            userId: this.userId,
            openId: this.openId,
            taskNo: 'T00',
            reqSource: APP_TYPE,
            platformType: APP_TYPE,
            osType: 'ANDROID',
            token: this.token,
        });
        if (body.success && String(body.code) === '0') {
            this.log(`✅ 签到成功，停车币+${body.data ?? '?'}`);
            return;
        }
        if (body.code === 'INTER888') throw new Error('签到触发人机验证，需更新验证处理机制');
        if (/已签|已领取|重复|已完成|今日已/.test(String(body.message || ''))) {
            this.log(`✅ 今日已签到（${body.message}）`);
            return;
        }
        throw new Error(`签到领取失败: ${body.message || text(body)}`);
    }

    async run() {
        try {
            await this.login();
            const before = await this.querySign();
            if (Number(before.signStatus) === 1) {
                this.log(`✅ 今日已签到，明日可领${before.signIntegralTomorrow ?? '?'}停车币`);
            } else {
                this.log(`今日可签到领取${before.signIntegralToday ?? '?'}停车币`);
                await this.receiveSign();
                const after = await this.querySign();
                if (Number(after.signStatus) !== 1) throw new Error(`签到后状态未更新: ${text(after)}`);
                this.log(`签到状态复核成功，明日可领${after.signIntegralTomorrow ?? '?'}停车币`);
            }
            successCount += 1;
        } catch (error) {
            failureCount += 1;
            retryableFailure = retryableFailure || isRetryable(error);
            this.log(`执行失败: ${error.message || error}`);
        }
    }
}

(async () => {
    $.checkEnv(CK_NAME);
    if (!$.userCount) {
        failureCount = 1;
        $.log(`未找到变量 ${CK_NAME}`);
        $.log('[QLRUN_RESULT] FAILURE reason=jtc_env_missing retryable=0');
        return;
    }
    for (let i = 0; i < $.userList.length; i++) {
        await new JtcAccount($.userList[i]).run();
        if (i < $.userList.length - 1) await $.wait(1200, 2200);
    }
    if (failureCount === 0 && successCount === $.userCount) {
        $.log(`[QLRUN_RESULT] SUCCESS reason=jtc_sign_ok accounts=${successCount}/${$.userCount}`);
    } else {
        $.log(`[QLRUN_RESULT] FAILURE reason=jtc_sign_failed retryable=${retryableFailure ? 1 : 0} accounts=${successCount}/${$.userCount}`);
        process.exitCode = 1;
    }
})().catch((error) => {
    $.log(`执行异常: ${error.message || error}`);
    $.log(`[QLRUN_RESULT] FAILURE reason=jtc_unhandled retryable=${isRetryable(error) ? 1 : 0}`);
    process.exitCode = 1;
}).finally(() => $.done());
