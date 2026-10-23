#!/usr/bin/env python3
"""Host worker bridging Qinglong requests to Katabump browser automation."""
import json
import os
import pathlib
import pwd
import subprocess
import time
import urllib.request

BASE = pathlib.Path("/opt/qinglong/data/config/katabump-renew")
REQ = BASE / "request"
RES = BASE / "result.json"
SCRIPT = "/opt/katabump-renew/katabump_auto.py"
PY = "/opt/woiden-renew/venv/bin/python"
BASE.mkdir(parents=True, exist_ok=True)


def cdp_ok():
    try:
        urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=3).read()
        return True
    except Exception:
        return False


def ensure_browser(wait=120):
    if cdp_ok():
        return True, "already-up"
    subprocess.run(["systemctl", "reset-failed", "woiden-browser.service"], capture_output=True)
    subprocess.run(["systemctl", "start", "woiden-browser.service"], capture_output=True)
    end = time.time() + wait
    while time.time() < end:
        if cdp_ok():
            return True, "restarted"
        time.sleep(3)
    return False, "not-ready"


def demote():
    u = pwd.getpwnam("ubuntu")
    os.setgroups([])
    os.setgid(u.pw_gid)
    os.setuid(u.pw_uid)


while True:
    if not REQ.exists():
        time.sleep(1)
        continue
    try:
        req = json.loads(REQ.read_text())
        nonce = str(req["nonce"])
    except Exception:
        REQ.unlink(missing_ok=True)
        continue
    REQ.unlink(missing_ok=True)
    browser_ok, browser_how = ensure_browser()
    if not browser_ok:
        out = {"status": "error", "error": "shared Chromium not ready", "browser": browser_how}
    else:
        try:
            r = subprocess.run(
                [PY, SCRIPT], capture_output=True, text=True, timeout=550,
                preexec_fn=demote,
                env={**os.environ, "HOME": "/home/ubuntu", "XDG_RUNTIME_DIR": "/run/user/1001"},
            )
            lines = [x for x in r.stdout.splitlines() if x.strip().startswith("{")]
            out = json.loads(lines[-1]) if lines else {"status": "error", "error": "missing JSON output"}
            out.update({"worker_rc": r.returncode, "browser": browser_how})
            if r.stderr.strip():
                out["stderr_tail"] = r.stderr.strip()[-1000:]
        except Exception as e:
            out = {"status": "error", "error": "%s: %s" % (type(e).__name__, e), "worker_rc": 31,
                   "browser": browser_how}
    out["nonce"] = nonce
    tmp = RES.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False) + "\n")
    os.chmod(tmp, 0o600)
    tmp.replace(RES)
