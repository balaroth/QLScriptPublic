#!/usr/bin/env python3
"""
woiden_worker.py — Woiden 续期请求 worker（宿主侧，常驻，root）

【它做什么】
    青龙跑在 docker 容器里，容器进程无法直接操作宿主的浏览器，也没有权限
    启停宿主服务。所以两边用一个共享目录当信箱：
        容器 → 写 request（含 nonce）
        本脚本 → 轮询到 request，执行 woiden_auto.py，把结果写进 result.json（回同一 nonce）
        容器 → 轮询 result.json，认 nonce 匹配后取结果

    本脚本自己不做任何续期逻辑，只负责三件事：
        1. 保证常驻 Chromium 活着（不通就 systemctl start 并等它就绪）
        2. 以 ubuntu 身份调起 woiden_auto.py，超时 520 秒
        3. 把 stdout 最后一行 JSON 连同执行元信息写进 result.json

【为什么必须是 root】
    需要 systemctl 启停 woiden-browser.service。但真正跑浏览器动作的
    woiden_auto.py 必须降权到 ubuntu，因为 Chromium 的 profile 属于 ubuntu，
    root 直接连会读到错误的 profile 目录。

【为什么超时是 520 秒】
    整条链路的超时必须是递减的：
        qlall 600s > 青龙入口脚本 WAIT_SECONDS 540s > 本脚本 subprocess 520s
    这样脚本先超时、worker 还能正常写回 result.json，入口脚本才能拿到
    结构化结果去发邮件，而不是干等到自己超时后一无所知。

【文件协议】
    /opt/qinglong/data/config/woiden-renew/
        request      容器写入，本脚本消费后立刻删除
        result.json  本脚本原子写入（先写 .tmp 再 rename），权限 600
"""
import json
import os
import pathlib
import pwd
import subprocess
import time

# 共享信箱目录（容器内挂载为 /ql/data/config/woiden-renew）
BASE = pathlib.Path("/opt/qinglong/data/config/woiden-renew")
REQ = BASE / "request"
RES = BASE / "result.json"
SCRIPT = "/opt/woiden-renew/woiden_auto.py"
PY = "/opt/woiden-renew/venv/bin/python"  # playwright 装在这个 venv 里
BASE.mkdir(parents=True, exist_ok=True)


def _cdp_ok():
    """探一下 Chromium 的调试端口是否可用（能拿到 /json/version 就算就绪）。"""
    import urllib.request
    try:
        urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=3).read()
        return True
    except Exception:
        return False


def ensure_browser(wait=120):
    """
    确保常驻 Chromium 可用，返回 (是否就绪, 处置方式)。

    处置方式会写进 result.json 的 browser 字段，取值：
        already-up  本来就活着，没动
        restarted   探不到 → reset-failed + start 后拉起来了
        not-ready   等满 wait 秒仍未就绪（此时脚本大概率也会失败）

    为什么要 reset-failed：Chromium 反复崩溃时 systemd 会把它标成 failed 并
    放弃自动重启，单纯 start 会报 "start request repeated too quickly"，
    必须先清掉失败计数。这覆盖了「unit 被人手动 stop」和「进 failed」两种
    不会被 Restart=always 救回来的情况。
    """
    if _cdp_ok():
        return True, "already-up"
    subprocess.run(["systemctl", "reset-failed", "woiden-browser.service"], capture_output=True)
    subprocess.run(["systemctl", "start", "woiden-browser.service"], capture_output=True)
    end = time.time() + wait
    while time.time() < end:
        if _cdp_ok():
            return True, "restarted"
        time.sleep(3)
    return False, "not-ready"


while True:
    # 没有请求就空转等待，1 秒一轮，开销可以忽略
    if not REQ.exists():
        time.sleep(1)
        continue

    # 解析请求；坏文件直接丢掉，避免卡死在同一个畸形请求上
    try:
        req = json.loads(REQ.read_text())
        nonce = str(req["nonce"])
        mode = req.get("mode", "check")
    except Exception as e:
        REQ.unlink(missing_ok=True)
        continue
    # 先删除再执行：即使下面崩溃，也不会被同一个请求反复触发
    REQ.unlink(missing_ok=True)

    cmd = [PY, SCRIPT, "--mode", mode]

    def demote():
        """把子进程降权到 ubuntu，理由见文件头「为什么必须是 root」。"""
        u = pwd.getpwnam("ubuntu")
        os.setgroups([])
        os.setgid(u.pw_gid)
        os.setuid(u.pw_uid)

    bk_ok, bk_how = ensure_browser()
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=520,
            preexec_fn=demote,
            # HOME 和 XDG_RUNTIME_DIR 必须显式给：降权后 systemd 环境里的值
            # 还指向 root 的运行时目录，playwright 会连不上正确的 profile
            env={**os.environ, "HOME": "/home/ubuntu", "XDG_RUNTIME_DIR": "/run/user/1001"},
        )
        # 只取最后一行 JSON —— woiden_auto.py 的输出契约
        lines = [x for x in r.stdout.splitlines() if x.strip().startswith("{")]
        out = json.loads(lines[-1]) if lines else {"status": "error", "error": "missing JSON output"}
        out.update({"nonce": nonce, "worker_rc": r.returncode, "browser": bk_how})
        # 保留 stderr 尾部，脚本崩了的时候这是唯一的线索
        if r.stderr.strip():
            out["stderr_tail"] = r.stderr.strip()[-1000:]
    except Exception as e:
        # 包括 TimeoutExpired（子进程被 kill）和其它意外
        out = {"status": "error", "error": f"{type(e).__name__}: {e}",
               "nonce": nonce, "worker_rc": 31, "browser": bk_how}

    # 原子写：先写 .tmp 再 rename，避免容器读到写了一半的 JSON
    tmp = RES.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False) + "\n")
    os.chmod(tmp, 0o600)
    tmp.replace(RES)
