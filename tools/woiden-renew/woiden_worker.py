#!/usr/bin/env python3
"""
woiden_worker.py — Woiden 续期请求 worker（宿主侧，常驻，root）

【它做什么】
    青龙跑在 docker 容器里，容器进程无法直接操作宿主的浏览器，也没有权限
    启停宿主服务。所以两边用一个共享目录当信箱：
        容器 → 写 request（含 nonce）
        本脚本 → 轮询到 request，执行 woiden_auto.py，把结果写进 result.json（回同一 nonce）
        容器 → 轮询 result.json，认 nonce 匹配后取结果

    本脚本自己不做任何续期逻辑，只负责四件事：
        1. 降权预检：确认 ubuntu 身份能读到续期脚本要用的密钥
        2. 保证常驻 Chromium 活着（不通就 systemctl start 并等它就绪）
        3. 以 ubuntu 身份调起 woiden_auto.py，超时 520 秒
        4. 把 stdout 最后一行 JSON 连同执行元信息写进 result.json

【为什么必须是 root】
    需要 systemctl 启停 woiden-browser.service。但真正跑浏览器动作的
    woiden_auto.py 必须降权到 ubuntu，因为 Chromium 的 profile 属于 ubuntu，
    root 直接连会读到错误的 profile 目录。

【为什么超时是 520 秒】
    整条链路的超时必须是递减的：
        qlall 600s > 青龙入口脚本 WAIT_SECONDS 540s > 本脚本 subprocess 520s
    这样脚本先超时、worker 还能正常写回 result.json，入口脚本才能拿到
    结构化结果去发邮件，而不是干等到自己超时后一无所知。

【为什么要做降权预检】（2026-11-02 加）
    11-01 新建的视觉 key 以 root:root 600 落盘，而子进程降权到 ubuntu，
    read_text() 直接 EACCES。整轮以 stage=crash 结束、retryable=0，
    当天唯一一次额度就这么浪费掉，直到早上才发现 VPS 只剩 0.96 天。
    现在把「密钥可读」提前到浏览器启动之前验证，失败直接返回
    stage=config 并附上 chown 命令，不浪费配额、不用读 traceback 才能定位。

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


def write_result(out):
    """原子写：先写 .tmp 再 rename，避免容器读到写了一半的 JSON。"""
    tmp = RES.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False) + "\n")
    os.chmod(tmp, 0o600)
    tmp.replace(RES)


# 预检跑在降权后的子进程里，所以必须是一段独立代码，不能直接复用本文件的常量。
# 只依赖标准库，避免预检本身因为缺包而失败。
PREFLIGHT_CODE = r'''
import json
import os
import pathlib

base = pathlib.Path("/opt/woiden-renew")
secrets = base / "secrets"
key = pathlib.Path(os.environ.get("WOIDEN_VISION_KEY") or (secrets / "eta_vision.key"))
problems = []


def check(p, what):
    try:
        text = p.read_text().strip()
    except Exception as e:
        problems.append({"path": str(p), "what": what,
                         "error": "%s: %s" % (type(e).__name__, e)})
        return
    if len(text) < 8:
        problems.append({"path": str(p), "what": what,
                         "error": "内容只有 %d 字符，疑似未写入" % len(text)})


check(key, "vision key")
for name in ("chatgpt2api.key",):
    p = secrets / name
    if p.exists():
        check(p, name)

print(json.dumps({"ok": not problems, "uid": os.getuid(), "key": str(key),
                  "secrets_dir": str(secrets), "problems": problems},
                 ensure_ascii=False))
'''


def preflight(demote, env, timeout=30):
    """
    用和真正子进程完全相同的降权方式验证关键文件可读。

    返回 dict（含 ok / problems）；预检自身出错时返回 None，
    此时不阻塞主流程 —— 预检是保险，不该成为新的故障点。
    """
    try:
        r = subprocess.run([PY, "-c", PREFLIGHT_CODE], capture_output=True,
                           text=True, timeout=timeout, preexec_fn=demote, env=env)
    except Exception:
        return None
    lines = [x for x in r.stdout.splitlines() if x.strip().startswith("{")]
    if not lines:
        return None
    try:
        return json.loads(lines[-1])
    except Exception:
        return None


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

    # HOME 和 XDG_RUNTIME_DIR 必须显式给：降权后 systemd 环境里的值还指向
    # root 的运行时目录，playwright 会连不上正确的 profile
    run_env = {**os.environ, "HOME": "/home/ubuntu", "XDG_RUNTIME_DIR": "/run/user/1001"}

    # 降权预检：在碰浏览器之前就确认密钥可读，失败不消耗当天额度
    pf = preflight(demote, run_env)
    if pf is not None and not pf.get("ok"):
        detail = "；".join(
            "%s（%s）→ %s" % (p.get("path"), p.get("what", ""), p.get("error"))
            for p in pf.get("problems", []))
        sdir = pf.get("secrets_dir") or "/opt/woiden-renew/secrets"
        write_result({
            "status": "error",
            "stage": "config",
            "error": ("降权到 ubuntu 后关键文件不可读：%s。修复："
                      "sudo chown ubuntu:ubuntu %s/*.key && sudo chmod 600 %s/*.key"
                      % (detail, sdir, sdir)),
            "nonce": nonce,
            "worker_rc": 32,
            "browser": "skipped",
        })
        continue

    bk_ok, bk_how = ensure_browser()
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=520,
            preexec_fn=demote,
            env=run_env,
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

    write_result(out)
