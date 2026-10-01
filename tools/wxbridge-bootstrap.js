'use strict';
/*
 * wxbridge-bootstrap.js — 青龙任务预加载注入器（不改第三方脚本，幂等）
 *
 * 青龙 BlackLK Android Root 模块为单进程架构（NODE_OPTIONS 不生效），
 * 在 config/task_before.js 末尾 require 本文件：
 *   require('/data/adb/qinglong-data/scripts/smallfawn_QLScriptPublic/tools/wxbridge-bootstrap.js');
 *
 * 默认把目标域名的 https 请求【透明降级为明文 http】发往 collector:8787
 * （复用已对手机开放的端口，规避移动网络对高位自签TLS端口的 RST）。
 * 可选环境变量：
 *   WX_BRIDGE_GATEWAY  网关 host:port（默认 d4.dqf.cc.cd:8787）
 *   WX_BRIDGE_HOSTS    劫持域名（默认 account.xiaomi.com,api.vip.miui.com,*.exijiu.com,hd.opposhop.cn）
 *
 * 关键：必须在 https.request 入口拦截并改用 http.request（仅在 agent 层换 socket
 * 无法把已定型为 TLS 的请求降级，会报 EPROTO packet length too long）。
 */
if (global.__WX_BRIDGE_PATCHED__) {
  try { console.error('[wxbridge] already patched, skip'); } catch (e) {}
} else {
  global.__WX_BRIDGE_PATCHED__ = true;
  const http = require('http');
  const https = require('https');
  const { URL } = require('url');

  const GATEWAY = (process.env.WX_BRIDGE_GATEWAY || 'd4.dqf.cc.cd:8787');
  const [GW_HOST, GW_PORT_RAW] = GATEWAY.split(':');
  const GW_PORT = Number(GW_PORT_RAW || 8787);
  const TARGETS = new Set(
    (process.env.WX_BRIDGE_HOSTS || 'account.xiaomi.com,api.vip.miui.com,apimallwm.exijiu.com,fm.exijiu.com,xcx.exijiu.com,camparicrm.81680.cn,www.feihevip.com,mcsp.midea.com,littleswanmp.midea.com,app.niuyougu.com.cn,jiuyixiaoer.fzjingzhou.com,vip.foxech.com,tm-api.pin-dao.cn,tm-web.pin-dao.cn,www.rewards.mobil.com.cn,vip.qiaqiafood.com,qq-tasting-hall.qiaqiafood.com,hd.opposhop.cn,mpb.jingjiu.com')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  const hostOf = (o) => String((o && (o.hostname || o.host)) || '').split(':')[0].toLowerCase();

  // 把 https.request 的各种调用形态改写成 http.request 到网关
  const origHttpsRequest = https.request;
  https.request = function (input, options, callback) {
    try {
      let urlObj = null;
      let opts = options || {};
      if (typeof input === 'string' || input instanceof URL) {
        urlObj = new URL(input);
      } else if (input && typeof input === 'object') {
        opts = input;
      }
      const h = urlObj ? urlObj.hostname : hostOf(opts);
      if (h && TARGETS.has(h.toLowerCase())) {
        // 构造 http 选项（明文连网关，Host 头保留原域名，无端口后缀）
        const base = {
          method: opts.method || 'GET',
          hostname: GW_HOST,
          port: GW_PORT,
          path: urlObj ? (urlObj.pathname + urlObj.search) : (opts.path || '/'),
          headers: Object.assign({}, opts.headers || {}),
        };
        // 确保 Host = 原域名（不带 :443），网关据此分流
        base.headers.host = h;
        // 移动运营商 NAT/代理对 keep-alive 长连接上承载的明文 http POST 容易挂起，
        // 强制每条降级连接用完即关，规避手机侧加密写请求 30s 超时（GET/快速 POST 不受影响）。
        base.headers.connection = 'close';
        for (const k of ['auth','agent','createConnection','socketPath','timeout','localAddress']) {
          if (opts[k] !== undefined) base[k] = opts[k];
        }
        if (typeof opts.onSocket === 'function') {/* follow-redirects 用，忽略 */}
        // body 写入由调用方在返回的 req 上 write/end，http.ClientRequest 接口一致
        const cb = typeof options === 'function' ? options : (typeof callback === 'function' ? callback : null);
        const req2 = http.request(base, cb);
        return req2;
      }
    } catch (e) {
      try { console.error('[wxbridge] intercept fallback due to:', e.message); } catch (e2) {}
    }
    return origHttpsRequest.apply(this, arguments);
  };

  // follow-redirects 缓存的是 require('https').request 同源引用，故上面的替换对其生效。
  // 但 axios 的 follow-redirects 在加载时解构了 https 模块对象；再兜底 patch https.Agent，
  // 给非降级路径（不应命中）保险，不影响已拦截逻辑。
  try { console.error('[wxbridge] enabled -> http://' + GATEWAY + ' targets=' + [...TARGETS].join(',')); } catch (e) {}
}
