#!/usr/bin/env python3
"""Katabump renewal using the shared persistent Chromium.

Safety and ownership rules:
- Credentials are read only from /opt/katabump-renew/login.json.
- Every run creates dedicated pages and closes exactly those pages in finally.
- Existing Woiden, Telegram, Katabump, or unrelated tabs are never closed.
- Cloudflare Turnstile is never bypassed. If verification is required, the run
  stops before submission and reports needs_human_verification.
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


def has_turnstile(page):
    try:
        if page.locator("iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile']").count():
            return True
        return bool(page.locator("input[name='cf-turnstile-response']").count())
    except Exception:
        return False


def body_text(page):
    try:
        return page.locator("body").inner_text(timeout=10000)
    except Exception:
        return ""


def login(page, username, password):
    page.goto(LOGOUT_URL, wait_until="domcontentloaded", timeout=60000)
    page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(1800)
    email = page.get_by_role("textbox", name="Email")
    pwd = page.get_by_role("textbox", name="Password")
    email.wait_for(state="visible", timeout=15000)
    email.fill(username)
    pwd.fill(password)
    if has_turnstile(page):
        return "needs_human_verification", "登录页要求 Cloudflare Turnstile"
    page.get_by_role("button", name="Login", exact=True).click()
    page.wait_for_timeout(2500)
    text = body_text(page)
    if "Incorrect password or no account" in text:
        return "login_failed", "账号或密码错误"
    if "/auth/login" in page.url:
        if has_turnstile(page) or "captcha" in text.lower():
            return "needs_human_verification", "登录提交后要求验证码"
        return "login_failed", "登录后仍停留在登录页"
    return "ok", ""


def renew_one(page, username, password):
    status, reason = login(page, username, password)
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

    # Check verification before the irreversible submit click.
    if has_turnstile(page):
        return {"account": account, "status": "needs_human_verification", "reason": "续期确认需要 Turnstile"}
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


def main():
    users = load_users()
    owned_pages = []
    results = []
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP)
        if not browser.contexts:
            raise RuntimeError("shared Chromium has no browser context")
        ctx = browser.contexts[0]
        try:
            for username, password in users:
                page = ctx.new_page()
                owned_pages.append(page)
                page.set_default_timeout(60000)
                results.append(renew_one(page, username, password))
        finally:
            # Ownership-based cleanup: close only pages created by this run.
            for page in reversed(owned_pages):
                try:
                    page.close()
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
