/*
 * qlall - 统一签到执行器（青龙面板可见、可手动执行、每天6点由总控任务调度）
 * 动态扫描 smallfawn_QLScriptPublic 下全部业务脚本（wxapp/daily/jd 顶层，自动包含未来新增），
 * 串行执行、失败自动重试共3次、抑制逐脚本邮件，全部结束后只发一封汇总邮件。
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DATA = process.env.QL_DATA_DIR || "/data/adb/qinglong-data";
const REPO = path.join(DATA, "scripts", "smallfawn_QLScriptPublic");
const STATE_DIR = path.join(DATA, ".qlrun");
const DB_PATH = path.join(DATA, "db", "database.sqlite");
const ATTEMPTS = 3;
const RETRY_GAP_MS = 20000;
const TIMEOUT_MS = 600000;

const NOISE = /spawnSync|node:internal|sitecustomize|\/bin\/bash|ENOENT|execSync|SMTP 发送|发送通知消息成功|run task before error|^\s*at |wxbridge|Center 通知|系统通知/;
const SUCC = /✅|🎉|签到成功|签到：?成功|今日已签|已签到|已经签到|今日已完成|登录成功|code 登录成功|获取用户Token成功|获取用户信息\[|领取成功|执行完成|任务执行完成|今日已签到|重复打卡|请勿重复|次数已达到上限|次数已达上限|签到状态 status=2| 1\/1 成功|N\/N 成功|===== .* 成功 =====|全部成功/;
const FAIL = /取不到|失效|实人|人机验证|安全验证|拦截|滑块|风控|断开|无响应|未完成|未配置|未拿到|未返回 code|未开就|无法|缺少|错误|超时|未查询|NO_TOKEN|NO_MOBILE|denied|expired|40001|40029|404001|⚠|❌|执行失败|登录失败|签到失败|请求失败|未登录|会话失效|登录失效|invalid session|Bad Auth|信息获取失败|未找到变量|未填写变量|选择账号|choose_account|MODULE_NOT_FOUND|Cannot find module|运行失败/;
const QLRUN_SUCCESS = /\[QLRUN_RESULT\]\s+SUCCESS(?:\s|$)/;
const QLRUN_FAILURE = /\[QLRUN_RESULT\]\s+FAILURE(?:\s|$)/;

// —— 修复版归因信号（2026-09-30 53项误判审计）——
// 设计原则：优先结构化结果；其次服务器“已签到/幂等终态”权威结论；
// 空跑(无账号/未配变量)与业务受限(活动结束/地理围栏/需广告)归 skip，既不算成功也不算失败；
// 凡未被上述“明确终态”命中的，一律回落严格失败判定，不放宽，绝不拿模糊成功词掩盖真实失败。
// 服务器已确认“今天签到动作已完成/无需再签”的幂等终态
const CORE_SIGNIN_OK = /今日已签到|已经签到|请勿重复打卡|重复打卡|已达最大参与次数|已达签到上限|次数已达到?上限|签到完成|签到[0-9]?成功|今日广告签到已完成|每日任务完成|领工作奖励[^\n]*完成|今日已抽奖/;
// 登录/账号在“发起签到之前”就已不可用（真失败，幂等成功不能覆盖）
const PRE_LOGIN_FAIL = /Bad Auth|AccessToken无效|accessToken is illegal|accessToken\s+illegal|未登录|需要登录|去登录|necessaryloginerror|NO_TOKEN|NO_MOBILE|invalid session|会话失效|登录失效|登录失败|未完成升级|未完成注册|用户不存在|信息获取失败|登录响应未返回\s*token|未返回\s*token/;
// 网络/依赖/服务端真故障
const INFRA_FAIL = /timeout of \d+\s*ms exceeded|HTTP\s*4\d\d|HTTP\s*5\d\d|HTTPError: Response code 4\d\d|WAF拦截|CERT_HAS_EXPIRED|MODULE_NOT_FOUND|Cannot find module|<title>40[0-9]<\/title>|<title>50[0-9]<\/title>/;
// 配置缺失：明确失败，但无需重试（重试无法补出账号或变量）
const CONFIG_FAIL = /共找到\s*0\s*个账号|未设置[^\n]*环境变量|未找到[^\n]*环境变量|未找到任何账号信息|未添加[^\n]*变量|变量值格式应为|未配置[^\n]*账号/;
// 服务端明确当前没有可执行签到或额度：脚本已正确完成检查，按成功处理
const NO_ACTION_OK = /当前无每日签到活动|活动已结束|活动未开启|未开启签到|未查询到每日额度|未找到签到\/每日任务/;
// 任务存在但自动化未完成：明确失败，且属于确定性限制，无需重试
const BLOCKED_FAIL = /任务需要跳转\/广告，跳过|运行态校验拦截|当前距离不在门店签到范围内|非会员跳过|会员级别不能签到|门店未开启签到/;
const NO_RETRY_FAILURE = /\[QLRUN_RESULT\]\s+FAILURE[^\n]*retryable=0|共找到\s*0\s*个账号|未设置[^\n]*环境变量|未找到[^\n]*环境变量|未找到任何账号信息|未添加[^\n]*变量|变量值格式应为|未配置[^\n]*账号|任务需要跳转\/广告，跳过|运行态校验拦截|当前距离不在门店签到范围内|非会员跳过|会员级别不能签到|门店未开启签到/;

function ts() { return new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }); }

// 业务脚本发现：递归收集可直接运行的入口脚本，排除库/备份/资源
function discover() {
    const out = [];
    const EXCLUDE_DIR = new Set(["node_modules", "tools", "backup", "function", "assets", "cache", ".git"]);
    const EXCLUDE_FILE = new Set(["sendNotify.js", "wcs.js", "env.js", "notify.py"]);
    (function walk(dir) {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (!EXCLUDE_DIR.has(ent.name)) walk(full);
            } else if (/\.(js|py)$/.test(ent.name) && !EXCLUDE_FILE.has(ent.name)) {
                out.push(full);
            }
        }
    })(REPO);
    // 排序：wxapp → daily → jd → 其它，再按文件名
    const rank = (p) => p.includes(`${path.sep}wxapp${path.sep}`) ? 0 : p.includes(`${path.sep}daily${path.sep}`) ? 1 : p.includes(`${path.sep}jd${path.sep}`) ? 2 : 3;
    return out.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function judge(text, exitCode = 0) {
    const clean = text.split("\n").filter((l) => !NOISE.test(l)).join("\n");
    // —— 优先级（高→低）——
    // 1) 结构化失败契约：脚本自报 FAILURE，任何成功词都不能覆盖
    if (QLRUN_FAILURE.test(clean)) return "fail";
    // 2) 非零退出 = 进程自报失败，恢复原 qlall “非零退出优先失败”口径
    if (exitCode !== 0) return "fail";
    // 3) 结构化成功契约：脚本自报 SUCCESS，优先于模糊文本失败词
    if (QLRUN_SUCCESS.test(clean)) return "ok";

    const configFail = CONFIG_FAIL.test(clean);
    const coreOk = CORE_SIGNIN_OK.test(clean);
    const noActionOk = NO_ACTION_OK.test(clean);
    const blockedFail = BLOCKED_FAIL.test(clean);
    const preLoginFail = PRE_LOGIN_FAIL.test(clean);
    const infraFail = INFRA_FAIL.test(clean);

    // 4) 硬故障优先：登录态在签到前已坏，或网络/依赖/服务端故障。
    if (preLoginFail || infraFail) return "fail";
    // 5) 配置缺失和明确阻断都属于失败；只是无需重复执行。
    if (configFail || blockedFail) return "fail";
    // 6) 权威幂等成功：服务端已确认今天签过/无需再签。
    if (coreOk) return "ok";
    // 7) 服务端明确没有当日可执行活动/额度，视为脚本正确完成检查。
    if (noActionOk) return "ok";
    // 8) 其余回落原有严格判定，不放宽
    if (FAIL.test(clean)) return "fail";
    if (SUCC.test(clean)) return "ok";
    return "fail";
}

function runOnce(rel, taskId) {
    return new Promise((resolve) => {
        // 走青龙原生 task，保留 env/sitecustomize/task_before 注入。
        // detached:true 让每个脚本成为独立新进程组，停止时可整组杀干净；
        // QL_SUPPRESS_NOTIFY=1 硬静默子任务一切通知（含失败邮件），汇总由本执行器单独发；
        // 注入 ID=<该脚本对应Crontab的id>，task.sh 才会把日志写到面板识别的 logName_id 目录。
        const childEnv = { ...process.env, ONLY_ERROR_NOTIFY: "true", QL_SUPPRESS_NOTIFY: "1", QL_ALL_RUN: "1" };
        // 定时触发 qlall 时，青龙会给父任务注入 no_tee/log_name 等日志控制变量。
        // 若原样继承，子 task 会把输出纯重定向到父任务日志目录，stdout 为空，最终全部 unknown→fail。
        // 子任务必须自行生成面板日志并同时通过 tee 回传 stdout；ID 仍保留用于关联对应 Crontab。
        for (const key of ["no_tee", "real_log_path", "log_name", "real_time"]) delete childEnv[key];
        if (taskId) childEnv.ID = String(taskId);
        const child = spawn("task", [rel], {
            cwd: path.join(DATA, "scripts"),
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
        });
        let buf = "";
        const append = (d) => { buf += d.toString(); if (buf.length > 200000) buf = buf.slice(-200000); };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const timer = setTimeout(() => { killCurrentGroup(true); }, TIMEOUT_MS);
        child.on("close", (code) => {
            clearTimeout(timer);
            if (currentChild === child) currentChild = null;
            resolve({ code, text: buf, verdict: judge(buf, code), child });
        });
        child.on("error", () => { clearTimeout(timer); if (currentChild === child) currentChild = null; resolve({ code: 1, text: buf, verdict: "fail", child }); });
        currentChild = child;
    });
}


// 自动纳新：为磁盘上存在、但 Crontabs 里没有对应任务的业务脚本，创建一条"手动执行"任务（@once 过去时间，永不自动触发）。
// 这样 QLScriptPublic 更新新增脚本后，下次 qlall 运行即自动出现在面板（手动），并被统一执行器覆盖。
function ensureCrontabs(rels) {
    try {
        const Sqlite3 = require("sqlite3");
        const Database = Sqlite3.Database || Sqlite3.verbose().Database;
        const db = new Database(DB_PATH);
        const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
        const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
        return (async () => {
            const rows = await q("SELECT id, command, isDisabled FROM Crontabs");
            const have = new Set();
            const disabled = new Set();
            const idMap = {};
            rows.forEach((r) => { const m = (r.command || "").match(/(smallfawn_QLScriptPublic\/\S+\.(?:js|py))/); if (m) { have.add(m[1]); if (r.isDisabled === 1) disabled.add(m[1]); else idMap[m[1]] = r.id; } });
            const iso = new Date().toISOString();
            let added = 0;
            for (const rel of rels) {
                if (have.has(rel)) continue;
                const base = path.basename(rel).replace(/\.(js|py)$/, "");
                // command 用 qlrun（手动点单个也走串行/重试包装）
                await run(
                    `INSERT INTO Crontabs (name,command,schedule,timestamp,saved,status,isSystem,pid,isDisabled,isPinned,log_path,labels,last_running_time,last_execution_time,sub_id,extra_schedules,task_before,task_after,log_name,allow_multiple_instances,createdAt,updatedAt)
                     VALUES (?,?,?,?,0,0,0,0,0,0,'',NULL,0,0,NULL,NULL,NULL,NULL,NULL,0,?,?)`,
                    [base, `qlrun ${rel}`, "@once 1577808000000", String(Date.now()), iso, iso]
                );
                added++;
                console.log(`[qlall] 自动纳新脚本，已建手动任务: ${rel}`);
            }
            db.close();
            if (added) console.log(`[qlall] 共自动纳新 ${added} 个新脚本（已置为手动执行）`);
            return { disabled, idMap };
        })().catch((e) => { console.log("[qlall] 自动纳新跳过(非致命):", e.message); return { disabled: new Set(), idMap: {} }; });
    } catch (e) {
        console.log("[qlall] 自动纳新不可用(非致命):", e.message);
    }
    return { disabled: new Set(), idMap: {} };
}

let currentChild = null;
let stopped = false;

// 自报面板状态：scheduled 触发链(shared/runCron)不会更新DB，统一执行器自行把任务置为 running/idle，
// 这样面板能正确显示“运行中”，且“停止”按钮可用（pid=本node进程，killTask 的 psTree 或兜底 SIGINT 都会命中本进程）。
function dbExec(sql, p = []) {
    return new Promise((resolve) => {
        try {
            const Sqlite3 = require("sqlite3");
            const Ctor = Sqlite3.Database || Sqlite3.verbose().Database;
            const db = new Ctor(DB_PATH);
            db.run(sql, p, function (e) { try { db.close(); } catch (_) {} resolve(e ? e.message : "ok"); });
        } catch (e) { resolve(e.message); }
    });
}
// 回写【单个子任务】运行状态/最后运行时间（毫秒），使面板每个脚本的“最后运行时间”和状态实时更新。
function dbExecId(sql, p = []) {
    return new Promise((resolve) => {
        try {
            const Sqlite3 = require("sqlite3");
            const Ctor = Sqlite3.Database || Sqlite3.verbose().Database;
            const db = new Ctor(DB_PATH);
            db.run(sql, p, function (e) { try { db.close(); } catch (_) {} resolve(e ? e.message : "ok"); });
        } catch (e) { resolve(e.message); }
    });
}
async function markSubState(taskId, state) {
    if (!taskId) return;
    const now = Math.floor(Date.now() / 1000); // 青龙这两列用秒级时间戳
    if (state === "running") {
        await dbExecId("UPDATE Crontabs SET status=0, pid=?, last_running_time=? WHERE id=?", [process.pid, now, taskId]);
    } else {
        // idle + 最后执行时间；pid 清空（子进程已结束）
        await dbExecId("UPDATE Crontabs SET status=1, pid=NULL, last_execution_time=? WHERE id=?", [now, taskId]);
    }
}
let MASTER_ID = 291;
async function detectMasterId() {
    try {
        const Sqlite3 = require("sqlite3");
        const Ctor = Sqlite3.Database || Sqlite3.verbose().Database;
        const db = new Ctor(DB_PATH);
        const rows = await new Promise((res, rej) => db.all("SELECT id FROM Crontabs WHERE command='qlall' AND isDisabled=0 LIMIT 1", (e, r) => (e ? rej(e) : res(r))));
        try { db.close(); } catch (_) {}
        if (rows && rows.length) MASTER_ID = rows[0].id;
    } catch (e) { /* 用默认 291 */ }
}
async function markRunning() { await dbExec("UPDATE Crontabs SET status=0, pid=? WHERE id=?", [process.pid, MASTER_ID]); }
async function markIdle() { await dbExec("UPDATE Crontabs SET status=1, pid=NULL WHERE id=?", [MASTER_ID]); }

// 读取某进程的 pgid（/proc/<pid>/stat 第5列）；读不到返回 null
// 读取 /proc/<pid>/stat 得到 {state,ppid,pgid}（comm 可能含括号/空格，按最后一个 ')' 切）
function procInfo(pid) {
    try {
        const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const a = st.slice(st.lastIndexOf(")") + 2).split(/\s+/);
        return { state: a[0], ppid: Number(a[1]), pgid: Number(a[2]) };
    } catch (_) { return null; }
}
// 递归收集某 pid 的所有后代 pid（Android toybox ps 无法给 psTree 可靠结果，直接读 /proc）
function descendantPids(rootPid) {
    const out = [];
    let ppidOf = null;
    try {
        ppidOf = {};
        for (const name of fs.readdirSync("/proc")) {
            if (!/^\d+$/.test(name)) continue;
            const inf = procInfo(Number(name));
            if (inf) ppidOf[Number(name)] = inf.ppid;
        }
    } catch (_) { return out; }
    const childrenOf = {};
    for (const [child, pp] of Object.entries(ppidOf)) {
        (childrenOf[pp] = childrenOf[pp] || []).push(Number(child));
    }
    const stack = [rootPid];
    while (stack.length) {
        const cur = stack.pop();
        for (const ch of childrenOf[cur] || []) { out.push(ch); stack.push(ch); }
    }
    return out;
}
// 杀掉当前脚本整棵子树。cross-spawn 在 Android 下 child.pid 是 sh 包装层，真正的 task.sh/bash/node 在其后代里，
// 故按 /proc 的 PPID 关系递归收集后代，逐个 TERM 再 KILL；同时兜底按 child 的 pgid 整组杀。
function killCurrentGroup(hard = false) {
    const ch = currentChild;
    if (!ch || ch.killed) return false;
    const pids = descendantPids(ch.pid);
    const all = [ch.pid, ...pids];
    const inf = procInfo(ch.pid);
    const sig = hard ? "SIGKILL" : "SIGTERM";
    all.forEach((p) => { try { process.kill(p, sig); } catch (_) {} });
    if (inf && inf.pgid > 1) { try { process.kill(-inf.pgid, sig); } catch (_) {} }
    if (!hard) setTimeout(() => {
        const pids2 = descendantPids(ch.pid);
        [ch.pid, ...pids2].forEach((p) => { try { process.kill(p, "SIGKILL"); } catch (_) {} });
        try { ch.kill("SIGKILL"); } catch (_) {}
    }, 1200);
    return true;
}
function installSignalHandlers() {
    const onStop = async (sig) => {
        if (stopped) return;
        stopped = true;
        console.log(`[qlall] 收到 ${sig}，正在停止当前脚本及整个执行器...`);
        killCurrentGroup();
        await markIdle();
        setTimeout(() => process.exit(130), 1800);
    };
    process.on("SIGINT", () => onStop("SIGINT"));
    process.on("SIGTERM", () => onStop("SIGTERM"));
    process.on("SIGHUP", () => onStop("SIGHUP"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTML 转义
function esc(t) {
    return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// 取一份可读的完整日志：去噪声行、限长
function cleanFullLog(text, maxLen = 8000) {
    const lines = String(text || "").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => !NOISE.test(l));
    let out = lines.join("\n").trim();
    if (out.length > maxLen) out = out.slice(0, maxLen) + "\n……（日志过长，已截断，完整日志见青龙面板该任务日志）";
    return out || "(无输出)";
}

async function sendSummary(report, totalMs) {
    // 复用脚本自己的 sendNotify（会读取 SMTP_* 环境变量，由青龙 env 注入）；本进程不带 QL_SUPPRESS_NOTIFY，汇总照发
    try {
        const tools = path.join(REPO, "tools", "sendNotify.js");
        const { sendNotify } = require(tools);
        const okN = report.filter((r) => r.verdict === "ok").length;
        const failed = report.filter((r) => r.verdict === "fail");
        const failN = failed.length;
        const unkN = report.filter((r) => r.wasUnknown).length;
        const mins = Math.round(totalMs / 60000);
        let desp = `<p>统一签到执行完成（北京时间 ${ts()}，耗时约 ${mins} 分钟）</p>`;
        desp += `<p>共 <b>${report.length}</b> 个脚本：<span style="color:green">成功 ${okN}</span> ｜ <span style="color:red">失败 ${failN}</span>`;
        if (unkN) desp += `（其中 <b>${unkN}</b> 个无明确成功结论，已按失败计）`;
        desp += `</p>`;
        if (failN) {
            desp += `<h3 style="color:red">失败/未成功明细（${failN}）</h3>`;
            // 概览表
            desp += `<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-size:13px">`;
            desp += `<tr><th>脚本</th><th>尝试</th><th>判定</th><th>关键信息</th></tr>`;
            for (const r of failed) {
                const key = (r.lastText || "").split("\n").map((x) => x.trim()).filter(Boolean)
                    .filter((x) => FAIL.test(x)).slice(-2).join(" / ").slice(0, 200);
                const tag = r.wasUnknown ? "未判定→失败" : "失败";
                desp += `<tr><td>${esc(r.name)}</td><td>${r.attempts}</td><td>${tag}</td><td>${esc(key || "(无明确成功/失败结论，见下方完整日志)")}</td></tr>`;
            }
            desp += `</table>`;
            // 每条附完整日志（折叠）
            desp += `<h4>完整日志（点击展开）</h4>`;
            for (const r of failed) {
                desp += `<details style="margin:6px 0;border:1px solid #ddd;border-radius:4px;padding:6px"><summary style="cursor:pointer;font-weight:600">${esc(r.name)}（${r.wasUnknown ? "未判定" : "失败"}，尝试 ${r.attempts} 次）</summary>`;
                desp += `<pre style="white-space:pre-wrap;word-break:break-all;font-size:12px;background:#f7f7f7;padding:8px;border-radius:4px;max-height:480px;overflow:auto">${esc(cleanFullLog(r.lastText))}</pre></details>`;
            }
        }
        desp += `<hr><div style="color:#888;font-size:12px">本邮件由统一签到执行器 qlall 在全部脚本执行完成后汇总发送，单个脚本不再单独发信；无明确成功结论的任务已统一按失败统计并附完整日志。</div>`;
        await sendNotify(`【青龙签到汇总】成功${okN} 失败${failN} 共${report.length}`, desp, {});
        console.log("[qlall] 汇总邮件已发送");
    } catch (e) {
        console.log("[qlall] 汇总邮件发送失败:", e.message);
    }
}

(async () => {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    installSignalHandlers();
    await detectMasterId();
    await markRunning();
    // 外层 task.sh/api.sh 启动时会用它自身 pid 更新本任务造成覆盖，运行期间每 3s 用本 node pid 回写，
    // 保证面板“停止”始终把信号发到真正能处理的 qlall node 进程。
    const pidKeepAlive = setInterval(() => { if (!stopped) markRunning(); }, 3000);
    let files = discover();
    let rels = files.map((f) => path.relative(path.join(DATA, "scripts"), f));
    // 运维/测试开关：QL_FILTER 仅保留文件名包含该串的脚本；QL_LIMIT 只取前 N 个；QL_NO_MAIL 跳过发信
    if (process.env.QL_FILTER) { const k = process.env.QL_FILTER; rels = rels.filter((r) => r.includes(k)); }
    const LIMIT = parseInt(process.env.QL_LIMIT || "0", 10);
    // 自动纳新应针对"全量发现"的脚本（在 LIMIT/测试裁剪之前）；同时取回用户在面板【禁用】的脚本集合
    const reconcile = await ensureCrontabs(rels);
    const disabledSet = reconcile.disabled || new Set();
    const idMap = reconcile.idMap || {};
    const beforeFilter = rels.length;
    rels = rels.filter((r) => !disabledSet.has(r));
    const skippedDisabled = beforeFilter - rels.length;
    if (skippedDisabled) console.log(`[qlall] 按面板禁用状态跳过 ${skippedDisabled} 个已禁用脚本`);
    if (LIMIT > 0) rels = rels.slice(0, LIMIT);
    console.log(`[qlall] ${ts()} 发现 ${rels.length} 个业务脚本，开始串行执行（每个最多 ${ATTEMPTS} 次，全程静默，仅存在最终失败时发送一封报告）`);
    const report = [];
    const start = Date.now();
    for (let i = 0; i < rels.length; i++) {
        if (stopped) { console.log("[qlall] 已被停止，放弃剩余脚本"); break; }
        const rel = rels[i];
        const name = path.basename(rel);
        const taskId = idMap[rel];
        let result = null, attempts = 0;
        await markSubState(taskId, "running");
        for (let a = 1; a <= ATTEMPTS; a++) {
            attempts = a;
            console.log(`[qlall] (${i + 1}/${rels.length}) 第${a}次 ${name}`);
            result = await runOnce(rel, taskId);
            // 成功立即结束；确定性配置/平台限制失败也无需重复执行。
            if (result.verdict === "ok" || (result.verdict === "fail" && NO_RETRY_FAILURE.test(result.text || ""))) break;
            if (a < ATTEMPTS) await sleep(RETRY_GAP_MS);
        }
        // 无明确成功结论（unknown）按失败口径；最终只保留成功/失败两类。
        const wasUnknown = result.verdict === "unknown";
        if (wasUnknown) result.verdict = "fail";
        await markSubState(taskId, "idle");
        const r = { name, rel, verdict: result.verdict, attempts, lastText: result.text, wasUnknown };
        report.push(r);
        console.log(`[qlall] ${name} => ${r.verdict}（尝试 ${attempts} 次）`);
    }
    const okN = report.filter((r) => r.verdict === "ok").length;
    const failN = report.filter((r) => r.verdict === "fail").length;
    fs.writeFileSync(path.join(STATE_DIR, "last-summary.json"), JSON.stringify({ time: ts(), total: report.length, ok: okN, fail: failN, report }, null, 1));
    console.log(`[qlall] 全部完成：成功 ${okN} / 失败 ${failN}，共 ${report.length}`);
    if (!stopped && failN > 0 && process.env.QL_NO_MAIL !== '1') {
        await sendSummary(report, Date.now() - start);
    } else if (stopped) {
        console.log('[qlall] 已停止，不发送失败报告');
    } else if (process.env.QL_NO_MAIL === '1') {
        console.log('[qlall] QL_NO_MAIL=1 跳过失败报告');
    } else {
        console.log('[qlall] 全部业务成功，按失败专报策略不发送邮件');
    }
    await markIdle();
    // 退出码：有失败=1（便于面板状态识别），全成功=0
    process.exit(failN > 0 ? 1 : 0);
})();
