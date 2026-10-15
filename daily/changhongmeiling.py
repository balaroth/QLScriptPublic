# 微信小程序：长虹智慧家居
# 环境变量 chmlck：兼容旧 token#备注，多账号换行。
# 默认优先通过 collector 自动执行 wx.login → getTokenByJsCode；旧变量仅作失败回退。

import os
import re
from dataclasses import dataclass
from typing import Callable, List, Optional

import requests

try:
    from notify import send
except Exception:
    def send(title, content):
        print(f"\n===== {title} =====\n{content}")

APPID = os.getenv("CHML_APPID", "wx36c3413e8fe39263").strip()
WX_SERVER_URL = os.getenv("wx_server_url", "http://d4.dqf.cc.cd:8787").rstrip("/")
WX_AUTH = os.getenv("wx_auth", "").strip()
DISABLE_COLLECTOR = os.getenv("CHML_DISABLE_COLLECTOR", "") == "1"
BASE_URL = "https://hongke.changhong.com/gw/applet"
AGGR_ID_OVERRIDE = os.getenv("CHML_AGGR_ID", "").strip()
TIMEOUT = max(5, min(60, int(os.getenv("CHML_HTTP_TIMEOUT", "20"))))
USER_AGENT = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Mobile MicroMessenger/8.0.49 MiniProgramEnv/android"


class ChanghongError(RuntimeError):
    pass


@dataclass
class Account:
    token: str
    note: str = ""
    source: str = "legacy"


def safe_notify(title: str, content: str) -> None:
    try:
        send(title, content)
    except Exception as exc:
        print(f"[通知] 发送异常已隔离: {type(exc).__name__}: {exc}")


def mask_phone(value: str) -> str:
    return re.sub(r"(\d{3})\d{4}(\d{4})", r"\1****\2", str(value or ""))


def parse_accounts(raw: str) -> List[Account]:
    accounts: List[Account] = []
    for index, line in enumerate(str(raw or "").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        token, sep, note = line.partition("#")
        if not token.strip():
            raise ChanghongError(f"账号[{index}] chmlck 缺少 token")
        accounts.append(Account(token.strip(), note.strip() if sep else f"旧变量账号{index}"))
    return accounts


def fetch_collector_session(http=requests, auth: Optional[str] = None, url: Optional[str] = None,
                            appid: Optional[str] = None, timeout: int = 180) -> Account:
    collector_auth = WX_AUTH if auth is None else str(auth or "")
    if not collector_auth:
        raise ChanghongError("未配置 wx_auth")
    response = http.post(
        (url or WX_SERVER_URL).rstrip("/") + "/wx/changhong-session",
        json={"appid": appid or APPID},
        headers={"auth": collector_auth, "Content-Type": "application/json"},
        timeout=timeout,
    )
    try:
        body = response.json()
    except Exception as exc:
        raise ChanghongError(f"collector 返回无法解析：HTTP {response.status_code}") from exc
    data = body.get("data") or {}
    if response.status_code != 200 or body.get("status") is not True or not data.get("token"):
        raise ChanghongError(f"collector 自动登录失败：{body.get('message') or f'HTTP {response.status_code}'}")
    phone = mask_phone(data.get("phone") or "")
    return Account(str(data["token"]), f"collector:{phone}" if phone else "collector", str(body.get("via") or "collector"))


class Task:
    def __init__(self, account: Account, http=requests, logger: Callable[[str], None] = print):
        self.account = account
        self.http = http
        self.logger = logger

    @property
    def headers(self):
        return {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            "Token": self.account.token,
            "token": self.account.token,
            "smarthome": self.account.token,
        }

    def request(self, method: str, path: str, *, params=None, json_body=None):
        response = self.http.request(method, BASE_URL + path, params=params, json=json_body,
                                     headers=self.headers, timeout=TIMEOUT)
        if response.status_code != 200:
            raise ChanghongError(f"{path} HTTP {response.status_code}: {response.text[:160]}")
        try:
            body = response.json()
        except Exception as exc:
            raise ChanghongError(f"{path} 返回非 JSON：{response.text[:160]}") from exc
        if str(body.get("code")) != "200":
            raise ChanghongError(f"{path} 失败：{body.get('message') or body.get('msg') or body.get('code')}")
        return body

    def discover_activity_id(self) -> str:
        if AGGR_ID_OVERRIDE:
            return AGGR_ID_OVERRIDE
        body = self.request("POST", "/homePage/getShortcutMenuList", params={"type": 1}, json_body={})
        for item in body.get("data") or []:
            if item.get("name", "").strip() != "签到打卡":
                continue
            match = re.search(r"activityData=([^,&]+)", str(item.get("webUrl") or ""))
            if match:
                return match.group(1)
        raise ChanghongError("首页未发现当前有效的“签到打卡”活动")

    def activity_info(self, aggr_id: str):
        check = self.request("GET", "/aggr/aggregationCheck", params={"aggrId": aggr_id})
        check_data = check.get("data") or {}
        if int(check_data.get("isCan") or 0) != 1:
            raise ChanghongError(f"签到活动不可用：{check_data.get('prompt') or aggr_id}")
        return self.request("GET", "/aggr/aggregationInfo", params={"aggrId": aggr_id})

    @staticmethod
    def signed_from_activity(body) -> bool:
        for assembly in (body.get("data") or {}).get("aggrAssemblyList") or []:
            signin = assembly.get("aggrAssemblySignin") or {}
            if signin and int(signin.get("isSignin") or 0) == 1:
                return True
        return False

    def sign(self, aggr_id: str):
        return self.request("POST", "/aggr/signin", params={"aggrId": aggr_id}, json_body={})

    def run(self):
        label = self.account.note or self.account.source
        try:
            aggr_id = self.discover_activity_id()
            before = self.activity_info(aggr_id)
            if self.signed_from_activity(before):
                self.logger(f"✅ {label}：今日已签到（服务端活动状态确认，{aggr_id}）")
                return {"ok": True, "already": True, "aggrId": aggr_id}
            self.sign(aggr_id)
            after = self.activity_info(aggr_id)
            if not self.signed_from_activity(after):
                raise ChanghongError("签到接口已返回，但活动状态回查仍为未签到")
            self.logger(f"✅ {label}：签到成功（已回查确认，{aggr_id}）")
            return {"ok": True, "already": False, "aggrId": aggr_id}
        except Exception as exc:
            self.logger(f"❌ {label}：执行失败 - {exc}")
            return {"ok": False, "error": str(exc)}


def main(*, raw: Optional[str] = None, auto_login: Optional[bool] = None, collector_http=requests,
         collector_auth: Optional[str] = None, collector_url: Optional[str] = None,
         collector_appid: Optional[str] = None, http=requests,
         logger: Callable[[str], None] = print, emit_result: bool = True):
    legacy = parse_accounts(os.getenv("chmlck", "") if raw is None else raw)
    accounts: List[Account] = []
    enabled = (not DISABLE_COLLECTOR and bool(WX_AUTH)) if auto_login is None else auto_login
    if enabled:
        try:
            account = fetch_collector_session(collector_http, auth=collector_auth, url=collector_url, appid=collector_appid)
            accounts.append(account)
            logger(f"collector 自动登录成功（{account.source}），已取得最新长虹业务 token")
        except Exception as exc:
            logger(f"collector 自动登录失败：{exc}{'；将回退旧 chmlck 变量' if legacy else ''}")
    if not accounts:
        accounts.extend(legacy)
    if not accounts:
        logger("未取得可用账号：请配置 wx_auth，或临时保留 chmlck")
        if emit_result:
            logger("[QLRUN_RESULT] FAILURE reason=changhong_no_account retryable=1")
        return []

    logger(f"共找到 {len(accounts)} 个账号")
    results = [Task(account, http=http, logger=logger).run() for account in accounts]
    if emit_result:
        logger("[QLRUN_RESULT] SUCCESS" if results and all(x.get("ok") for x in results)
               else "[QLRUN_RESULT] FAILURE reason=changhong_signin_unverified retryable=1")
    return results


if __name__ == "__main__":
    print("☞☞☞ 长虹智慧家居每日签到 ☜☜☜\n")
    lines: List[str] = []
    try:
        main(logger=lambda message: (print(message), lines.append(message))[0])
    except Exception as exc:
        message = f"❌ 主流程异常：{exc}"
        print(message)
        print("[QLRUN_RESULT] FAILURE reason=changhong_main_exception retryable=1")
        lines.extend([message, "[QLRUN_RESULT] FAILURE reason=changhong_main_exception retryable=1"])
    safe_notify("长虹智慧家居每日签到", "\n".join(lines) if lines else "无账号执行")
