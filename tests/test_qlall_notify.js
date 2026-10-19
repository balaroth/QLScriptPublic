#!/usr/bin/env node
const fs = require("fs");
const assert = require("assert/strict");
const source = fs.readFileSync(process.argv[2] || "tools/qlall.js", "utf8");
assert.match(source, /if \(failN === 0\)/);
assert.match(source, /【青龙签到完成】全部成功/);
assert.match(source, /全部成功 <b>\$\{okN\}\/\$\{report\.length\}<\/b>｜耗时约/);
assert.match(source, /if \(!stopped && process\.env\.QL_NO_MAIL !== '1'\)/);
assert.doesNotMatch(source, /按失败专报策略不发送邮件/);
assert.match(source, /失败\/未成功明细/);
console.log("RESULT PASS=6 FAIL=0");
