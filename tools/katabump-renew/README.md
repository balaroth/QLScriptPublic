# Katabump 自动续期（d3 / 青龙统一签到）

## 架构

- 青龙 `daily/katabump_auto_renew.py` 由 `qlall` 每日统一调用，也可通过 `qlrun` 手动运行。
- 容器入口通过 `/ql/data/config/katabump-renew` 文件信箱调用宿主 `katabump-renew-worker.service`。
- 宿主复用 `woiden-browser.service` 的 Chromium（CDP `127.0.0.1:9222`）与 `/opt/woiden-renew/venv` 的 Playwright。
- 每次运行复用带私有 `window.name` 标记的 Katabump 专属页面；只会清理带相同标记的重复页，不扫描或关闭 Woiden、Telegram、无标记 Katabump 或其他既有页面。遇到人工验证时保留并置前该专属页面。
- 脚本独立调用青龙 `sendNotify.js` 发邮件，不受 `qlall` 子任务通知抑制影响。

## 凭据

生产凭据只放在 `/opt/katabump-renew/login.json`，权限 `600`，属主 `ubuntu:ubuntu`。该文件在 `.gitignore` 中，仓库仅保留 `login.json.template`。

## 验证边界

脚本不绕过 Cloudflare Turnstile。登录或续期若出现验证，会在提交前/检测到服务端要求后停止，返回 `needs_human_verification` 并单独发邮件。
