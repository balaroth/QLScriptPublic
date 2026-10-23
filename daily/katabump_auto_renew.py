#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Katabump renew entry for Qinglong qlall.

Runs inside qinglong-d3. It asks the host worker to operate the shared Chromium,
then sends an independent email even when qlall suppresses child notifications.
"""
import json
import os
import pathlib
import subprocess
import sys
import time

BASE = pathlib.Path("/ql/data/config/katabump-renew")
REQ = BASE / "request"
RES = BASE / "result.json"
LOCK = BASE / "request.lock"
NOTIFY_JS = "/ql/data/scripts/smallfawn_QLScriptPublic/tools/sendNotify.js"
WAIT_SECONDS = 570
LOCK_STALE_SECONDS = 1200

SUCCESS = {"renewed", "not_due"}
LABELS = {
    "renewed": "续期成功",
    "not_due": "暂未到续期时间",
    "needs_human_verification": "需要人工完成验证",
    "login_failed": "登录失败",
    "failed": "续期失败",
    "busy": "上一次任务仍在执行",
    "error": "执行异常",
}


def log(msg):
    print("[katabump] %s" % msg, flush=True)


def notify(title, body):
    env = dict(os.environ)
    env.pop("QL_SUPPRESS_NOTIFY", None)
    env.pop("ONLY_ERROR_NOTIFY", None)
    code = (
        "const {sendNotify}=require(%r);"
        "sendNotify(%r,%r).then(()=>console.log('notify sent'))"
        ".catch(e=>{console.error('notify err',e&&e.message||e);process.exitCode=1})"
    ) % (NOTIFY_JS, title, body)
    try:
        r = subprocess.run(["node", "-e", code], env=env, timeout=120,
                           capture_output=True, text=True)
        log("notify rc=%s %s" % (r.returncode, ((r.stdout or "") + (r.stderr or "")).strip()[:240]))
        return r.returncode == 0
    except Exception as e:
        log("notify exception: %s" % e)
        return False


def clean_stale_lock():
    try:
        if LOCK.exists() and time.time() - LOCK.stat().st_mtime > LOCK_STALE_SECONDS:
            LOCK.rmdir()
            log("removed stale lock")
    except Exception as e:
        log("stale lock cleanup failed: %s" % e)


def detail_lines(result):
    out = ["时间：%s" % result.get("at", "")]
    accounts = result.get("accounts") or []
    for idx, item in enumerate(accounts, 1):
        account = item.get("account") or ("账号%d" % idx)
        status = item.get("status", "unknown")
        line = "%s：%s" % (account, LABELS.get(status, status))
        if item.get("next_renewal"):
            line += "（下次可续期：%s）" % item["next_renewal"]
        if item.get("reason"):
            line += "；%s" % item["reason"]
        out.append(line)
    if result.get("error"):
        out.append("错误：%s" % result["error"])
    return "\n".join(out)


def main():
    BASE.mkdir(parents=True, exist_ok=True)
    clean_stale_lock()
    nonce = "%d-%d" % (int(time.time()), os.getpid())
    try:
        LOCK.mkdir()
    except FileExistsError:
        notify("【Katabump】上一次任务仍在执行", "request.lock 仍被占用，本次未重复触发。")
        print("[QLRUN_RESULT] FAILURE retryable=0 reason=lock-busy")
        return 1

    try:
        tmp = REQ.with_suffix(".tmp")
        tmp.write_text(json.dumps({"mode": "auto", "nonce": nonce}) + "\n")
        os.chmod(tmp, 0o666)
        tmp.replace(REQ)
        log("request written nonce=%s" % nonce)

        deadline = time.time() + WAIT_SECONDS
        result = None
        while time.time() < deadline:
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
            notify("【Katabump】执行超时", "等待宿主 worker 超过 %d 秒仍无结果。" % WAIT_SECONDS)
            print("[QLRUN_RESULT] FAILURE retryable=0 reason=worker-timeout")
            return 1

        status = result.get("status", "error")
        title = "【Katabump】%s" % LABELS.get(status, status)
        detail = detail_lines(result)
        notify(title, detail)
        log("result status=%s" % status)
        if status in SUCCESS:
            print("[QLRUN_RESULT] SUCCESS")
            return 0
        print("[QLRUN_RESULT] FAILURE retryable=0 reason=%s" % status)
        return 1
    finally:
        try:
            LOCK.rmdir()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
