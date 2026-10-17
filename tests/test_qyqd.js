#!/usr/bin/env node
const assert = require("assert");
const path = require("path");

process.env.qyqd = "test-openid#回归账号";
const mod = require(path.resolve(__dirname, "../wxapp/qyqd.js"));

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log("PASS", name);
    } catch (e) {
        failed++;
        console.error("FAIL", name, e.stack || e);
    }
}

(async () => {
    await test("parseAccount", () => {
        assert.deepStrictEqual(mod.parseAccount("abc#备注"), { openid: "abc", remark: "备注" });
    });
    await test("transient timeout classification", () => {
        assert.strictEqual(mod.isTransientError(Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" })), true);
        assert.strictEqual(mod.isTransientError(new Error("business denied")), false);
    });
    await test("already signed classification", () => {
        assert.strictEqual(mod.isAlreadyDone("今日已经签到"), true);
        assert.strictEqual(mod.isAlreadyDone("系统繁忙"), false);
    });
    await test("read request retries transient error", async () => {
        const t = new mod.Task("openid");
        let n = 0;
        const old = require("axios").request;
        require("axios").request = async () => {
            n++;
            if (n < 3) throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
            return { status: 200, data: { code: 0, data: { points: 1 } } };
        };
        try {
            const r = await t.request("/user/info", {}, true, "GET", null, { attempts: 3 });
            assert.strictEqual(r.code, 0);
            assert.strictEqual(n, 3);
        } finally { require("axios").request = old; }
    });
    await test("write request is never blindly retried", async () => {
        const t = new mod.Task("openid");
        let n = 0;
        const old = require("axios").request;
        require("axios").request = async () => { n++; throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); };
        try {
            await assert.rejects(() => t.request("/signin/do", {}, true, "POST"), /timeout/);
            assert.strictEqual(n, 1);
        } finally { require("axios").request = old; }
    });
    await test("sign timeout verifies server state", async () => {
        const t = new mod.Task("openid");
        let statuses = 0;
        t.querySignStatus = async () => {
            statuses++;
            return statuses === 1 ? { signed: false, data: {} } : { signed: true, data: { today_reward: 10 } };
        };
        t.request = async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); };
        assert.strictEqual(await t.sign(), true);
        assert.strictEqual(statuses, 2);
    });
    await test("sign success must pass postcondition", async () => {
        const t = new mod.Task("openid");
        let statuses = 0;
        t.querySignStatus = async () => ({ signed: false, data: {}, authInvalid: false });
        t.request = async () => ({ code: 0, message: "success" });
        await assert.rejects(() => t.sign(), /服务端状态仍为未签到/);
        assert.strictEqual(statuses, 0);
    });
    await test("already signed skips write", async () => {
        const t = new mod.Task("openid");
        t.querySignStatus = async () => ({ signed: true, data: { today_reward: 10 } });
        t.request = async () => { throw new Error("must not write"); };
        assert.strictEqual(await t.sign(), true);
    });
    await test("auth invalid triggers one relogin", async () => {
        const t = new mod.Task("openid");
        let statusCalls = 0;
        let loginCalls = 0;
        t.querySignStatus = async () => {
            statusCalls++;
            return statusCalls === 1 ? { authInvalid: true } : { signed: true, data: {} };
        };
        t.login = async () => { loginCalls++; t.token = "fresh"; };
        assert.strictEqual(await t.sign(), true);
        assert.strictEqual(loginCalls, 1);
    });

    console.log(`RESULT PASS=${passed} FAIL=${failed}`);
    process.exitCode = failed ? 1 : 0;
})();
