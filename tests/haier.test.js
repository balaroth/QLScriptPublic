'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const script = process.env.HAIER_CANDIDATE || '../wxapp/haier.js';

async function main() {
  const source = fs.readFileSync(script, 'utf8');
  assert.match(source, /用户信息获取失败/);
  assert.match(source, /clearCachedToken\(\)/);
  assert.match(source, /delete cache\[this\.account\.openid\]/);
  assert.match(source, /return this\.sign\(false\)/);
  assert.match(source, /throw new Error\(`签到失败:/);
  console.log('PASS haier stale-token recovery contract 5/5');
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
