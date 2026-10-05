/*
君品荟 - 登录、签到、查询、酒谷之旅农场
cron: 45 8 * * *

变量名：junpinhui
变量值：wx_server 中保存的 openid/账号标识，多账号用 & 或换行分隔
      也支持 openid#token 或仅 token
依赖变量：wx_server_url、wx_auth

------------------------------------------
现行协议（2026-10-05按生产日志重新核验）：
  ① 君品荟现行真实身份是 wx8d41cdc44c8aeaab，App-Version=1.7。
  ② d4 gateway 是 garden 会话的唯一所有者：用君品荟 code 完成 silentLogin +
     saveSessionKey，并用缓存 X-Access-Token 转发业务请求。
  ③ 本脚本不得再执行旧的 wx489 两段式登录。旧协议虽然被 gateway 合成兼容响应，
     但会额外获取两个无用 code；读接口遇到401时再次旧登录还会与 gateway 的现行刷新
     抢占同一 redroid 队列，造成 20/30 秒超时和“授权已过期”复发。
  ④ encryptData 仍由脚本按需从 /wx/encryptkey 获取，但直接使用君品荟 appid；
     encrypt_key(24字符)和iv(16字符)按utf-8字节使用 AES-192-CBC/PKCS7，输出hex。
  ⑤ gateway 未就绪时返回“会话预热中”，脚本只对幂等GET有界等待；POST不自动重放，
     避免签到、分享或农场写操作重复提交。
滑块验证(5008)按规则不绕。
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("君品荟");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const ckName = "junpinhui";
const MINI_APP_ID = "wx8d41cdc44c8aeaab";
const APP_VERSION = "1.7";
const GARDEN_BASE = "https://apimallwm.exijiu.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "junpinhui_token_cache.json");

// 现行协议只使用君品荟真实 appid；garden 的 token/sessionKey 由 d4 gateway 单飞维护。
// 脚本只通过同一 appid 获取 encryptKey，避免旧 wx489 code 与现行会话刷新抢占 redroid。
const wechat = new WeChatServer({
  url: process.env.wx_server_url || "http://192.168.31.196:8787",
  appid: MINI_APP_ID,
  auth: process.env.wx_auth || "your-api-key",
});

function readCache() {
  try {
    if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {
    $.log(`token缓存写入失败: ${e.message || e}`);
  }
}

function md5(text) {
  return crypto.createHash("md5").update(String(text)).digest("hex");
}

function mask(value = "") {
  value = String(value);
  if (!value) return "";
  if (value.length <= 12) return `${value.slice(0, 3)}***`;
  return `${value.slice(0, 6)}***${value.slice(-6)}`;
}

function parseAccount(raw) {
  const text = String(raw || "").trim();
  if (!text) return { openid: "", token: "" };

  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      return {
        openid: data.openid || data.openId || data.account || "",
        token: data.token || data.accessToken || "",
      };
    } catch {}
  }

  for (const sep of ["#", "|"]) {
    if (text.includes(sep)) {
      const [openid, ...rest] = text.split(sep);
      return { openid: openid.trim(), token: rest.join(sep).trim() };
    }
  }

  if (text.length > 40 && !text.startsWith("o")) return { openid: "", token: text };
  return { openid: text, token: "" };
}

function headers(token = "") {
  return {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 MicroMessenger MiniProgramEnv/Windows",
    Referer: `https://servicewechat.com/${MINI_APP_ID}/215/page-frame.html`,
    AppID: MINI_APP_ID,
    "App-Version": APP_VERSION,
    Authorization: `Basic ${Buffer.from("wechat:wechat_secret").toString("base64")}`,
    ...(token ? { "X-Access-Token": token } : {}),
  };
}

/**
 * 业务请求头只表达现行君品荟协议。X-Access-Token 与 sessionKey 由 gateway 注入，
 * 客户端不持有第二套 garden token，确保只有一个会话所有者。
 */
function gardenHeaders() {
  return {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 MicroMessenger MiniProgramEnv/Windows",
    Referer: `https://servicewechat.com/${MINI_APP_ID}/215/page-frame.html`,
    AppID: MINI_APP_ID,
    "App-Version": APP_VERSION,
    Authorization: `Basic ${Buffer.from("wechat:wechat_secret").toString("base64")}`,
  };
}

function shortJson(value, limit = 180) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function okCode(res) {
  return String(res?.code) === "10000" || res?.success === true || Number(res?.err) === 0;
}

function assertOk(res, action) {
  if (!res || !okCode(res)) {
    throw new Error(`${action}失败: ${res?.message || res?.msg || res?.errMsg || shortJson(res, 500)}`);
  }
  return res.data;
}

async function request(method, base, urlPath, { token = "", data = null, params = null, hdrs = null } = {}) {
  const maxAttempts = String(method).toLowerCase() === "get" ? 2 : 1;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await axios({
        method,
        url: `${base}${urlPath}`,
        data,
        params,
        timeout: 20000,
        validateStatus: () => true,
        headers: hdrs || headers(token),
      });
      return res.data;
    } catch (e) {
      lastError = e;
      if (attempt >= maxAttempts || !/timeout|ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(String(e.code || "") + " " + String(e.message || e))) break;
      $.log(`${method.toUpperCase()} ${urlPath} 瞬时网络异常，1.5秒后重试(${attempt}/${maxAttempts - 1}): ${e.code || e.message || e}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw new Error(`${method.toUpperCase()} ${urlPath} 网络异常: ${lastError?.code || lastError?.message || lastError}`);
}

function aesCbcPkcs7Hex(text, key, iv) {
  const keyBuf = Buffer.from(String(key), "utf8");
  const ivBuf = Buffer.from(String(iv), "utf8");
  const algo = { 16: "aes-128-cbc", 24: "aes-192-cbc", 32: "aes-256-cbc" }[keyBuf.length];
  if (!algo) throw new Error(`encrypt_key长度异常: ${keyBuf.length}`);
  if (ivBuf.length !== 16) throw new Error(`iv长度异常: ${ivBuf.length}`);
  const cipher = crypto.createCipheriv(algo, keyBuf, ivBuf);
  return cipher.update(text, "utf8", "hex") + cipher.final("hex");
}

function listify(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["list", "data", "records", "items", "rows"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function pickId(item = {}) {
  for (const key of ["id", "sorghum_id", "sorghumId", "member_sorghum_id", "memberSorghumId", "land_id", "landId"]) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== "") return item[key];
  }
  return "";
}

function landNo(item = {}) {
  return item.serial_number ?? item.serialNumber ?? pickId(item) ?? "?";
}

function landStatus(item = {}) {
  const value = Number(item.status ?? -1);
  return Number.isFinite(value) ? value : -1;
}

function isPlantable(item = {}) {
  return pickId(item) && landStatus(item) === 0;
}

function isGrowing(item = {}) {
  const status = landStatus(item);
  return pickId(item) && status > 0 && ![10, 11].includes(status);
}

function isHarvestable(item = {}) {
  return pickId(item) && [10, 11].includes(landStatus(item));
}

function isCompleted(task = {}) {
  return Number(task.is_complete ?? task.isComplete ?? task.complete ?? task.status_complete ?? 0) === 1;
}

class Task {
  constructor(raw) {
    this.index = $.userIdx++;
    const account = parseAccount(raw);
    this.openid = account.openid;
    this.token = account.token || "";
    this.member = {};
    this.encryptKeyCache = null;
    this.cacheKey = this.openid || (this.token ? md5(this.token).slice(0, 16) : `account_${this.index}`);
  }

  getCached() {
    return readCache()[this.cacheKey] || {};
  }

  saveCache(extra = {}) {
    const cache = readCache();
    cache[this.cacheKey] = {
      ...(cache[this.cacheKey] || {}),
      openid: this.openid || this.getCached().openid || "",
      ...(this.token ? { token: this.token } : {}),
      ...extra,
      updatedAt: new Date().toISOString(),
    };
    writeCache(cache);
  }

  async gardenGet(urlPath, params = {}) {
    // gateway 冷会话未就绪时返回明确预热状态。GET 幂等，可在有界窗口内轮询；
    // 不自行取 code/重登，避免与 gateway 的单飞会话刷新争抢 redroid。
    const warmupDelays = [1500, 2500, 4000, 6000, 8000];
    for (let attempt = 0; attempt <= warmupDelays.length; attempt++) {
      const res = await request("get", GARDEN_BASE, urlPath, { hdrs: gardenHeaders(), params });
      const msg = `${res?.message || ""}${res?.msg || ""}`;
      const warming = /会话预热中|请\s*\d+\s*秒后重试/.test(msg) || Number(res?.err || res?.code) === 503;
      if (okCode(res) || !warming || attempt >= warmupDelays.length) return assertOk(res, urlPath);
      const delay = warmupDelays[attempt];
      $.log(`账号[${this.index}] ${urlPath} 会话预热中，${(delay / 1000).toFixed(1)}秒后重试(${attempt + 1}/${warmupDelays.length})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  async gardenPost(urlPath, data = {}) {
    // 写接口不做网络层自动重放，避免签到/分享/农场动作重复提交。
    const res = await request("post", GARDEN_BASE, urlPath, { hdrs: gardenHeaders(), data });
    return assertOk(res, urlPath);
  }

  /**
   * encryptData 使用现行君品荟 runtime 的用户密钥。collector 仍兼容旧 wx489 入参，
   * 但新脚本直接传真实 appid，避免身份映射继续扩散。
   */
  async getEncryptKey(force = false) {
    if (!this.openid) throw new Error("缺少 openid，无法生成 encryptData");
    if (!force && this.encryptKeyCache) return this.encryptKeyCache;
    let response;
    try {
      response = await axios.post(
        `${wechat.serverUrl}/wx/encryptkey`,
        { appid: MINI_APP_ID, openid: this.openid, ...(force ? { force: true } : {}) },
        {
          headers: { auth: wechat.auth },
          timeout: 85000,
          validateStatus: () => true,
        }
      );
    } catch (e) {
      throw new Error(`/wx/encryptkey 网络异常: ${e.code || e.message || e}`);
    }
    const data = response.data;
    if (!data?.status) throw new Error(data?.message || "wx_server 获取 encryptkey 失败");
    const info = data.data || {};
    const encryptKey = info.encryptKey || info.encrypt_key;
    const iv = info.iv;
    const version = info.version;
    if (!encryptKey || !iv || version === undefined) {
      throw new Error(`wx_server encryptkey 缺少必要字段: ${JSON.stringify(data)}`);
    }
    this.encryptKeyCache = { encryptKey, iv, version };
    $.log(`账号[${this.index}] encryptkey ${force ? "强刷" : "获取"}成功并在本轮复用(version=${version}, source=${data.source || "unknown"})`);
    return this.encryptKeyCache;
  }

  async encryptData(data = {}, forceKey = false) {
    const payload = data && typeof data === "object" ? { ...data } : {};
    const key = await this.getEncryptKey(forceKey);
    payload.ts = Date.now();
    payload.encryptData = aesCbcPkcs7Hex(JSON.stringify(payload), key.encryptKey, key.iv);
    payload.version = key.version;
    return payload;
  }

  async encryptedPost(urlPath, data = {}) {
    return this.withEncryptHint(urlPath, async (forceKey) => this.gardenPost(urlPath, await this.encryptData(data, forceKey)));
  }

  async encryptedGet(urlPath, data = {}) {
    return this.withEncryptHint(urlPath, async (forceKey) => this.gardenGet(urlPath, await this.encryptData(data, forceKey)));
  }

  /**
   * 加密写接口被拒时，强刷现行君品荟 runtime 的 encryptKey 并仅重试一次。
   * garden 会话刷新由 gateway 独占处理，脚本不再自行登录或切换 token。
   */
  async withEncryptHint(urlPath, fn) {
    try {
      return await fn(false);
    } catch (e) {
      const msg = String(e.message || e);
      if (/用户信息异常|请从小程序重新进入|请删除小程序/.test(msg)) {
        this.encryptKeyCache = null;
        $.log(`账号[${this.index}] ${urlPath} 加密校验被拒，强刷 encryptkey 后仅重试该接口一次`);
        try {
          return await fn(true);
        } catch (retryError) {
          throw new Error(`${retryError.message || retryError} ← encryptData 校验失败：已强刷 ${MINI_APP_ID}(君品荟) 密钥并重试`);
        }
      }
      if (/滑块|5008/.test(msg)) {
        throw new Error(`${msg} ← 触发滑块验证，按规则不绕，请在小程序里手动过一次`);
      }
      throw e;
    }
  }

  async queryMember() {
    const info = await this.gardenGet("/garden/Gardenmemberinfo/getMemberInfo");
    this.member = info || {};
    this.saveCache({
      memberId: info?.member_id || "",
      nickName: info?.nick_name || "",
      integration: info?.integration || "",
    });
    $.log(
      `账号[${this.index}] 会员: ${info?.nick_name || mask(info?.member_id || "")}，积分${info?.integration ?? "未知"}，水滴${info?.water ?? 0}，有机肥${info?.manure ?? 0}，种子${info?.sorghum ?? 0}`
    );
    return info || {};
  }

  async dailySign() {
    try {
      const data = await this.encryptedPost("/garden/sign/dailySign");
      $.log(`账号[${this.index}] 签到成功: ${shortJson(data || "ok")}`);
      return true;
    } catch (e) {
      $.log(`账号[${this.index}] 签到失败: ${e.message || e}`);
      const m = String(e.message || e);
      // dailySign encryptData 校验被拒：withEncryptHint 内已强刷君品荟密钥并重试过一次仍失败，
      // 属上游 garden 签名校验问题，同轮立即重试无意义 → 结构化 FAILURE retryable=0，避免 qlall 3 次空跑。
      if (/用户信息异常|encryptData 校验失败|请删除小程序|请从小程序重新进入/.test(m)) {
        $.log(`[QLRUN_RESULT] FAILURE reason=junpinhui_encryptdata_rejected retryable=0`);
      }
      return false;
    }
  }

  async queryFarm() {
    const data = await this.gardenGet("/garden/sorghum/index");
    const lands = listify(data);
    const summary = lands
      .map((v) => `#${v.serial_number ?? v.id ?? "?"}:${v.status ?? "?"}`)
      .join(" ");
    $.log(`账号[${this.index}] 地块: ${lands.length || 0}块 ${summary}`.trim());
    return lands;
  }

  landPayload(land) {
    const id = pickId(land);
    return {
      id,
      sorghum_id: id,
      member_sorghum_id: id,
      land_id: id,
    };
  }

  async harvestFarm(lands) {
    const candidates = lands.filter(isHarvestable);
    if (!candidates.length) return false;

    let acted = false;
    try {
      const data = await this.encryptedGet("/garden/Sorghum/harvestAll");
      $.log(`账号[${this.index}] 一键收获成功: ${shortJson(data || "ok")}`);
      return true;
    } catch (e) {
      $.log(`账号[${this.index}] 一键收获失败，尝试单块收获: ${e.message || e}`);
    }

    for (const land of candidates) {
      try {
        const data = await this.encryptedPost("/garden/sorghum/harvest", this.landPayload(land));
        $.log(`账号[${this.index}] 收获成功: 地块${landNo(land)} ${shortJson(data || "ok")}`);
        acted = true;
      } catch (e) {
        $.log(`账号[${this.index}] 收获失败[${landNo(land)}]: ${e.message || e}`);
      }
      await $.wait(500, 1200);
    }
    return acted;
  }

  async seedFarm(lands) {
    const seedCount = Number(this.member.sorghum || 0);
    if (seedCount <= 0) {
      $.log(`账号[${this.index}] 无可用种子，跳过种植`);
      return false;
    }
    const candidates = lands.filter(isPlantable);
    if (!candidates.length) {
      $.log(`账号[${this.index}] 未识别到可种植地块`);
      return false;
    }
    let acted = false;
    const limit = Math.min(seedCount, candidates.length);
    for (let i = 0; i < limit; i++) {
      const land = candidates[i];
      try {
        const data = await this.encryptedPost("/garden/sorghum/seed", this.landPayload(land));
        $.log(`账号[${this.index}] 种植成功: 地块${landNo(land)} ${shortJson(data || "ok")}`);
        acted = true;
      } catch (e) {
        $.log(`账号[${this.index}] 种植失败[${landNo(land)}]: ${e.message || e}`);
      }
      await $.wait(500, 1200);
    }
    return acted;
  }

  async waterFarm(lands) {
    const waterCount = Number(this.member.water || 0);
    if (waterCount <= 0) {
      $.log(`账号[${this.index}] 无可用水滴，跳过浇水`);
      return false;
    }
    const candidates = lands.filter(isGrowing);
    if (!candidates.length) {
      $.log(`账号[${this.index}] 未识别到可浇水地块`);
      return false;
    }
    let acted = false;
    const limit = Math.min(waterCount, candidates.length);
    for (let i = 0; i < limit; i++) {
      const land = candidates[i];
      try {
        const data = await this.encryptedPost("/garden/sorghum/watering", this.landPayload(land));
        $.log(`账号[${this.index}] 浇水成功: 地块${landNo(land)} ${shortJson(data || "ok")}`);
        acted = true;
      } catch (e) {
        $.log(`账号[${this.index}] 浇水失败[${landNo(land)}]: ${e.message || e}`);
      }
      await $.wait(500, 1200);
    }
    return acted;
  }

  async manureFarm(lands) {
    const manureCount = Number(this.member.manure || 0);
    if (manureCount <= 0) {
      $.log(`账号[${this.index}] 无可用有机肥，跳过施肥/养护`);
      return false;
    }
    const candidates = lands.filter(isGrowing);
    if (!candidates.length) {
      $.log(`账号[${this.index}] 未识别到可施肥/养护地块`);
      return false;
    }
    let acted = false;
    const limit = Math.min(manureCount, candidates.length);
    for (let i = 0; i < limit; i++) {
      const land = candidates[i];
      try {
        const data = await this.encryptedPost("/garden/sorghum/manuring", this.landPayload(land));
        $.log(`账号[${this.index}] 施肥/养护成功: 地块${landNo(land)} ${shortJson(data || "ok")}`);
        acted = true;
      } catch (e) {
        $.log(`账号[${this.index}] 施肥/养护失败[${landNo(land)}]: ${e.message || e}`);
      }
      await $.wait(500, 1200);
    }
    return acted;
  }

  async runFarmAutomation() {
    const maxRounds = Number(process.env.junpinhui_farm_rounds || 5);
    let anyAction = false;
    for (let round = 1; round <= maxRounds; round++) {
      $.log(`账号[${this.index}] 农场自动化第${round}轮`);
      await this.queryMember();
      let lands = await this.queryFarm();

      const harvested = await this.harvestFarm(lands);
      if (harvested) {
        anyAction = true;
        await this.queryMember();
        lands = await this.queryFarm();
      }

      const seeded = await this.seedFarm(lands);
      if (seeded) {
        anyAction = true;
        await this.queryMember();
        lands = await this.queryFarm();
      }

      const watered = await this.waterFarm(lands);
      if (watered) {
        anyAction = true;
        await this.queryMember();
        lands = await this.queryFarm();
      }

      const manured = await this.manureFarm(lands);
      if (manured) {
        anyAction = true;
        await this.queryMember();
        await this.queryFarm();
      }

      if (!harvested && !seeded && !watered && !manured) break;
      await $.wait(800, 1600);
    }
    if (!anyAction) $.log(`账号[${this.index}] 农场暂无可执行动作`);
    return anyAction;
  }

  async queryTasks() {
    const data = await this.gardenGet("/garden/tasks/index");
    const tasks = listify(data);
    if (!tasks.length) {
      $.log(`账号[${this.index}] 未查询到任务列表`);
      return [];
    }
    $.log(
      `账号[${this.index}] 任务: ${tasks
        .map((t) => `${t.name || t.code || t.id}:${isCompleted(t) ? "已完成" : "未完成"}`)
        .join("，")}`
    );
    return tasks;
  }

  async doShareTask() {
    try {
      const data = await this.encryptedPost("/garden/gardenmemberinfo/dailyShare");
      $.log(`账号[${this.index}] 分享任务完成: ${shortJson(data || "ok")}`);
    } catch (e) {
      $.log(`账号[${this.index}] 分享任务失败: ${e.message || e}`);
    }
  }

  async doQuestionTask() {
    try {
      const questions = listify(await this.gardenGet("/garden/Gardenquestiontask/index"));
      if (!questions.length) {
        $.log(`账号[${this.index}] 每日一答无题目`);
        return;
      }
      for (const q of questions) {
        const id = q.id;
        const answer = q.answer;
        if (!id || !answer) continue;
        const data = await this.encryptedGet("/garden/Gardenquestiontask/answerResultsJph", {
          question_id: id,
          answer,
        });
        $.log(`账号[${this.index}] 每日一答完成: ${q.title ? shortJson(q.title, 45) : id} => ${shortJson(data || "ok")}`);
        await $.wait(500, 1200);
      }
    } catch (e) {
      $.log(`账号[${this.index}] 每日一答失败: ${e.message || e}`);
    }
  }

  async doRealityTask() {
    try {
      const data = await this.gardenGet("/garden/realscene/reward");
      $.log(`账号[${this.index}] 实景相册任务: ${shortJson(data || "ok")}`);
    } catch (e) {
      $.log(`账号[${this.index}] 实景相册任务失败: ${e.message || e}`);
    }
  }

  async doCompleteInfoTask() {
    try {
      const data = await this.gardenGet("/garden/tasks/checkCompleteMemberInfo");
      $.log(`账号[${this.index}] 完善信息任务: ${shortJson(data || "ok")}`);
    } catch (e) {
      $.log(`账号[${this.index}] 完善信息任务失败: ${e.message || e}`);
    }
  }

  async doSubscribePrize() {
    try {
      const data = await this.gardenGet("/garden/tasks/getSubscribePrize");
      $.log(`账号[${this.index}] 订阅奖励: ${shortJson(data || "ok")}`);
    } catch (e) {
      $.log(`账号[${this.index}] 订阅奖励失败: ${e.message || e}`);
    }
  }

  async doTasks(tasks) {
    const pending = tasks.filter((task) => !isCompleted(task));
    if (!pending.length) {
      $.log(`账号[${this.index}] 暂无未完成任务`);
      return;
    }
    for (const task of pending) {
      const code = task.code || "";
      if (code === "answer_survey") await this.doQuestionTask();
      else if (code === "garden_share") await this.doShareTask();
      else if (code === "view_organic_sorghum") await this.doRealityTask();
      else if (code === "complete_member_info") await this.doCompleteInfoTask();
      else if (/subscribe/i.test(code)) await this.doSubscribePrize();
      else $.log(`账号[${this.index}] 未适配任务: ${task.name || code || task.id}`);
      await $.wait(500, 1200);
    }
  }

  async run() {
    $.log(`\n账号[${this.index}] ${mask(this.openid || this.cacheKey)}`);
    // 核心顺序不可交换：先完成可能唤起/切换小程序runtime的 encryptKey 获取，
    // 再由会员GET让 gateway 建立与当前runtime一致的最终会话，最后才执行签到。
    await this.getEncryptKey(false);
    await this.queryMember();
    if (!(await this.dailySign())) throw new Error("核心签到失败");

    try {
      const tasks = await this.queryTasks();
      await this.doTasks(tasks);
    } catch (e) {
      $.log(`账号[${this.index}] 附属任务告警: ${e.message || e}`);
    }

    try {
      await this.runFarmAutomation();
    } catch (e) {
      $.log(`账号[${this.index}] 农场附属动作告警: ${e.message || e}`);
    }

    try {
      await this.queryMember();
      await this.queryFarm();
    } catch (e) {
      $.log(`账号[${this.index}] 末尾状态复查告警（不影响已完成签到）: ${e.message || e}`);
    }
    return true;
  }
}

!(async () => {
  $.checkEnv(ckName);
  if (!$.userCount) {
    $.log("[QLRUN_RESULT] FAILURE reason=no-account");
    return;
  }
  let coreSuccess = 0;
  let coreFailure = 0;
  for (const account of $.userList) {
    try {
      await new Task(account).run();
      coreSuccess++;
    } catch (e) {
      coreFailure++;
      $.log(`账号核心执行失败: ${e.message || e}`);
    }
  }
  if (coreFailure === 0 && coreSuccess === $.userCount) {
    $.log(`[QLRUN_RESULT] SUCCESS core=${coreSuccess}/${$.userCount}`);
  } else {
    $.log(`[QLRUN_RESULT] FAILURE core=${coreSuccess}/${$.userCount} failed=${coreFailure}`);
  }
})()
  .catch((e) => $.log(`[QLRUN_RESULT] FAILURE reason=script-exception detail=${e.message || e}`))
  .finally(() => $.done && $.done());
