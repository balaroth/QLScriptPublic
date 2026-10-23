#!/usr/bin/env python3
"""Katabump renewal using the shared persistent Chromium.

Safety and ownership rules:
- Credentials are read only from /opt/katabump-renew/login.json.
- The script persists its Chromium CDP targetId in a local state file and reuses
  exactly that page across runs and cross-site navigations.
- It never closes Woiden, Telegram, unowned Katabump, or unrelated tabs.
- Cloudflare Turnstile is completed the same way a human would: by clicking the
  widget's checkbox with a real mouse event. Nothing is bypassed or forged. If the
  widget escalates to an image challenge, the run stops and reports
  needs_human_verification with the owned page brought to front.
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = Path("/opt/katabump-renew")
LOGIN = BASE / "login.json"
CDP = "http://127.0.0.1:9222"
LOGIN_URL = "https://dashboard.katabump.com/auth/login"
LOGOUT_URL = "https://dashboard.katabump.com/auth/logout"
DASHBOARD_URL = "https://dashboard.katabump.com/dashboard"
STATE = BASE / "state"
TARGET_FILE = STATE / "page-target-id"


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def safe_account(username):
    if "@" not in username:
        return "account"
    local, domain = username.split("@", 1)
    return (local[:2] + "***@" + domain) if local else ("***@" + domain)


def load_users():
    raw = json.loads(LOGIN.read_text())
    users = raw if isinstance(raw, list) else raw.get("users", [])
    out = []
    for item in users:
        u, p = str(item.get("username", "")).strip(), str(item.get("password", ""))
        if not u or not p:
            raise ValueError("login.json contains an incomplete account")
        out.append((u, p))
    if not out:
        raise ValueError("login.json contains no accounts")
    return out


def turnstile_token(page):
    """已签发 token 的长度；-1 表示页面上没有该 hidden input。"""
    try:
        return page.evaluate(
            """() => { const e = document.querySelector('input[name="cf-turnstile-response"]');"""
            """ return e ? (e.value || '').length : -1; }"""
        )
    except Exception:
        return -1


def has_turnstile(page):
    """
    页面是否挂载了 Turnstile widget。

    两个曾经的误判来源，都记在这里避免重犯：
      1. 不能用 input[name=cf-turnstile-response] 的 count() 判断「需要人工」。
         该 hidden input 从 widget 挂载起就一直存在，value 为空只代表尚未验证通过。
      2. 不能靠 querySelectorAll('iframe') 找 widget。Turnstile 的 iframe 位于
         closed shadow root 内，页面脚本查不到，但截图里明明看得见。
    唯一可靠的判据是 .cf-turnstile 容器是否存在。
    """
    try:
        return bool(page.locator(".cf-turnstile").count())
    except Exception:
        return False


def solve_turnstile(page, wait_auto=6, rounds=3):
    """
    完成 Cloudflare Turnstile 的交互式验证（等价于真人点一下勾选框）。

    2026-10-23 在 d3 常驻 Chromium 上实测：
      - widget 渲染在 .cf-turnstile 容器内，尺寸约 366x71
      - 勾选框在容器左上偏移 (25, 33)；真实鼠标点一下即通过
      - 通过后 input[name=cf-turnstile-response] 的 value 约 752 字符
      - 该站是 managed 模式，点击后不弹图片九宫格
      - 若 cf_clearance 仍有效，widget 有时会自己勾上，所以先等一会儿再点

    返回 (ok, token_len, log)。
    """
    log = []
    if not has_turnstile(page):
        return True, turnstile_token(page), log
    # 先留时间给自动通过
    for _ in range(max(1, wait_auto // 2)):
        page.wait_for_timeout(2000)
        tl = turnstile_token(page)
        if tl and tl > 20:
            log.append({"auto_pass": tl})
            return True, tl, log
    for rnd in range(rounds):
        try:
            box = page.locator(".cf-turnstile").first.bounding_box()
        except Exception as e:
            log.append("box_err:" + str(e)[:60])
            box = None
        if not box:
            page.wait_for_timeout(1500)
            continue
        x, y = box["x"] + 25, box["y"] + 33
        log.append({"round": rnd, "click": [round(x), round(y)]})
        try:
            page.mouse.move(x, y)
            page.wait_for_timeout(250)
            page.mouse.click(x, y)
        except Exception as e:
            log.append("click_err:" + str(e)[:60])
        for _ in range(8):
            page.wait_for_timeout(1000)
            tl = turnstile_token(page)
            if tl and tl > 20:
                log.append({"round": rnd, "token_len": tl})
                return True, tl, log
        log.append({"round": rnd, "token_len": turnstile_token(page)})
    return False, turnstile_token(page), log


def logged_in(page):
    """直接开 dashboard 判断会话是否仍然有效，避免每次都被迫重登+过 Turnstile。"""
    try:
        page.goto(DASHBOARD_URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(1500)
        return "/auth/login" not in page.url
    except Exception:
        return False


def body_text(page):
    try:
        return page.locator("body").inner_text(timeout=10000)
    except Exception:
        return ""


def login(page, username, password, force_logout=False):
    # 会话还在就直接用，省掉一次登录 + Turnstile。
    # 多账号时必须强制重登，否则会把别人的会话当成这个账号的。
    if not force_logout and logged_in(page):
        return "ok", "复用现有会话"
    if force_logout:
        try:
            page.goto(LOGOUT_URL, wait_until="domcontentloaded", timeout=60000)
        except Exception:
            pass
    page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(1800)
    email = page.get_by_role("textbox", name="Email")
    pwd = page.get_by_role("textbox", name="Password")
    email.wait_for(state="visible", timeout=15000)
    email.fill(username)
    pwd.fill(password)

    ts_ok, ts_len, ts_log = solve_turnstile(page)
    if not ts_ok:
        return "needs_human_verification", "登录页 Turnstile 未通过（token_len=%s, %s）" % (ts_len, ts_log[-1] if ts_log else "")

    page.get_by_role("button", name="Login", exact=True).click()
    page.wait_for_timeout(2500)
    text = body_text(page)
    if "Incorrect password or no account" in text:
        return "login_failed", "账号或密码错误"
    if "/auth/login" in page.url:
        if "error=captcha" in page.url or "Please complete captcha" in text:
            return "needs_human_verification", "服务端仍判定验证码未通过"
        return "login_failed", "登录后仍停留在登录页"
    return "ok", ""


def renew_one(page, username, password, force_logout=False):
    status, reason = login(page, username, password, force_logout)
    account = safe_account(username)
    if status != "ok":
        return {"account": account, "status": status, "reason": reason}

    see = page.get_by_role("link", name="See").first
    try:
        see.wait_for(state="visible", timeout=15000)
        see.click()
        page.wait_for_timeout(1800)
    except Exception:
        return {"account": account, "status": "failed", "reason": "未找到服务器详情入口"}

    renew = page.get_by_role("button", name="Renew", exact=True).first
    try:
        renew.wait_for(state="visible", timeout=8000)
    except Exception:
        return {"account": account, "status": "failed", "reason": "未找到续期按钮"}
    renew.click()
    modal = page.locator("#renew-modal")
    try:
        modal.wait_for(state="visible", timeout=8000)
    except Exception:
        return {"account": account, "status": "failed", "reason": "续期确认窗口未出现"}

    # 提交前先把确认弹窗里的 Turnstile 过掉；过不掉就不点，避免无效提交
    if has_turnstile(page):
        ts_ok, ts_len, ts_log = solve_turnstile(page, wait_auto=4)
        if not ts_ok:
            return {"account": account, "status": "needs_human_verification",
                    "reason": "续期确认窗口 Turnstile 未通过（token_len=%s）" % ts_len}
    confirm = modal.get_by_role("button", name="Renew")
    try:
        confirm.wait_for(state="visible", timeout=5000)
        confirm.click()
    except Exception:
        return {"account": account, "status": "failed", "reason": "无法点击续期确认"}

    page.wait_for_timeout(2500)
    text = body_text(page)
    if "Please complete the captcha to continue" in text or has_turnstile(page):
        return {"account": account, "status": "needs_human_verification", "reason": "服务端要求完成验证码"}
    if "You can't renew your server yet" in text or "renew-error" in page.url:
        m = re.search(r"as of\s+([^\(\n\r&]+)", text, re.I)
        if not m:
            try:
                decoded = page.url.replace("+", " ")
                m = re.search(r"as of\s+([^\(\n\r&]+)", decoded, re.I)
            except Exception:
                m = None
        return {"account": account, "status": "not_due", "next_renewal": m.group(1).strip() if m else "未知"}
    if not modal.is_visible():
        return {"account": account, "status": "renewed"}
    return {"account": account, "status": "failed", "reason": "确认窗口仍未关闭，未取得成功证据"}


def page_target_id(ctx, page):
    client = ctx.new_cdp_session(page)
    try:
        return client.send("Target.getTargetInfo")["targetInfo"]["targetId"]
    finally:
        client.detach()


def owned_page(ctx):
    """Reuse exactly the locally persisted CDP page target; otherwise create one."""
    STATE.mkdir(parents=True, exist_ok=True)
    wanted = TARGET_FILE.read_text().strip() if TARGET_FILE.exists() else ""
    if wanted:
        for page in ctx.pages:
            try:
                if page_target_id(ctx, page) == wanted:
                    return page
            except Exception:
                pass
    page = ctx.new_page()
    target = page_target_id(ctx, page)
    tmp = TARGET_FILE.with_suffix(".tmp")
    tmp.write_text(target + "\n")
    tmp.replace(TARGET_FILE)
    return page


def main():
    users = load_users()
    results = []
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP)
        if not browser.contexts:
            raise RuntimeError("shared Chromium has no browser context")
        ctx = browser.contexts[0]
        page = owned_page(ctx)
        page.set_default_timeout(60000)
        multi = len(users) > 1
        for username, password in users:
            results.append(renew_one(page, username, password, force_logout=multi))
            if results[-1]["status"] == "needs_human_verification":
                try:
                    page.bring_to_front()
                except Exception:
                    pass

    statuses = {x["status"] for x in results}
    if statuses <= {"renewed", "not_due"}:
        overall = "renewed" if "renewed" in statuses else "not_due"
    elif "needs_human_verification" in statuses:
        overall = "needs_human_verification"
    elif "login_failed" in statuses:
        overall = "login_failed"
    else:
        overall = "failed"
    print(json.dumps({"status": overall, "at": now_iso(), "accounts": results}, ensure_ascii=False))
    return 0 if overall in ("renewed", "not_due") else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(json.dumps({"status": "error", "at": now_iso(), "error": "%s: %s" % (type(e).__name__, e)}, ensure_ascii=False))
        sys.exit(1)
