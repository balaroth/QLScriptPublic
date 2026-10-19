# woiden-auto-renew

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
| `browser=not-ready` | Chromium 起不来，查 `journalctl -u woiden-browser`、profile 是否损坏 |
| `stage=stage1` | 数学验证码或 Cloudflare 拦截 |
| `stage=telegram` | 读码超时（120s） |
| `stage=recaptcha_v2` | 视觉模型返回不可用 / 点选失败 |

标签清理：所有终态经 `emit()` 调 `tidy_tabs()`；with 块内异常也会趁连接存活先清再抛；另有 `atexit` 兜底。SIGKILL（worker 520s 超时）无法捕获，残留标签由下次运行复用 + 清理自愈。

## 已知边界

- Chromium 被 SIGKILL → systemd 约 20s 拉起，登录态不丢（profile 持久化）
- 续期中途崩溃 → 当天不重试（避免重复发 Telegram 码），次日再跑
- 只有一次失败容错窗口，见「关键参数」
