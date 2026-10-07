#!/usr/bin/env node
/**
 * cron 27 19 * * * wx_midea.js
 * Show:每天运行一次
 * 美的会员兼容入口。
 *
 * 业务实现统一由 mdhy.js 提供，避免同一业务双份实现再次分叉。
 * mdhy.js 负责：缓存 session 会员接口验真、失效后完整手机号授权恢复、
 * 积分流水同步、官方积分任务查询与领取、严格退出码。
 */
'use strict';
require('./mdhy.js');
