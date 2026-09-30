/*
 * 透明通知包装器：原业务主体字节未改，见 jd_fruit_new.core.cjs。
 * 本层只做通知编排：拉起 core → 透传日志 → 汇总退出码/逐账号日志 → 调用统一 tools/sendNotify.js 发摘要 → 按 core 退出码退出。
 * 不改业务协议/接口/参数/动作；退出码与直接运行 core 一致。详见 tools/notify_run.js 顶部边界说明。
 */
const path = require("node:path");
require(path.join(__dirname, "..", "tools", "notify_run.js")).runBusinessScript({
    core: path.join(__dirname, "jd_fruit_new.core.cjs"),
    title: "新农场任务"
});
