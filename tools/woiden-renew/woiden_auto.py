#!/usr/bin/env python3
"""
woiden_auto.py — Woiden 免费 VPS 全自动续期执行器（宿主侧）

【运行位置】
    d3 宿主操作系统层，以 ubuntu 身份执行，由 woiden_worker.py 通过 subprocess 调起。
    一次运行完成一轮「检查」或「续期」，跑完即退出，不常驻。

【为什么必须跑在宿主，而不是青龙容器里】
    续期依赖一个 7x24 常驻的 Chromium（woiden-browser.service），其中保存着
    woiden.id 的登录 Cookie 和 web.telegram.org 的会话。青龙容器内没有浏览器、
    没有 playwright，也访问不到宿主的 127.0.0.1:9222，所以浏览器动作只能落在宿主侧。
    容器只负责调度和发通知，通过共享文件（request/result.json）与本脚本通信。

【依赖】
    - 常驻 Chromium 的 CDP 端口 127.0.0.1:9222，profile 在 /opt/woiden-renew/profile
    - digit_templates.json：9 类数字位图模板，用于解两道数学验证码
    - secrets/chatgpt2api.key：调用本机视觉模型解 reCAPTCHA v2 的密钥

【输出契约】
    标准输出最后一行必须是 JSON（worker 只读这一行）。status 取值：
        ok                        仅检查，VPS 状态正常
        not_due                   未到续期窗口
        renewed                   续期成功
        uncertain                 服务端有成功迹象但到期日未变，需人工核对
        failed                    服务端明确拒绝
        error                     执行异常（stage 字段标明阶段）
        needs_login               登录态失效
        needs_human_verification  需要人工过验证（Cloudflare / reCAPTCHA / Telegram）
        needs_manual_renewal      验证码解不出，需人工续期
    退出码见文件末尾 if __name__ 块。

【标签页管理】
    每轮会打开 woiden 页面和 Telegram 页面。清理做三层兜底：
        1. emit()            —— 所有正常终态都经过这里
        2. with 块内 except  —— 异常时趁 CDP 连接还活着先清再抛
        3. atexit            —— 覆盖 sys.exit 等路径
    SIGKILL（worker 520s 超时）无法捕获，残留标签由下次运行复用并清理，自愈。
"""
import argparse, atexit, base64, json, os, re, sys, time
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

# ---------------------------------------------------------------------------
# 路径与外部服务
# ---------------------------------------------------------------------------
BASE = Path("/opt/woiden-renew")          # 宿主工作目录，与本文件同级
ART = BASE / "artifacts"                  # 失败时的证据截图，供人工排查
STATE = BASE / "state"                    # 预留状态目录
TPL_PATH = BASE / "digit_templates.json"  # 数学验证码数字模板
KEY_PATH = BASE / "secrets" / "chatgpt2api.key"  # 视觉模型密钥（不入 git）
CDP = "http://127.0.0.1:9222"             # 常驻 Chromium 的调试端口，只监听本机
URL_INFO = "https://woiden.id/vps-info"       # 状态页，读到期日
URL_RENEW = "https://woiden.id/vps-renew"     # 续期第一步
URL_CODE = "https://woiden.id/vps-renew-code"  # 续期第二步，填 Telegram 收到的码
VISION_API = "http://127.0.0.1:40337/v1/chat/completions"  # d3 本机的视觉模型服务
VISION_MODEL = "gpt-5.6"

# 剩余天数低于此值才真正提交续期。
# 关键业务事实：Woiden 续期后到期日不是「原到期日 + 2 天」，而是重置为
# 「续期当天 + 2 天的 00:00」。实测剩 3.12 天时续期，到期日反而从
# 2026-10-22 13:58 变成 2026-10-21 00:00，净损失约 1.5 天。
# 因此每天跑一次、阈值 2.0，续期后余量约 1.75 天，刚好够次日再跑一轮。
DUE_DAYS = 2.0

# ---------------------------------------------------------------------------
# 注入到页面里执行的 JS
# ---------------------------------------------------------------------------

# 把两道数学验证码的 <img> 画到 canvas 上做二值化，输出每行的 0/1 字符串。
# 阈值 128 是对 RGB 均值取的，实测对 Woiden 这两张 25x20 的位图稳定。
# 同时把验证码容器里的文字（运算符 + 或 X）一并取回。
JS_BITMAP = """() => {
  const out = [];
  document.querySelectorAll('#form-submit img').forEach(im => {
    const c = document.createElement('canvas');
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const rows = [];
    for (let y = 0; y < c.height; y++) {
      let line = '';
      for (let x = 0; x < c.width; x++) {
        const k = (y * c.width + x) * 4;
        line += ((d[k] + d[k+1] + d[k+2]) / 3 < 128) ? '1' : '0';
      }
      rows.push(line);
    }
    out.push(rows);
  });
  const box = document.querySelector('#form-submit .form-group.row');
  return {imgs: out, opText: box ? box.innerText : ''};
}"""

# 直接 fetch /vps-info 再正则，而不是读 DOM：
# 页面结构改动频繁，而 HTML 里的 "Valid until" 文本一直存在，正则更抗改版。
# challenge 字段用于识别 Cloudflare 拦截页。
JS_INFO = """async () => {
  const r = await fetch('/vps-info', {credentials: 'include', cache: 'no-store'});
  const t = await r.text();
  const m = t.match(/Valid until[\\s\\S]{0,120}?(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})/);
  const s = t.match(/Status[\\s\\S]{0,300}?(ACTIVE|INACTIVE|SUSPENDED)/i);
  const host = t.match(/Hostname[\\s\\S]{0,80}?([0-9]+)-woiden/i);
  return {expiry: m ? m[1] : null, status: s ? s[1].toUpperCase() : null, vps_id: host ? host[1] : null,
          challenge: /Just a moment|security verification/i.test(t),
          login_wall: /Please login using your telegram account/i.test(t), len: t.length};
}"""

# 读取提交后服务端返回的提示文本（#response 里的 alert）
JS_RESPONSE = """() => { const a = document.querySelector('#response .alert'); return a ? (a.innerText || '').trim() : ''; }"""


# ---------------------------------------------------------------------------
# 基础设施
# ---------------------------------------------------------------------------

def now_iso():
    """当前时间的 ISO 8601 字符串，带本地时区偏移，写进结果 JSON。"""
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def shot(page, name):
    """截一张全页图存到 artifacts/，返回路径；失败返回 None（截图不能影响主流程）。"""
    ART.mkdir(parents=True, exist_ok=True)
    p = ART / ("%s-%s.png" % (datetime.now().strftime("%Y%m%d-%H%M%S"), name))
    try:
        page.screenshot(path=str(p), full_page=True)
        return str(p)
    except Exception:
        return None


# 保存当前 browser context 和「本轮必须保留的页面」。
# 放在模块级，是为了让 emit() 和 atexit 兜底都能拿到，而不必层层传参。
_TIDY = {"ctx": None, "keep": set()}


def _tidy_final():
    """最后一层兜底：解释器退出时（含未捕获异常、sys.exit）尝试清理标签。"""
    try:
        ctx = _TIDY.get("ctx")
        if ctx is not None:
            tidy_tabs(ctx, _TIDY.get("keep") or set())
    except Exception:
        pass


atexit.register(_tidy_final)


def emit(status, **extra):
    """
    唯一的终态出口。

    所有 return 都必须走这里，原因有二：
      1. 保证标签清理一定执行（趁 CDP 连接还活着）
      2. 保证标准输出最后一行是 worker 能解析的 JSON
    额外的业务字段通过 **extra 透传，写进结果供入口脚本拼邮件正文。
    """
    obj = {"status": status, "at": now_iso(), **extra}
    try:
        ctx = _TIDY.get("ctx")
        if ctx is not None:
            tidy_tabs(ctx, _TIDY.get("keep") or set())
    except Exception:
        pass
    print(json.dumps(obj, ensure_ascii=False))
    return obj


# ---------------------------------------------------------------------------
# 数学验证码：模板匹配
# ---------------------------------------------------------------------------

def load_templates():
    """读取 digit_templates.json：{数字: {"rows": [位图行字符串...]}}，共 9 类（1-9，无 0）。"""
    return json.loads(TPL_PATH.read_text())


def recognize(rows, tpl):
    """
    把一张位图和 9 个模板逐一比对，返回 (数字, 汉明距离) 中距离最小的那个。

    位图只有 25x20 像素，且字体固定，所以精确模板匹配就够用，不需要 OCR 模型。
    实测生产环境距离恒为 0；调用方会再卡一道 dist <= 12 的上限。
    """
    best = None
    for digit, t in tpl.items():
        tr = t["rows"]
        if len(tr) != len(rows):
            continue
        dist = sum(1 for r1, r2 in zip(rows, tr) for a, b in zip(r1, r2) if a != b)
        if best is None or dist < best[1]:
            best = (digit, dist)
    return best


def solve_math(page, tpl, timeout=20):
    """
    等待两道验证码图片渲染完成，识别后按运算符算出答案。

    返回 {"op","a","b","answer","dist"} 或 None（超时/识别不可信）。
    几个防御点：
      - 图片可能还没加载完，所以循环轮询直到两张都有足够墨迹
      - ink > 10 用来排除空白图（占位图）
      - dist <= 12 用来排除识别不可信的情况，宁可失败也不乱填
      - 运算符来自页面文字：'+' 做加法，其它（X/x/*）一律按乘法处理
    """
    end = time.time() + timeout
    while time.time() < end:
        try:
            data = page.evaluate(JS_BITMAP)
        except Exception:
            data = {"imgs": [], "opText": ""}
        imgs = data.get("imgs") or []
        if len(imgs) >= 2:
            ink = [sum(r.count("1") for r in rows) for rows in imgs[:2]]
            if all(n > 10 for n in ink):
                ds = [recognize(r, tpl) for r in imgs[:2]]
                if all(d is not None and d[1] <= 12 for d in ds):
                    op = re.sub(r"\s", "", data.get("opText") or "")
                    if op:
                        a, b = int(ds[0][0]), int(ds[1][0])
                        ans = a + b if op.startswith("+") else a * b
                        return {"op": op, "a": a, "b": b, "answer": ans,
                                "dist": [ds[0][1], ds[1][1]]}
        page.wait_for_timeout(800)
    return None


# ---------------------------------------------------------------------------
# 页面导航辅助
# ---------------------------------------------------------------------------

def wait_cf(page, timeout=60):
    """等 Cloudflare 的 "Just a moment..." 拦截页自己放行；超时返回 False。"""
    end = time.time() + timeout
    while time.time() < end:
        try:
            if "just a moment" not in page.title().lower():
                return True
        except Exception:
            pass
        page.wait_for_timeout(1500)
    return False


def goto(page, url, timeout=60):
    """导航到指定 URL，并顺带处理可能出现的 Cloudflare 挑战。"""
    page.goto(url, wait_until="domcontentloaded", timeout=timeout * 1000)
    ok = wait_cf(page, timeout)
    page.wait_for_timeout(1500)
    return ok


def wait_alert(page, timeout=60):
    """轮询等 #response 出现文本（表单提交后的服务端提示），超时返回空串。"""
    end = time.time() + timeout
    while time.time() < end:
        try:
            txt = page.evaluate(JS_RESPONSE)
        except Exception:
            txt = ""
        if txt:
            return txt
        page.wait_for_timeout(1500)
    return ""


def clear_overlays(page):
    """
    移除挡住页面交互的广告遮罩层。

    woiden.id 会随机弹出 "Unlock more content" 弹层和 Google vignette 插页广告，
    它们是 position:fixed 的高 z-index 覆盖层，会拦截 pointer events。
    实测后果：reCAPTCHA 的勾选框看起来点到了（Playwright 不报错），
    实际点击被遮罩吃掉，三轮都拿不到 token，td_count 恒为 0。

    纯 DOM 移除，不点广告、不等待，失败静默（遮罩不存在是常态）。

    2026-10-20 补充（reCAPTCHA 反复点不中的真因）：
    广告弹层除了拦截点击，还会给 body 设 overflow:hidden 把滚动条干掉。
    滚动条有无会改变视口宽度（1440 ↔ 1425），整页横向偏移约 8px。
    如果先取 bounding_box 再清广告，坐标就过期了，鼠标落在勾选框右侧空白，
    reCAPTCHA 收到了点击却没勾上，于是 td_count 恒为 0、token 永远拿不到。
    因此这里必须把 overflow 一起还原，且调用方要在清除「之后」再取坐标。
    """
    try:
        page.evaluate("""() => {
            // 广告是「持续再插入」的：清掉之后页面脚本会重新建 overlay，
            // 所以装一个常驻清理器，每 400ms 扫一遍，页面导航后自动失效重建。
            if (!window.__etaClean) {
                window.__etaClean = () => {
                    const sels = ['.fc-dialog-overlay', '.fc-message-root', '[class*=fc-dialog]',
                                  '#google_vignette', '[id*=google_vignette]', '.modal-backdrop'];
                    for (const s of sels) {
                        for (const el of document.querySelectorAll(s)) {
                            try { el.style.pointerEvents = 'none'; } catch (e) {}
                            try { el.remove(); } catch (e) {}
                        }
                    }
                    // 兜底：找含 "Unlock more content" 的块，向上定位到 fixed 祖先一起删掉。
                    // 先做廉价判断：这个清理器每 400ms 跑一次，若无条件对整页
                    // div/section/aside 读 innerText，会强制 reflow 拖慢页面。
                    if ((document.body.textContent || '').includes('Unlock more content')) {
                        for (const el of document.querySelectorAll('div,section,aside')) {
                            const t = el.innerText || '';
                            if (t.includes('Unlock more content') && t.length < 800) {
                                let n = el;
                                for (let i = 0; i < 6 && n.parentElement; i++) {
                                    if (getComputedStyle(n).position === 'fixed') break;
                                    n = n.parentElement;
                                }
                                try { n.style.pointerEvents = 'none'; } catch (e) {}
                                try { n.remove(); } catch (e) {}
                            }
                        }
                    }
                    // 残留的全屏空覆盖层（Google vignette 容器，z-index 2e9）
                    const vw = window.innerWidth, vh = window.innerHeight;
                    for (const el of document.querySelectorAll('body > div, body > section')) {
                        const cs = getComputedStyle(el);
                        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
                        if (parseInt(cs.zIndex || '0', 10) < 1000000000) continue;
                        const r = el.getBoundingClientRect();
                        if (r.width < vw * 0.8 || r.height < vh * 0.6) continue;
                        if ((el.innerText || '').trim()) continue;
                        try { el.remove(); } catch (e) {}
                    }
                    // 关键：还原被广告锁死的滚动，否则视口宽度差 15px，坐标全偏
                    for (const n of [document.documentElement, document.body]) {
                        if (!n) continue;
                        if (n.style.overflow === 'hidden') n.style.removeProperty('overflow');
                        if (n.style.overflowY === 'hidden') n.style.removeProperty('overflow-y');
                        if (n.style.position === 'fixed') {
                            n.style.removeProperty('position');
                            n.style.removeProperty('top');
                            n.style.removeProperty('left');
                            n.style.removeProperty('width');
                        }
                    }
                };
                window.__etaTimer = setInterval(() => { try { window.__etaClean(); } catch (e) {} }, 400);
            }
            window.__etaClean();
        }""")
    except Exception:
        pass


def ensure_login(page):
    """
    用 Telegram OAuth 一键重登。

    为什么需要：woiden.id 的 PHPSESSID 寿命很短，实测一天内就会失效，
    失效后 /vps-info 返回登录墙（"Please login using your telegram account"）。

    登录方式：/login 页面嵌入 Telegram Login Widget（bot = LoginWoidenBot）。
    由于同一个 Chromium profile 里 web.telegram.org 仍处于登录状态，
    widget 会直接显示 "Log in as <name>"，调用 TWidgetLogin.auth() 即完成 OAuth。

    踩过的坑：
      1. 广告遮罩（fc-dialog-overlay / Unlock more content）会吃掉点击
         → 先 clear_overlays，再用 JS 直接调函数，绕开 pointer events
      2. 按钮点击后页面会导航，evaluate 可能抛 execution-context-destroyed
         → 后续操作全部容错
      3. iframe 加载慢（页面广告多），要轮询等它出现
      4. 2026-10-23：widget 里既没有 TWidgetLogin.auth 也没有登录按钮，
         原实现照样返回 ok=True，于是"登录成功"是假的，最后报 needs_login
         却没有任何可查的证据（日志只有一句 fired:nothing）。
         现在 fired==nothing 会 dump widget 内容，并且每轮结束都回 /vps-info
         实地验证，读不到就重试。

    返回 {"ok": bool, "log": [...]}。ok=True 表示 /vps-info 已能读到内容。
    """
    log = []
    for attempt in range(2):
        try:
            page.goto("https://woiden.id/login", wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            log.append("goto_err:" + str(e)[:60])
            continue
        page.wait_for_timeout(1500)

        # 会话还有效时 /login 会直接跳走，不必再走 OAuth
        try:
            if "/login" not in page.url:
                log.append("already_logged_in")
                if _info_readable(page, log):
                    return {"ok": True, "log": log}
                continue
        except Exception:
            pass

        got = False
        for _ in range(20):
            page.wait_for_timeout(1000)
            try:
                if page.locator("iframe[src*='oauth.telegram.org']").count():
                    got = True
                    break
            except Exception:
                pass
        if not got:
            log.append("no_telegram_iframe_%d" % attempt)
            continue

        clear_overlays(page)
        page.wait_for_timeout(600)

        fired = "nothing"
        try:
            frames = [f for f in page.frames if "oauth.telegram.org" in f.url]
            if frames:
                fired = frames[0].evaluate("""() => {
                    try {
                        if (window.TWidgetLogin && typeof TWidgetLogin.auth === 'function') {
                            TWidgetLogin.auth(); return 'TWidgetLogin.auth';
                        }
                    } catch (e) {}
                    const b = document.querySelector('button.tgme_widget_login_button');
                    if (b) { b.click(); return 'btn.click'; }
                    return 'nothing';
                }""")
        except Exception as e:
            fired = "err:" + str(e)[:60]
        log.append("fired:" + str(fired))

        if fired == "nothing":
            # 记下 widget 的真实内容，否则下次还是只有一句没信息量的 fired:nothing
            try:
                frames = [f for f in page.frames if "oauth.telegram.org" in f.url]
                if frames:
                    log.append({"widget": frames[0].evaluate(
                        "() => ({url: location.href,"
                        " text: (document.body ? document.body.innerText : '').slice(0, 200),"
                        " htmlLen: document.body ? document.body.innerHTML.length : -1})")})
            except Exception as e:
                log.append("widget_dump_err:" + str(e)[:60])

        # 等 OAuth 回调把页面带走
        for _ in range(20):
            page.wait_for_timeout(1500)
            try:
                if "/login" not in page.url:
                    log.append("left_login")
                    break
            except Exception:
                pass

        if _info_readable(page, log):
            return {"ok": True, "log": log}
        log.append("verify_failed_%d" % attempt)

    return {"ok": False, "log": log}


def _info_readable(page, log):
    """回 /vps-info 实地确认登录态：能读到 Status 才算真登录。"""
    try:
        page.goto(URL_INFO, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2000)
        txt = page.locator("body").inner_text(timeout=10000)
    except Exception as e:
        log.append("verify_err:" + str(e)[:60])
        return False
    if "Please login" in txt:
        return False
    log.append("verified")
    return True


def js_click_submit(page):
    """
    用 JS 直接点提交按钮，而不是 Playwright 的 click()。

    原因：按钮可能被固定的页脚遮住，Playwright 会判定不可点击而超时；
    这里先 scrollIntoView 再原生 click()，绕开可见性检查。
    """
    page.evaluate("""() => { const b = document.querySelector("button[name='submit_button']"); if (b) { b.scrollIntoView({block:'center'}); b.click(); } }""")


# ---------------------------------------------------------------------------
# Telegram：读取续期验证码
# ---------------------------------------------------------------------------

def ensure_telegram(ctx):
    """
    拿到 Telegram Web 页面：已存在就复用，不存在就新开并等它加载完。

    登录态保存在 Chromium profile 里，所以正常情况下不需要重新登录。
    打开后主动点一下 "HAX Bot" 会话，确保消息列表已渲染。
    """
    tg = None
    for pg in ctx.pages:
        if "web.telegram.org" in pg.url:
            tg = pg
            break
    if tg is None:
        tg = ctx.new_page()
        tg.goto("https://web.telegram.org/k/", wait_until="domcontentloaded", timeout=90000)
        tg.wait_for_timeout(6000)
    tg.bring_to_front()
    try:
        tg.locator(".chatlist-chat", has_text="HAX Bot").first.click(timeout=15000)
        tg.wait_for_timeout(1200)
    except Exception:
        pass
    return tg


def tg_codes(tg):
    """
    从当前会话的所有气泡里提取续期码。

    Bot 消息形如 "Your Code is\\n<base64>"，取 base64 部分。
    返回的是「当前可见的全部码」，新旧混在一起，由调用方做差集。
    """
    try:
        txts = tg.evaluate("""() => Array.from(document.querySelectorAll('.bubble')).map(e => (e.innerText || '').trim()).filter(Boolean)""")
    except Exception:
        return []
    out = []
    for t in txts:
        m = re.search(r"Your Code is\s*\n?\s*([A-Za-z0-9+/=]{16,})", t)
        if m:
            out.append(m.group(1))
    return out


def tg_wait_new_code(tg, before, timeout=120):
    """
    等待「提交第一步之后新出现」的验证码。

    before 是提交前抓到的码集合，这里只返回不在其中的码。
    这一步很关键：Bot 会保留历史消息，直接用最新的码有可能拿到上一轮的旧码，
    导致第二步必然失败，所以必须做差集。
    轮询期间会重复点一次会话，防止 Telegram Web 掉线后列表不再刷新。
    """
    end = time.time() + timeout
    while time.time() < end:
        codes = tg_codes(tg)
        fresh = [c for c in codes if c not in before]
        if fresh:
            return fresh[-1]
        tg.wait_for_timeout(2000)
        try:
            tg.locator(".chatlist-chat", has_text="HAX Bot").first.click(timeout=5000)
        except Exception:
            pass
    return None


# ---------------------------------------------------------------------------
# reCAPTCHA v2：截图交给本机视觉模型判断该点哪些格子
# ---------------------------------------------------------------------------

def ask_vision(png_bytes, n=9):
    """
    把 reCAPTCHA 的挑战图片发给 d3 本机的视觉模型，拿回该点的格子编号。

    返回 {"instruction": "...", "cells": [1,5], "notes": "..."} 或 None。
    两个已知坑：
      - 模型常把 JSON 包在 <escape>...</escape> 里，要先剥掉标签
      - 输出可能夹带解释文字，用最外层 {...} 正则捞出 JSON
    """
    key = KEY_PATH.read_text().strip()
    img = base64.b64encode(png_bytes).decode()
    cols = 3 if n == 9 else 4
    prompt = (
        "Look at this image. It shows a short instruction line at the top and a %dx%d grid of photos below it. "
        "Number the grid cells 1-%d in reading order: 1=top-left, then left-to-right and top-to-bottom, %d=bottom-right. "
        "Report the instruction text, then list every cell whose photo clearly contains the object named in the instruction. "
        'Answer strictly as JSON: {"instruction":"...","cells":[1,5],"notes":"..."}'
    ) % (cols, cols, n, n)
    payload = {"model": VISION_MODEL, "messages": [{"role": "user", "content": [
        {"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + img}},
    ]}]}
    import urllib.request
    req = urllib.request.Request(VISION_API, data=json.dumps(payload).encode(),
                                headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    r = urllib.request.urlopen(req, timeout=180)
    body = json.loads(r.read().decode())
    content = body.get("choices", [{}])[0].get("message", {}).get("content") or ""
    content = re.sub(r"</?escape>", "", content).strip()
    m = re.search(r"\{.*\}", content, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def read_target(bf):
    """
    从挑战 iframe 里读出「要选的物体」。

    2026-10-30 实测的 DOM（16 格 4x4 布局）：
        .rc-imageselect-desc-wrapper > .rc-imageselect-desc-no-canonical > span > strong
    注意：这种布局下 **根本不存在 .rc-imageselect-desc 这个元素**，类名整个换成了
    -no-canonical 后缀。老实现首选 ".rc-imageselect-desc strong" 必然匹配 0 个，
    退回 ".rc-imageselect-desc-wrapper" 拿整段文本后，又被 "images? with" 的正则
    卡住 —— 16 格网格的文案是 "Select all squares with motorcycles"，
    用的是 squares 不是 images。两道关卡同时失效，target 恒为空，
    于是每次都掉进整图 ask_vision 分支被模型拒答。

    所以这里改成：
      1. 逐层尝试 strong（覆盖 desc / desc-no-canonical / wrapper / payload 四种容器）
      2. 再退到整段文本，正则只锚 "with <物体>"，不再限定 images/squares
    """
    for sel in (".rc-imageselect-desc strong",
                ".rc-imageselect-desc-no-canonical strong",
                ".rc-imageselect-desc-wrapper strong",
                ".rc-imageselect-payload strong"):
        try:
            t = (bf.locator(sel).first.text_content(timeout=3000) or "").strip()
        except Exception:
            continue
        if t and len(t) < 60:
            return t.lower().rstrip(".")
    for sel in (".rc-imageselect-desc-no-canonical",
                ".rc-imageselect-desc-wrapper",
                ".rc-imageselect-desc",
                ".rc-imageselect-payload"):
        try:
            t = (bf.locator(sel).first.text_content(timeout=3000) or "").strip()
        except Exception:
            continue
        if not t:
            continue
        m = re.search(r"with\s+(?:a |an |the )?([^\n]+)", t, re.I)
        if m:
            return m.group(1).strip().lower().rstrip(".")
    return ""


def ask_desc_ocr(bf):
    """
    read_target 的兜底：把说明条截图交给视觉模型做纯 OCR。

    这里问的是「图上这段文字要求选什么物体」，不是「帮我解验证码」，
    所以模型不会拒答 —— 与 ask_vision() 那条被拒的路径是两回事。
    """
    try:
        png = bf.locator(".rc-imageselect-desc-wrapper").first.screenshot(timeout=6000)
    except Exception:
        try:
            png = bf.locator(".rc-imageselect-payload").first.screenshot(timeout=6000)
        except Exception:
            return ""
    prompt = ("Read the instruction text in this image and tell me which kind of "
              "object it asks the user to select. Answer with only that object noun, "
              "lowercase, no explanation.")
    return _vision_text(png, prompt, max_tokens=24)


def _vision_text(png_bytes, prompt, max_tokens=24):
    """通用视觉调用：返回模型给的短文本，失败返回空串。"""
    key = KEY_PATH.read_text().strip()
    img = base64.b64encode(png_bytes).decode()
    payload = {"model": VISION_MODEL, "max_tokens": max_tokens,
               "messages": [{"role": "user", "content": [
                   {"type": "text", "text": prompt},
                   {"type": "image_url",
                    "image_url": {"url": "data:image/png;base64," + img}},
               ]}]}
    import urllib.request
    req = urllib.request.Request(
        VISION_API, data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=60)
        body = json.loads(r.read().decode())
    except Exception:
        return ""
    c = (body.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
    c = re.sub(r"</?escape>", "", c).strip().strip(".").lower()
    if len(c) > 40 or not c:
        return ""
    return c

def grid_cells(bf, n):
    """
    用 iframe 内的 canvas 把整张挑战图切成 n 个单格 JPEG 字节。

    为什么不用 locator.screenshot()：
      2026-10-31 实测，挑战挂起约 2 分钟后 Chromium 合成器进入挂起状态，
      Playwright 所有截屏都卡在 "attempting to take screenshot" 直到 30 秒超时
      （错误里 fonts 明明已经 loaded，问题不在字体）。16 格 × 30 秒直接烧光
      时间预算，token 恒为 0，最终误报 needs_human_verification。

    为什么不直接下载 img.src：
      实测 9 格与 16 格布局下，所有 td 的 <img> 都指向**同一张 300×300 整图**
      （靠 CSS 裁剪显示各格）。直接下载得到的是整图，模型会把每一格都答 yes。

    canvas 方案：img 与 bframe 同源（都是 recaptcha.net），canvas 不会被 taint，
    可以 drawImage 后按网格裁切再 toDataURL。纯 JS 计算，不经过渲染管线。
    """
    cols = int(round(n ** 0.5))
    if cols * cols != n:
        return []
    js = """() => {
      const cols = %d;
      const imgs = Array.from(document.querySelectorAll('td img'));
      if (!imgs.length) return {err: 'no img'};
      const img = imgs[0];
      const W0 = img.naturalWidth || 300, H0 = img.naturalHeight || 300;
      const cw = Math.floor(W0 / cols), ch = Math.floor(H0 / cols);
      const out = [];
      for (let r = 0; r < cols; r++) {
        for (let c = 0; c < cols; c++) {
          const cv = document.createElement('canvas');
          cv.width = cw; cv.height = ch;
          const ctx = cv.getContext('2d');
          try {
            ctx.drawImage(img, c * cw, r * ch, cw, ch, 0, 0, cw, ch);
            out.push(cv.toDataURL('image/jpeg', 0.92));
          } catch (e) { return {err: 'canvas:' + e.name}; }
        }
      }
      return {imgs: out};
    }""" % cols
    try:
        res = bf.locator("html").evaluate(js)
    except Exception:
        return []
    if not isinstance(res, dict) or "imgs" not in res:
        return []
    out = []
    for d in res["imgs"][:n]:
        try:
            out.append(base64.b64decode(d.split(",", 1)[1]))
        except Exception:
            return []
    return out


def ask_cells(pngs, target, workers=4, retries=2, deadline=None, loose=False):
    """
    并发问每一格「有没有 target」，返回与 pngs 等长的列表（True/False/None）。

    为什么要并发：单格一次视觉调用实测 8-11 秒，16 格串行就是 150 秒以上，
    加上前面的数学验证码和 Telegram 取码，很容易撞上 worker 的 520 秒上限。
    并发 4 路把这段压到 40-60 秒。

    为什么要重试：2026-10-31 实测 9 格里 4 格返回 None（接口抖动），
    而 None 会被上层当 false，导致漏选、整轮失败。重试 2 次后归零。
    """
    from concurrent.futures import ThreadPoolExecutor

    stop = {"hit": False}

    def one(i):
        for attempt in range(retries + 1):
            # deadline 是绝对时间戳：超了就不再发起新调用，避免整轮撞上 worker 520s 上限
            if stop["hit"] or (deadline and time.time() > deadline):
                return i, None
            v = ask_cell(pngs[i], target, loose=loose)
            if v == "throttled":
                # 配额打满：剩下所有格子都别再发了，否则只是白烧
                stop["hit"] = True
                return i, "throttled"
            if v is not None:
                return i, v
            time.sleep(1.2 * (attempt + 1))
        return i, None

    res = [None] * len(pngs)
    if not pngs:
        return res
    with ThreadPoolExecutor(max_workers=max(1, min(workers, len(pngs)))) as ex:
        for i, v in ex.map(one, range(len(pngs))):
            res[i] = v
    # 补判：并发下总有格子拿不到结果（实测 16 格里 4 个），多半是被同一时刻的
    # 并发压力打回来的。这些格子若其实是目标物就会漏选，所以对它们串行再走一遍，
    # 一次只发一个请求，避开限流。仍然失败才留 None。
    for i in [k for k, v in enumerate(res) if v is None]:
        if stop["hit"] or (deadline and time.time() > deadline):
            break
        v = ask_cell(pngs[i], target, loose=loose)
        if v == "throttled":
            stop["hit"] = True
            break
        if v is not None:
            res[i] = v
    return res


def cell_image(bf, idx):
    """
    取第 idx 格（0 基）的图片字节。

    为什么不直接 locator.screenshot()：
      2026-10-31 实测，挑战挂起约 2 分钟后 Chromium 合成器进入挂起状态，
      Playwright 的所有截屏都卡在 "attempting to take screenshot" 直到 30 秒超时
      （错误里 fonts 明明已经 loaded，问题不在字体）。16 格 × 30 秒直接把时间预算
      烧光，token 恒为 0，最终误报 needs_human_verification。
      而每个 td 里的 <img> 指向 recaptcha 的 payload URL，可以直接 HTTP 下载：
      实测 0.2 秒一张、约 26KB JPEG，完全绕开渲染管线。
    截图只作兜底（URL 取不到或下载失败时）。
    """
    src = None
    try:
        src = bf.locator("td").nth(idx).locator("img").evaluate(
            "el => el.currentSrc || el.src || ''")
    except Exception:
        src = None
    if src and src.startswith("http"):
        try:
            import urllib.request
            req = urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0"})
            data = urllib.request.urlopen(req, timeout=20).read()
            if len(data) > 500:
                return data
        except Exception:
            pass
    try:
        return bf.locator("td").nth(idx).screenshot(timeout=6000)
    except Exception:
        return None


def ask_cell(png_bytes, target, loose=False):
    """
    只把「一个格子」发给视觉模型，问它里面有没有目标物体。

    为什么不再整张图问「点哪几格」：
      2026-10-28 起模型能认出整张九宫格是 CAPTCHA，直接拒答（cells 恒为 []，
      notes 写 "I can't identify the specific cells in an image-selection CAPTCHA"）。
      但把图片裁成单格、不提 CAPTCHA，它就会老实回答。

    为什么是三态而不是 yes/no：
      单格图只有 100x100，小目标（烟囱、消防栓）常常只露出一角，
      二选一会被迫在「不确定」和「没有」之间选边，实测容易出现整轮全 no。
      引入 maybe 后上层可以分档处理：有明确 yes 就只信 yes，
      全无 yes 时才退而用 maybe，避免一开始就多选把这一轮浪费掉。

    loose=True 用于「全判 no」之后的复判：措辞放宽到「部分可见、很小、在背景里也算」。
    返回 "yes" / "maybe" / "no"；接口失败返回 None（交给调用方重试）。
    """
    key = KEY_PATH.read_text().strip()
    img = base64.b64encode(png_bytes).decode()
    if loose:
        prompt = ("Look closely at this photo. Does it contain %s, even if it is only "
                  "partially visible, small, or in the background? "
                  "Answer with exactly one word: yes, no, or maybe." % target)
    else:
        prompt = ("This is a single photo cropped from a street-scene dataset. "
                  "Does it show %s? Answer with exactly one word: yes, no, or maybe." % target)
    payload = {"model": VISION_MODEL, "messages": [{"role": "user", "content": [
        {"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + img}},
    ]}]}
    import urllib.request
    import urllib.error
    req = urllib.request.Request(VISION_API, data=json.dumps(payload).encode(),
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=90)
        body = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # 2026-10-31 实测：图片走 /backend-api/files，上游有「文件上传上限」配额，
        # 打满后返回 502 包着 429 throttled。这不是网络抖动，重试只会继续烧配额，
        # 必须单独识别出来让上层立刻收手。
        txt = ""
        try:
            txt = e.read().decode()[:600]
        except Exception:
            pass
        if e.code == 429 or "throttled" in txt or "上传上限" in txt:
            return "throttled"
        return None
    except Exception:
        return None
    c = (body.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
    c = re.sub(r"</?escape>", "", c).strip().lower()
    if c.startswith("yes"):
        return "yes"
    if c.startswith(("maybe", "perhaps", "possibly", "partially", "partly")):
        return "maybe"
    if c.startswith("no"):
        return "no"
    return None


def solve_recaptcha_v2(page, max_rounds=3):
    """
    完成 reCAPTCHA v2，成功后 token 会自动写进页面隐藏的 textarea。

    流程：
      1. 点 iframe 里的 #recaptcha-anchor（没触发挑战就直接出 token）
      2. 出现 bframe 挑战时，统计格子数（只接受 9 或 16，其它视为未加载）
      3. 截图 → ask_vision() → 按返回的编号依次点 td → 点 verify
      4. 最多 3 轮；每轮都重新检查 textarea 是否已有 token

    返回 {"ok", "token_len", "rounds", "log"}，log 记录每轮细节便于事后排查。
    失败时不抛异常，交给上层判为 needs_human_verification 并发邮件。
    """
    log = []
    # 勾选框在 reCAPTCHA iframe 内的固定位置：左上各 28px 处是 checkbox 中心。
    # 这个偏移比 #recaptcha-anchor 的 bounding_box 更稳（后者受布局偏移影响）。
    anchor = page.frame_locator("iframe[title='reCAPTCHA']").locator("#recaptcha-anchor")

    def _point():
        """
        取一个「确实落在 reCAPTCHA iframe 上」的点击坐标。

        为什么不能直接 anchor.bounding_box() 点下去：
          广告弹层在时 body 是 overflow:hidden，清掉广告后滚动条回来，
          视口宽度从 1440 变 1425，整页横向偏移约 8px，之前取的坐标就点空了。
          所以每次都：清遮罩 → 等布局稳定 → 重新取坐标 → 用
          elementFromPoint 校验该点最顶层确实是 reCAPTCHA iframe。
        """
        for _ in range(3):
            # 每次取坐标前都重新清一遍：广告脚本会在滚动时把 overlay 再插回来
            clear_overlays(page)
            page.wait_for_timeout(350)
            page.locator("iframe[title='reCAPTCHA']").first.scroll_into_view_if_needed(timeout=8000)
            page.wait_for_timeout(350)
            fbox = page.locator("iframe[title='reCAPTCHA']").first.bounding_box()
            try:
                abox = anchor.bounding_box()
            except Exception:
                abox = None
            cands = []
            if abox and abox.get("width"):
                cands.append((abox["x"] + abox["width"] / 2, abox["y"] + abox["height"] / 2, "anchor"))
            if fbox:
                cands.append((fbox["x"] + 28, fbox["y"] + 28, "iframe+28"))
            vh = page.evaluate("() => window.innerHeight")
            for x, y, how in cands:
                if y > vh - 5:
                    continue
                top = page.evaluate(
                    "([x, y]) => { const e = document.elementFromPoint(x, y);"
                    " return e ? (e.tagName + '|' + (e.title || '')) : 'NULL'; }", [x, y])
                log.append({"cand": how, "at": [round(x), round(y)], "top": top})
                if top.startswith("IFRAME") and "reCAPTCHA" in top:
                    return x, y, how
            page.wait_for_timeout(250)
        return None, None, None

    def _reacted():
        """点击是否被接受：出了 token，或挑战格子渲染出来了。"""
        tok = page.evaluate("""() => { const e = document.querySelector('textarea[name="g-recaptcha-response"]'); return e ? (e.value || '') : ''; }""")
        if tok:
            return True
        try:
            return page.frame_locator("iframe[src*='bframe']").locator("td").count() > 0
        except Exception:
            return False

    hit = False
    for attempt in range(2):
        # 顺序不能反：先清遮罩并等布局稳定，再取坐标（理由见 _point）
        clear_overlays(page)
        page.wait_for_timeout(600)
        try:
            cx, cy, how = _point()
        except Exception as e:
            log.append("point_err:" + str(e)[:80])
            cx = None
        if cx is None:
            break
        page.mouse.move(cx, cy)
        page.wait_for_timeout(250)
        page.mouse.click(cx, cy)
        hit = True
        log.append("click@%s %.0f,%.0f" % (how, cx, cy))
        page.wait_for_timeout(2500)
        if _reacted():
            break
        log.append("no_reaction_retry_%d" % attempt)
    if not hit:
        try:
            anchor.click(timeout=15000)
            log.append("anchor_clicked")
        except Exception as e:
            log.append("anchor_click_err:" + str(e)[:80])
    t_start = time.time()
    for rnd in range(max_rounds):
        page.wait_for_timeout(2500)
        # 每轮再清一次：广告是随机插入的，可能在验证过程中弹出
        clear_overlays(page)
        tok = page.evaluate("""() => { const e = document.querySelector('textarea[name="g-recaptcha-response"]'); return e ? (e.value || '') : ''; }""")
        if tok:
            return {"ok": True, "token_len": len(tok), "rounds": rnd, "log": log}
        frame = page.locator("iframe[src*='bframe']")
        if frame.count() == 0:
            log.append("no_bframe_round_%d" % rnd)
            page.wait_for_timeout(3000)
            continue
        bf = page.frame_locator("iframe[src*='bframe']")
        # bframe 出现不代表内容已渲染，等第一个格子出现，避免把加载中误判成 0 格
        try:
            # 用 attached 而不是默认的 visible：合成器挂起后 visible 检查会一直等
            bf.locator("td").first.wait_for(timeout=10000, state="attached")
        except Exception:
            pass
        try:
            n_td = bf.locator("td").count()
        except Exception:
            n_td = 0
        log.append({"round": rnd, "td_count": n_td})
        # reCAPTCHA 实际会出 2x2 / 3x3 / 4x4 三种网格。只认 9 和 16 会在
        # 出现 4 格时连续 3 轮直接 continue，最终 token 恒 0。
        if n_td not in (4, 9, 16):
            page.wait_for_timeout(2000)
            continue
        # 主路径：逐格问 yes/no。整图问「点哪几格」会被模型当成 CAPTCHA 拒答。
        target = read_target(bf)
        if not target:
            target = ask_desc_ocr(bf)
            log.append({"round": rnd, "target_from_ocr": target})
        log.append({"round": rnd, "target": target})
        cells = []
        if target:
            # 时间预算：整个 v2 阶段最多 200 秒。worker 是 520 秒硬超时，
            # 前面还有数学验证码、Telegram 取码、stage1 表单，必须留足余量。
            deadline = t_start + 200
            grid = grid_cells(bf, n_td)
            if len(grid) != n_td:
                log.append({"round": rnd, "grid_fallback": len(grid)})
                grid = []
                for i in range(n_td):
                    if time.time() > deadline:
                        log.append("time_budget_hit")
                        break
                    grid.append(cell_image(bf, i))
                grid += [None] * (n_td - len(grid))
            idx = [i for i, g in enumerate(grid) if g]
            pngs = [grid[i] for i in idx]
            verdicts = ask_cells(pngs, target, deadline=deadline) if pngs else []
            yes = [idx[k] + 1 for k, v in enumerate(verdicts) if v == "yes"]
            maybe = [idx[k] + 1 for k, v in enumerate(verdicts) if v == "maybe"]
            throttled = sum(1 for v in verdicts if v == "throttled")
            log.append({"round": rnd, "yes": yes, "maybe": maybe,
                        "unknown": sum(1 for v in verdicts if v is None),
                        "throttled": throttled,
                        "elapsed": round(time.time() - t_start)})
            if yes:
                cells = yes
            elif maybe:
                # 没有明确 yes，但有模棱两可的格子：先按 maybe 提交。
                # 即使选错，reCAPTCHA 也会换一张新图，比直接 break 多一次机会。
                cells = maybe
            elif pngs and not throttled and time.time() < deadline:
                # 全判 no：多半是 100x100 小图里目标只露一角，换宽松措辞复判一次
                verdicts2 = ask_cells(pngs, target, deadline=deadline, loose=True)
                loose_hit = [idx[k] + 1 for k, v in enumerate(verdicts2)
                             if v in ("yes", "maybe")]
                log.append({"round": rnd, "loose_retry": loose_hit})
                cells = loose_hit

        if not cells:
            # 后备：老的整图识别。目标词读不到、或逐格全否时才走这里。
            try:
                png = frame.first.screenshot(timeout=10000)
                ans = ask_vision(png, n_td)
            except Exception as e:
                log.append("vision_err:" + str(e)[:120])
                ans = None
            log.append({"round": rnd, "answer": ans})
            if ans:
                for c in ans.get("cells", []):
                    try:
                        c = int(c)
                    except Exception:
                        continue
                    if 1 <= c <= n_td:
                        cells.append(c)
        log.append({"round": rnd, "click": cells})
        if not cells:
            break
        for c in cells:
            # 渲染挂起后 Playwright 的 click 会卡到超时（要求可见+稳定+可交互），
            # 但 JS click 只派发事件、不依赖渲染状态，所以这里反过来：JS 优先。
            try:
                bf.locator("td").nth(c - 1).evaluate("el => el.click()")
                page.wait_for_timeout(300)
            except Exception:
                try:
                    bf.locator("td").nth(c - 1).click(timeout=5000)
                    page.wait_for_timeout(300)
                except Exception as e:
                    log.append("cell_click_err_%d:%s" % (c, str(e)[:60]))
        try:
            btn = bf.locator("#recaptcha-verify-button")
            btn.wait_for(state="attached", timeout=10000)
            try:
                # JS click 优先：① 广告横幅会盖住按钮 ② 渲染挂起后 Playwright 的
                # click 要等可见+稳定+可交互，必然超时。JS click 只派发事件。
                btn.evaluate("el => el.click()")
                log.append("verify_js_click")
            except Exception:
                btn.click(timeout=6000)
        except Exception as e:
            log.append("verify_err:" + str(e)[:80])
            break
        page.wait_for_timeout(4500)
    tok = page.evaluate("""() => { const e = document.querySelector('textarea[name="g-recaptcha-response"]'); return e ? (e.value || '') : ''; }""")
    return {"ok": bool(tok), "token_len": len(tok) if tok else 0, "rounds": max_rounds, "log": log}


# ---------------------------------------------------------------------------
# 日期与浏览器连接
# ---------------------------------------------------------------------------

def parse_days(expiry):
    """把 "YYYY-MM-DD HH:MM:SS" 换算成「距现在还有多少天」（可为负），解析失败返回 None。"""
    if not expiry:
        return None
    for f in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            d = datetime.strptime(expiry, f).replace(tzinfo=datetime.now().astimezone().tzinfo)
            return (d - datetime.now().astimezone()).total_seconds() / 86400
        except ValueError:
            pass
    return None


def connect_cdp(p, timeout=150):
    """
    连接常驻 Chromium，失败则每 3 秒重试，最长等 timeout 秒。

    存在的理由：Chromium 被 SIGKILL 后 systemd 大约 20 秒才拉起
    （Restart=always + RestartSec=10）。如果定时任务正好落在这个窗口里，
    裸调 connect_over_cdp 会立刻抛异常，导致当天整轮报废且没有第二次机会。
    这里把「等它回来」变成正常流程的一部分。
    注意还要等 contexts 非空：端口通了不代表 browser 已经能提供 context。
    """
    deadline = time.time() + timeout
    last = None
    while True:
        try:
            b = p.chromium.connect_over_cdp(CDP)
            if b.contexts:
                return b
            last = RuntimeError("cdp up but no browser context yet")
        except Exception as e:
            last = e
        if time.time() >= deadline:
            raise RuntimeError("CDP not ready after %ss: %s" % (timeout, last))
        time.sleep(3)


def find_woiden_page(ctx):
    """复用已有的 woiden 页面（/vps-info 或 /vps-renew），没有就新开一个。"""
    for pg in ctx.pages:
        if "/vps-renew" in pg.url or "/vps-info" in pg.url:
            return pg
    return ctx.new_page()


def tidy_tabs(ctx, keep):
    """
    关掉多余的 woiden 标签，只保留 keep 集合里的页面。

    刻意只处理 URL 含 /vps-info 或 /vps-renew 的页面：
    用户在同一个 Chromium 里可能还开着别的站点，那些一律不动。
    """
    for pg in list(ctx.pages):
        try:
            if pg in keep:
                continue
            if "/vps-info" in pg.url or "/vps-renew" in pg.url:
                pg.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    """
    一轮执行。所有分支都必须 return emit(...)，不允许裸 return 或静默退出。

    --mode check    只读状态并输出，不提交续期（用于日常巡检和故障演练）
    --mode auto     默认。剩余天数 <= DUE_DAYS 时走完整续期流程
    --mode prepare  预留模式
    --force         忽略到期阈值，强制走续期
    """
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["check", "auto", "prepare"], default="auto")
    ap.add_argument("--force", action="store_true", help="ignore due-window check")
    a = ap.parse_args()
    tpl = load_templates()
    ART.mkdir(parents=True, exist_ok=True)
    STATE.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        b = connect_cdp(p)
        ctx = b.contexts[0]
        wd = find_woiden_page(ctx)
        # 先登记清理上下文：从这里开始，任何退出路径都能找到要保留的页面
        _TIDY["ctx"] = ctx
        _TIDY["keep"] = {wd}
        try:
            wd.bring_to_front()
            if "/vps-info" not in wd.url and "/vps-renew" not in wd.url:
                goto(wd, URL_INFO)
            # 读状态：用 fetch + 正则，避免依赖 DOM 结构
            try:
                info = wd.evaluate(JS_INFO)
            except Exception as e:
                return emit("error", stage="info", error="%s: %s" % (type(e).__name__, e))
            # Cloudflare 拦截页：给它 60 秒自己放行，过不去就交人工
            if info.get("challenge"):
                if not wait_cf(wd, 60):
                    return emit("needs_human_verification", stage="info", screenshot=shot(wd, "cf"))
                info = wd.evaluate(JS_INFO)
            # 登录态失效：先自动用 Telegram OAuth 重登，失败才交人工。
            # 不能只看 login_wall：页面结构变动时 expiry 读不到但没有登录墙文案，
            # 一并当作会话问题处理，避免误报 "vps not active"。
            if info.get("login_wall") or not info.get("expiry"):
                lg = ensure_login(wd)
                if not goto(wd, URL_INFO):
                    return emit("needs_human_verification", stage="login", login=lg,
                                screenshot=shot(wd, "cf-login"))
                info = wd.evaluate(JS_INFO)
                if info.get("login_wall") or not info.get("expiry"):
                    return emit("needs_login", stage="login", login=lg,
                                screenshot=shot(wd, "login"))
            expiry0 = info.get("expiry")
            days = parse_days(expiry0)
            # check 模式到此为止：只读，不产生任何副作用
            if a.mode == "check":
                try:
                    wd.goto(URL_INFO, wait_until="domcontentloaded", timeout=60000)
                except Exception:
                    pass
                tidy_tabs(ctx, {wd})
                return emit("ok", status_text=info.get("status"), expiry=expiry0,
                            days_remaining=round(days, 2) if days is not None else None, vps_id=info.get("vps_id"))
            if not info.get("status") or info["status"] != "ACTIVE":
                return emit("error", stage="info", error="vps not active", status_text=info.get("status"), expiry=expiry0)
            if days is None:
                return emit("error", stage="info", error="cannot parse expiry", raw=expiry0)
            # 未到窗口就早退，避免每天都消耗一次 Telegram 发码和 reCAPTCHA 额度
            if days > DUE_DAYS and not a.force:
                tidy_tabs(ctx, {wd})
                return emit("not_due", expiry=expiry0, days_remaining=round(days, 2))

            # 先把 Telegram 页面准备好，并记录「提交前已有哪些码」，后面做差集
            tg = ensure_telegram(ctx)
            _TIDY["keep"].add(tg)
            before = set(tg_codes(tg))

            # ---- 第一步 /vps-renew：填 web_address + 勾协议 + 数学验证码 + reCAPTCHA v3 ----
            wd.bring_to_front()
            if not goto(wd, URL_RENEW):
                return emit("needs_human_verification", stage="stage1", screenshot=shot(wd, "cf-stage1"))
            clear_overlays(wd)
            cap1 = solve_math(wd, tpl)
            if not cap1:
                return emit("needs_manual_renewal", stage="stage1", error="math captcha unreadable",
                            screenshot=shot(wd, "stage1-captcha"))
            # 直接写 value 再派发 input 事件，让页面自己的校验逻辑认为用户输入过
            wd.evaluate("""(ans) => {
              document.querySelector('#web_address').value = 'woiden.id';
              const cb = document.querySelector('input[name="agreement"]');
              if (cb && !cb.checked) cb.checked = true;
              const c = document.querySelector('#captcha');
              if (c) { c.value = String(ans); c.dispatchEvent(new Event('input', {bubbles: true})); }
            }""", cap1["answer"])
            js_click_submit(wd)
            r1 = wait_alert(wd, 75)
            # 只有出现这句才说明服务端已把码发到 Telegram；其它提示一律判人工
            if "verification code has been sent" not in r1.lower():
                return emit("needs_manual_renewal", stage="stage1", response=r1[:300], captcha=cap1,
                            screenshot=shot(wd, "stage1-response"))

            # ---- 等 Telegram 里的新码 ----
            code = tg_wait_new_code(tg, before, timeout=120)
            if not code:
                return emit("needs_human_verification", stage="telegram", error="no new telegram code",
                            screenshot=shot(tg, "telegram"))

            # ---- 第二步 /vps-renew-code：填码 + 第二个数学验证码 + reCAPTCHA v2 ----
            wd.bring_to_front()
            if not goto(wd, URL_CODE):
                return emit("needs_human_verification", stage="stage2", screenshot=shot(wd, "cf-stage2"))
            clear_overlays(wd)
            cap2 = solve_math(wd, tpl)
            if not cap2:
                return emit("needs_manual_renewal", stage="stage2", error="math captcha unreadable",
                            screenshot=shot(wd, "stage2-captcha"))
            wd.evaluate("""([code, ans]) => {
              document.querySelector('#code').value = code;
              const c = document.querySelector('#captcha');
              if (c) { c.value = String(ans); c.dispatchEvent(new Event('input', {bubbles: true})); }
            }""", [code, cap2["answer"]])
            v2 = solve_recaptcha_v2(wd)
            if not v2.get("ok"):
                return emit("needs_human_verification", stage="recaptcha_v2", captcha=cap2, v2=v2,
                            screenshot=shot(wd, "v2-fail"))
            js_click_submit(wd)
            r2 = wait_alert(wd, 90)

            # ---- 复核：重新读到到期日才算数，不信页面提示 ----
            info2 = wd.evaluate(JS_INFO)
            expiry1 = info2.get("expiry")
            new_days = parse_days(expiry1)
            renewed = bool(expiry0 and expiry1 and expiry1 != expiry0 and (new_days or 0) > (days or 0) + 0.5)
            out = {
                "expiry_before": expiry0,
                "expiry_after": expiry1,
                "days_before": round(days, 2) if days is not None else None,
                "days_after": round(new_days, 2) if new_days is not None else None,
                "stage1_captcha": cap1,
                "stage2_captcha": cap2,
                "recaptcha_v2": {"rounds": v2.get("rounds"), "token_len": v2.get("token_len")},
                "stage2_response": r2[:400],
                "vps_id": info2.get("vps_id"),
                "screenshot": shot(wd, "final"),
            }
            server_ok = bool(re.search(r"has been renewed until|successfully renewed|renewed until", r2, re.I))
            # 服务端明确说续期成功，且到期日读得出来 → 成功
            if server_ok and expiry1:
                try:
                    wd.goto(URL_INFO, wait_until="domcontentloaded", timeout=60000)
                except Exception:
                    pass
                tidy_tabs(ctx, {wd, tg})
                return emit("renewed", **out)
            # 服务端没明说，但到期日确实往后跳了 → 也算成功
            if renewed:
                tidy_tabs(ctx, {wd, tg})
                return emit("renewed", **out)
            # 有成功迹象但到期日没变 → 不下结论，交人工核对
            if server_ok or "success" in r2.lower():
                return emit("uncertain", **out)
            return emit("failed", **out)
        except BaseException:
            # 关键：趁 CDP 连接还没关闭先清理，否则出了 with 块就再也清不掉了
            try:
                tidy_tabs(ctx, _TIDY.get("keep") or set())
            except Exception:
                pass
            raise


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as e:
        # 兜住所有未预期异常：仍要输出一行 JSON，否则 worker 会报 "missing JSON output"，
        # 入口脚本也就拿不到 stage 信息，排查会失去线索。
        emit("error", stage="crash", error="%s: %s" % (type(e).__name__, e))
        sys.exit(30)
