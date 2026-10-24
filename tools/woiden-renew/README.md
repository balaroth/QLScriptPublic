# woiden-auto-renew

> **本目录必须位于 `QLScriptPublic` 仓库的 `tools/woiden-renew/`。**
> 原因：`tools/qlall.js` 的 `EXCLUDE_DIR` 包含 `tools`，只有放在这里，
> 下面的 `.py` 才不会被 qlall 当成青龙业务脚本扫描执行。
> 2026-10-20 曾放在仓库根 `woiden-renew/`，qlall 把 `woiden_auto.py` 和
> `woiden_worker.py` 当任务跑了各 3 次，汇总邮件里因此多出两条失败记录。

Woiden 免费 VPS（d11）的全自动续期，跑在 d3 的常驻 Chromium 上，通过 CDP 复用已登录会话。

## 架构

```
青龙 291「统一签到执行器」 06:00  (qlall)
   └─ 590「Woiden d11 自动续期」  qlrun → 容器内 daily/woiden_auto_renew.py
        └─ 写 /opt/qinglong/data/config/woiden-renew/request   (含 nonce)
             └─ 宿主 woiden-renew-worker.service (root)
                  ├─ ensure_browser()  : 探 9222，不通就 reset-failed + start，等 ≤120s
                  └─ subprocess → woiden_auto.py (ubuntu)  timeout=520
                       └─ CDP 127.0.0.1:9222 → 常驻 Chromium (woiden-browser.service)
                            ├─ /vps-info  读到期日
                            ├─ /vps-renew 第一步：web_address + agreement + 数学验证码 + reCAPTCHA v3
                            ├─ Telegram Web 读 HAX Bot 的续期码
                            └─ /vps-renew-code 第二步：code + 数学验证码 + reCAPTCHA v2（视觉模型）
                  └─ 写 result.json (含 nonce)  → 容器轮询取结果 → 发邮件
```

## 文件

| 路径 | 说明 |
|---|---|
| `woiden_auto.py` | 主自动化：CDP 连接、两步续期、验证码识别、标签清理 |
| `woiden_worker.py` | 宿主请求 worker，含 `ensure_browser()` 自愈 |
| `digit_templates.json` | 9 类数字位图模板（数学验证码 OCR） |
| `woiden_renew.py` | 早期实现，仅作历史参考，不参与运行 |
| `deploy/systemd/*.service` | 两个 systemd unit（部署时复制到 `/etc/systemd/system/`） |

青龙入口脚本在同仓库的 `daily/woiden_auto_renew.py`（与 `dnshe_auto_renew.py`
同级，同属 qlall 调度家族）。本目录只放宿主侧代码。


**不入库**（见 `.gitignore`）：`secrets/`（视觉接口 key）、`profile/`（浏览器 Cookie、Telegram 会话）、`state/`、`artifacts/`、`venv/`。

## 部署

```bash
# 1) 代码
git clone <repo> /opt/woiden-renew && cd /opt/woiden-renew
python3 -m venv venv && venv/bin/pip install playwright

# 2) 密钥
mkdir -p secrets && chmod 700 secrets
echo -n '<vision-api-key>' > secrets/chatgpt2api.key && chmod 600 secrets/chatgpt2api.key

# 3) unit
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now woiden-browser.service woiden-renew-worker.service

# 4) 青龙入口（来自 QLScriptPublic 仓库，不是本仓库）
cd /opt/qinglong/data/scripts/smallfawn_QLScriptPublic
git pull fork main   # 或 upstream 同步后确认 daily/woiden_auto_renew.py 存在
```

首次需要人工准备两件事：在 Chromium 里登录 woiden.id，在 `web.telegram.org/k/` 登录 Telegram。

## 关键参数

| 参数 | 值 | 说明 |
|---|---|---|
| `DUE_DAYS` | 2.0 | 剩余天数低于此值才续期 |
| `connect_cdp` 超时 | 150s | 等 Chromium 崩溃重启 |
| `ensure_browser` 等待 | 120s | worker 侧拉起 Chromium |
| 超时链 | 600 > 540 > 520 | qlall > 入口 WAIT_SECONDS > worker subprocess |

**续期后到期日 = 续期当天 +2 天的 00:00**，不是累加。所以日更一次只维持 1~2 天余量，没有失败缓冲。

## 退出码

`renewed/ok/not_due=0`、`needs_login=20`、`needs_human_verification=21`、`unknown=22`、`needs_manual_renewal=25`、`error=30`

## 故障排查

| 症状 | 定位 |
|---|---|
| `status=needs_human_verification` | Telegram Web 登录态被踢，或 reCAPTCHA v2 视觉接口不可用；VNC 重登 |
| `status=needs_login` | 自动重登两轮都失败。先看 `login.log`：`fired:TWidgetLogin.auth` 但 `verify_failed` 说明点了没生效；`fired:nothing` 说明 widget 没渲染出按钮，紧接着的 `widget` 字段里有它的 url / text / htmlLen，据此判断是 Telegram 会话失效还是 widget 报错 |
| `browser=not-ready` | Chromium 起不来，查 `journalctl -u woiden-browser`、profile 是否损坏 |
| `stage=stage1` | 数学验证码或 Cloudflare 拦截 |
| `stage=telegram` | 读码超时（120s） |
| `stage=recaptcha_v2` 且日志 `td_count:0` | 勾选框没点上。先看日志里的 `top` 字段：`DIV|` 表示广告覆盖层又插回来了（常驻清理器没生效，或页面已导航）；`IFRAME|reCAPTCHA` 才是坐标问题 |
| `stage=login` | 自动重登流程失败，看 `login.log` 里的 `fired` 值 |

## 踩过的坑（2026-10-20 实战）

| 现象 | 根因 | 处理 |
|---|---|---|
| 汇总邮件多报两条失败 | 宿主侧 `.py` 放在仓库根被 qlall 当业务脚本扫到 | 移到 `tools/`（在 `EXCLUDE_DIR` 里） |
| `error / vps not active` | PHPSESSID 寿命短，一天内失效；页面变登录墙后正则读不到 Status | `JS_INFO` 加 `login_wall`，失效时 `ensure_login()` 走 Telegram OAuth 自动重登 |
| reCAPTCHA 三轮 `td_count:0`、`token_len:0` | ① `fc-dialog-overlay` 广告遮罩吃掉点击 ② 勾选框在视口下方，`bounding_box` 给的是页面坐标，`mouse.click` 点到空气 | ① `clear_overlays()` 每次点击前清遮罩 ② `scroll_into_view_if_needed()` 后再取坐标点击 |
| 清了遮罩仍然 `td_count:0`，日志里 `top:"DIV\|"` | ① `.fc-monetization-dialog-container`（z-index 2147483647）会被页面脚本**持续再插入**，清一次根本压不住 ② 它顺手给 `body` 设 `overflow:hidden` 干掉滚动条；清掉后视口宽 1440→1425，整页横向偏移约 8px，先前取的 `bounding_box` 当场过期，鼠标落在勾选框右侧空白 | ① `clear_overlays()` 改成装 `setInterval` 常驻清理（400ms 一轮，页面导航后自动重建） ② 显式还原 `overflow` / `position` ③ `_point()` 每轮「清 → 等布局稳定 → 重取坐标」，并用 `elementFromPoint` 校验落点最顶层必须是 reCAPTCHA iframe，不符就重试（最多 3 轮） |
| `needs_login` 且日志只有一句 `fired:nothing` | Telegram widget 里既没有 `TWidgetLogin.auth` 也没有 `button.tgme_widget_login_button`。原实现不管点没点上一律 `return {"ok": True}`，于是"登录成功"是假的，重读 `/vps-info` 仍是登录墙，最终报 `needs_login` 却查不到任何证据 | `ensure_login` 改为最多 2 轮；`fired == nothing` 时把 widget 的 `url` / `text` / `htmlLen` 记进日志；每轮结束都回 `/vps-info` 实地验证（`_info_readable`），读不到就重试，两轮都不行才 `ok=False`。另外 `/login` 若直接跳走说明会话仍有效，不再白跑 OAuth |
| 勾选后仍无 token | bframe 出现但内容还在加载，`td` 数为 0 | 点完后 `td.first.wait_for(timeout=8000)` |

标签清理：所有终态经 `emit()` 调 `tidy_tabs()`；with 块内异常也会趁连接存活先清再抛；另有 `atexit` 兜底。SIGKILL（worker 520s 超时）无法捕获，残留标签由下次运行复用 + 清理自愈。

## 已知边界

- Chromium 被 SIGKILL → systemd 约 20s 拉起，登录态不丢（profile 持久化）
- 续期中途崩溃 → 当天不重试（避免重复发 Telegram 码），次日再跑
- 只有一次失败容错窗口，见「关键参数」
