#!/usr/bin/env node
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const candidate = process.argv[2] || path.join(__dirname, "../daily/lenovo.js");
const source = fs.readFileSync(candidate, "utf8");
const prefix = source.split("!(async () => {")[0] + "\nmodule.exports={Task,isAlreadySigned};";

const logs = [];
const axios = { request: async () => ({ data: { code: "1", msg: "请勿重复签到" } }) };
class Env {
  constructor() { this.userIdx = 1; }
  log(message) { logs.push(String(message)); }
  wait() { return Promise.resolve(); }
}
const context = {
  module: { exports: {} }, exports: {}, self: {}, console,
  require(name) {
    if (name === "axios") return axios;
    if (name === "../tools/env") return { Env };
    if (name === "jsencrypt") return class { setPublicKey() {} encrypt() { return "encrypted"; } };
    return require(name);
  },
};
vm.runInNewContext(prefix, context, { filename: candidate });
const { Task, isAlreadySigned } = context.module.exports;

(async () => {
  assert.equal(isAlreadySigned("请勿重复签到"), true);
  assert.equal(isAlreadySigned("今日已签到"), true);
  assert.equal(isAlreadySigned("系统错误"), false);
  const task = new Task("token");
  task.ck = "lenovo-id";
  task.headers = {};
  assert.equal(await task.checkIn(), true);
  assert.ok(logs.some((x) => x.includes("今日已签到")));
  assert.ok(!logs.some((x) => x.includes("❌")));
  assert.match(source, /\[QLRUN_RESULT\] SUCCESS/);
  assert.match(source, /\[QLRUN_RESULT\] FAILURE/);
  console.log("RESULT PASS=7 FAIL=0");
})().catch((e) => { console.error(e); process.exit(1); });
