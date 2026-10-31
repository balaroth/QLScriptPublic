#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Woiden d11 auto-renew entry for Qinglong unified check-in runner (qlall).

Runs inside the qinglong-d3 container. Talks to the host worker through the
shared request/result files; never touches docker, CDP or the browser profile.
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import time

BASE = pathlib.Path("/ql/data/config/woiden-renew")
REQ = BASE / "request"
RES = BASE / "result.json"
LOCK = BASE / "request.lock"
NOTIFY_JS = "/ql/data/scripts/smallfawn_QLScriptPublic/tools/sendNotify.js"
WAIT_SECONDS = 540
LOCK_STALE_SECONDS = 1500

LABELS = {
    "renewed": "续期成功",
    "ok": "检查通过",
    "not_due": "未到续期窗口",
    "needs_login": "登录态失效，需人工登录",
    "needs_human_verification": "需人工完成验证",
    "needs_manual_renewal": "需人工完成续期",
    "failed": "续期失败",
    "uncertain": "结果不确定，请人工核对",
    "busy": "上一次任务仍在执行",
    "error": "执行异常",
}

# 哪些失败值得让 qlall 重跑一次。
#
# 2026-10-20 最初这里写的是 `set()`（一律不重试），理由是重试会重新走 stage1、
# 重新触发一次 Telegram 发码。但那条规则是从「PHPSESSID 失效变登录墙」这一种
# 情况推出来的 —— 登录态问题重试确实没用 —— 却被写成了全局规则。结果后面
# 失败类型早就变了（模型拒答、DOM 改版、渲染挂起），这些全是技术性瞬时故障，
# 重跑一次就能过，却因为 retryable=0 被 qlall 直接 break，一天只有一次机会。
#
# 现在按 stage 区分，只放行「重跑有意义」的两类：
#   recaptcha_v2  视觉模型判错 / 合成器挂起 / 配额抖动 —— 重跑大概率能过
#   telegram      没等到新码 —— 重新发码有机会
# 需要人工介入的一律不放行：login（要人重登）、stage1/stage2（数学验证码
# 读不出，重试只会再失败一次）。
RETRYABLE_STAGES = {"recaptcha_v2", "telegram"}

# 同一天最多执行 2 次（1 次正常 + 1 次重试）。按日期自动重置，避免某天连续
# 发码或连续刷 reCAPTCHA。qlall 侧 ATTEMPTS 是 3，这里收紧到 2。
MAX_ATTEMPTS_PER_DAY = 2


def log(msg):
    print("[woiden] %s" % msg, flush=True)


def notify(title, body):
    """Send mail through the shared Qinglong notifier, ignoring qlall suppression."""
    env = dict(os.environ)
    env.pop("QL_SUPPRESS_NOTIFY", None)
    env.pop("ONLY_ERROR_NOTIFY", None)
    code = (
        "const {sendNotify}=require(%r);"
        "sendNotify(%r,%r).then(()=>console.log('notify sent'))"
        ".catch(e=>console.error('notify err',e&&e.message||e))"
    ) % (NOTIFY_JS, title, body)
    try:
        r = subprocess.run(["node", "-e", code], env=env, timeout=120,
                           capture_output=True, text=True)
        tail = (r.stdout or "") + (r.stderr or "")
        log("notify rc=%s %s" % (r.returncode, tail.strip()[:200]))
    except Exception as e:
        log("notify exception: %s" % e)


ATTEMPT_FILE = BASE / "attempt.count"


def bump_attempt():
    """记录并返回「今天是第几次执行」，跨天自动重置。"""
    today = time.strftime("%Y-%m-%d")
    n = 0
    try:
        d, v = ATTEMPT_FILE.read_text().strip().split()
        if d == today:
            n = int(v)
    except Exception:
        pass
    n += 1
    try:
        ATTEMPT_FILE.write_text("%s %d" % (today, n))
        os.chmod(ATTEMPT_FILE, 0o666)
    except Exception:
        pass
    return n


def clear_attempt():
    """成功（含 not_due / ok）后清零，避免当天后续手动执行被次数上限挡住。"""
    try:
        ATTEMPT_FILE.unlink()
    except Exception:
        pass


def clean_stale_lock():
    try:
        if LOCK.exists():
            age = time.time() - LOCK.stat().st_mtime
            if age > LOCK_STALE_SECONDS:
                for p in sorted(LOCK.rglob("*"), reverse=True):
                    try:
                        p.rmdir()
                    except Exception:
                        pass
                try:
                    LOCK.rmdir()
                except Exception:
                    pass
                log("removed stale lock (age %.0fs)" % age)
    except Exception as e:
        log("lock cleanup failed: %s" % e)


def body_lines(r):
    keys = [
        ("vps_id", "VPS ID"),
        ("expiry_before", "原到期"),
        ("expiry_after", "新到期"),
        ("days_before", "续期前剩余天数"),
        ("days_after", "续期后剩余天数"),
        ("stage2_response", "服务端返回"),
        ("error", "错误"),
        ("response", "页面返回"),
        ("screenshot", "证据截图"),
    ]
    out = ["时间：%s" % r.get("at", "")]
    for k, label in keys:
        v = r.get(k)
        if v not in (None, "", []):
            out.append("%s：%s" % (label, v))
    return out


def main():
    mode = os.environ.get("WOIDEN_MODE") or "auto"
    args = sys.argv[1:]
    if "--mode" in args:
        mode = args[args.index("--mode") + 1]
    elif args and args[0] in ("check", "auto"):
        mode = args[0]

    BASE.mkdir(parents=True, exist_ok=True)
    clean_stale_lock()
    attempt = bump_attempt()
    log("attempt #%d today (max %d)" % (attempt, MAX_ATTEMPTS_PER_DAY))

    nonce = "%d-%d" % (int(time.time()), os.getpid())
    try:
        LOCK.mkdir()
    except FileExistsError:
        log("another run holds the lock, skip")
        notify("【Woiden d11】上一次任务仍在执行",
               "检测到 request.lock 仍被占用，本次跳过，未做任何提交。")
        print("[QLRUN_RESULT] FAILURE retryable=0 reason=lock-busy")
        return 1

    try:
        tmp = REQ.with_suffix(".tmp")
        tmp.write_text(json.dumps({"mode": mode, "nonce": nonce}) + "\n")
        os.chmod(tmp, 0o666)
        tmp.replace(REQ)
        log("request written: mode=%s nonce=%s" % (mode, nonce))

        end = time.time() + WAIT_SECONDS
        result = None
        while time.time() < end:
            if RES.exists():
                try:
                    data = json.loads(RES.read_text())
                except Exception:
                    data = None
                if data and str(data.get("nonce")) == nonce:
                    result = data
                    break
            time.sleep(3)

        if result is None:
            log("host worker timeout after %ds" % WAIT_SECONDS)
            notify("【Woiden d11】执行超时",
                   "等待宿主 worker 超过 %d 秒仍无结果，请检查 "
                   "woiden-renew-worker.service 与 /opt/woiden-renew/state。"
                   % WAIT_SECONDS)
            print("[QLRUN_RESULT] FAILURE retryable=1 reason=worker-timeout")
            return 1

        status = result.get("status", "error")
        label = LABELS.get(status, status)
        log("result status=%s" % status)
        lines = body_lines(result)
        detail = "\n".join(lines)

        if status == "renewed":
            clear_attempt()
            notify("【Woiden d11】续期成功", "自动续期已完成。\n" + detail)
            print("[QLRUN_RESULT] SUCCESS")
            return 0
        if status == "not_due":
            clear_attempt()
            notify("【Woiden d11】未到续期窗口", "本次仅检查，未提交续期。\n" + detail)
            print("[QLRUN_RESULT] SUCCESS")
            return 0
        if status == "ok":
            clear_attempt()
            notify("【Woiden d11】检查通过", "VPS 状态正常，本次未提交续期。\n" + detail)
            print("[QLRUN_RESULT] SUCCESS")
            return 0

        stage = result.get("stage") or ""
        can_retry = (status in ("needs_human_verification", "needs_manual_renewal")
                     and stage in RETRYABLE_STAGES
                     and attempt < MAX_ATTEMPTS_PER_DAY)
        retry = 1 if can_retry else 0
        log("stage=%s attempt=%d/%d retryable=%d" % (
            stage, attempt, MAX_ATTEMPTS_PER_DAY, retry))
        notify("【Woiden d11】%s" % label,
               "自动续期未完成，需要处理。\n状态：%s\n%s" % (status, detail))
        print("[QLRUN_RESULT] FAILURE retryable=%d reason=%s stage=%s attempt=%d/%d"
              % (retry, status, stage, attempt, MAX_ATTEMPTS_PER_DAY))
        return 1
    finally:
        try:
            LOCK.rmdir()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
