# 微信小程序长虹智慧家居
# new Env("长虹智慧家居每日签到")
# 环境变量 chmlck 取url请求头中的token，
#变量格式 token#备注，多账号换行
#撸实物加视频会员
#
import os
import requests

try:
    from notify import send
except Exception:
    def send(title, content):
        print(f"\n===== {title} =====\n{content}")


def _safe_notify(title, content):
    """发送通知；任何异常都被隔离，不影响业务结论与退出码。"""
    try:
        send(title, content)
    except Exception as e:
        print(f"[通知] 发送异常已隔离: {type(e).__name__}: {e}")


accounts = os.getenv("chmlck", "").splitlines()
print("☞☞☞ 长虹美菱每日签到 ☜☜☜\n")
report_lines = []
if not accounts:
    print("未找到任何账号信息。")
    report_lines.append("❌ 配置缺失：未找到任何 chmlck 账号信息")
else:
    for account in accounts:
        if not account.strip():
            continue
        try:
            token, note = account.split("#")
        except ValueError:
            print(f"格式错误: {account}")
            report_lines.append(f"❌ 账号配置格式错误（应为 token#备注）: {account}")
            continue
        note = note.strip()

        url = "https://hongke.changhong.com/gw/applet/aggr/signin"
        params = {'aggrId': "608"}
        headers = {
            'User-Agent': "Mozilla/5.0 (Linux; Android 14; 23116PN5BC Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.120 Mobile Safari/537.36 XWEB/1220099 MMWEBSDK/20240404 MMWEBID/2445 MicroMessenger/8.0.49.2600(0x28003133) WeChat/arm64 Weixin NetType/4G Language/zh_CN ABI/arm64 MiniProgramEnv/android",
            'Accept-Encoding': "gzip, deflate",
            'Content-Type': "application/json",
            'Token': token.strip()
        }

        try:
            response = requests.post(url, params=params, headers=headers)
            if response.status_code == 200:
                print(f"{note}：签到成功")
                report_lines.append(f"✅ {note}：签到成功")
            elif response.status_code == 400:
                print(f"{note}：请勿重复签到")
                report_lines.append(f"ℹ️ {note}：请勿重复签到")
            else:
                print(f"{note}：响应状态码 {response.status_code} - {response.text}")
                report_lines.append(f"❌ {note}：签到失败 HTTP {response.status_code}")
        except requests.RequestException as e:
            print(f"{note}：请求失败 - {e}")
            report_lines.append(f"❌ {note}：请求失败 - {type(e).__name__}")

_safe_notify("长虹美菱每日签到", "\n".join(report_lines) if report_lines else "无账号执行")