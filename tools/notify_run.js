/*
 * notify_run.js —— 透明通知包装器（前后置通知层）
 * ------------------------------------------------------------------
 * 用途：为无法安全修改主体的混淆业务脚本提供「前后置通知层」。
 *
 * 边界（重要）：
 *  1) 本层不修改、不感知业务脚本主体；业务逻辑原样放在 <name>.core.cjs。
 *  2) 只负责：用当前 node(process.execPath) 拉起 core → 透传 stdout/stderr 到青龙日志 →
 *     捕获退出码与日志尾部 → 汇总后调用统一 tools/sendNotify.js 发一封摘要 → 按 core 原退出码退出。
 *  3) 业务结论与退出码严格透传：core 退出码是什么，本层就 exit 什么。
 *  4) 通知失败一律 try/catch 隔离，绝不改变业务结论或退出码。
 *  5) 子进程注入 QL_SUPPRESS_NOTIFY=1，抑制 core 自身的冗余邮件（Standalone 时由本层统一发一封；
 *     qlall 下本层自身也被 QL_SUPPRESS_NOTIFY=1 静默，汇总仍由 qlall 发送，不会重复）。
 *  6) NOTIFY_SELFTEST=1：只发测试邮件、不拉起 core（安全自测入口，严禁真实领取/签到）。
 */
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_TAIL_CHARS = 6000; // 摘要里保留的业务日志尾部长度

// 解析如何用 node 拉起业务脚本（core）。
// - Mac/标准 Linux：process.execPath 就是 node ELF，直接 [execPath, core]。
// - 青龙 Android root 模块：bin/node 是 sh 包装，它 exec `ld-linux --library-path <libdir> node.real "$@"`。
//   此时 process.execPath 只剩 ld-linux；直接 spawn(execPath,[core]) 会把 core 当共享库加载而 exit 127。
//   故当 execPath 像动态链接器(ld-*)时，按该模块标准布局重建启动参数；QL_NODE_BIN 可显式覆盖。
function nodeLaunch(script) {
    const exe = process.execPath;
    if (path.basename(exe).startsWith("ld-")) {
        const libdir = path.dirname(exe);
        const realnode = process.env.QL_NODE_BIN || path.join(libdir, "..", "bin", "node.real");
        return { cmd: exe, args: ["--library-path", libdir, realnode, script] };
    }
    return { cmd: exe, args: [script] };
}

function loadUnifiedNotifier() {
    // 与本文件同目录的统一通知器 tools/sendNotify.js
    return require(path.join(__dirname, "sendNotify.js"));
}

// 通知发送：任何异常都吞掉并打印非敏感诊断，绝不外抛影响业务退出码
// 通知所有权显式规则：批量入口(qlall)为本进程注入 QL_SUPPRESS_NOTIFY=1 时，
// 本子脚本不得单发，最终汇总由 qlall 独占。该判断在本层显式完成，
// 不依赖 sendNotify.js 内部是否实现静默（避免"变量存在即生效"的误判）。
async function sendSafe(title, desp) {
    if (process.env.QL_SUPPRESS_NOTIFY === "1" || process.env.QL_SUPPRESS_NOTIFY === "true") {
        console.log("[notify] 批量子任务，通知所有权归 qlall，本层跳过单发: " + title);
        return;
    }
    try {
        const { sendNotify } = loadUnifiedNotifier();
        await sendNotify(title, desp);
    } catch (e) {
        console.log("[notify] 包装器通知发送异常，已隔离（不影响业务退出码）: " +
            ((e && e.message) ? e.message : e));
    }
}

function nowStr() {
    try {
        return new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
    } catch (_) {
        return new Date().toISOString();
    }
}

async function selfTest(title) {
    await sendSafe(
        `【${title}】通知自测`,
        `这是一条来自透明通知包装器的自测邮件（NOTIFY_SELFTEST=1），未拉起任何业务脚本、不含业务结果。时间：${nowStr()}`
    );
}

function runBusinessScript(opts) {
    const core = opts && opts.core;
    const title = (opts && opts.title) || "未命名任务";
    if (!core) {
        console.log("[notify] 包装器配置错误：缺少 core 路径");
        process.exit(2);
    }

    return (async () => {
        // 安全自测入口：只发测试邮件，绝不运行业务
        if (process.env.NOTIFY_SELFTEST === "1" || process.env.NOTIFY_SELFTEST === "true") {
            await selfTest(title);
            process.exit(0);
        }

        const started = Date.now();

        // 子进程环境：继承全部 env，但硬静默 core 自身通知（避免与本层汇总邮件重复）；
        // 去掉自测开关，保证 core 行为与直接运行一致。
        const childEnv = { ...process.env, QL_SUPPRESS_NOTIFY: "1" };
        delete childEnv.NOTIFY_SELFTEST;

        const nl = nodeLaunch(core);
        const child = spawn(nl.cmd, nl.args, {
            cwd: process.cwd(),
            env: childEnv,
            stdio: ["inherit", "pipe", "pipe"],
        });

        let out = "";
        const append = (d) => {
            const s = d.toString();
            process.stdout.write(s); // 原样透传到青龙日志
            out += s;
            if (out.length > MAX_TAIL_CHARS * 4) out = out.slice(-MAX_TAIL_CHARS * 2);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);

        const code = await new Promise((resolve) => {
            child.on("error", (e) => {
                console.log("[notify] 包装器拉起业务进程失败: " + ((e && e.message) ? e.message : e));
                resolve(1);
            });
            child.on("close", (c) => resolve(c == null ? 0 : c));
        });

        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const tail = out.length > MAX_TAIL_CHARS ? out.slice(-MAX_TAIL_CHARS) : out;
        const ok = code === 0;
        const status = ok ? "成功" : "失败";
        const desp =
            `脚本：${title}\n` +
            `退出码：${code}（${status}）｜耗时 ${secs}s\n` +
            `---- 业务日志尾部（含逐账号结果）----\n${tail}`;

        await sendSafe(`【${title}】${status}摘要`, desp);

        // 严格透传业务退出码
        process.exit(code);
    })();
}

module.exports = { runBusinessScript };
