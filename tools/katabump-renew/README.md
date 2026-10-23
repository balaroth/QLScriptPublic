# Katabump 自动续期（d3 / 青龙统一签到）

## 架构

- 青龙 `daily/katabump_auto_renew.py` 由 `qlall` 每日统一调用，也可通过 `qlrun` 手动运行。
- 容器入口通过 `/ql/data/config/katabump-renew` 文件信箱调用宿主 `katabump-renew-worker.service`。
- 宿主复用 `woiden-browser.service` 的 Chromium（CDP `127.0.0.1:9222`）与 `/opt/woiden-renew/venv` 的 Playwright。
- 每次运行复用本地 `state/page-target-id` 记录的 Chromium CDP `targetId`；该标识跨站导航保持稳定。脚本不按 URL 扫描清理，也不关闭 Woiden、Telegram、未登记的 Katabump 或其他既有页面。遇到无法自动处理的验证时保留并置前该专属页面。
- 脚本独立调用青龙 `sendNotify.js` 发邮件，不受 `qlall` 子任务通知抑制影响。

## 凭据

生产凭据只放在 `/opt/katabump-renew/login.json`，权限 `600`，属主 `ubuntu:ubuntu`。该文件在 `.gitignore` 中，仓库仅保留 `login.json.template`。

## Turnstile 处理

脚本会**像真人一样点一下 Turnstile 的勾选框**，不伪造 token、不绕过校验：

- widget 渲染在 `.cf-turnstile` 容器内，尺寸约 `366x71`，勾选框位于容器左上偏移 `(25, 33)`
- 用真实鼠标事件（`page.mouse.move` / `page.mouse.click`）点击；通过后 `input[name=cf-turnstile-response]` 的 value 约 752 字符
- 该站是 managed 模式，点击后不弹图片九宫格；若将来升级为图片挑战，脚本返回 `needs_human_verification` 并把页面置前
- `cf_clearance` 仍有效时 widget 可能自己勾上，所以点击前先等 6 秒

登录与续期确认窗口各有一处 Turnstile，都走同一个 `solve_turnstile()`。

## 三个曾经的误判（2026-10-23 修复）

| 误判 | 真相 |
|---|---|
| `has_turnstile()` 用 `input[name=cf-turnstile-response]` 的 `count()` 判断「需要人工」 | 该 hidden input 从 widget 挂载起就一直存在，value 为空只代表还没验证通过。结果**永远**判定为需要人工，一次都没真正尝试过 |
| 用 `querySelectorAll('iframe')` 找 widget，查不到就认为没渲染 | Turnstile 的 iframe 位于 **closed shadow root** 内，页面脚本查不到，但截图里明明看得见。可靠判据只有 `.cf-turnstile` 容器是否存在 |
| 每次运行先 `goto(/auth/logout)` | 白白销毁有效会话，导致每次都要重新登录 + 过 Turnstile。改为先探 `/dashboard`，会话还在就复用；多账号时仍强制重登 |

**诊断方法：先截图，再读 DOM。** 这次如果一开始就截图，能省掉六轮排查。

## 续期结果判定

提交确认后页面是**整页跳转**（`/servers/edit?id=...&renew-error=...` 或 `&renew-success=...`），不是弹窗动画。所以判据必须看 URL，不能只看 `#renew-modal` 是否还在：

| 现象 | 结论 |
|---|---|
| URL 含 `renew-error`，正文 "You can't renew your server yet" | `not_due`，从正文或解码后的 URL 里抓 `as of <日期>` 作为下次可续期时间 |
| URL 含 `renew-success` | `renewed` |
| 弹窗已关闭且无 error | `renewed` |
| 弹窗仍开着 | `failed`（未取得证据，不臆断成功） |

**2026-10-23 的第四个误判**：原来点完确认固定 `wait_for_timeout(2500)` 就检查，此时整页跳转还没完成，`#renew-modal` 仍可见、正文里也没有 "can't renew"，于是落到 `failed / 确认窗口仍未关闭`。实际服务端早就返回了 `renew-error`。改为轮询 URL 与弹窗状态，最多 25 秒。

当前账号实测：服务器 `frc`（id 404205），到期 `2026-10-27`，续期周期 **4 天**，可续期日 `10-26`。所以平时跑出来的正常结果就是 `not_due`。

## 登录错误码

| URL | 含义 |
|---|---|
| `?error=captcha` | Turnstile token 为空或被判无效，服务端在验密码**之前**就拒绝 |
| `?error=passwd` | 验证码已通过，邮箱或密码错误 |
| 无 error 且跳出 `/auth/login` | 登录成功 |

`error=captcha` 与 `error=passwd` 是两件事，排查时不要混为一谈。
